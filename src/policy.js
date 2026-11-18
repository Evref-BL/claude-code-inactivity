// Team policy, cycle phases, scoring and offers (pure; no I/O).
// Spec: docs/design.md sections 3.2, 4.3, 5.1, 5.4, 7.4, 9.7.
import { digest, compareStrings } from './util.js';
import { isValidTimeZone, localDate, weekday, zonedToUtc, addMinutes } from './time.js';

/** @typedef {import('./types.js').Difficulty} Difficulty */
/** @typedef {import('./types.js').Tier} Tier */

export const TIERS = Object.freeze(['haiku', 'sonnet', 'opus']);
export const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard']);
export const WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const HEADROOM = Object.freeze({ low: 0.5, normal: 1, high: 1.5 });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const TOP_KEYS = new Set([
  '$schema', 'v', 'timezone', 'cycleDays', 'window', 'graceSeconds', 'startDeadline', 'round2', 'executionEnd',
  'fields', 'statusValues', 'priorityWeights', 'defaultPriority', 'defaultDifficulty', 'difficultyModel',
  'difficultyCost', 'effort', 'trustedAssociations', 'includePullRequests', 'labelFallbacks',
  'maxClaimsPerMember', 'fairness', 'roster',
]);

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/**
 * Fresh copy of every team default (without the required keys timezone and roster).
 * @returns {object}
 */
export function teamDefaults() {
  return {
    v: 1,
    cycleDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    window: { start: '06:00', end: '10:00' },
    graceSeconds: 60,
    startDeadline: '11:30',
    round2: { enabled: true, durationMinutes: 30 },
    executionEnd: '20:00',
    fields: { priority: 'Priority', difficulty: 'Difficulty', status: 'Status', agent: 'Agent' },
    statusValues: {
      ready: 'Todo', claimed: 'Claimed', inProgress: 'In progress', inReview: 'In review', blocked: 'Blocked', done: 'Done',
    },
    priorityWeights: { P0: 1000, P1: 100, P2: 10, P3: 1 },
    defaultPriority: 'P2',
    defaultDifficulty: 'medium',
    difficultyModel: { easy: 'haiku', medium: 'sonnet', hard: 'opus' },
    difficultyCost: { easy: 1, medium: 2, hard: 4 },
    effort: { haiku: 'low', sonnet: 'medium', opus: 'high' },
    includePullRequests: false,
    labelFallbacks: true,
    maxClaimsPerMember: 8,
    fairness: { historyDays: 7, historyWeightPct: 25 },
  };
}

/**
 * Validate and normalize a team policy (4.3). Always returns a best-effort `team`
 * object (null only when the input is not an object).
 *
 * `trustedAssociations` is DEPRECATED: it used to grant trust to issue authors by GitHub association.
 * Trust is now a per-member whitelist (`trustedAuthors` in the user config, see trust.js), so the key is
 * still accepted in an existing team.json but ignored (a warning is returned) and is not part of the
 * normalized team, hence not of the shared `cfg` digest.
 * @param {unknown} input
 * @returns {{ok:boolean, errors:{path:string,message:string}[], warnings:{path:string,message:string}[], team:object|null}}
 */
export function validateTeam(input) {
  /** @type {{path:string,message:string}[]} */
  const errors = [];
  /** @type {{path:string,message:string}[]} */
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  if (!isObj(input)) {
    err('', 'team policy must be an object');
    return { ok: false, errors, warnings, team: null };
  }
  const d = teamDefaults();
  const src = /** @type {Record<string, any>} */ (input);
  for (const k of Object.keys(src)) if (!TOP_KEYS.has(k)) err(`/${k}`, 'unknown property');

  // Generic readers: return the default (and record an error) when invalid.
  const readEnum = (value, path, allowed, def) => {
    if (value === undefined) return def;
    if (!allowed.includes(value)) { err(path, `must be one of ${allowed.join(', ')}`); return def; }
    return value;
  };
  const readInt = (value, path, min, max, def) => {
    if (value === undefined) return def;
    if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
      err(path, `must be an integer >= ${min}${max !== undefined ? ` and <= ${max}` : ''}`);
      return def;
    }
    return value;
  };
  const readBool = (value, path, def) => {
    if (value === undefined) return def;
    if (typeof value !== 'boolean') { err(path, 'must be a boolean'); return def; }
    return value;
  };
  const readTime = (value, path, def) => {
    if (value === undefined) return def;
    if (typeof value !== 'string' || !HHMM.test(value)) { err(path, 'must be a time HH:MM (00:00-23:59)'); return def; }
    return value;
  };
  const readSubObject = (value, path, allowedKeys) => {
    if (value === undefined) return {};
    if (!isObj(value)) { err(path, 'must be an object'); return {}; }
    for (const k of Object.keys(value)) if (!allowedKeys.includes(k)) err(`${path}/${k}`, 'unknown property');
    return value;
  };
  const readEnumList = (value, path, allowed, def, { min = 0 } = {}) => {
    if (value === undefined) return [...def];
    if (!Array.isArray(value)) { err(path, 'must be an array'); return [...def]; }
    const out = [];
    value.forEach((v, i) => {
      if (!allowed.includes(v)) err(`${path}/${i}`, `must be one of ${allowed.join(', ')}`);
      else if (!out.includes(v)) out.push(v);
    });
    if (out.length < min) err(path, `must contain at least ${min} item(s)`);
    return out;
  };

  const team = teamDefaults();
  if (src.v !== 1) err('/v', 'must be 1');

  if (typeof src.timezone !== 'string' || src.timezone === '') {
    err('/timezone', 'is required (IANA zone, e.g. Europe/Paris)');
    team.timezone = '';
  } else if (!isValidTimeZone(src.timezone)) {
    err('/timezone', `unknown time zone '${src.timezone}'`);
    team.timezone = src.timezone;
  } else team.timezone = src.timezone;

  // Canonical weekday order keeps the digest independent of how the days were written.
  const days = readEnumList(src.cycleDays, '/cycleDays', WEEKDAYS, d.cycleDays, { min: 1 });
  team.cycleDays = WEEKDAYS.filter((w) => days.includes(w));

  const w = readSubObject(src.window, '/window', ['start', 'end']);
  team.window = { start: readTime(w.start, '/window/start', d.window.start), end: readTime(w.end, '/window/end', d.window.end) };
  team.graceSeconds = readInt(src.graceSeconds, '/graceSeconds', 0, 600, d.graceSeconds);
  team.startDeadline = readTime(src.startDeadline, '/startDeadline', d.startDeadline);
  const r2 = readSubObject(src.round2, '/round2', ['enabled', 'durationMinutes']);
  team.round2 = {
    enabled: readBool(r2.enabled, '/round2/enabled', d.round2.enabled),
    durationMinutes: readInt(r2.durationMinutes, '/round2/durationMinutes', 5, 240, d.round2.durationMinutes),
  };
  team.executionEnd = readTime(src.executionEnd, '/executionEnd', d.executionEnd);

  // Ordering rules (all times are cycle-local and < 24:00).
  const ws = minutesOf(team.window.start);
  const we = minutesOf(team.window.end);
  const sd = minutesOf(team.startDeadline);
  const ee = minutesOf(team.executionEnd);
  if (we <= ws) err('/window/end', 'must be later than window.start');
  if (sd * 60 < we * 60 + team.graceSeconds) err('/startDeadline', 'must be at or after window.end + graceSeconds');
  if (ee <= sd) err('/executionEnd', 'must be later than startDeadline');
  if (team.round2.enabled && sd + team.round2.durationMinutes > ee) {
    err('/round2/durationMinutes', `round 2 would end at ${hhmm(sd + team.round2.durationMinutes)}, after executionEnd`);
  }

  // Field and status names.
  const readNames = (value, path, defaults) => {
    const sub = readSubObject(value, path, Object.keys(defaults));
    const out = {};
    for (const k of Object.keys(defaults)) {
      const v = sub[k];
      if (v === undefined) out[k] = defaults[k];
      else if (typeof v !== 'string' || v.trim() === '') { err(`${path}/${k}`, 'must be a non-empty string'); out[k] = defaults[k]; }
      else out[k] = v;
    }
    const seen = new Map();
    for (const k of Object.keys(out)) {
      const low = out[k].toLowerCase();
      if (seen.has(low)) err(`${path}/${k}`, `collides with ${path}/${seen.get(low)} ('${out[k]}')`);
      else seen.set(low, k);
    }
    return out;
  };
  team.fields = readNames(src.fields, '/fields', d.fields);
  team.statusValues = readNames(src.statusValues, '/statusValues', d.statusValues);

  // Priorities.
  if (src.priorityWeights === undefined) team.priorityWeights = { ...d.priorityWeights };
  else if (!isObj(src.priorityWeights)) { err('/priorityWeights', 'must be an object'); team.priorityWeights = { ...d.priorityWeights }; } else {
    team.priorityWeights = {};
    for (const [k, v] of Object.entries(src.priorityWeights)) {
      if (!Number.isInteger(v)) err(`/priorityWeights/${k}`, 'must be an integer');
      else team.priorityWeights[k] = v;
    }
  }
  if (src.defaultPriority === undefined) team.defaultPriority = d.defaultPriority;
  else if (typeof src.defaultPriority !== 'string' || src.defaultPriority === '') { err('/defaultPriority', 'must be a non-empty string'); team.defaultPriority = d.defaultPriority; } else team.defaultPriority = src.defaultPriority;
  team.defaultDifficulty = readEnum(src.defaultDifficulty, '/defaultDifficulty', DIFFICULTIES, d.defaultDifficulty);

  // Per-difficulty and per-tier tables merge over their defaults.
  const dm = readSubObject(src.difficultyModel, '/difficultyModel', DIFFICULTIES);
  const dc = readSubObject(src.difficultyCost, '/difficultyCost', DIFFICULTIES);
  const ef = readSubObject(src.effort, '/effort', TIERS);
  team.difficultyModel = {};
  team.difficultyCost = {};
  for (const x of DIFFICULTIES) {
    team.difficultyModel[x] = readEnum(dm[x], `/difficultyModel/${x}`, TIERS, d.difficultyModel[x]);
    team.difficultyCost[x] = readInt(dc[x], `/difficultyCost/${x}`, 1, undefined, d.difficultyCost[x]);
  }
  team.effort = {};
  for (const t of TIERS) team.effort[t] = readEnum(ef[t], `/effort/${t}`, EFFORTS, d.effort[t]);

  if (src.trustedAssociations !== undefined) {
    if (!Array.isArray(src.trustedAssociations)) err('/trustedAssociations', 'must be an array (deprecated and ignored anyway)');
    else warnings.push({ path: '/trustedAssociations', message: "deprecated and ignored: trust is a per-member whitelist (`inactivity trust add <login>`, config 'trustedAuthors'); remove this key" });
  }
  team.includePullRequests = readBool(src.includePullRequests, '/includePullRequests', d.includePullRequests);
  team.labelFallbacks = readBool(src.labelFallbacks, '/labelFallbacks', d.labelFallbacks);
  team.maxClaimsPerMember = readInt(src.maxClaimsPerMember, '/maxClaimsPerMember', 1, 50, d.maxClaimsPerMember);
  const fa = readSubObject(src.fairness, '/fairness', ['historyDays', 'historyWeightPct']);
  team.fairness = {
    historyDays: readInt(fa.historyDays, '/fairness/historyDays', 0, 60, d.fairness.historyDays),
    historyWeightPct: readInt(fa.historyWeightPct, '/fairness/historyWeightPct', 0, 100, d.fairness.historyWeightPct),
  };

  // Roster: `login` is stored lower-cased (matching key), `display` keeps the original.
  team.roster = [];
  if (!Array.isArray(src.roster) || src.roster.length === 0) err('/roster', 'is required and must contain at least one member');
  else {
    const seen = new Set();
    src.roster.forEach((m, i) => {
      const p = `/roster/${i}`;
      if (!isObj(m)) { err(p, 'must be an object'); return; }
      for (const k of Object.keys(m)) if (!['login', 'display', 'maxCapacity', 'models'].includes(k)) err(`${p}/${k}`, 'unknown property');
      if (typeof m.login !== 'string' || m.login.trim() === '') { err(`${p}/login`, 'must be a non-empty string'); return; }
      const display = nonEmpty(m.display) && m.display.trim().toLowerCase() === m.login.trim().toLowerCase() ? m.display.trim() : m.login.trim();
      const key = display.toLowerCase();
      if (seen.has(key)) { err(`${p}/login`, `duplicate member '${display}'`); return; }
      seen.add(key);
      const models = readEnumList(m.models, `${p}/models`, TIERS, TIERS);
      team.roster.push({
        login: key,
        display,
        maxCapacity: readInt(m.maxCapacity, `${p}/maxCapacity`, 0, undefined, 8),
        models: TIERS.filter((t) => models.includes(t)),
      });
    });
  }
  return { ok: errors.length === 0, errors, warnings, team };
}

/**
 * Stable digest of a normalized team policy (the `cfg` of every comment).
 * @param {object} team
 * @returns {string}
 */
export function digestTeam(team) {
  return digest(team);
}

/**
 * Cycle date (local date in the team zone) for an instant.
 * @param {{timezone:string}} team
 * @param {Date|string|number} instant
 * @returns {string}
 */
export function cycleDateFor(team, instant) {
  return localDate(instant, team.timezone);
}

function roundState(now, claimStart, claimEnd, resolveAt) {
  const t = now.getTime();
  if (t < claimStart.getTime()) return 'pending';
  if (t < claimEnd.getTime()) return 'open';
  if (t < resolveAt.getTime()) return 'closed';
  return 'resolved';
}

/**
 * Phases of the cycle that contains `now` (5.1). Rounds are independent; the
 * execution window overlaps round 2. `active` is false when the cycle date is
 * not in `cycleDays` (the rounds are still computed, for dry-run what-ifs).
 * @param {object} team normalized team policy
 * @param {Date} now
 * @param {string} [cycle] override the cycle date (default: local date of now)
 * @returns {import('./types.js').CyclePhases}
 */
export function cyclePhases(team, now, cycle) {
  const date = cycle ?? cycleDateFor(team, now);
  const tz = team.timezone;
  const grace = team.graceSeconds * 1000;
  const mk = (round, claimStart, claimEnd) => {
    const resolveAt = new Date(claimEnd.getTime() + grace);
    return { round, claimStart, claimEnd, resolveAt, state: roundState(now, claimStart, claimEnd, resolveAt) };
  };
  const r1 = mk(1, zonedToUtc(date, team.window.start, tz), zonedToUtc(date, team.window.end, tz));
  let r2 = null;
  const startDeadline = zonedToUtc(date, team.startDeadline, tz);
  if (team.round2.enabled) r2 = mk(2, startDeadline, addMinutes(startDeadline, team.round2.durationMinutes));
  const executionEnd = zonedToUtc(date, team.executionEnd, tz);
  const active = team.cycleDays.includes(weekday(date));
  const executionOpen = active && now.getTime() >= r1.resolveAt.getTime() && now.getTime() < executionEnd.getTime();
  return { cycle: date, active, rounds: { 1: r1, 2: r2 }, startDeadline, executionEnd, executionOpen };
}

const norm = (s) => String(s).trim().toLowerCase();

/** Canonical key of `priorityWeights` matching `value` case-insensitively, else null. */
function weightKey(value, team) {
  const v = norm(value);
  for (const k of Object.keys(team.priorityWeights)) if (norm(k) === v) return k;
  return null;
}

function labelValues(item, prefix) {
  const out = [];
  for (const raw of item.labels ?? []) {
    const label = String(raw).trim();
    if (label.toLowerCase().startsWith(prefix)) out.push(label.slice(prefix.length).trim());
  }
  return out;
}

/**
 * Priority: field value, else `priority:<X>` label, else team default.
 * A known value is returned under its canonical key; an unknown field value is
 * returned unchanged (its weight is 0).
 * @returns {string}
 */
export function priorityOf(item, team) {
  const field = item.fields?.priority;
  if (typeof field === 'string' && field.trim() !== '') return weightKey(field, team) ?? field.trim();
  if (team.labelFallbacks) {
    const known = labelValues(item, 'priority:')
      .map((v) => weightKey(v, team))
      .filter((k) => k !== null)
      .sort((a, b) => team.priorityWeights[b] - team.priorityWeights[a] || compareStrings(a, b));
    if (known.length > 0) return known[0];
  }
  return team.defaultPriority;
}

/** @returns {number} */
export function priorityWeight(item, team) {
  const key = weightKey(priorityOf(item, team), team);
  return key === null ? 0 : team.priorityWeights[key];
}

/**
 * Difficulty: field value, else `difficulty:<x>` label, else team default.
 * @returns {Difficulty}
 */
export function difficultyOf(item, team) {
  const field = item.fields?.difficulty;
  if (typeof field === 'string' && DIFFICULTIES.includes(norm(field))) return /** @type {Difficulty} */ (norm(field));
  if (team.labelFallbacks) {
    const found = labelValues(item, 'difficulty:').map(norm).filter((v) => DIFFICULTIES.includes(v));
    // Hardest label wins when several are present (deterministic, conservative on cost).
    for (const x of [...DIFFICULTIES].reverse()) if (found.includes(x)) return /** @type {Difficulty} */ (x);
  }
  return team.defaultDifficulty;
}

/** Points consumed from a member's capacity. @returns {number} */
export function costOf(difficulty, team) {
  return team.difficultyCost[difficulty];
}

/** @returns {Tier} */
export function tierFor(difficulty, team) {
  return team.difficultyModel[difficulty];
}

/**
 * Total candidate order (5.4): priority weight desc, `owner/repo` lower-case asc, issue number asc.
 * @template {{repo:string, number:number, id?:string}} T
 * @param {T[]} items
 * @param {object} team
 * @returns {T[]} new array
 */
export function sortCandidates(items, team) {
  const keyed = items.map((item) => ({ item, w: priorityWeight(item, team), repo: item.repo.toLowerCase() }));
  keyed.sort((a, b) => b.w - a.w
    || compareStrings(a.repo, b.repo)
    || a.item.number - b.item.number
    || compareStrings(String(a.item.id ?? ''), String(b.item.id ?? '')));
  return keyed.map((k) => k.item);
}

/**
 * Points and tasks already started on a cycle date, summed over every project
 * (the daily budget belongs to the member, not to a project).
 * @param {{cycles?:Record<string,{pointsUsed?:number,tasksStarted?:number}>}|null|undefined} state
 * @param {string} cycle
 */
export function usedToday(state, cycle) {
  let pointsUsed = 0;
  let tasksStarted = 0;
  for (const [key, c] of Object.entries(state?.cycles ?? {})) {
    if (!c || !key.endsWith(`:${cycle}`)) continue;
    pointsUsed += Number(c.pointsUsed) || 0;
    tasksStarted += Number(c.tasksStarted) || 0;
  }
  return { pointsUsed, tasksStarted };
}

/**
 * What this member can offer now (4.5, 9.7). Null: paused, day off, usage limit
 * active, not on the roster, no model, or no capacity left.
 * Capacity = floor(dailyPoints * headroom) - pointsUsedToday, clamped to
 * roster.maxCapacity and to remainingTasks * maxCost.
 * @param {{config:object, team:object, login:string, now:Date, state?:object|null, round?:1|2}} p
 * @returns {import('./types.js').Offer|null}
 */
export function buildOffer({ config, team, login, now, state }) {
  const av = config.availability ?? {};
  const t = now.getTime();
  if (av.paused) return null;
  if (av.pausedUntil) {
    const until = Date.parse(av.pausedUntil);
    if (Number.isFinite(until) && until > t) return null;
  }
  const limitUntil = state?.limit?.until ? Date.parse(state.limit.until) : NaN;
  if (Number.isFinite(limitUntil) && limitUntil > t) return null;

  const cycle = cycleDateFor(team, now);
  const day = weekday(cycle);
  if (!team.cycleDays.includes(day)) return null;
  if (!(av.days ?? ['mon', 'tue', 'wed', 'thu', 'fri']).includes(day)) return null;

  const member = team.roster.find((m) => m.login === norm(login));
  if (!member) return null;

  const factor = HEADROOM[av.creditHeadroom ?? 'normal'] ?? 1;
  const { pointsUsed, tasksStarted } = usedToday(state, cycle);
  const remainingTasks = (av.maxTasksPerDay ?? 2) - tasksStarted;
  if (remainingTasks < 1) return null;
  const maxCost = Math.max(...Object.values(team.difficultyCost));
  let capacity = Math.floor((av.dailyPoints ?? 4) * factor) - pointsUsed;
  capacity = Math.min(capacity, member.maxCapacity, remainingTasks * maxCost);
  if (!(capacity >= 1)) return null;

  const offered = av.models ?? ['haiku', 'sonnet'];
  const models = TIERS.filter((m) => offered.includes(m) && member.models.includes(m));
  if (models.length === 0) return null;
  return { capacity, models };
}

/**
 * Model, effort and spending limits for a difficulty (7.4).
 * `--model` = config.modelOverrides[tier] ?? tier; effort = config.effort[tier] ?? team.effort[tier].
 * @param {{difficulty:Difficulty, team:object, config:object}} p
 * @returns {{tier:Tier, model:string, effort:string, timeoutMs:number, maxTurns:number, maxBudgetUsd:number|null}}
 */
export function modelArgs({ difficulty, team, config }) {
  const tier = tierFor(difficulty, team);
  const ex = config.execution ?? {};
  const timeoutMin = ex.timeoutMinutes?.[difficulty] ?? { easy: 20, medium: 45, hard: 90 }[difficulty];
  const maxTurns = ex.maxTurns?.[difficulty] ?? { easy: 40, medium: 80, hard: 150 }[difficulty];
  const budgets = ex.maxBudgetUsd === undefined ? { easy: 1, medium: 3, hard: 10 } : ex.maxBudgetUsd;
  const budget = budgets ? budgets[difficulty] : undefined;
  return {
    tier,
    model: config.modelOverrides?.[tier] ?? tier,
    effort: config.effort?.[tier] ?? team.effort[tier],
    timeoutMs: Math.round(timeoutMin * 60_000),
    maxTurns,
    maxBudgetUsd: typeof budget === 'number' ? budget : null,
  };
}
