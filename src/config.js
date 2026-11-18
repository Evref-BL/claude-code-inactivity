// User config: locations, load / validate (with defaults) / save, dotted-path edit.
// Spec: docs/design.md sections 4.1, 4.2, 4.4, 9.6.
import path from 'node:path';
import { DispatchError, atomicWriteJson } from './util.js';
import { validateTeam, TIERS, DIFFICULTIES, WEEKDAYS, EFFORTS } from './policy.js';
import { normalizeLogin } from './trust.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Config home, config file and state dir (4.1). `platform` selects path flavour
 * so the Windows rules can be tested anywhere.
 * @param {Record<string,string|undefined>} env
 * @param {string} platform process.platform
 * @param {string} homedir
 * @returns {{configHome:string, configPath:string, stateDir:string}}
 */
export function resolvePaths(env, platform, homedir) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const pick = (v) => (nonEmpty(v) ? v : undefined);
  let configHome;
  let stateDir;
  if (pick(env.INACTIVITY_HOME)) {
    configHome = env.INACTIVITY_HOME;
    stateDir = pick(env.INACTIVITY_STATE) ?? p.join(configHome, 'state');
  } else if (platform === 'win32') {
    configHome = p.join(pick(env.APPDATA) ?? p.join(homedir, 'AppData', 'Roaming'), 'inactivity');
    stateDir = pick(env.INACTIVITY_STATE)
      ?? p.join(pick(env.LOCALAPPDATA) ?? p.join(homedir, 'AppData', 'Local'), 'inactivity');
  } else {
    configHome = p.join(pick(env.XDG_CONFIG_HOME) ?? p.join(homedir, '.config'), 'inactivity');
    stateDir = pick(env.INACTIVITY_STATE)
      ?? p.join(pick(env.XDG_STATE_HOME) ?? p.join(homedir, '.local', 'state'), 'inactivity');
  }
  return { configHome, configPath: p.join(configHome, 'config.json'), stateDir };
}

/** Config with every default explicit and no projects (what `init` writes). */
export function defaultConfig() {
  return {
    version: 1,
    login: null,
    // This member's own whitelist of GitHub logins whose tasks they accept (docs/design.md 1.5, src/trust.js).
    // Empty = secure by default: nothing is claimed or executed until logins are added.
    trustedAuthors: [],
    // Opt-in: tolerate a PUBLIC project board (doctor and `projects check` fail on one otherwise). A project may override it.
    allowPublicBoard: false,
    projects: [],
    availability: {
      paused: false,
      pausedUntil: null,
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      dailyPoints: 4,
      maxTasksPerDay: 2,
      maxTasksPerRun: 1,
      models: ['haiku', 'sonnet'],
      hardDifficultyAllowed: false,
      creditHeadroom: 'normal',
    },
    modelOverrides: {},
    effort: {},
    execution: {
      timeoutMinutes: { easy: 20, medium: 45, hard: 90 },
      maxTurns: { easy: 40, medium: 80, hard: 150 },
      maxBudgetUsd: { easy: 1, medium: 3, hard: 10 },
      mutationDelayMs: 1500,
    },
    permissions: { extraAllowedTools: [], extraDisallowedTools: [], denyPharoTools: [], allowPharoTools: [], allowImageEvaluate: false },
    pharo: { defaultTemplate: null, imageStartTimeoutSeconds: 600, display: 'headless', passEnv: [] },
    claude: { path: 'claude', configDir: null, allowApiKey: false, loadUserSettings: false, passEnv: [] },
    git: { branchPrefix: 'inactivity', remote: 'origin', keepWorktreeOnFailure: false },
    github: { apiUrl: 'https://api.github.com' },
    schedule: { intervalMinutes: 10 },
    dryRun: false,
  };
}

/**
 * Validate and normalize a user config (4.2). Errors carry JSON pointers.
 * `config` is always a best-effort normalized object (defaults filled in).
 * @param {unknown} input
 * @returns {{ok:boolean, errors:{path:string,message:string}[], config:object}}
 */
export function validateConfig(input) {
  /** @type {{path:string,message:string}[]} */
  const errors = [];
  const err = (p, message) => errors.push({ path: p, message });
  const out = defaultConfig();
  if (!isObj(input)) {
    err('', 'config must be a JSON object');
    return { ok: false, errors, config: out };
  }
  const src = /** @type {Record<string, any>} */ (input);

  const sub = (value, p, allowed) => {
    if (value === undefined) return {};
    if (!isObj(value)) { err(p, 'must be an object'); return {}; }
    if (allowed) for (const k of Object.keys(value)) if (!allowed.includes(k)) err(`${p}/${k}`, 'unknown property');
    return value;
  };
  const int = (value, p, min, max, def) => {
    if (value === undefined) return def;
    if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
      err(p, `must be an integer >= ${min}${max !== undefined ? ` and <= ${max}` : ''}`);
      return def;
    }
    return value;
  };
  const bool = (value, p, def) => {
    if (value === undefined) return def;
    if (typeof value !== 'boolean') { err(p, 'must be a boolean'); return def; }
    return value;
  };
  const oneOf = (value, p, allowed, def) => {
    if (value === undefined) return def;
    if (!allowed.includes(value)) { err(p, `must be one of ${allowed.join(', ')}`); return def; }
    return value;
  };
  const strOrNull = (value, p, def) => {
    if (value === undefined) return def;
    if (value !== null && typeof value !== 'string') { err(p, 'must be a string or null'); return def; }
    return value;
  };
  const str = (value, p, def) => {
    if (value === undefined) return def;
    if (!nonEmpty(value)) { err(p, 'must be a non-empty string'); return def; }
    return value;
  };
  const list = (value, p, allowed, def) => {
    if (value === undefined) return [...def];
    if (!Array.isArray(value)) { err(p, 'must be an array'); return [...def]; }
    const res = [];
    value.forEach((v, i) => {
      if (allowed ? !allowed.includes(v) : typeof v !== 'string') err(`${p}/${i}`, allowed ? `must be one of ${allowed.join(', ')}` : 'must be a string');
      else if (!res.includes(v)) res.push(v);
    });
    return res;
  };

  const TOP = ['$schema', 'version', 'login', 'trustedAuthors', 'allowPublicBoard', 'projects', 'availability', 'modelOverrides', 'effort', 'execution',
    'permissions', 'pharo', 'claude', 'git', 'github', 'schedule', 'dryRun'];
  for (const k of Object.keys(src)) if (!TOP.includes(k)) err(`/${k}`, 'unknown property');

  if (src.version !== 1) err('/version', 'must be 1');
  out.login = strOrNull(src.login, '/login', null);
  if (out.login !== null && !nonEmpty(out.login)) { err('/login', 'must not be empty (use null to discover it)'); out.login = null; }

  // Trusted authors: member-private whitelist, stored normalized (lower case, no '@'), de-duplicated.
  out.trustedAuthors = [];
  if (src.trustedAuthors !== undefined) {
    if (!Array.isArray(src.trustedAuthors)) err('/trustedAuthors', 'must be an array of GitHub logins');
    else {
      src.trustedAuthors.forEach((entry, i) => {
        const n = normalizeLogin(entry);
        if (!n.ok) err(`/trustedAuthors/${i}`, n.error);
        else if (!out.trustedAuthors.includes(n.login)) out.trustedAuthors.push(n.login);
      });
    }
  }
  out.allowPublicBoard = bool(src.allowPublicBoard, '/allowPublicBoard', false);

  // Projects
  out.projects = [];
  if (src.projects === undefined) err('/projects', 'is required');
  else if (!Array.isArray(src.projects)) err('/projects', 'must be an array');
  else {
    const ids = new Set();
    src.projects.forEach((pr, i) => {
      const p = `/projects/${i}`;
      if (!isObj(pr)) { err(p, 'must be an object'); return; }
      for (const k of Object.keys(pr)) {
        if (!['id', 'enabled', 'owner', 'ownerType', 'number', 'policy', 'team', 'repos', 'allowPublicBoard'].includes(k)) err(`${p}/${k}`, 'unknown property');
      }
      const proj = {};
      if (typeof pr.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(pr.id)) {
        err(`${p}/id`, 'must match ^[a-z0-9][a-z0-9_-]{0,31}$');
        proj.id = String(pr.id ?? '');
      } else if (ids.has(pr.id)) { err(`${p}/id`, `duplicate project id '${pr.id}'`); proj.id = pr.id; } else { ids.add(pr.id); proj.id = pr.id; }
      proj.enabled = bool(pr.enabled, `${p}/enabled`, true);
      if (pr.allowPublicBoard !== undefined) proj.allowPublicBoard = bool(pr.allowPublicBoard, `${p}/allowPublicBoard`, false);
      proj.owner = nonEmpty(pr.owner) ? pr.owner : (err(`${p}/owner`, 'is required (non-empty string)'), '');
      proj.ownerType = oneOf(pr.ownerType, `${p}/ownerType`, ['organization', 'user', null], null);
      proj.number = Number.isInteger(pr.number) && pr.number >= 1 ? pr.number : (err(`${p}/number`, 'must be an integer >= 1'), 0);

      const hasPolicy = pr.policy !== undefined;
      const hasTeam = pr.team !== undefined;
      if (hasPolicy === hasTeam) err(p, "exactly one of 'policy' or 'team' is required");
      if (hasPolicy) {
        const pol = sub(pr.policy, `${p}/policy`, ['repo', 'path']);
        const repo = typeof pol.repo === 'string' && /^[^/\s]+\/[^/\s]+$/.test(pol.repo) ? pol.repo : (err(`${p}/policy/repo`, "is required and must look like 'owner/repo'"), '');
        proj.policy = { repo, path: str(pol.path, `${p}/policy/path`, '.inactivity/team.json') };
      }
      if (hasTeam) {
        const v = validateTeam(pr.team);
        for (const e of v.errors) errors.push({ path: `${p}/team${e.path}`, message: e.message });
        proj.team = v.team ?? {};
      }
      proj.repos = {};
      if (pr.repos !== undefined) {
        if (!isObj(pr.repos)) err(`${p}/repos`, 'must be an object keyed by owner/repo');
        else {
          for (const [repo, v] of Object.entries(pr.repos)) {
            const rp = `${p}/repos/${repo}`;
            if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) err(rp, "repo key must look like 'owner/repo'");
            const r = sub(v, rp, ['cloneUrl', 'baseBranch']);
            proj.repos[repo] = {
              cloneUrl: r.cloneUrl === undefined ? `https://github.com/${repo}.git` : str(r.cloneUrl, `${rp}/cloneUrl`, `https://github.com/${repo}.git`),
              baseBranch: strOrNull(r.baseBranch, `${rp}/baseBranch`, null),
            };
          }
        }
      }
      out.projects.push(proj);
    });
  }

  // Availability
  const av = sub(src.availability, '/availability', Object.keys(out.availability));
  const a = out.availability;
  a.paused = bool(av.paused, '/availability/paused', a.paused);
  a.pausedUntil = strOrNull(av.pausedUntil, '/availability/pausedUntil', null);
  if (a.pausedUntil !== null && Number.isNaN(Date.parse(a.pausedUntil))) { err('/availability/pausedUntil', 'must be an ISO instant'); a.pausedUntil = null; }
  const days = list(av.days, '/availability/days', WEEKDAYS, a.days);
  a.days = WEEKDAYS.filter((d) => days.includes(d));
  a.dailyPoints = int(av.dailyPoints, '/availability/dailyPoints', 0, undefined, a.dailyPoints);
  a.maxTasksPerDay = int(av.maxTasksPerDay, '/availability/maxTasksPerDay', 0, undefined, a.maxTasksPerDay);
  a.maxTasksPerRun = int(av.maxTasksPerRun, '/availability/maxTasksPerRun', 1, undefined, a.maxTasksPerRun);
  const models = list(av.models, '/availability/models', TIERS, a.models);
  a.models = TIERS.filter((m) => models.includes(m));
  a.hardDifficultyAllowed = bool(av.hardDifficultyAllowed, '/availability/hardDifficultyAllowed', a.hardDifficultyAllowed);
  a.creditHeadroom = oneOf(av.creditHeadroom, '/availability/creditHeadroom', ['low', 'normal', 'high'], a.creditHeadroom);

  // Overrides
  const mo = sub(src.modelOverrides, '/modelOverrides', TIERS);
  for (const t of TIERS) if (mo[t] !== undefined) out.modelOverrides[t] = str(mo[t], `/modelOverrides/${t}`, t);
  const ef = sub(src.effort, '/effort', TIERS);
  for (const t of TIERS) if (ef[t] !== undefined) out.effort[t] = oneOf(ef[t], `/effort/${t}`, EFFORTS, 'medium');

  // Execution
  const ex = sub(src.execution, '/execution', ['timeoutMinutes', 'maxTurns', 'maxBudgetUsd', 'mutationDelayMs']);
  const perDifficulty = (value, p, def, nullable) => {
    if (value === null && nullable) return null;
    const o = sub(value, p, DIFFICULTIES);
    const res = {};
    for (const x of DIFFICULTIES) {
      const v = o[x];
      if (v === undefined) res[x] = def[x];
      else if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) { err(`${p}/${x}`, 'must be a positive number'); res[x] = def[x]; } else res[x] = v;
    }
    return res;
  };
  out.execution.timeoutMinutes = perDifficulty(ex.timeoutMinutes, '/execution/timeoutMinutes', out.execution.timeoutMinutes, false);
  out.execution.maxTurns = perDifficulty(ex.maxTurns, '/execution/maxTurns', out.execution.maxTurns, false);
  for (const x of DIFFICULTIES) {
    if (!Number.isInteger(out.execution.maxTurns[x])) { err(`/execution/maxTurns/${x}`, 'must be an integer'); out.execution.maxTurns[x] = defaultConfig().execution.maxTurns[x]; }
  }
  out.execution.maxBudgetUsd = perDifficulty(ex.maxBudgetUsd, '/execution/maxBudgetUsd', out.execution.maxBudgetUsd, true);
  out.execution.mutationDelayMs = int(ex.mutationDelayMs, '/execution/mutationDelayMs', 0, undefined, out.execution.mutationDelayMs);

  // Permissions
  const pm = sub(src.permissions, '/permissions', Object.keys(out.permissions));
  for (const k of ['extraAllowedTools', 'extraDisallowedTools', 'denyPharoTools', 'allowPharoTools']) out.permissions[k] = list(pm[k], `/permissions/${k}`, undefined, []);
  out.permissions.allowImageEvaluate = bool(pm.allowImageEvaluate, '/permissions/allowImageEvaluate', false);

  // Pharo
  const ph = sub(src.pharo, '/pharo', ['plexusCommand', 'defaultTemplate', 'imageStartTimeoutSeconds', 'display', 'passEnv']);
  if (ph.plexusCommand !== undefined) {
    if (!Array.isArray(ph.plexusCommand) || ph.plexusCommand.length === 0 || !ph.plexusCommand.every(nonEmpty)) err('/pharo/plexusCommand', 'must be a non-empty array of non-empty strings');
    else out.pharo.plexusCommand = [...ph.plexusCommand];
  }
  out.pharo.defaultTemplate = strOrNull(ph.defaultTemplate, '/pharo/defaultTemplate', null);
  out.pharo.imageStartTimeoutSeconds = int(ph.imageStartTimeoutSeconds, '/pharo/imageStartTimeoutSeconds', 1, undefined, 600);
  out.pharo.display = oneOf(ph.display, '/pharo/display', ['headless'], 'headless');
  out.pharo.passEnv = list(ph.passEnv, '/pharo/passEnv', undefined, []);

  // Claude
  const cl = sub(src.claude, '/claude', ['path', 'configDir', 'allowApiKey', 'loadUserSettings', 'passEnv']);
  out.claude.path = str(cl.path, '/claude/path', 'claude');
  out.claude.configDir = strOrNull(cl.configDir, '/claude/configDir', null);
  out.claude.allowApiKey = bool(cl.allowApiKey, '/claude/allowApiKey', false);
  out.claude.loadUserSettings = bool(cl.loadUserSettings, '/claude/loadUserSettings', false);
  out.claude.passEnv = list(cl.passEnv, '/claude/passEnv', undefined, []);

  // Git, GitHub, schedule
  const gi = sub(src.git, '/git', ['branchPrefix', 'remote', 'keepWorktreeOnFailure']);
  out.git.branchPrefix = str(gi.branchPrefix, '/git/branchPrefix', 'inactivity');
  out.git.remote = str(gi.remote, '/git/remote', 'origin');
  out.git.keepWorktreeOnFailure = bool(gi.keepWorktreeOnFailure, '/git/keepWorktreeOnFailure', false);
  const gh = sub(src.github, '/github', ['apiUrl']);
  out.github.apiUrl = str(gh.apiUrl, '/github/apiUrl', 'https://api.github.com').replace(/\/+$/, '');
  const sc = sub(src.schedule, '/schedule');
  out.schedule = { ...sc, intervalMinutes: int(sc.intervalMinutes, '/schedule/intervalMinutes', 5, 60, 10) };
  out.dryRun = bool(src.dryRun, '/dryRun', false);

  return { ok: errors.length === 0, errors, config: out };
}

/**
 * Read, parse and validate the config file. Missing file: DispatchError('no-config').
 * Unparsable JSON: DispatchError('bad-config'). Validation problems are returned
 * in `errors` (callers decide whether they are fatal).
 * @param {import('./deps.js').Deps|any} deps
 * @param {{path?:string}} [opts]
 * @returns {Promise<{config:object, errors:{path:string,message:string}[], path:string}>}
 */
export async function loadConfig(deps, { path: file } = {}) {
  const target = file ?? resolvePaths(deps.env, deps.platform, deps.homedir()).configPath;
  let text;
  try {
    text = await deps.fs.readFile(target, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new DispatchError('no-config', `config file not found: ${target} (run 'inactivity init')`);
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new DispatchError('bad-config', `${target} is not valid JSON: ${e.message}`);
  }
  const { config, errors } = validateConfig(parsed);
  return { config, errors, path: target };
}

/**
 * Validate then write atomically (creates the directory). Invalid -> DispatchError('invalid-config').
 * @param {import('./deps.js').Deps|any} deps
 * @param {object} config
 * @param {{path?:string}} [opts]
 * @returns {Promise<string>} the path written
 */
export async function saveConfig(deps, config, { path: file } = {}) {
  const target = file ?? resolvePaths(deps.env, deps.platform, deps.homedir()).configPath;
  const v = validateConfig(config);
  if (!v.ok) {
    const first = v.errors[0];
    throw new DispatchError('invalid-config', `refusing to save invalid config: ${first.path || '/'} ${first.message}`, { errors: v.errors });
  }
  const dir = path.dirname(target);
  await deps.fs.mkdir(dir, { recursive: true });
  await atomicWriteJson(deps.fs, target, v.config);
  return target;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * New config with `dottedKey` set to `value` (inputs are never mutated).
 * Numeric segments index arrays; missing intermediate objects are created.
 * The result is NOT validated: callers re-validate.
 * @param {object} config
 * @param {string} dottedKey e.g. "availability.dailyPoints" or "projects.0.enabled"
 * @param {unknown} value
 * @returns {object}
 */
export function setByPath(config, dottedKey, value) {
  const keys = String(dottedKey).split('.');
  if (keys.some((k) => k === '')) throw new DispatchError('bad-key', `invalid key '${dottedKey}'`);
  if (keys.some((k) => FORBIDDEN_KEYS.has(k))) throw new DispatchError('bad-key', `forbidden key in '${dottedKey}'`);
  const root = structuredClone(config);
  let node = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = keys[i + 1];
    if (!isObj(node[k]) && !Array.isArray(node[k])) {
      if (node[k] !== undefined && node[k] !== null) throw new DispatchError('bad-key', `'${keys.slice(0, i + 1).join('.')}' is not an object`);
      node[k] = /^\d+$/.test(next) ? [] : {};
    }
    node = node[k];
  }
  node[keys[keys.length - 1]] = structuredClone(value);
  return root;
}
