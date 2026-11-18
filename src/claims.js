// Claim protocol: comment formatting, tolerant parsing, event validation and the
// deterministic cycle resolver. Pure: no I/O, no clock, no randomness.
// Spec: docs/design.md section 5 and 9.8.

import { canonicalJson, sha256Hex, digest, compareStrings, DispatchError, sanitizeForComment, stripLinks } from './util.js';
import { zonedToUtc, addDays, addMinutes, formatLocal } from './time.js';
import { digestTeam, sortCandidates, difficultyOf, costOf, tierFor } from './policy.js';
import { partitionByTrust } from './trust.js';

export const MARKER_PREFIX = 'inactivity:v1';

const MARKER_SUBSTRING = 'inactivity:v';
const MARKER_LINE = /^<!-- inactivity:v(\d+) (\{.*\}) -->\s*$/;
const KINDS = ['claim', 'withdraw', 'assign', 'release', 'start', 'done', 'failed'];
const TIERS = ['haiku', 'sonnet', 'opus'];
const SKIP_LABEL = 'inactivity:skip';
const LIFECYCLE = ['assign', 'start', 'done', 'failed', 'release'];

/** @typedef {import('./types.js').BoardItem} BoardItem */
/** @typedef {import('./types.js').ClaimEvent} ClaimEvent */
/** @typedef {import('./types.js').RoundResult} RoundResult */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const lc = (s) => String(s).toLowerCase();
const isInt = (n) => Number.isInteger(n);
const isStr = (s) => typeof s === 'string' && s.length > 0;

/** Total order of events: (createdAt, databaseId, commentId). */
function cmpEvent(a, b) {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.databaseId !== b.databaseId) return a.databaseId < b.databaseId ? -1 : 1;
  return compareStrings(String(a.commentId ?? ''), String(b.commentId ?? ''));
}

/** Team with the few defaults claims.js needs (a normalized team already has them). */
function teamDefaults(team) {
  return {
    timezone: team.timezone,
    window: { start: '06:00', end: '10:00', ...(team.window ?? {}) },
    graceSeconds: team.graceSeconds ?? 60,
    startDeadline: team.startDeadline ?? '11:30',
    round2: { enabled: true, durationMinutes: 30, ...(team.round2 ?? {}) },
    statusValues: {
      ready: 'Todo', claimed: 'Claimed', inProgress: 'In progress', inReview: 'In review', blocked: 'Blocked', done: 'Done',
      ...(team.statusValues ?? {}),
    },
    maxClaimsPerMember: team.maxClaimsPerMember ?? 8,
    fairness: { historyDays: 7, historyWeightPct: 25, ...(team.fairness ?? {}) },
    includePullRequests: team.includePullRequests ?? false,
  };
}

function rosterMap(team) {
  const map = new Map();
  for (const entry of team.roster ?? []) {
    map.set(lc(entry.login), {
      login: lc(entry.login),
      maxCapacity: entry.maxCapacity ?? 8,
      models: entry.models ?? TIERS,
    });
  }
  return map;
}

/**
 * Absolute windows of both rounds for a cycle date.
 * @returns {{1:{claimStart:Date,claimEnd:Date,resolveAt:Date}, 2:null|{claimStart:Date,claimEnd:Date,resolveAt:Date}}}
 */
export function roundWindows(team, cycle) {
  const t = teamDefaults(team);
  const graceMs = t.graceSeconds * 1000;
  const start1 = zonedToUtc(cycle, t.window.start, t.timezone);
  const end1 = zonedToUtc(cycle, t.window.end, t.timezone);
  const out = { 1: { claimStart: start1, claimEnd: end1, resolveAt: new Date(end1.getTime() + graceMs) }, 2: null };
  if (t.round2.enabled) {
    const start2 = zonedToUtc(cycle, t.startDeadline, t.timezone);
    const end2 = addMinutes(start2, t.round2.durationMinutes);
    out[2] = { claimStart: start2, claimEnd: end2, resolveAt: new Date(end2.getTime() + graceMs) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Single marker line, canonical JSON payload. */
export function formatMarker(payload) {
  const clean = JSON.parse(JSON.stringify({ v: 1, ...payload }));
  return `<!-- ${MARKER_PREFIX} ${canonicalJson(clean)} -->`;
}

/** Make arbitrary text unable to forge or hide a marker. */
function neutralizeText(text) {
  return String(text)
    .split(MARKER_SUBSTRING).join('inactivity:​v')
    .split('<!--').join('<!- -')
    .split('-->').join('- ->');
}

function resolveClock(team, payload) {
  if (!team?.timezone) return '';
  try {
    const win = roundWindows(team, payload.cycle)[payload.round ?? 1];
    if (!win) return '';
    return `${formatLocal(win.resolveAt, team.timezone).slice(-5)} ${team.timezone}`;
  } catch {
    return '';
  }
}

function humanText(payload, team, summary) {
  const who = `@${payload.member}`;
  const cyc = `cycle ${payload.cycle} (round ${payload.round ?? 1})`;
  switch (payload.kind) {
    case 'claim': {
      const when = resolveClock(team, payload);
      const tail = when ? ` Claims are resolved after ${when}, nothing to do.` : ' Nothing to do.';
      return `:robot: **Claude claim** for ${cyc} by ${who}. Rank ${payload.rank}, offering ${payload.models.join('/')}, capacity ${payload.capacity} pts.${tail}`;
    }
    case 'assign': {
      const n = Array.isArray(payload.claims) ? payload.claims.length : 0;
      return `:robot: **Assigned** to ${who} (model: ${payload.model}) for ${cyc}. Resolved from ${n} claims.`;
    }
    case 'start':
      return `:robot: **Started** by ${who}${payload.model ? ` (model: ${payload.model})` : ''} for ${cyc}.`;
    case 'done': {
      const lines = [`:white_check_mark: **Done** by ${who} for ${cyc}.`];
      if (payload.pr) lines.push(`Pull request: ${sanitizeForComment(payload.pr, 300)}`);
      if (summary) lines.push('', sanitizeForComment(stripLinks(sanitizeForComment(summary, 5000)), 600));
      return lines.join('\n');
    }
    case 'failed': {
      let line = `:warning: **Failed** by ${who} for ${cyc}. Reason: ${sanitizeForComment(payload.reason, 120)}.`;
      if (payload.branch) line += ` Branch: ${sanitizeForComment(payload.branch, 200)}.`;
      if (payload.pr) line += ` Pull request: ${sanitizeForComment(payload.pr, 300)}.`;
      return line;
    }
    case 'release':
      return `:robot: **Released** by ${who} for ${cyc}. Reason: ${sanitizeForComment(payload.reason, 120)}. The task can be claimed again.`;
    case 'withdraw':
      return `:robot: **Claim withdrawn** by ${who} for ${cyc}.`;
    default:
      return `:robot: inactivity event by ${who}.`;
  }
}

/**
 * Full comment body: human text first, exactly one marker line last.
 * @param {object} payload
 * @param {{team?:object, text?:string, summary?:string}} [opts]
 */
export function renderComment(payload, { team, text, summary } = {}) {
  const human = neutralizeText(text ?? humanText(payload, team, summary));
  return `${human}\n\n${formatMarker(payload)}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const TASK_RE = /^[^/\s#]+\/[^/\s#]+#[1-9]\d*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** @returns {string|null} name of the first invalid field, null when valid */
function badField(p) {
  if (!KINDS.includes(p.kind)) return 'kind';
  if (!isStr(p.cycle) || !DATE_RE.test(p.cycle)) return 'cycle';
  if (p.round !== 1 && p.round !== 2) return 'round';
  if (!isStr(p.task) || !TASK_RE.test(p.task)) return 'task';
  if (!isStr(p.member) || !LOGIN_RE.test(p.member)) return 'member';
  if (!isStr(p.cfg) || !/^sha256:[0-9a-f]{64}$/.test(p.cfg)) return 'cfg';
  if (p.runId !== undefined && (!isStr(p.runId) || p.runId.length > 64)) return 'runId';
  if (p.ts !== undefined && (!isStr(p.ts) || Number.isNaN(Date.parse(p.ts)))) return 'ts';
  const tier = (t) => TIERS.includes(t);
  switch (p.kind) {
    case 'claim':
      if (!isInt(p.capacity) || p.capacity < 1) return 'capacity';
      if (!Array.isArray(p.models) || p.models.length === 0 || !p.models.every(tier)) return 'models';
      if (!isInt(p.rank) || p.rank < 1) return 'rank';
      break;
    case 'assign':
      if (!tier(p.model)) return 'model';
      if (p.claims !== undefined && !(Array.isArray(p.claims) && p.claims.every(isInt))) return 'claims';
      if (p.inputs !== undefined && !isStr(p.inputs)) return 'inputs';
      break;
    case 'start':
      if (!tier(p.model)) return 'model';
      break;
    case 'done':
      if (p.model !== undefined && !tier(p.model)) return 'model';
      if (!isInt(p.points) || p.points < 0) return 'points';
      if (p.pr !== undefined && !isStr(p.pr)) return 'pr';
      if (p.branch !== undefined && !isStr(p.branch)) return 'branch';
      break;
    case 'failed':
      if (p.model !== undefined && !tier(p.model)) return 'model';
      if (!isStr(p.reason)) return 'reason';
      if (p.pr !== undefined && !isStr(p.pr)) return 'pr';
      if (p.branch !== undefined && !isStr(p.branch)) return 'branch';
      break;
    case 'release':
      if (!isStr(p.reason)) return 'reason';
      break;
    default:
      break;
  }
  return null;
}

/** Locate the single marker; returns {ok, version, json} or {ok:false, reason}. */
function extractMarker(body) {
  if (typeof body !== 'string') return { ok: false, reason: 'no-marker' };
  const occurrences = body.split(MARKER_SUBSTRING).length - 1;
  if (occurrences === 0) return { ok: false, reason: 'no-marker' };
  if (occurrences > 1) return { ok: false, reason: 'multiple-markers' };
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!line.includes(MARKER_SUBSTRING)) continue;
    if (inFence) return { ok: false, reason: 'no-marker' };
    const m = MARKER_LINE.exec(line);
    if (!m) return { ok: false, reason: 'no-marker' };
    return { ok: true, version: m[1], json: m[2] };
  }
  return { ok: false, reason: 'no-marker' };
}

/**
 * Tolerant parser. Checks everything that can be checked from the comment and its item.
 * @returns {{ok:true,payload:object}|{ok:false,reason:string}}
 */
export function parseComment(comment, item) {
  if (!comment || typeof comment !== 'object') return { ok: false, reason: 'no-marker' };
  if (comment.isMinimized) return { ok: false, reason: 'minimized' };
  const marker = extractMarker(comment.body);
  if (!marker.ok) return marker;
  const author = comment.author;
  if (!author || !author.login) return { ok: false, reason: 'author-null' };
  if (author.type === 'Bot' || /\[bot\]$/i.test(author.login)) return { ok: false, reason: 'author-bot' };
  if (marker.version !== '1') return { ok: false, reason: 'bad-version' };
  let raw;
  try {
    raw = JSON.parse(marker.json);
  } catch {
    return { ok: false, reason: 'bad-json' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad-json' };
  if (raw.v !== 1) return { ok: false, reason: 'bad-version' };
  const payload = { ...raw, round: raw.round === undefined ? 1 : raw.round };
  const bad = badField(payload);
  if (bad) return { ok: false, reason: `bad-field:${bad}` };
  if (lc(payload.member) !== lc(author.login)) return { ok: false, reason: 'member-mismatch' };
  if (item && payload.task !== item.id) return { ok: false, reason: 'task-mismatch' };
  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Event collection and folding
// ---------------------------------------------------------------------------

/**
 * Parse and validate every protocol comment of one cycle.
 * Comments of other cycles are not errors and are skipped silently.
 * @returns {{events: ClaimEvent[], rejected: {commentId:string, reason:string}[]}}
 */
export function collectEvents({ items, team, cycle, cfg }) {
  cfg ??= digestTeam(team);
  const t = teamDefaults(team);
  const win = roundWindows(team, cycle);
  const roster = rosterMap(team);
  const rejected = [];
  const valid = [];

  for (const item of items) {
    for (const comment of item.comments ?? []) {
      const parsed = parseComment(comment, item);
      if (!parsed.ok) {
        if (parsed.reason !== 'no-marker') rejected.push({ commentId: comment.id, reason: parsed.reason });
        continue;
      }
      const p = parsed.payload;
      if (p.cycle !== cycle) continue;
      const reject = (reason) => rejected.push({ commentId: comment.id, reason });
      const member = lc(p.member);
      if (!roster.has(member)) { reject('not-roster'); continue; }
      if (p.cfg !== cfg) { reject('cfg-mismatch'); continue; }
      const w = win[p.round];
      if (!w) { reject('outside-window'); continue; }
      const created = Date.parse(comment.createdAt);
      if (Number.isNaN(created)) { reject('outside-window'); continue; }
      if (p.kind === 'claim' || p.kind === 'withdraw') {
        if (created < w.claimStart.getTime() || created >= w.claimEnd.getTime()) { reject('outside-window'); continue; }
        if (comment.lastEditedAt && Date.parse(comment.lastEditedAt) >= w.claimEnd.getTime()) { reject('edited-after-window'); continue; }
      } else if (created < w.resolveAt.getTime()) {
        reject('outside-window');
        continue;
      }
      valid.push({
        kind: p.kind, payload: p, member, task: p.task, round: p.round,
        createdAt: comment.createdAt, databaseId: comment.databaseId, commentId: comment.id,
      });
    }
  }

  valid.sort(cmpEvent);

  const dropped = new Set();
  const drop = (ev, reason) => { dropped.add(ev); rejected.push({ commentId: ev.commentId, reason }); };

  // Duplicates of lifecycle kinds keep the earliest.
  const seen = new Set();
  for (const ev of valid) {
    if (ev.kind === 'claim' || ev.kind === 'withdraw') continue;
    const key = `${ev.kind}|${ev.member}|${ev.task}|${ev.round}`;
    if (seen.has(key)) drop(ev, 'duplicate');
    else seen.add(key);
  }

  // Fold claim/withdraw per (member, round, task).
  const live = new Map(); // `${member}|${round}|${task}` -> event
  for (const ev of valid) {
    if (ev.kind !== 'claim' && ev.kind !== 'withdraw') continue;
    const key = `${ev.member}|${ev.round}|${ev.task}`;
    if (ev.kind === 'claim') {
      if (live.has(key)) drop(ev, 'duplicate');
      else live.set(key, ev);
    } else {
      live.delete(key);
    }
  }

  // Rank uniqueness, then cap, per (member, round) over surviving claims.
  const groups = new Map();
  for (const ev of live.values()) {
    const key = `${ev.member}|${ev.round}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  for (const list of groups.values()) {
    list.sort(cmpEvent);
    const ranks = new Set();
    const unique = [];
    for (const ev of list) {
      if (ranks.has(ev.payload.rank)) drop(ev, 'rank-duplicate');
      else { ranks.add(ev.payload.rank); unique.push(ev); }
    }
    unique.sort((a, b) => a.payload.rank - b.payload.rank || cmpEvent(a, b));
    for (const ev of unique.slice(t.maxClaimsPerMember)) drop(ev, 'claim-cap');
  }

  return { events: valid.filter((ev) => !dropped.has(ev)), rejected };
}

/**
 * Surviving claims of one round.
 * @returns {Map<string,{capacity:number, models:string[], claims:Map<string,ClaimEvent>}>} keyed by lower login.
 *   capacity/models are the roster-clamped values of the member's latest valid claim.
 */
export function foldClaims(events, team, round) {
  const roster = rosterMap(team);
  const live = new Map();
  for (const ev of [...events].sort(cmpEvent)) {
    if (ev.round !== round) continue;
    if (ev.kind !== 'claim' && ev.kind !== 'withdraw') continue;
    const key = `${ev.member}|${ev.task}`;
    if (ev.kind === 'claim') { if (!live.has(key)) live.set(key, ev); } else live.delete(key);
  }
  const out = new Map();
  for (const ev of [...live.values()].sort(cmpEvent)) {
    const r = roster.get(ev.member);
    if (!r) continue;
    let entry = out.get(ev.member);
    if (!entry) { entry = { capacity: 0, models: [], claims: new Map() }; out.set(ev.member, entry); }
    entry.claims.set(ev.task, ev);
    // events are visited in order, so the last assignment is the latest claim
    entry.capacity = Math.min(ev.payload.capacity, r.maxCapacity);
    entry.models = ev.payload.models.filter((m) => r.models.includes(m));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** Latest valid `assign` of cycles before `cycle`, and whether any start/done/failed/release followed. */
function priorAssignState(item, team, cycle) {
  const roster = rosterMap(team);
  const evs = [];
  for (const comment of item.comments ?? []) {
    const parsed = parseComment(comment, item);
    if (!parsed.ok) continue;
    const p = parsed.payload;
    if (!roster.has(lc(p.member)) || !LIFECYCLE.includes(p.kind)) continue;
    evs.push({ kind: p.kind, cycle: p.cycle, createdAt: comment.createdAt, databaseId: comment.databaseId, commentId: comment.id });
  }
  evs.sort(cmpEvent);
  let last = null;
  let lastIndex = -1;
  evs.forEach((ev, i) => { if (ev.kind === 'assign' && ev.cycle < cycle) { last = ev; lastIndex = i; } });
  if (!last) return null;
  const after = evs.slice(lastIndex + 1).some((ev) => ev.kind === 'start' || ev.kind === 'done');
  return { assign: last, started: after };
}

function eventsByTask(events) {
  const map = new Map();
  for (const ev of events) {
    if (!map.has(ev.task)) map.set(ev.task, []);
    map.get(ev.task).push(ev);
  }
  return map;
}

/**
 * Issue-level conditions shared by both rounds. Deliberately NOT a trust check: who may be believed is a
 * per-member whitelist (trust.js) applied by each member to what THEY claim and run, never an input of the
 * shared resolution (every member must compute the same table). A task nobody trusts gets no claim.
 */
function baseEligible(item, team, t, taskEvents) {
  if (item.contentType === 'PullRequest' && !t.includePullRequests) return false;
  if ((item.labels ?? []).includes(SKIP_LABEL)) return false;
  // a closed issue stays in the picture when this cycle's protocol already touched it (stable recomputation)
  const touched = taskEvents.some((ev) => ev.kind === 'start' || ev.kind === 'done');
  if (item.state !== 'OPEN' && !touched) return false;
  return true;
}

function candidatesRound1(items, team, cycle, events) {
  const t = teamDefaults(team);
  const byTask = eventsByTask(events);
  const sv = t.statusValues;
  const out = [];
  for (const item of items) {
    const evs = byTask.get(item.id) ?? [];
    if (!baseEligible(item, team, t, evs)) continue;
    const status = item.fields?.status ?? null;
    const touchedThisCycle = evs.some((ev) => LIFECYCLE.includes(ev.kind));
    let ok = false;
    if (status === sv.ready) ok = true;
    else if (status === sv.claimed) {
      if (touchedThisCycle) ok = true;
      else {
        const prior = priorAssignState(item, team, cycle);
        ok = Boolean(prior && !prior.started);
      }
    } else if ([sv.inProgress, sv.inReview, sv.blocked].includes(status)) ok = touchedThisCycle;
    if (!ok) continue;
    out.push(item);
  }
  return sortCandidates(out, team);
}

function candidatesRound2(items, team, cycle, events, previous, win) {
  const t = teamDefaults(team);
  const w2 = win[2];
  if (!w2 || !previous) return { items: [], excluded: {} };
  const cutoff = w2.claimStart.getTime();
  const byTask = eventsByTask(events);
  const byId = new Map(items.map((i) => [i.id, i]));
  const excluded = {};
  const picked = new Set();

  // A start the holder later released (infrastructure failure, limit) does not count: the task can be claimed again.
  const startedBeforeCutoff = (evs) => {
    const ordered = [...evs].sort(cmpEvent);
    return ordered.some((ev) => (ev.kind === 'done' || (ev.kind === 'start' && !startReleased(ordered, ev))) && Date.parse(ev.createdAt) < cutoff);
  };

  for (const { task } of previous.unassigned) picked.add(task);
  for (const a of previous.assignments) {
    const evs = byTask.get(a.task) ?? [];
    const released = evs.some((ev) => ev.kind === 'release' && ev.member === a.member && ev.round === a.round);
    const started = evs.some((ev) => ev.kind === 'start' && ev.member === a.member && Date.parse(ev.createdAt) < cutoff);
    if (released || !started) {
      picked.add(a.task);
      excluded[a.task] = [a.member];
    }
  }

  const out = [];
  for (const task of picked) {
    const item = byId.get(task);
    if (!item) continue;
    const evs = byTask.get(task) ?? [];
    if (startedBeforeCutoff(evs)) { delete excluded[task]; continue; }
    if (!baseEligible(item, team, t, evs)) { delete excluded[task]; continue; }
    out.push(item);
  }
  return { items: sortCandidates(out, team), excluded };
}

/**
 * Candidates of a round, in total candidate order, plus the per-task excluded members (round 2).
 * @returns {{items: BoardItem[], excluded: Record<string,string[]>}}
 */
export function candidates({ items, team, cycle, round = 1, events, previous }) {
  if (!events) events = collectEvents({ items, team, cycle, cfg: digestTeam(team) }).events;
  if (round === 1) return { items: candidatesRound1(items, team, cycle, events), excluded: {} };
  const win = roundWindows(team, cycle);
  if (!previous) {
    const history = computeHistory({ items, team, cycle });
    previous = solveRound({ items, team, cycle, events, history, win, now: null }, 1, { items: candidatesRound1(items, team, cycle, events), excluded: {} });
  }
  return candidatesRound2(items, team, cycle, events, previous, win);
}

// ---------------------------------------------------------------------------
// History (fairness)
// ---------------------------------------------------------------------------

/**
 * Points of `done` events in the previous fairness.historyDays cycle dates, per lower login.
 * Any policy digest is accepted (a policy edit must not erase history); `cfg` is kept for signature symmetry.
 * @returns {Record<string, number>}
 */
export function computeHistory({ items, team, cycle }) {
  const t = teamDefaults(team);
  const roster = rosterMap(team);
  const dates = new Set();
  for (let i = 1; i <= t.fairness.historyDays; i += 1) dates.add(addDays(cycle, -i));
  const dones = [];
  for (const item of items) {
    for (const comment of item.comments ?? []) {
      const parsed = parseComment(comment, item);
      if (!parsed.ok || parsed.payload.kind !== 'done') continue;
      const p = parsed.payload;
      if (!dates.has(p.cycle) || !roster.has(lc(p.member))) continue;
      dones.push({ member: lc(p.member), task: p.task, round: p.round, cycle: p.cycle, points: p.points, createdAt: comment.createdAt, databaseId: comment.databaseId, commentId: comment.id });
    }
  }
  dones.sort(cmpEvent);
  const seen = new Set();
  const totals = {};
  for (const d of dones) {
    const key = `${d.member}|${d.task}|${d.cycle}|${d.round}`;
    if (seen.has(key)) continue;
    seen.add(key);
    totals[d.member] = (totals[d.member] ?? 0) + d.points;
  }
  const out = {};
  for (const k of Object.keys(totals).sort(compareStrings)) out[k] = totals[k];
  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function compareFill(loadsA, histA, capA, loadsB, histB, capB, pct) {
  const na = loadsA * 100 + histA * pct;
  const nb = loadsB * 100 + histB * pct;
  const da = capA * 100;
  const db = capB * 100;
  const left = na * db;
  const right = nb * da;
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedClaimIds(claimsByMember) {
  const ids = [];
  for (const entry of claimsByMember.values()) for (const ev of entry.claims.values()) ids.push(ev.databaseId);
  return ids.sort((a, b) => a - b);
}

/** Solve one round. `ctx.now === null` means "treat as ready". */
function solveRound(ctx, round, cand) {
  const { team, cycle, events, history, win, now, rejected } = ctx;
  const t = teamDefaults(team);
  const cfg = ctx.cfg ?? digestTeam(team);
  const folded = foldClaims(events, team, round);
  const histMap = new Map(Object.entries(history ?? {}).map(([k, v]) => [lc(k), v]));
  const w = win[round];
  const ready = w ? now === null || now.getTime() >= w.resolveAt.getTime() : false;
  const inputsDigest = digest({ cycle, round, cfg, claims: sortedClaimIds(folded), history: history ?? {} });
  // claimIds: databaseIds that fed this round, for the audit `assign` comment (buildAssign `claims`).
  const result = { round, ready, assignments: [], unassigned: [], loads: {}, inputsDigest, claimIds: sortedClaimIds(folded), rejected: rejected ?? [] };
  if (!ready) return result;

  const members = [...folded.keys()].sort(compareStrings);
  const loads = new Map(members.map((m) => [m, 0]));
  const pct = t.fairness.historyWeightPct;

  for (const item of cand.items) {
    const difficulty = difficultyOf(item, team);
    const cost = costOf(difficulty, team);
    const tier = tierFor(difficulty, team);
    const excluded = cand.excluded?.[item.id] ?? [];
    const claimants = members.filter((m) => folded.get(m).claims.has(item.id) && !excluded.includes(m));
    if (claimants.length === 0) { result.unassigned.push({ task: item.id, reason: 'no-claim' }); continue; }
    const modelOk = claimants.filter((m) => folded.get(m).models.includes(tier));
    if (modelOk.length === 0) { result.unassigned.push({ task: item.id, reason: 'no-model' }); continue; }
    const feasible = modelOk.filter((m) => loads.get(m) + cost <= folded.get(m).capacity);
    if (feasible.length === 0) { result.unassigned.push({ task: item.id, reason: 'no-capacity' }); continue; }

    let best = null;
    let bestKey = null;
    for (const m of feasible) {
      const entry = folded.get(m);
      const key = {
        rank: entry.claims.get(item.id).payload.rank,
        hash: sha256Hex(`${cycle}|${round}|${item.id}|${m}`),
        m,
      };
      if (best === null) { best = m; bestKey = key; continue; }
      const be = folded.get(best);
      let c = compareFill(loads.get(m), histMap.get(m) ?? 0, entry.capacity, loads.get(best), histMap.get(best) ?? 0, be.capacity, pct);
      if (c === 0) c = key.rank - bestKey.rank;
      if (c === 0) c = compareStrings(key.hash, bestKey.hash);
      if (c === 0) c = compareStrings(key.m, bestKey.m);
      if (c < 0) { best = m; bestKey = key; }
    }
    loads.set(best, loads.get(best) + cost);
    result.assignments.push({ task: item.id, member: best, model: tier, difficulty, points: cost, rank: bestKey.rank, round });
  }
  for (const m of members) result.loads[m] = loads.get(m);
  return result;
}

/**
 * Deterministic resolution of a whole cycle (both rounds).
 * Pure: depends only on (team, cycle, items, now, history).
 * Members are reported in lower case.
 */
export function resolveCycle({ team, cycle, items, now, history }) {
  const cfg = digestTeam(team);
  const win = roundWindows(team, cycle);
  const { events, rejected } = collectEvents({ items, team, cycle, cfg });
  history ??= computeHistory({ items, team, cycle, cfg });
  const nowDate = now === undefined || now === null ? null : new Date(now);
  const ctx = { team, cycle, cfg, events, history, win, now: nowDate, rejected };

  const cand1 = { items: candidatesRound1(items, team, cycle, events), excluded: {} };
  const r1 = solveRound(ctx, 1, cand1);
  let r2 = null;
  if (win[2]) {
    const cand2 = r1.ready ? candidatesRound2(items, team, cycle, events, r1, win) : { items: [], excluded: {} };
    r2 = solveRound(ctx, 2, cand2);
    if (!r1.ready) r2.ready = false;
  }

  const byTask = eventsByTask(events);
  const final = {};
  for (const a of r1.assignments) {
    const released = (byTask.get(a.task) ?? []).some((ev) => ev.kind === 'release' && ev.member === a.member && ev.round === a.round);
    if (!released) final[a.task] = { member: a.member, model: a.model, round: 1, points: a.points };
  }
  if (r2) {
    for (const a of r2.assignments) {
      const released = (byTask.get(a.task) ?? []).some((ev) => ev.kind === 'release' && ev.member === a.member && ev.round === a.round);
      if (released) delete final[a.task];
      else final[a.task] = { member: a.member, model: a.model, round: 2, points: a.points };
    }
  }

  // Warnings: informational only, the recomputation stays authoritative.
  const warnings = [];
  for (const item of items) {
    if (item.commentsComplete === false) warnings.push({ code: 'comments-incomplete', task: item.id });
  }
  const results = { 1: r1, 2: r2 };
  for (const ev of events) {
    if (ev.kind !== 'assign') continue;
    const res = results[ev.round];
    if (!res || !res.ready) continue;
    const mine = res.assignments.find((a) => a.task === ev.task);
    if (!mine || mine.member !== ev.member) {
      warnings.push({ code: 'divergence', task: ev.task, round: ev.round, posted: ev.member, computed: mine ? mine.member : null });
      continue;
    }
    const known = new Set(sortedClaimIds(foldClaims(events, team, ev.round)));
    const missing = (ev.payload.claims ?? []).filter((id) => !known.has(id));
    if (missing.length) warnings.push({ code: 'claim-disappeared', task: ev.task, round: ev.round, ids: missing });
  }

  return { cycle, cfg, rounds: { 1: r1, 2: r2 }, final, rejected, warnings };
}

/**
 * Assignments of `login` in execution order (round, then candidate order), only those still in `final`.
 */
export function ownAssignments(resolution, login) {
  const me = lc(login);
  const out = [];
  for (const round of [1, 2]) {
    const res = resolution.rounds?.[round];
    if (!res) continue;
    for (const a of res.assignments) {
      const f = resolution.final[a.task];
      if (a.member === me && f && f.member === me && f.round === round) out.push(a);
    }
  }
  return out;
}

/**
 * True when `start` was followed (by comment order) by a `release` of the same member for the same task
 * and cycle: the holder gave the task back (infrastructure failure, usage limit, lost lock, pause).
 * A `failed` alone does not release: it is a terminal task outcome (Blocked, needs a human), and an
 * infrastructure failure always posts `failed` and `release` together.
 * @param {ClaimEvent[]} evs events of one task and cycle
 * @param {ClaimEvent} start
 */
function startReleased(evs, start) {
  return evs.some((ev) => ev.kind === 'release' && ev.member === start.member && cmpEvent(ev, start) > 0);
}

/**
 * Starts of a task in a cycle that still hold the task lock, in lock order (by (createdAt, databaseId)).
 * A start whose holder later released the task no longer holds it.
 * @returns {ClaimEvent[]}
 */
function liveStarts(events, task, cycle) {
  const evs = events.filter((ev) => ev.task === task && ev.payload.cycle === cycle).sort(cmpEvent);
  return evs.filter((ev) => ev.kind === 'start' && !startReleased(evs, ev));
}

/**
 * Lock holder of a task in a cycle: the earliest valid `start` not followed by a `release` of the same
 * member (by (createdAt, databaseId)), or null.
 */
export function earliestStart({ events, task, cycle }) {
  return liveStarts(events, task, cycle)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function base({ team, cycle, round, login, task, runId, ts, kind }) {
  const p = { v: 1, kind, cycle, round, task, member: login, cfg: digestTeam(team) };
  if (runId !== undefined) p.runId = runId;
  if (ts !== undefined) p.ts = ts;
  return p;
}

function checked(payload) {
  const bad = badField(payload);
  if (bad) throw new DispatchError('bad-payload', `invalid ${payload.kind} payload: field ${bad}`);
  return payload;
}

/**
 * Claim payloads to post: ranked in candidate order, capped, repo-allowlisted, model/cost-feasible,
 * skipping tasks I already claimed. Hard tasks are never claimed unless `hardDifficultyAllowed` is true
 * (given as an argument or on the offer).
 *
 * Trust gate 1 of 3 (docs/design.md 1.5): a task whose issue author (or last editor) is not in MY
 * `trustedAuthors` is never claimed. Secure by default: without `trustedAuthors` (or with an empty list)
 * nothing is claimed. The whitelist is member-private and is not an input of `resolveCycle`.
 * @param {{team:object, cycle:string, round:1|2, login:string, offer:{capacity:number,models:string[]}|null,
 *   candidates:BoardItem[], repoAllowlist:string[]|Record<string,unknown>, existing?:Array<ClaimEvent|object>,
 *   hardDifficultyAllowed?:boolean, trustedAuthors?:string[], runId?:string, ts?:string}} args
 */
export function buildClaims({ team, cycle, round, login, offer, candidates: cand, repoAllowlist, existing = [], hardDifficultyAllowed, trustedAuthors, runId, ts }) {
  if (!offer || !isInt(offer.capacity) || offer.capacity < 1) return [];
  cand = partitionByTrust(cand, trustedAuthors).trusted;
  const t = teamDefaults(team);
  const me = lc(login);
  const roster = rosterMap(team).get(me);
  if (!roster) return [];
  const hardOk = (hardDifficultyAllowed ?? offer.hardDifficultyAllowed) === true;
  const allow = new Set((Array.isArray(repoAllowlist) ? repoAllowlist : Object.keys(repoAllowlist ?? {})).map(lc));
  const capacity = Math.min(offer.capacity, roster.maxCapacity);
  const models = TIERS.filter((m) => offer.models.includes(m) && roster.models.includes(m));
  if (capacity < 1 || models.length === 0) return [];

  const mine = existing
    .map((e) => e.payload ?? e)
    .filter((p) => p.kind === 'claim' && lc(p.member) === me && p.cycle === cycle && (p.round ?? 1) === round);
  const withdrawn = existing
    .map((e) => e.payload ?? e)
    .filter((p) => p.kind === 'withdraw' && lc(p.member) === me && p.cycle === cycle && (p.round ?? 1) === round);
  const already = new Set(mine.map((p) => p.task));
  for (const p of withdrawn) already.delete(p.task);
  let nextRank = mine.reduce((max, p) => Math.max(max, p.rank), 0) + 1;
  let room = t.maxClaimsPerMember - already.size;

  const out = [];
  for (const item of sortCandidates(cand, team)) {
    if (room <= 0) break;
    if (already.has(item.id) || !allow.has(lc(item.repo))) continue;
    const difficulty = difficultyOf(item, team);
    if (difficulty === 'hard' && !hardOk) continue;
    if (!models.includes(tierFor(difficulty, team))) continue;
    if (costOf(difficulty, team) > capacity) continue;
    out.push(checked({ ...base({ team, cycle, round, login, task: item.id, runId, ts, kind: 'claim' }), capacity, models, rank: nextRank }));
    nextRank += 1;
    room -= 1;
  }
  return out;
}

/** Audit `assign` payload (posted by the assignee). */
export function buildAssign({ team, cycle, round, login, assignment, claims, inputs, runId, ts }) {
  const p = { ...base({ team, cycle, round, login, task: assignment.task, runId, ts, kind: 'assign' }), model: assignment.model };
  if (claims) p.claims = [...claims].sort((a, b) => a - b);
  if (inputs) p.inputs = inputs;
  return checked(p);
}

/** start | done | failed | release | withdraw payload; `extra` keys are model, points, pr, branch, reason. */
export function buildLifecycle({ kind, team, cycle, round, login, task, runId, ts, extra = {} }) {
  if (!['start', 'done', 'failed', 'release', 'withdraw'].includes(kind)) throw new DispatchError('bad-payload', `unsupported lifecycle kind: ${kind}`);
  const allowed = { start: ['model'], done: ['model', 'points', 'pr', 'branch'], failed: ['model', 'reason', 'pr', 'branch'], release: ['reason'], withdraw: [] }[kind];
  const p = base({ team, cycle, round, login, task, runId, ts, kind });
  for (const k of allowed) if (extra[k] !== undefined && extra[k] !== null) p[k] = extra[k];
  return checked(p);
}
