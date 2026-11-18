// Manual, content-bound per-ticket approval (docs/design.md section 1.5 and 4.6).
//
// The whitelist (trust.js) says WHO may write tasks this member accepts. Approval says that this member READ this
// exact ticket and accepts it: a ticket never runs on someone's Claude account without that member's explicit,
// local validation, and an approved ticket that is edited afterwards loses its approval (the approval is bound to
// a hash of the content that reaches the agent: author, title and body).
//
// Everything here is local to the member's machine: the store `approvals.json` lives in the state dir (0600),
// nothing is posted on the board, and claim resolution never sees it (like the whitelist, it is a per-member
// filter on what is claimed and executed). Mode `none` (explicit opt-in) disables the filter.
import path from 'node:path';
import { atomicWriteJson, digest, DispatchError } from './util.js';
import { actorKey } from './trust.js';

export const APPROVAL_MODES = ['local', 'none'];
export const APPROVAL_FILE = 'approvals.json';
/** Appended to every "nothing happens" explanation. */
export const APPROVAL_HINT = 'Read the pending tasks with `inactivity review`, then approve the ones you accept with `inactivity approve <repo#number> --hash <hash>`.';
const SHORT_HASH_LENGTH = 12;

/** Effective mode: anything but an explicit `none` is `local` (secure by default). @param {any} config @returns {'local'|'none'} */
export function approvalMode(config) {
  return config?.approval === 'none' ? 'none' : 'local';
}

/** Line endings unified, outer whitespace dropped. Nothing else is touched: every other character is content. @param {unknown} text */
export function normalizeContent(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim();
}

/**
 * Hash of what reaches the agent about a ticket: the author (as the whitelist compares it) and the normalized
 * title and body. Editing either text, or a different author, changes it. Labels, fields, comments and the
 * difficulty are not part of it (they do not enter the prompt).
 * @param {{authorLogin?:string|null, authorType?:string|null, title?:string, body?:string}} item
 * @returns {string} 'sha256:<hex>'
 */
export function contentHash(item) {
  return digest({
    v: 1,
    author: actorKey(item?.authorLogin, item?.authorType) ?? null,
    title: normalizeContent(item?.title),
    body: normalizeContent(item?.body),
  });
}

/** @param {string} hash 'sha256:<hex>' @returns {string} the first 12 hex digits */
export function shortHash(hash) {
  return String(hash ?? '').replace(/^sha256:/, '').slice(0, SHORT_HASH_LENGTH);
}

/** Does a (possibly short, possibly `sha256:`-prefixed) hash typed by a person designate `hash`? At least 6 digits. @param {string} hash @param {string} typed */
export function hashMatches(hash, typed) {
  const want = String(typed ?? '').trim().toLowerCase().replace(/^sha256:/, '');
  const have = String(hash ?? '').toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{6,64}$/.test(want) && have.startsWith(want);
}

/** Store key of a task: `owner/repo#number`, lower case (GitHub repository names are case-insensitive). @param {string} id */
export const refKey = (id) => String(id ?? '').trim().toLowerCase();

/**
 * `owner/repo#12` or an issue/PR URL -> `{id, repo, number}` or null.
 * @param {string} text
 */
export function parseRef(text) {
  const t = String(text ?? '').trim();
  let m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(t);
  if (!m) m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/i.exec(t);
  if (!m) return null;
  const number = Number(m[2]);
  return { id: `${m[1]}#${number}`, repo: m[1], number };
}

// ---------------------------------------------------------------------------
// Store

export const emptyStore = () => ({ v: 1, approvals: {} });

/** Keeps only well-formed entries. @param {unknown} raw */
function sanitizeStore(raw) {
  const store = emptyStore();
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw).approvals : null;
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [key, e] of Object.entries(src)) {
      if (!e || typeof e !== 'object' || typeof e.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(e.hash)) continue;
      store.approvals[refKey(key)] = {
        hash: e.hash,
        approvedAt: typeof e.approvedAt === 'string' ? e.approvedAt : null,
        title: typeof e.title === 'string' ? e.title : '',
        author: typeof e.author === 'string' ? e.author : null,
        approvedBy: 'local',
      };
    }
  }
  return store;
}

/**
 * Read the member's approvals. A missing file is an empty store. A corrupt or unreadable file also yields an EMPTY store
 * (nothing is approved: the safe side) flagged `corrupt: true`; it is never fatal and never trusted.
 * @param {any} deps @param {string} stateDir
 * @returns {Promise<{v:1, approvals:Record<string,{hash:string, approvedAt:string|null, title:string, author:string|null, approvedBy:'local'}>, corrupt?:boolean}>}
 */
export async function loadApprovals(deps, stateDir) {
  const file = path.join(stateDir, APPROVAL_FILE);
  let text;
  try {
    text = await deps.fs.readFile(file, 'utf8');
  } catch (error) {
    if (error && /** @type {any} */ (error).code === 'ENOENT') return emptyStore();
    return { ...emptyStore(), corrupt: true };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v !== 1) return { ...emptyStore(), corrupt: true };
    return sanitizeStore(parsed);
  } catch {
    return { ...emptyStore(), corrupt: true };
  }
}

/** Atomic, owner-only write. A `corrupt` marker is never persisted. @param {any} deps @param {string} stateDir @param {{v:1, approvals:object}} store */
export async function saveApprovals(deps, stateDir, store) {
  await atomicWriteJson(deps.fs, path.join(stateDir, APPROVAL_FILE), { v: 1, approvals: sanitizeStore(store).approvals });
}

/**
 * New store with `item` approved at its CURRENT content (inputs are not mutated).
 * @param {{v:1, approvals:Record<string,any>}} store
 * @param {{id:string, title?:string, authorLogin?:string|null, authorType?:string|null, body?:string}} item
 * @param {Date|string} at
 */
export function withApproval(store, item, at) {
  const next = sanitizeStore(store);
  next.approvals[refKey(item.id)] = {
    hash: contentHash(item),
    approvedAt: at instanceof Date ? at.toISOString() : String(at),
    title: String(item.title ?? '').replace(/\s+/g, ' ').slice(0, 200),
    author: item.authorLogin ?? null,
    approvedBy: 'local',
  };
  return next;
}

/** @param {{v:1, approvals:Record<string,any>}} store @param {string} id */
export function withoutApproval(store, id) {
  const next = sanitizeStore(store);
  delete next.approvals[refKey(id)];
  return next;
}

// ---------------------------------------------------------------------------
// Verdicts

/**
 * Approval verdict on an item for ONE member. `approval` is `{mode, store}`; an absent argument means mode `local`
 * with an empty store (secure by default: nothing is approved).
 * @param {{id:string, title?:string, body?:string, authorLogin?:string|null, authorType?:string|null}} item
 * @param {{mode?:'local'|'none', store?:{approvals?:Record<string,any>}}|undefined|null} approval
 * @returns {{approved:true, mode:'none'|'local', hash?:string}|{approved:false, reason:'pending-approval'|'changed-since-approval', hash:string, approvedHash?:string, detail:string}}
 */
export function checkItemApproval(item, approval) {
  if (approval?.mode === 'none') return { approved: true, mode: 'none' };
  const hash = contentHash(item);
  const entry = approval?.store?.approvals?.[refKey(item?.id)];
  if (!entry) return { approved: false, reason: 'pending-approval', hash, detail: `you have not approved this task yet. ${APPROVAL_HINT}` };
  if (entry.hash !== hash) {
    return { approved: false, reason: 'changed-since-approval', hash, approvedHash: entry.hash, detail: `this task was edited after you approved it (author, title or body changed). Read it again: \`inactivity review\`.` };
  }
  return { approved: true, mode: 'local', hash };
}

/** @param {object} item @param {any} approval @returns {boolean} */
export function isApprovedItem(item, approval) {
  return checkItemApproval(/** @type {any} */ (item), approval).approved;
}

/**
 * Split items into approved ones and those still waiting for this member.
 * @template {{id:string}} T
 * @param {T[]} items
 * @param {any} approval `{mode, store}`
 * @returns {{approved:T[], pending:{item:T, task:string, reason:'pending-approval'|'changed-since-approval', hash:string}[]}}
 */
export function partitionByApproval(items, approval) {
  const approved = [];
  const pending = [];
  for (const item of items) {
    const v = checkItemApproval(/** @type {any} */ (item), approval);
    if (v.approved) approved.push(item);
    else pending.push({ item, task: item.id, reason: v.reason, hash: v.hash });
  }
  return { approved, pending };
}

// ---------------------------------------------------------------------------
// Display (review): the person must see what the agent would receive, including what is hidden

const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g;

/**
 * Text for a person to read: control characters dropped, invisible and bidirectional characters made visible as
 * `<U+XXXX>`, HTML comments left in place (they are stripped before the agent sees the text, but a reader should
 * know they exist). Returns the findings worth a warning.
 * @param {unknown} text
 * @returns {{text:string, findings:string[]}}
 */
export function displayContent(text) {
  const findings = [];
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (INVISIBLE.test(s)) findings.push('invisible-characters');
  INVISIBLE.lastIndex = 0;
  s = s.replace(INVISIBLE, (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
  if (/<!--/.test(s)) findings.push('html-comment');
  if (/\b(?:ignore|disregard|forget)\b[^\n]{0,40}\b(?:previous|prior|above|all|earlier)\b[^\n]{0,30}\b(?:instruction|rule|prompt)s?\b/i.test(s)) findings.push('instruction-override');
  if (/\b(?:curl|wget)\b|\bbase64\b|\bsudo\b|\brm\s+-rf\b|\.ssh\b|\.env\b|\bapi[_ -]?key\b|\btoken\b|\bsecret\b/i.test(s)) findings.push('sensitive-or-shell-wording');
  return { text: s, findings };
}

/** Shape of one pending ticket as shown by `review`. */
export function describePending({ item, reason, hash, difficulty, priority, maxBody = 3000 }) {
  const title = displayContent(String(item.title ?? '').replace(/\s+/g, ' '));
  const body = displayContent(item.body);
  const findings = [...new Set([...title.findings, ...body.findings])];
  const truncated = body.text.length > maxBody;
  return {
    task: item.id,
    url: item.url ?? null,
    author: item.authorLogin ?? null,
    difficulty: difficulty ?? null,
    priority: priority ?? null,
    state: reason === 'changed-since-approval' ? 'changed-since-approval' : 'pending',
    hash,
    shortHash: shortHash(hash),
    title: title.text,
    body: truncated ? `${body.text.slice(0, maxBody)}\n[... truncated]` : body.text,
    bodyChars: body.text.length,
    bodyTruncated: truncated,
    warnings: findings,
  };
}

/** Throws unless the mode is valid. @param {unknown} mode */
export function assertMode(mode) {
  if (!APPROVAL_MODES.includes(/** @type {any} */ (mode))) throw new DispatchError('bad-mode', `approval must be one of ${APPROVAL_MODES.join(', ')}`);
}
