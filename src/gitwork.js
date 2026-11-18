// Git plumbing for one task: bare mirror, disposable worktree, diff gate, commit, push.
// Everything goes through deps.exec (argv arrays, no shell). Spec: docs/design.md 7.2 and 9.13.
import path from 'node:path';
import os from 'node:os';
import { DispatchError, ensurePrivateDir, slug } from './util.js';

const PROTECTED_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'dev', 'release', 'production']);

/**
 * Run git, throw DispatchError('git', ...) on a non-zero exit.
 * @param {any} deps @param {string[]} args @param {{cwd?:string, code?:string}} [opts]
 */
async function git(deps, args, { cwd, code = 'git' } = {}) {
  const res = await deps.exec('git', args, { cwd, env: gitEnv(deps) });
  if (res.code !== 0) {
    const tail = String(res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
    throw new DispatchError(code, `git ${args.slice(0, 3).join(' ')} failed (exit ${res.code}): ${tail}`);
  }
  return res;
}

/** The child env never prompts for credentials. */
function gitEnv(deps) {
  return { ...(deps.env ?? globalThis.process.env), GIT_TERMINAL_PROMPT: '0' };
}

/**
 * `<prefix>/<login>/<number>-<slug(title,40)>`, suffixed -2, -3 ... when taken.
 * @param {{prefix:string, login:string, number:number, title:string, taken?:string[]}} p
 */
export function branchName({ prefix, login, number, title, taken = [] }) {
  const base = `${prefix}/${login}/${number}-${slug(title, 40) || 'task'}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  throw new DispatchError('git', `no free branch name for ${base}`);
}

/** Path of the bare mirror of a repo. */
export function mirrorPathFor(stateDir, repo) {
  return path.join(stateDir, 'repos', `${repo.replace('/', '__')}.git`);
}

/**
 * Clone the mirror once, fetch afterwards.
 * @returns {Promise<string>} mirror path
 */
export async function ensureMirror(deps, { stateDir, repo, cloneUrl }) {
  const mirror = mirrorPathFor(stateDir, repo);
  let exists = true;
  try {
    await deps.fs.access(path.join(mirror, 'HEAD'));
  } catch {
    exists = false;
  }
  if (!exists) {
    await ensurePrivateDir(deps.fs, path.dirname(mirror));
    // Bare clone, remote branches tracked under refs/remotes/origin: a task branch checked out in a
    // worktree can then never be a fetch target, and explicit-refspec pushes are not refused.
    await git(deps, ['clone', '--bare', cloneUrl, mirror]);
    await git(deps, ['-C', mirror, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  }
  await git(deps, ['-C', mirror, 'fetch', '--prune', 'origin']);
  return mirror;
}

async function resolveBase(deps, mirrorPath, base) {
  for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
    const res = await deps.exec('git', ['-C', mirrorPath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { env: gitEnv(deps) });
    if (res.code === 0) return ref;
  }
  throw new DispatchError('git', `base branch '${base}' not found in ${mirrorPath}`);
}

/**
 * New branch + worktree from the base branch.
 * @returns {Promise<{path:string, baseCommit:string}>}
 */
export async function createWorktree(deps, { mirrorPath, workDir, branch, base }) {
  const ref = await resolveBase(deps, mirrorPath, base);
  await ensurePrivateDir(deps.fs, path.dirname(workDir));
  await git(deps, ['-C', mirrorPath, 'worktree', 'add', '-b', branch, workDir, ref]);
  const head = await git(deps, ['-C', workDir, 'rev-parse', 'HEAD']);
  return { path: workDir, baseCommit: head.stdout.trim() };
}

/** Escapes regex metacharacters. */
const esc = (s) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&');

/**
 * Glob with `*` (no slash) and `**` (anything). A pattern without a slash matches the
 * basename at any depth; `**` followed by `/` also matches zero directories.
 * @param {string} file posix-style relative path
 * @param {string} glob
 */
export function matchesGlob(file, glob) {
  const target = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const hasSlash = glob.includes('/');
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else re += esc(ch);
  }
  const rx = new RegExp(`^${re}$`);
  if (rx.test(target)) return true;
  return !hasSlash && rx.test(target.slice(target.lastIndexOf('/') + 1));
}

/** Parse `git status --porcelain=v1 -z` output. @returns {string[]} every touched path (renames: both) */
export function parsePorcelainZ(out) {
  const entries = String(out).split('\0');
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    files.push(e.slice(3));
    if (/[RC]/.test(xy)) {
      i += 1;
      if (entries[i]) files.push(entries[i]);
    }
  }
  return files;
}

/**
 * Gate on what the agent changed.
 * @returns {Promise<{ok:boolean, files:string[], reason?:'no-change'|'policy-violation', detail?:string}>}
 */
export async function checkDiff(deps, { path: worktree, forbidden = [], maxFiles = 200, maxBytes = 5 * 1024 * 1024 }) {
  const res = await git(deps, ['-C', worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const files = [...new Set(parsePorcelainZ(res.stdout))].sort();
  if (files.length === 0) return { ok: false, files, reason: 'no-change', detail: 'no file changed' };
  const bad = files.find((f) => forbidden.some((g) => matchesGlob(f, g)));
  if (bad) return { ok: false, files, reason: 'policy-violation', detail: `forbidden path touched: ${bad}` };
  if (files.length > maxFiles) return { ok: false, files, reason: 'policy-violation', detail: `${files.length} files changed (limit ${maxFiles})` };
  const root = path.resolve(worktree);
  let total = 0;
  for (const f of files) {
    const full = path.join(worktree, f);
    let st;
    try {
      st = await deps.fs.lstat(full);
    } catch {
      continue; // deleted file
    }
    if (st.isSymbolicLink()) {
      const target = path.resolve(path.dirname(full), await deps.fs.readlink(full));
      if (target !== root && !target.startsWith(root + path.sep)) {
        return { ok: false, files, reason: 'policy-violation', detail: `symlink escapes the worktree: ${f}` };
      }
    } else if (st.isFile()) total += st.size;
  }
  if (total > maxBytes) return { ok: false, files, reason: 'policy-violation', detail: `${total} bytes changed (limit ${maxBytes})` };
  return { ok: true, files, detail: `${files.length} file(s) changed, ${total} bytes` };
}

/**
 * Stage everything and commit as "<login> (inactivity)". Hooks and signing are disabled.
 * @returns {Promise<string>} head commit
 */
export async function commitAll(deps, { path: worktree, login, title, number, summary, runId }) {
  await git(deps, ['-C', worktree, 'add', '-A']);
  await git(deps, [
    '-C', worktree,
    '-c', `user.name=${login} (inactivity)`,
    '-c', `user.email=${login}@users.noreply.github.com`,
    '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${os.devNull}`,
    'commit', '--no-verify',
    '-m', `${title} (#${number})`,
    '-m', summary || 'Automated change by inactivity.',
    '-m', `Inactivity-Run: ${runId}`,
  ]);
  const head = await git(deps, ['-C', worktree, 'rev-parse', 'HEAD']);
  return head.stdout.trim();
}

/** Push HEAD to `refs/heads/<branch>` (never forced, never the base or a protected branch). */
export async function push(deps, { path: worktree, remote = 'origin', branch, base }) {
  if (!branch || branch === base || PROTECTED_BRANCHES.has(branch)) {
    throw new DispatchError('push', `refusing to push to '${branch}' (base or protected branch)`);
  }
  await git(deps, ['-C', worktree, 'push', remote, `HEAD:refs/heads/${branch}`], { code: 'push' });
}

/**
 * Remove a worktree. Only paths under `<stateDir>/work/` are ever touched (stateDir is derived
 * from the mirror path `<stateDir>/repos/<x>.git`).
 */
export async function removeWorktree(deps, { mirrorPath, path: worktree }) {
  const stateDir = path.dirname(path.dirname(mirrorPath));
  const workRoot = path.join(stateDir, 'work') + path.sep;
  const target = path.resolve(worktree);
  if (!target.startsWith(workRoot)) throw new DispatchError('git', `refusing to remove '${worktree}': not under ${workRoot}`);
  const res = await deps.exec('git', ['-C', mirrorPath, 'worktree', 'remove', '--force', target], { env: gitEnv(deps) });
  if (res.code !== 0) await deps.fs.rm(target, { recursive: true, force: true });
  await deps.exec('git', ['-C', mirrorPath, 'worktree', 'prune'], { env: gitEnv(deps) });
  try {
    await deps.fs.access(target);
  } catch {
    return;
  }
  throw new DispatchError('git', `worktree ${worktree} still exists after removal`);
}
