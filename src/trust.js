// Per-member trust whitelist (pure; no I/O). Spec: docs/design.md section 1.5 and 4.2 (`trustedAuthors`).
//
// Anyone who can create or edit a task on the board could prompt-inject the Claude of the member who
// runs it. Each member therefore keeps THEIR OWN list of GitHub logins whose tasks they accept
// (`trustedAuthors` in the user-level config.json). The list is empty by default: nothing is claimed
// or executed until the member adds logins. It is applied on this machine only, at three points
// (building claims, an assignment arriving, the runner start gate). It never enters claim
// resolution, which stays a deterministic function of the board that every member computes alike.

/** GitHub login: 1-39 chars, alphanumerics and single hyphens, not starting with a hyphen. */
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const BOT_SUFFIX = /\[bot\]$/i;

/** Hint appended to every "nothing happens" explanation. */
export const TRUST_HINT = "Add the GitHub logins you trust with `inactivity trust add <login>...` (list them with `inactivity trust list`).";

/**
 * Normalize one whitelist entry typed by a person: trims, drops a leading `@`, lower-cases,
 * validates the GitHub login syntax. A GitHub App is written with its `[bot]` suffix
 * (`dependabot[bot]`); a bare name only ever matches a human account.
 * @param {unknown} input
 * @returns {{ok:true, login:string}|{ok:false, error:string}}
 */
export function normalizeLogin(input) {
  if (typeof input !== 'string') return { ok: false, error: 'must be a string' };
  let text = input.trim();
  if (text.startsWith('@')) text = text.slice(1);
  const bot = BOT_SUFFIX.test(text);
  const base = bot ? text.replace(BOT_SUFFIX, '') : text;
  if (!LOGIN_RE.test(base)) return { ok: false, error: `'${input.trim()}' is not a valid GitHub login (letters, digits and single hyphens, up to 39 characters)` };
  if (base.includes('--')) return { ok: false, error: `'${input.trim()}' is not a valid GitHub login (no consecutive hyphens)` };
  return { ok: true, login: `${base.toLowerCase()}${bot ? '[bot]' : ''}` };
}

/**
 * Comparison key of an actor seen on GitHub, or null when the actor can never be trusted
 * (no login, a mannequin, an organization). Bots get the `[bot]` suffix, humans do not,
 * so listing `foo` never trusts the bot `foo[bot]` and the other way round.
 * @param {string|null|undefined} login
 * @param {string|null|undefined} type GraphQL __typename (User, Bot, Mannequin, ...), default User
 * @returns {string|null}
 */
export function actorKey(login, type) {
  if (typeof login !== 'string' || login.trim() === '') return null;
  const text = login.trim();
  const bot = type === 'Bot' || BOT_SUFFIX.test(text);
  if (!bot && type !== undefined && type !== null && type !== 'User') return null;
  const base = text.replace(BOT_SUFFIX, '').toLowerCase();
  return bot ? `${base}[bot]` : base;
}

/**
 * Whitelist as a Set of normalized entries. Invalid entries are ignored (config validation reports them).
 * @param {unknown} list
 * @returns {Set<string>}
 */
export function trustSet(list) {
  const out = new Set();
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    const n = normalizeLogin(entry);
    if (n.ok) out.add(n.login);
  }
  return out;
}

/** @param {unknown} list @param {string|null|undefined} login @param {string|null|undefined} [type] */
export function isTrustedActor(list, login, type) {
  const key = actorKey(login, type);
  return key !== null && trustSet(list).has(key);
}

/**
 * Trust verdict on a board item for ONE member's whitelist: the author must be whitelisted and, when the
 * item was edited, so must be the last editor of the body (`editorLogin`) and the last renamer of the
 * title (`titleEditorLogin`). This closes the bait-and-switch where a trusted person opens an issue and
 * someone else rewrites it before it runs. Case-insensitive. Bots count only when listed explicitly.
 *
 * @param {{authorLogin?:string|null, authorType?:string|null, lastEditedAt?:string|null, editorLogin?:string|null,
 *   editorType?:string|null, titleEditedAt?:string|null, titleEditorLogin?:string|null, titleEditorType?:string|null}} item
 * @param {unknown} trustedAuthors the member's `trustedAuthors`
 * @returns {{trusted:true}|{trusted:false, reason:'empty-trust-list'|'untrusted-author', who:'author'|'editor'|'title-editor'|null, login:string|null, detail:string}}
 */
export function checkItemTrust(item, trustedAuthors) {
  const set = trustSet(trustedAuthors);
  if (set.size === 0) {
    return { trusted: false, reason: 'empty-trust-list', who: null, login: null, detail: `no trusted author is configured. ${TRUST_HINT}` };
  }
  const deny = (who, login, label) => ({
    trusted: false,
    reason: 'untrusted-author',
    who,
    login: login ?? null,
    detail: `${label} ${login ? `@${login}` : '(unknown account)'} is not in your trusted authors`,
  });
  const authorKey = actorKey(item?.authorLogin, item?.authorType);
  if (authorKey === null) return deny('author', item?.authorLogin ?? null, 'the author');
  if (!set.has(authorKey)) return deny('author', item.authorLogin, 'the author');
  if (item.lastEditedAt) {
    const k = actorKey(item.editorLogin, item.editorType);
    if (k === null || !set.has(k)) return deny('editor', item.editorLogin ?? null, 'the last editor of the issue');
  }
  if (item.titleEditedAt || item.titleEditorLogin) {
    const k = actorKey(item.titleEditorLogin, item.titleEditorType);
    if (k === null || !set.has(k)) return deny('title-editor', item.titleEditorLogin ?? null, 'the last person who renamed the issue');
  }
  return { trusted: true };
}

/** @param {object} item @param {unknown} trustedAuthors @returns {boolean} */
export function isTrustedItem(item, trustedAuthors) {
  return checkItemTrust(item, trustedAuthors).trusted;
}

/**
 * Split items into those this member may claim or run and those skipped, with the reason and the people involved.
 * @template {object} T
 * @param {T[]} items
 * @param {unknown} trustedAuthors
 * @returns {{trusted:T[], untrusted:{item:T, task:string, reason:string, who:string|null, login:string|null, author:string|null, editor:string|null, detail:string}[]}}
 */
export function partitionByTrust(items, trustedAuthors) {
  const trusted = [];
  const untrusted = [];
  for (const item of items) {
    const v = checkItemTrust(item, trustedAuthors);
    if (v.trusted) trusted.push(item);
    else {
      const a = /** @type {any} */ (item);
      untrusted.push({ item, task: a.id, reason: v.reason, who: v.who, login: v.login, author: a.authorLogin ?? null, editor: a.lastEditedAt ? (a.editorLogin ?? null) : null, detail: v.detail });
    }
  }
  return { trusted, untrusted };
}
