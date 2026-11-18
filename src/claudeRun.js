// Headless `claude -p` for one task: argv, child env, stream-json parsing, outcome
// classification (usage limit, overloaded, auth, ...). docs/design.md 7.2 step 7, 7.5, 9.11.
// Field names of the stream beyond those documented are optional everywhere (tolerant parser).

import { PRIVATE_FILE_MODE, redact } from './util.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Pharo MCP tools the agent may call: inspection, editing of classes and methods, test runs and
 * Tonel export. An explicit list, never the whole `mcp__pharo` server: PLexus also forwards
 * `image_evaluate` (arbitrary Smalltalk, hence arbitrary code on the host) and the image lifecycle
 * tools. Refresh it from the image's `tools/list`; more names can be added per machine with
 * `permissions.allowPharoTools`.
 */
export const PHARO_AGENT_TOOLS = [
  'tool_search', 'tool_get',
  'class_get', 'class_search', 'class_create', 'class_update',
  'method_get', 'method_search', 'method_compile', 'method_update', 'method_remove', 'method_rewrite',
  'package_search',
  'repository_search', 'repository_change_list', 'repository_identity_verify', 'repository_export', 'repository_reload',
  'test_run',
  'history_entry_list', 'history_entry_revert',
];

/** Tools that run Smalltalk, a shell or manage images: denied unless a config opt-in lifts it. */
export const PHARO_DENIED_TOOLS = [
  'image_evaluate',
  'image_templates', 'image_create', 'image_start', 'image_stop', 'image_delete', 'image_list',
];

const pharoTool = (name) => `mcp__pharo__${name}`;

/**
 * File tools are scoped to the worktree (the working directory of the run). No Bash at all:
 * git is the dispatcher's job and `git grep -O` / `git diff --output` run commands and write files.
 */
export const BASE_ALLOWED_TOOLS = [
  'Read(./**)', 'Glob(./**)', 'Grep(./**)', 'Edit(./**)', 'Write(./**)',
  ...PHARO_AGENT_TOOLS.map(pharoTool),
];

/** Secrets and system files the agent has no business reading, wherever it is asked to look. */
export const SENSITIVE_READ_DENIES = [
  'Read(//etc/**)',
  'Read(~/.ssh/**)', 'Read(~/.gnupg/**)', 'Read(~/.aws/**)', 'Read(~/.azure/**)', 'Read(~/.kube/**)', 'Read(~/.docker/**)',
  'Read(~/.config/gh/**)', 'Read(~/.config/gcloud/**)', 'Read(~/.claude/**)', 'Read(~/.codex/**)',
  'Read(~/.netrc)', 'Read(~/.npmrc)', 'Read(~/.pypirc)', 'Read(~/.git-credentials)', 'Read(~/.gitconfig)',
  'Read(**/.ssh/**)', 'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/.git-credentials)', 'Read(**/.netrc)',
  'Read(**/id_rsa)', 'Read(**/id_ed25519)', 'Read(**/*.pem)', 'Read(**/*.key)',
];

export const BASE_DISALLOWED_TOOLS = [
  'WebFetch', 'WebSearch',
  ...PHARO_DENIED_TOOLS.map(pharoTool),
  ...SENSITIVE_READ_DENIES,
  'Edit(.github/**)', 'Write(.github/**)', 'Edit(.inactivity.json)', 'Write(.inactivity.json)',
  'Edit(**/.git/**)', 'Write(**/.git/**)', 'Edit(.git)', 'Write(.git)',
];

/** Settings handed to the run with --settings: nothing from the machine, no hooks. */
export const AGENT_SETTINGS = { disableAllHooks: true, includeCoAuthoredBy: false };

/** `Read(//abs/dir/**)` for an absolute directory (a second Claude config dir, say). */
function absoluteReadDeny(dir) {
  const d = String(dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!d.startsWith('/')) return null;
  return `Read(/${d}/**)`;
}

/**
 * argv of the headless run. The prompt is NOT in argv (it goes to stdin). Never `--bare`,
 * never `--dangerously-skip-permissions`; all lists are comma-joined into one element.
 * Machine settings are NOT loaded (`--setting-sources ''` plus an explicit `--settings`): a broad
 * user-level allow rule or hook must not widen the dispatcher's allowlist. `loadUserSettings`
 * brings user settings back (the dispatcher's deny list still applies on top).
 * @param {{model:string, effort?:string|null, mcpConfigPath:string, systemPromptFile:string, maxTurns:number, maxBudgetUsd?:number|null,
 *   extraAllowedTools?:string[], extraDisallowedTools?:string[], denyPharoTools?:string[], allowPharoTools?:string[],
 *   allowImageEvaluate?:boolean, loadUserSettings?:boolean, claudeConfigDir?:string|null}} o
 * @returns {string[]}
 */
export function buildClaudeArgs(o) {
  const extraAllowed = o.extraAllowedTools ?? [];
  const pharoAllowed = (o.allowPharoTools ?? []).filter((t) => typeof t === 'string' && /^[A-Za-z0-9_]+$/.test(t)).map(pharoTool);
  const evaluateOptIn = o.allowImageEvaluate === true;
  const allowed = [...BASE_ALLOWED_TOOLS, ...(evaluateOptIn ? [pharoTool('image_evaluate')] : []), ...pharoAllowed, ...extraAllowed];
  const configDirDeny = absoluteReadDeny(o.claudeConfigDir);
  const disallowed = [
    ...BASE_DISALLOWED_TOOLS.filter((t) => !(evaluateOptIn && t === pharoTool('image_evaluate'))),
    // deny wins over any allow rule, including one from user settings; skipped when the config opted into Bash
    ...(extraAllowed.some((t) => /^Bash\b/.test(t)) ? [] : ['Bash']),
    ...(configDirDeny ? [configDirDeny] : []),
    ...(o.denyPharoTools ?? []).map(pharoTool),
    ...(o.extraDisallowedTools ?? []),
  ];
  const args = ['-p', '--model', o.model];
  if (o.effort) args.push('--effort', o.effort);
  args.push(
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--allowedTools', allowed.join(','),
    '--disallowedTools', disallowed.join(','),
    '--mcp-config', o.mcpConfigPath, '--strict-mcp-config',
  );
  if (o.loadUserSettings) args.push('--setting-sources', 'user');
  else args.push('--setting-sources', '', '--settings', JSON.stringify(AGENT_SETTINGS));
  args.push(
    '--append-system-prompt-file', o.systemPromptFile,
    '--max-turns', String(o.maxTurns),
  );
  if (typeof o.maxBudgetUsd === 'number') args.push('--max-budget-usd', String(o.maxBudgetUsd));
  args.push('--no-session-persistence');
  return args;
}

/**
 * Variables a child process may inherit: what a program needs to start and find its files, locale,
 * temp dir, proxies and certificate bundles. Everything else (AWS_*, NPM_TOKEN, OPENAI_*,
 * SSH_AUTH_SOCK, DATABASE_URL, ...) stays behind. Names are matched case-insensitively on win32 only.
 */
const ENV_BASE = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'COMPUTERNAME', 'OS',
  'DISPLAY', 'WAYLAND_DISPLAY',
]);
const ENV_BASE_PREFIX = ['LC_', 'PLEXUS_', 'PHARO_'];
const ENV_NETWORK = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE',
  'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_CAFILE',
]);
const ENV_AUTH = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']);

/**
 * Allowlisted copy of an environment for a child process (the agent, PLexus, the Pharo image).
 * @param {Record<string,string|undefined>} env
 * @param {{network?:boolean, auth?:boolean, apiKey?:boolean, extra?:string[]}} [opts]
 *   `network`: proxy and certificate variables; `auth`: the Claude subscription token and config dir;
 *   `apiKey`: ANTHROPIC_API_KEY; `extra`: further names from `claude.passEnv`.
 * @returns {Record<string,string>}
 */
export function allowlistEnv(env, { network = false, auth = false, apiKey = false, extra = [] } = {}) {
  const extras = new Set((extra ?? []).map((n) => String(n).toUpperCase()));
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined) continue;
    const up = k.toUpperCase();
    const ok = ENV_BASE.has(up)
      || ENV_BASE_PREFIX.some((p) => up.startsWith(p))
      || (network && ENV_NETWORK.has(up))
      || (auth && ENV_AUTH.has(up))
      || (apiKey && up === 'ANTHROPIC_API_KEY')
      || extras.has(up);
    if (ok) out[k] = v;
  }
  return out;
}

/**
 * Child environment of the agent: an allowlist (PATH, HOME, locale, temp dir, proxies, Claude auth),
 * no API key (it would switch billing off the subscription) unless allowed, no GitHub token even
 * when listed in `claude.passEnv`, background tasks off.
 * @param {Record<string,string|undefined>} env
 * @param {{claude?:{allowApiKey?:boolean, configDir?:string|null, passEnv?:string[]}}} config
 */
export function buildClaudeEnv(env, config) {
  const passEnv = (config?.claude?.passEnv ?? []).filter((n) => !/^(GH_TOKEN|GITHUB_TOKEN|GITHUB_PAT)/i.test(String(n)));
  const out = allowlistEnv(env, { network: true, auth: true, apiKey: config?.claude?.allowApiKey === true, extra: passEnv });
  out.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  out.CLAUDE_CODE_MAX_RETRIES = '3';
  if (config?.claude?.configDir) out.CLAUDE_CONFIG_DIR = config.claude.configDir;
  return out;
}

/**
 * Parse stream-json (one event per line); junk lines are ignored.
 * @param {string} text
 * @returns {{init:any|null, result:any|null, assistantErrors:{error:string, text:string}[], rateLimitEvents:any[], texts:string[]}}
 */
export function parseStream(text) {
  const out = { init: null, result: null, assistantErrors: [], rateLimitEvents: [], texts: [] };
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'system' && ev.subtype === 'init') out.init ??= ev;
    else if (ev.type === 'result') out.result = ev;
    else if (ev.type === 'rate_limit_event') out.rateLimitEvents.push(ev);
    else if (ev.type === 'assistant') {
      const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
      const body = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
      if (body) out.texts.push(body);
      const error = ev.error ?? ev.message?.error;
      if (typeof error === 'string' && error) out.assistantErrors.push({ error, text: body });
    }
  }
  if (typeof out.result?.result === 'string' && out.result.result) out.texts.push(out.result.result);
  return out;
}

/**
 * Best effort: "resets 3pm", "resets 10:30am", "resets Mon" -> next such instant (machine local time).
 * @param {string} text @param {Date} now @param {string} [_tz]
 * @returns {string|null} ISO instant
 */
export function parseResetTime(text, now, _tz) {
  const s = String(text ?? '');
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s?([ap])\.?m/i.exec(s);
  if (clock) {
    let h = Number(clock[1]) % 12;
    if (clock[3].toLowerCase() === 'p') h += 12;
    const when = new Date(now);
    when.setHours(h, clock[2] ? Number(clock[2]) : 0, 0, 0);
    if (when.getTime() <= now.getTime()) when.setDate(when.getDate() + 1);
    return when.toISOString();
  }
  const day = /resets?\s+(?:on\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*/i.exec(s);
  if (day) {
    const target = DAYS.indexOf(day[1].toLowerCase());
    const when = new Date(now);
    when.setHours(0, 0, 0, 0);
    let delta = (target - when.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    when.setDate(when.getDate() + delta);
    return when.toISOString();
  }
  return null;
}

const LIMIT_TEXT = [/You've hit your (?:session|weekly|Opus|Sonnet|monthly spend)? ?limit/i, /usage limit/i, /Credit balance is too low/i, /Request rejected \(429\)/i];
const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold']);
const OVERLOADED_ERRORS = new Set(['overloaded', 'server_error']);

/**
 * Decide what happened (7.5). `limit` wins over everything but a clean success.
 * @param {{parsed:ReturnType<typeof parseStream>, exec:{code?:number|null, timedOut?:boolean}, now?:Date}} p
 * @returns {{kind:'success'|'limit'|'overloaded'|'auth'|'max_turns'|'budget'|'timeout'|'error', resetsAt?:string, detail:string}}
 */
export function classifyOutcome({ parsed, exec, now }) {
  const result = parsed?.result ?? null;
  const texts = (parsed?.texts ?? []).join('\n');
  const clock = now ?? new Date();
  const subtype = String(result?.subtype ?? '');
  const apiStatus = result?.api_error_status;
  const aErrors = (parsed?.assistantErrors ?? []).map((e) => e.error);
  // A long, successful final answer may merely talk about limits: only structural signals count then.
  const longSuccess = Boolean(result && !result.is_error && String(result.result ?? '').length > 300);

  const limited = apiStatus === 429
    || aErrors.some((e) => e === 'rate_limit' || e === 'billing_error')
    || (parsed?.rateLimitEvents ?? []).some((e) => String(e.status ?? e.rate_limit_info?.status ?? '') === 'rejected')
    || (!longSuccess && LIMIT_TEXT.some((re) => re.test(texts)));
  if (limited) {
    const ev = (parsed?.rateLimitEvents ?? []).find((e) => (e.rate_limit_info ?? e).resetsAt);
    const epoch = Number((ev?.rate_limit_info ?? ev)?.resetsAt);
    const fromEvent = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch > 1e12 ? epoch : epoch * 1000).toISOString() : null;
    const resetsAt = fromEvent ?? parseResetTime(texts, clock);
    return { kind: 'limit', ...(resetsAt ? { resetsAt } : {}), detail: 'usage limit reached' };
  }
  if (aErrors.some((e) => AUTH_ERRORS.has(e)) || AUTH_ERRORS.has(subtype)) return { kind: 'auth', detail: 'authentication problem' };
  if (apiStatus === 529 || aErrors.some((e) => OVERLOADED_ERRORS.has(e)) || /\bOverloaded\b/.test(texts)) return { kind: 'overloaded', detail: 'API overloaded' };
  if (exec?.timedOut) return { kind: 'timeout', detail: 'wall-clock timeout' };
  if (subtype === 'error_max_turns') return { kind: 'max_turns', detail: 'max turns reached' };
  if (subtype === 'error_max_budget_usd') return { kind: 'budget', detail: 'max budget reached' };
  if (result && !result.is_error && (subtype === 'success' || subtype === '')) return { kind: 'success', detail: 'ok' };
  if (result) return { kind: 'error', detail: `agent error (${subtype || 'unknown'})` };
  return { kind: 'error', detail: `no result event (exit ${exec?.code ?? 'signal'})` };
}

/**
 * Last ```json inactivity-result fenced block, parsed. Null when absent or invalid.
 * @param {string} text
 */
export function extractResultBlock(text) {
  const re = /```json[ \t]+inactivity-result[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  let last = null;
  for (let m = re.exec(String(text ?? '')); m; m = re.exec(String(text ?? ''))) last = m[1];
  if (last === null) return null;
  try {
    const value = JSON.parse(last);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The agent must see the Pharo MCP server, connected, with tools.
 * @param {{init:any|null}} parsed
 * @returns {{ok:boolean, problems:string[]}}
 */
export function verifyInit(parsed) {
  const init = parsed?.init;
  if (!init) return { ok: false, problems: ['no init event in the stream'] };
  const problems = [];
  if (Array.isArray(init.plugin_errors) && init.plugin_errors.length) problems.push(`plugin errors: ${init.plugin_errors.length}`);
  const server = (init.mcp_servers ?? []).find((s) => s?.name === 'pharo');
  if (!server) problems.push('pharo MCP server not declared');
  else if (server.status !== 'connected') problems.push(`pharo MCP server status: ${server.status}`);
  if (!(init.tools ?? []).some((t) => String(t).startsWith('mcp__pharo__'))) problems.push('no mcp__pharo__* tool listed');
  return { ok: problems.length === 0, problems };
}

/**
 * Spawn claude, prompt on stdin, stream tee'd to `teePath`.
 * @returns {Promise<{exec:any, parsed:ReturnType<typeof parseStream>, outcome:ReturnType<typeof classifyOutcome>}>}
 */
export async function runClaude(deps, { cwd, prompt, args, env, timeoutMs, claudePath = 'claude', teePath }) {
  const exec = await deps.exec(claudePath, args, {
    cwd, env, stdin: prompt, timeoutMs, killGraceMs: 15000, ...(teePath ? { tee: { stdout: teePath } } : {}),
  });
  if (teePath) {
    // The raw stream holds every tool result the agent saw: token shapes are masked once the run is over,
    // and the file is owner-only (0600) from the first byte (see deps.realExec).
    try {
      const raw = exec.teed ? await deps.fs.readFile(teePath, 'utf8') : String(exec.stdout ?? '');
      await deps.fs.writeFile(teePath, redact(raw), { mode: PRIVATE_FILE_MODE });
    } catch {
      // best effort
    }
  }
  const parsed = parseStream(exec.stdout);
  const outcome = classifyOutcome({ parsed, exec, now: deps.now() });
  return { exec, parsed, outcome };
}
