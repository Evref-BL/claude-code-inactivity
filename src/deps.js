// The real `Deps` (docs/design.md 9.1): the only module that touches process globals,
// spawn and the network. Everything else receives these through arguments; tests pass fakes.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { PRIVATE_FILE_MODE, quoteWin, redact } from './util.js';

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const KILL_AFTER_TERM_MS = 5000;

/** Keeps the last `max` bytes (approximated in chars) of a stream. */
function tailBuffer(max) {
  let text = '';
  return {
    push(chunk) {
      text += chunk;
      if (text.length > max) text = text.slice(text.length - max);
    },
    get value() {
      return text;
    },
  };
}

/**
 * Spawn without a shell (win32 .cmd/.bat shims get one, with quoting).
 * Never rejects on a non-zero exit; rejects only when the process cannot be spawned.
 * @type {import('./types.js').Deps['exec']}
 */
export function realExec(cmd, args, opts = {}) {
  const startedAt = Date.now();
  const isWin = globalThis.process.platform === 'win32';
  const needsShell = isWin && /\.(cmd|bat)$/i.test(cmd);
  const finalCmd = needsShell ? [quoteWin(cmd), ...args.map(quoteWin)].join(' ') : cmd;
  const finalArgs = needsShell ? [] : args;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(finalCmd, finalArgs, {
        cwd: opts.cwd,
        env: opts.env ?? globalThis.process.env,
        shell: needsShell,
        stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    const max = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const out = tailBuffer(max);
    const err = tailBuffer(max);
    const tees = [];
    let teed = false;
    for (const [stream, file] of Object.entries(opts.tee ?? {})) {
      if (!file) continue;
      const ws = createWriteStream(file, { flags: 'w', mode: PRIVATE_FILE_MODE });
      ws.on('error', () => {});
      tees.push({ stream, ws });
      teed = true;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out.push(c);
      for (const t of tees) if (t.stream === 'stdout') t.ws.write(c);
    });
    child.stderr.on('data', (c) => {
      err.push(c);
      for (const t of tees) if (t.stream === 'stderr') t.ws.write(c);
    });
    if (opts.stdin !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(opts.stdin);
    }
    let timedOut = false;
    const timers = [];
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timers.push(setTimeout(() => {
        timedOut = true;
        child.kill('SIGINT');
        timers.push(setTimeout(() => {
          child.kill('SIGTERM');
          timers.push(setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_TERM_MS));
        }, opts.killGraceMs ?? 15000));
      }, opts.timeoutMs));
    }
    child.on('error', (error) => {
      for (const t of timers) clearTimeout(t);
      for (const t of tees) t.ws.end();
      reject(error);
    });
    child.on('close', (code, signal) => {
      for (const t of timers) clearTimeout(t);
      Promise.all(tees.map((t) => new Promise((done) => t.ws.end(done)))).then(() => {
        resolve({ code, signal, stdout: out.value, stderr: err.value, timedOut, durationMs: Date.now() - startedAt, teed });
      });
    });
  });
}

/** Logger writing to stderr, passing every line through `redact`. */
export function createLogger(write, level = 'info') {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = order[level] ?? 1;
  const emit = (name) => (...parts) => {
    if (order[name] < min) return;
    write(`${redact(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '))}\n`);
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/**
 * @param {Partial<import('./types.js').Deps> & Record<string, any>} [overrides]
 * @returns {import('./types.js').Deps}
 */
export function createDeps(overrides = {}) {
  const proc = globalThis.process;
  const base = {
    exec: realExec,
    now: () => new Date(),
    fs: fsp,
    env: proc.env,
    fetch: globalThis.fetch,
    log: createLogger((s) => proc.stderr.write(s), proc.env.INACTIVITY_LOG_LEVEL ?? 'info'),
    platform: proc.platform,
    homedir: () => os.homedir(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomHex: () => randomBytes(2).toString('hex'),
    proc: { execPath: proc.execPath, pid: proc.pid, uid: typeof proc.getuid === 'function' ? proc.getuid() : null },
  };
  return { ...base, ...overrides };
}
