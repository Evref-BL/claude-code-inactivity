// Pharo environment per task through PLexus (docs/design.md D1-D3, 7.2 step 5, 9.10).
// The `plexus` CLI is driven through deps.exec (JSON on stdout); the image is talked to
// with plain JSON-RPC over HTTP through deps.fetch. Nothing here saves or mutates a user image:
// every image lives in its own scope `pd_<repo>_<n>_<run>` and is deleted afterwards.
import { DispatchError } from './util.js';
import { allowlistEnv } from './claudeRun.js';

export const PLEXUS_VERSION = '0.16.0';
const IMAGE = 'task';
const MCP_PROTOCOL_VERSION = '2025-03-26';

export class PharoError extends DispatchError {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details) {
    super(code, message, details);
    this.name = 'PharoError';
  }
}

/**
 * Environment of every PLexus child (npx, the image start that spawns the Pharo VM): an allowlist.
 * The image runs arbitrary Smalltalk on request, so it must not inherit the member's cloud, registry
 * or database credentials. `pharo.passEnv` names extra variables to let through.
 */
export function plexusEnv(env, config) {
  return allowlistEnv(env, { network: true, extra: config?.pharo?.passEnv ?? [] });
}

/** Command prefix used to run PLexus. @returns {string[]} */
export function plexusCommand(config) {
  const custom = config?.pharo?.plexusCommand;
  if (Array.isArray(custom) && custom.length > 0) return [...custom];
  return ['npx', '--yes', `@evref-bl/plexus@${PLEXUS_VERSION}`];
}

/**
 * Scope names contain no dash (PLexus rule: ^[A-Za-z0-9][A-Za-z0-9._]{0,63}$).
 * @param {string} repo 'owner/name'
 * @param {number} number
 * @param {string} runId
 */
export function scopeFor(repo, number, runId) {
  const repoPart = String(repo).replace(/[^A-Za-z0-9._]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'repo';
  const suffix = String(runId).replace(/[^A-Za-z0-9]/g, '').slice(-4) || '0000';
  return `pd_${repoPart}_${Number(number)}_${suffix}`.slice(0, 64);
}

/** Parse the JSON document PLexus printed (tolerates npx noise before it). */
function parseJsonOutput(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Run `<plexusCommand> <args> --scope <scope>`; parse JSON; map failures to PharoError.
 * @param {any} deps @param {any} config @param {string} scope @param {string[]} args
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<any>} the parsed answer (`ok:true`)
 */
export async function plexus(deps, config, scope, args, opts = {}) {
  const [cmd, ...prefix] = plexusCommand(config);
  let res;
  try {
    res = await deps.exec(cmd, [...prefix, ...args, '--scope', scope], { timeoutMs: opts.timeoutMs ?? 15 * 60 * 1000, env: plexusEnv(deps.env, config) });
  } catch (error) {
    throw new PharoError('plexus-unavailable', `cannot run ${cmd}: ${/** @type {Error} */ (error).message}`);
  }
  const json = parseJsonOutput(res.stdout);
  if (json && json.ok === false) {
    throw new PharoError(String(json.code ?? 'plexus-failed'), `plexus ${args.slice(0, 2).join(' ')}: ${json.error ?? 'failed'}`);
  }
  if (res.code !== 0 || res.timedOut) {
    const tail = String(res.stderr || res.stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
    throw new PharoError(res.timedOut ? 'plexus-timeout' : 'plexus-failed', `plexus ${args.slice(0, 2).join(' ')} exited ${res.code}: ${tail}`);
  }
  return json ?? { ok: true };
}

/** @returns {Promise<{name:string, category?:string, ambiguous?:boolean}[]>} */
export async function listTemplates(deps, config) {
  const data = await plexus(deps, config, 'pd_templates', ['image', 'templates'], { timeoutMs: 5 * 60 * 1000 });
  const raw = data.templates ?? data.items ?? [];
  return raw.map((t) => (typeof t === 'string' ? { name: t } : { name: t.name, category: t.category, ambiguous: t.ambiguous }));
}

export async function createTaskImage(deps, config, { scope, template, category }) {
  const args = ['image', 'create', IMAGE, '--template', template];
  if (category) args.push('--category', category);
  return plexus(deps, config, scope, args, { timeoutMs: 30 * 60 * 1000 });
}

function endpointOf(data) {
  const candidates = [data?.endpoint, data?.image?.endpoint, ...(Array.isArray(data?.images) ? data.images.filter((i) => !i.name || i.name === IMAGE).map((i) => i.endpoint) : [])];
  for (const c of candidates) {
    const url = typeof c === 'string' ? c : c?.url;
    if (typeof url === 'string' && url) return url;
  }
  const direct = data?.endpointUrl ?? data?.url;
  return typeof direct === 'string' && direct ? direct : null;
}

/** @returns {Promise<{endpointUrl:string, pid:number|null}>} */
export async function startTaskImage(deps, config, { scope, timeoutSeconds = 600 }) {
  const started = await plexus(deps, config, scope, ['image', 'start', IMAGE, '--timeout', String(timeoutSeconds)], { timeoutMs: (timeoutSeconds + 60) * 1000 });
  let endpointUrl = endpointOf(started);
  let pid = started?.pid ?? started?.image?.pid ?? null;
  if (!endpointUrl) {
    const listed = await plexus(deps, config, scope, ['image', 'list'], { timeoutMs: 120000 });
    endpointUrl = endpointOf(listed) ?? endpointOf({ image: listed?.image });
    const entry = Array.isArray(listed?.images) ? listed.images.find((i) => !i.name || i.name === IMAGE) : listed?.image;
    pid ??= entry?.pid ?? null;
  }
  if (!endpointUrl) throw new PharoError('no-endpoint', `no MCP endpoint reported for the image in scope ${scope}`);
  return { endpointUrl, pid };
}

/** Collect text from an MCP tool result. */
function textOf(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
}

/** A JSON-RPC answer, either plain JSON or one SSE `data:` event. */
async function readRpc(res) {
  const body = await res.text();
  if (!body.trim()) return null;
  const type = res.headers?.get?.('content-type') ?? '';
  if (/event-stream/i.test(type) || /^\s*(event|data):/.test(body)) {
    const datas = body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    for (let i = datas.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(datas[i]);
      } catch {
        // next
      }
    }
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new PharoError('mcp-bad-response', `image endpoint answered with non-JSON (HTTP ${res.status})`);
  }
}

/**
 * JSON-RPC over HTTP: initialize, notifications/initialized, tools/call.
 * @returns {Promise<{isError:boolean, text:string, raw:any}>}
 */
export async function mcpCall(deps, endpointUrl, tool, args, { timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const post = async (payload) => {
    let res;
    try {
      res = await deps.fetch(endpointUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
    } catch (error) {
      const aborted = /** @type {any} */ (error)?.name === 'AbortError';
      throw new PharoError(aborted ? 'mcp-timeout' : 'mcp-unreachable', `image endpoint ${aborted ? 'timed out' : 'unreachable'}: ${/** @type {Error} */ (error).message}`);
    }
    const session = res.headers?.get?.('mcp-session-id');
    if (session) headers['mcp-session-id'] = session;
    return res;
  };
  try {
    const init = await post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'inactivity', version: '0.1.0' } },
    });
    const initBody = await readRpc(init);
    if (initBody?.error) throw new PharoError('mcp-error', `initialize failed: ${initBody.error.message ?? 'unknown'}`);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).then((r) => r.text()).catch((e) => { if (e instanceof PharoError) throw e; });
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args ?? {} } });
    const body = await readRpc(res);
    if (!body) throw new PharoError('mcp-bad-response', `empty answer to ${tool}`);
    if (body.error) return { isError: true, text: String(body.error.message ?? 'error'), raw: body };
    return { isError: Boolean(body.result?.isError), text: textOf(body.result), raw: body };
  } finally {
    clearTimeout(timer);
  }
}

const q = (s) => String(s).replace(/'/g, "''");

/**
 * Smalltalk evaluated in the image to load the project (golden-tested).
 * @param {{baseline:{name:string, sourceDirectory?:string, group?:string|null, repository?:string|null}, checkout:string}} p
 */
export function buildBaselineScript({ baseline, checkout }) {
  const dir = String(checkout).replace(/\\/g, '/');
  const abs = dir.startsWith('/') ? dir : `/${dir}`;
  const source = (baseline.sourceDirectory ?? 'src').replace(/^\/+|\/+$/g, '');
  const repository = baseline.repository ?? `tonel://${abs}/${source}`;
  const load = baseline.group ? `load: '${q(baseline.group)}'` : 'load';
  return [
    'Metacello new',
    `  baseline: '${q(baseline.name)}';`,
    `  repository: '${q(repository)}';`,
    '  onConflictUseLoaded;',
    `  ${load}.`,
  ].join('\n');
}

/** @returns {Promise<{ok:boolean, text:string, check:string}>} */
export async function loadBaseline(deps, { endpointUrl, baseline, checkout }) {
  const script = buildBaselineScript({ baseline, checkout });
  const loaded = await mcpCall(deps, endpointUrl, 'image_evaluate', { code: script }, { timeoutMs: 20 * 60 * 1000 });
  if (loaded.isError) return { ok: false, text: loaded.text, check: '' };
  const check = await mcpCall(deps, endpointUrl, 'image_evaluate', { code: `(Smalltalk globals includesKey: #BaselineOf${baseline.name}) printString` }, { timeoutMs: 120000 });
  const ok = !check.isError && /\btrue\b/.test(check.text);
  return { ok, text: ok ? loaded.text : `${loaded.text}\nbaseline class BaselineOf${baseline.name} not found after load`, check: check.text };
}

/**
 * Dispatcher-side verification. `expression`: the printed answer must start with PASS.
 * `mcp`: success iff the tool call is not an error.
 * @returns {Promise<{ran:boolean, passed:boolean|null, text:string}>}
 */
export async function runVerify(deps, { endpointUrl, verify }) {
  if (verify?.expression) {
    const r = await mcpCall(deps, endpointUrl, 'image_evaluate', { code: verify.expression }, { timeoutMs: 30 * 60 * 1000 });
    const passed = !r.isError && /^\s*['"]?PASS/.test(r.text);
    return { ran: true, passed, text: r.text };
  }
  if (verify?.mcp?.tool) {
    const r = await mcpCall(deps, endpointUrl, verify.mcp.tool, verify.mcp.arguments ?? {}, { timeoutMs: 30 * 60 * 1000 });
    return { ran: true, passed: !r.isError, text: r.text };
  }
  return { ran: false, passed: null, text: '' };
}

/**
 * MCP server declaration handed to the headless agent. Its environment is explicit: PATH, HOME,
 * locale and the PLEXUS_ and PHARO_ prefixes only, no credential and no proxy URL (this file is written to disk).
 * @param {any} config @param {string} scope @param {Record<string,string|undefined>} [env] the dispatcher's environment
 */
export function claudeMcpConfig(config, scope, env = {}) {
  const [command, ...rest] = plexusCommand(config);
  return { mcpServers: { pharo: { command, args: [...rest, 'mcp', '--scope', scope], env: allowlistEnv(env, { extra: config?.pharo?.passEnv ?? [] }) } } };
}

/**
 * Stop and delete the task image, then confirm through `image list` that nothing is left.
 * Never throws.
 * @returns {Promise<{stopped:boolean, deleted:boolean, leftovers:string[]}>}
 */
export async function disposeTaskImage(deps, config, scope) {
  let stopped = false;
  let deleted = false;
  try {
    await plexus(deps, config, scope, ['image', 'stop', IMAGE], { timeoutMs: 120000 });
    stopped = true;
  } catch (error) {
    deps.log?.debug?.(`pharo: stop ignored: ${/** @type {Error} */ (error).message}`);
  }
  try {
    await plexus(deps, config, scope, ['image', 'delete', IMAGE], { timeoutMs: 300000 });
    deleted = true;
  } catch (error) {
    deps.log?.warn?.(`pharo: delete failed: ${/** @type {Error} */ (error).message}`);
  }
  let leftovers = [];
  try {
    const listed = await plexus(deps, config, scope, ['image', 'list'], { timeoutMs: 120000 });
    const images = Array.isArray(listed?.images) ? listed.images : listed?.image ? [listed.image] : [];
    leftovers = images.map((i) => i.name ?? IMAGE);
  } catch (error) {
    leftovers = [`unverified: ${/** @type {Error} */ (error).message}`];
  }
  return { stopped, deleted, leftovers };
}

/**
 * Create, start, stop and delete a scratch image per template so the first real run is fast.
 * @returns {Promise<{template:string, ok:boolean, error?:string}[]>}
 */
export async function warmup(deps, config, templates) {
  const results = [];
  for (const template of templates) {
    const scope = 'pd_warmup';
    try {
      await createTaskImage(deps, config, { scope, template, category: null });
      await startTaskImage(deps, config, { scope, timeoutSeconds: config?.pharo?.imageStartTimeoutSeconds ?? 600 });
      results.push({ template, ok: true });
    } catch (error) {
      results.push({ template, ok: false, error: /** @type {Error} */ (error).message });
    } finally {
      await disposeTaskImage(deps, config, scope);
    }
  }
  return results;
}

/** Doctor probe: can PLexus answer `image templates`? @returns {Promise<{ok:boolean, templates:any[], detail?:string}>} */
export async function probe(deps, config) {
  try {
    const data = await plexus(deps, config, 'pd_doctor', ['image', 'templates'], { timeoutMs: 5 * 60 * 1000 });
    const raw = data.templates ?? data.items ?? [];
    return { ok: true, templates: raw.map((t) => (typeof t === 'string' ? { name: t } : t)) };
  } catch (error) {
    return { ok: false, templates: [], detail: /** @type {Error} */ (error).message };
  }
}
