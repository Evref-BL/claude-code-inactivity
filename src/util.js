// Shared helpers: canonical JSON, hashing, redaction, sanitising, atomic writes, errors.
// Spec: docs/design.md section 9.4. No I/O except through the `fs` argument.
import { createHash } from 'node:crypto';
import path from 'node:path';

const ZWSP = '​';

/** Error with a stable kebab-case `code`. */
export class DispatchError extends Error {
  /**
   * @param {string} code kebab-case
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'DispatchError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** @param {unknown} error @returns {string} */
export function errorCode(error) {
  const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined;
  return typeof code === 'string' && code ? code : 'internal';
}

/**
 * JSON with keys sorted recursively, no whitespace. `undefined` object members are
 * dropped (as JSON.stringify does), `undefined` array items become null.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof (/** @type {any} */ (value).toJSON) === 'function') return canonicalize(/** @type {any} */ (value).toJSON());
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  const out = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    const v = /** @type {any} */ (value)[key];
    if (v !== undefined) out[key] = canonicalize(v);
  }
  return out;
}

/** @param {string} text @returns {string} hex */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** @param {unknown} value @returns {string} 'sha256:<hex>' of the canonical JSON */
export function digest(value) {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** Plain code-unit comparison (never localeCompare). @returns {-1|0|1} */
export function compareStrings(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Lower-case [a-z0-9-]+ slug, no leading/trailing dash, at most `max` chars.
 * @param {string} text
 * @param {number} [max]
 */
export function slug(text, max = 40) {
  const s = String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/g, '');
}

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /(authorization\s*[:=]\s*)(?:bearer|token|basic)?\s*[^\s"',;]+/gi,
];

/**
 * Mask well-known token shapes, Authorization headers and explicitly given secrets.
 * @param {unknown} text
 * @param {string[]} [secrets]
 */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) s = s.split(secret).join('[redacted]');
  }
  s = s.replace(SECRET_PATTERNS[3], '$1[redacted]');
  for (const re of SECRET_PATTERNS.slice(0, 3)) s = s.replace(re, '[redacted]');
  return s;
}

/**
 * Neutralise everything that makes GitHub fetch or link a remote resource from agent-written text:
 * markdown images (fetched through the camo proxy when the page is viewed, a data exfiltration
 * channel), markdown links, link reference definitions, raw HTML tags and bare URLs.
 * Link text is kept, the target is dropped.
 * @param {unknown} text
 * @returns {string}
 */
export function stripLinks(text) {
  let s = String(text ?? '');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '[image removed]');
  s = s.replace(/!\[[^\]]*\]\[[^\]]*\]/g, '[image removed]');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  s = s.replace(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm, '[link removed]');
  s = s.replace(/\b(?:https?|ftp):\/\/[^\s<>"')\]]+/gi, '[link removed]');
  s = s.replace(/\bwww\.[^\s<>"')\]]+/gi, '[link removed]');
  s = s.replace(/<(?=[A-Za-z!/?])/g, '&lt;');
  return s;
}

/**
 * Text safe to put in a GitHub comment: control characters stripped, @mentions
 * defanged with a zero-width space, truncated with an ellipsis.
 * @param {unknown} text
 * @param {number} [max]
 */
export function sanitizeForComment(text, max = 600) {
  let s = String(text ?? '');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, `$1@${ZWSP}`);
  s = s.trim();
  if (s.length > max) s = `${s.slice(0, Math.max(0, max - 1))}…`;
  return s;
}

/** Owner-only modes for everything the dispatcher persists (state, runs, work trees, logs). */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * mkdir -p with owner-only permissions. Directories created here get 0700; `dir` itself is
 * chmod'ed too when it already existed (best effort, parents are never touched).
 * @param {typeof import('node:fs/promises')} fs
 * @param {string} dir
 */
export async function ensurePrivateDir(fs, dir) {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await fs.chmod?.(dir, PRIVATE_DIR_MODE);
  } catch {
    // best effort (Windows, foreign owner)
  }
}

/**
 * Write JSON atomically (temp file in the same directory, then rename). Owner-only (0600).
 * @param {typeof import('node:fs/promises')} fs
 * @param {string} file
 * @param {unknown} value
 */
export async function atomicWriteJson(fs, file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  const tmp = `${file}.tmp-${globalThis.process?.pid ?? 0}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * @param {typeof import('node:fs/promises')} fs
 * @param {string} file
 * @returns {Promise<any|null>} null when the file does not exist; invalid JSON throws DispatchError('bad-json')
 */
export async function readJsonIfExists(fs, file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error && /** @type {any} */ (error).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DispatchError('bad-json', `${file} is not valid JSON: ${/** @type {Error} */ (error).message}`);
  }
}

/** Quote one argument for cmd.exe / CreateProcess. @param {string} arg */
export function quoteWin(arg) {
  const s = String(arg);
  if (s !== '' && !/[\s"&|<>^()%!]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') out += `${'\\'.repeat(backslashes * 2 + 1)}"`;
    else out += `${'\\'.repeat(backslashes)}${ch}`;
    backslashes = 0;
  }
  out += `${'\\'.repeat(backslashes * 2)}"`;
  return out;
}
