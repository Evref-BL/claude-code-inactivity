// Local persistence: global lock, tick state, run records, append-only ledger.
// Spec: docs/design.md 4.1, 4.5, 7.7, 9.14.
import path from 'node:path';
import os from 'node:os';
import { DispatchError, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, atomicWriteJson, ensurePrivateDir, readJsonIfExists } from './util.js';

const PRUNE_DAYS = 14;

/** @param {string} stateDir @param {...string} parts */
const at = (stateDir, ...parts) => path.join(stateDir, ...parts);

function pidAlive(deps, pid) {
  if (typeof deps.isPidAlive === 'function') return deps.isPidAlive(pid);
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && /** @type {any} */ (error).code === 'EPERM');
  }
}

/**
 * O_EXCL lock file. Stale when the owner pid is dead (same host) or older than `staleMs`.
 * @param {any} deps
 * @param {{stateDir:string, command?:string, staleMs?:number}} opts
 * @returns {Promise<{release:()=>Promise<void>}|null>} null when held by a live process
 */
export async function acquireLock(deps, { stateDir, command = 'unknown', staleMs = 6 * 3600 * 1000 }) {
  const file = at(stateDir, 'lock');
  await ensurePrivateDir(deps.fs, stateDir);
  const host = os.hostname();
  const content = () => `${JSON.stringify({ pid: deps.proc?.pid ?? globalThis.process.pid, hostname: host, startedAt: deps.now().toISOString(), command })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await deps.fs.open(file, 'wx', PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(content());
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          await deps.fs.rm(file, { force: true });
        },
      };
    } catch (error) {
      if (!error || /** @type {any} */ (error).code !== 'EEXIST') throw error;
    }
    let info = null;
    try {
      info = JSON.parse(await deps.fs.readFile(file, 'utf8'));
    } catch {
      info = null; // unreadable or half-written lock: treated as stale below
    }
    const age = info?.startedAt ? deps.now().getTime() - Date.parse(info.startedAt) : Infinity;
    const sameHost = !info?.hostname || info.hostname === host;
    const dead = !info || (sameHost && Number.isInteger(info.pid) && !pidAlive(deps, info.pid));
    if (!dead && age <= staleMs) return null;
    await deps.fs.rm(file, { force: true });
  }
  return null;
}

/** @returns {object} a fresh default state (4.5) */
export function emptyState() {
  return { v: 1, login: null, limit: { until: null, reason: null }, teamCache: {}, cycles: {}, leaks: [], lastTickAt: null };
}

/**
 * @param {any} deps
 * @param {string} stateDir
 * @returns {Promise<any>}
 */
export async function loadState(deps, stateDir) {
  const raw = await readJsonIfExists(deps.fs, at(stateDir, 'state.json'));
  const state = { ...emptyState(), ...(raw && typeof raw === 'object' ? raw : {}) };
  state.limit = { until: null, reason: null, ...(state.limit ?? {}) };
  state.teamCache ??= {};
  state.cycles ??= {};
  state.leaks = Array.isArray(state.leaks) ? state.leaks : [];
  return state;
}

/** Drops cycles older than 14 days, in place. @param {any} state @param {Date} now */
export function pruneState(state, now) {
  const cutoff = new Date(now.getTime() - PRUNE_DAYS * 86400000).toISOString().slice(0, 10);
  for (const key of Object.keys(state.cycles ?? {})) {
    const date = key.slice(key.lastIndexOf(':') + 1);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date < cutoff) delete state.cycles[key];
  }
}

/** Atomic write; prunes old cycles first (in place). */
export async function saveState(deps, stateDir, state) {
  pruneState(state, deps.now());
  await atomicWriteJson(deps.fs, at(stateDir, 'state.json'), state);
}

/** @param {string} projectId @param {string} cycle */
export function cycleKey(projectId, cycle) {
  return `${projectId}:${cycle}`;
}

/** `YYYYMMDDTHHMMSSZ-xxxx` (UTC). */
export function makeRunId(deps) {
  const iso = deps.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${iso}-${deps.randomHex()}`;
}

/**
 * Allocate a run id and its directory.
 * @param {any} deps
 * @param {{stateDir:string, [k:string]:any}} meta
 * @returns {Promise<{runId:string, runDir:string}>}
 */
export async function newRun(deps, meta) {
  const { stateDir } = meta;
  for (let i = 0; i < 20; i += 1) {
    const runId = makeRunId(deps);
    const runDir = at(stateDir, 'runs', runId);
    await ensurePrivateDir(deps.fs, at(stateDir, 'runs'));
    try {
      await deps.fs.mkdir(runDir, { mode: PRIVATE_DIR_MODE });
      return { runId, runDir };
    } catch (error) {
      if (!error || /** @type {any} */ (error).code !== 'EEXIST') throw error;
    }
  }
  throw new DispatchError('internal', 'could not allocate a unique run id');
}

/** Append one JSON line to `ledger.jsonl`. */
export async function appendLedger(deps, stateDir, event) {
  await deps.fs.mkdir(stateDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await deps.fs.appendFile(at(stateDir, 'ledger.jsonl'), `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
}

/** Last `limit` ledger events, oldest first. */
export async function readLedger(deps, stateDir, { limit = 50 } = {}) {
  let text;
  try {
    text = await deps.fs.readFile(at(stateDir, 'ledger.jsonl'), 'utf8');
  } catch (error) {
    if (error && /** @type {any} */ (error).code === 'ENOENT') return [];
    throw error;
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip a torn line
    }
  }
  return limit > 0 ? events.slice(-limit) : events;
}

/** Write `run.json` atomically. */
export async function writeRun(deps, runDir, record) {
  await atomicWriteJson(deps.fs, path.join(runDir, 'run.json'), record);
}

/** @returns {Promise<any|null>} */
export async function readRun(deps, runDir) {
  return readJsonIfExists(deps.fs, path.join(runDir, 'run.json'));
}
