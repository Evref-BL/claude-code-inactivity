// Real git against local temp repositories (git is required to develop this plugin anyway).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDeps } from '../src/deps.js';
import { branchName, ensureMirror, createWorktree, checkDiff, commitAll, push, removeWorktree, matchesGlob, parsePorcelainZ } from '../src/gitwork.js';
import { makeRemoteRepo, tmpDirs } from './support/fakes.js';

const tmp = tmpDirs();
after(() => tmp.cleanup());
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

async function setup() {
  const root = await tmp.make('pd-git-');
  const remote = await makeRemoteRepo(root);
  const stateDir = path.join(root, 'state');
  const deps = createDeps({ log: { debug() {}, info() {}, warn() {}, error() {} } });
  const mirror = await ensureMirror(deps, { stateDir, repo: 'acme/widgets', cloneUrl: remote });
  const workDir = path.join(stateDir, 'work', 'run1');
  const wt = await createWorktree(deps, { mirrorPath: mirror, workDir, branch: 'inactivity/alice/1-fix', base: 'main' });
  return { root, remote, stateDir, deps, mirror, workDir, wt };
}

test('matchesGlob: * and ** only, basename patterns match at any depth', () => {
  assert.ok(matchesGlob('.github/workflows/ci.yml', '.github/**'));
  assert.ok(!matchesGlob('src/.github/x', '.github/**'));
  assert.ok(matchesGlob('.inactivity.json', '.inactivity.json'));
  assert.ok(matchesGlob('sub/dir/.inactivity.json', '.inactivity.json'));
  assert.ok(matchesGlob('a/b/key.pem', '*.pem'));
  assert.ok(matchesGlob('.env.local', '.env*'));
  assert.ok(matchesGlob('.git/config', '**/.git/**'));
  assert.ok(matchesGlob('x/y/.git/hooks/pre-commit', '**/.git/**'));
  assert.ok(!matchesGlob('src/Widgets/Widget.class.st', '.github/**'));
  assert.ok(matchesGlob('src/a/b.st', 'src/*/b.st'));
  assert.ok(!matchesGlob('src/a/c/b.st', 'src/*/b.st'));
});

test('branchName: slug and numeric suffix when taken', () => {
  const a = { prefix: 'inactivity', login: 'alice', number: 42, title: 'Fix the Parser!' };
  assert.equal(branchName(a), 'inactivity/alice/42-fix-the-parser');
  assert.equal(branchName({ ...a, taken: ['inactivity/alice/42-fix-the-parser'] }), 'inactivity/alice/42-fix-the-parser-2');
  assert.equal(branchName({ ...a, taken: ['inactivity/alice/42-fix-the-parser', 'inactivity/alice/42-fix-the-parser-2'] }), 'inactivity/alice/42-fix-the-parser-3');
  assert.equal(branchName({ ...a, title: '???' }), 'inactivity/alice/42-task');
});

test('parsePorcelainZ keeps both paths of a rename', () => {
  assert.deepEqual(parsePorcelainZ(' M a.st\0R  new.st\0old.st\0?? b.st\0'), ['a.st', 'new.st', 'old.st', 'b.st']);
});

test('mirror, worktree, diff gate, commit and push to a bare remote', async () => {
  const { remote, deps, mirror, workDir, wt, stateDir } = await setup();
  assert.equal(wt.path, workDir);
  assert.match(wt.baseCommit, /^[0-9a-f]{40}$/);

  // no change
  const none = await checkDiff(deps, { path: workDir, forbidden: ['.github/**'] });
  assert.deepEqual([none.ok, none.reason], [false, 'no-change']);

  // forbidden path
  await fsp.mkdir(path.join(workDir, '.github'), { recursive: true });
  await fsp.writeFile(path.join(workDir, '.github', 'ci.yml'), 'x');
  const bad = await checkDiff(deps, { path: workDir, forbidden: ['.github/**'] });
  assert.deepEqual([bad.ok, bad.reason], [false, 'policy-violation']);
  assert.match(bad.detail, /\.github\/ci\.yml/);
  await fsp.rm(path.join(workDir, '.github'), { recursive: true });

  // too many files, too many bytes, escaping symlink
  await fsp.writeFile(path.join(workDir, 'a.st'), 'a');
  await fsp.writeFile(path.join(workDir, 'b.st'), 'b');
  assert.equal((await checkDiff(deps, { path: workDir, maxFiles: 1 })).reason, 'policy-violation');
  assert.equal((await checkDiff(deps, { path: workDir, maxBytes: 1 })).reason, 'policy-violation');
  await fsp.symlink('/etc/passwd', path.join(workDir, 'link'));
  assert.match((await checkDiff(deps, { path: workDir })).detail, /symlink escapes/);
  await fsp.rm(path.join(workDir, 'link'));

  // fine
  const ok = await checkDiff(deps, { path: workDir, forbidden: ['.github/**'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.files, ['a.st', 'b.st']);

  // commit: author, trailer
  const head = await commitAll(deps, { path: workDir, login: 'alice', title: 'Fix the parser', number: 1, summary: 'Did it.', runId: 'RUN-1' });
  assert.match(head, /^[0-9a-f]{40}$/);
  const msg = git(workDir, 'log', '-1', '--format=%an <%ae>%n%B').stdout;
  assert.match(msg, /^alice \(inactivity\) <alice@users\.noreply\.github\.com>/);
  assert.match(msg, /Fix the parser \(#1\)/);
  assert.match(msg, /Inactivity-Run: RUN-1/);
  assert.ok(!/Co-Authored-By/i.test(msg));

  // push: refuses base and protected branches, pushes the task branch (never forced)
  await assert.rejects(push(deps, { path: workDir, remote: 'origin', branch: 'main', base: 'main' }), (e) => e.code === 'push');
  await assert.rejects(push(deps, { path: workDir, remote: 'origin', branch: 'master', base: 'trunk' }), (e) => e.code === 'push');
  await push(deps, { path: workDir, remote: 'origin', branch: 'inactivity/alice/1-fix', base: 'main' });
  assert.equal(git(remote, 'rev-parse', 'refs/heads/inactivity/alice/1-fix').stdout.trim(), head);
  assert.notEqual(git(remote, 'rev-parse', 'refs/heads/main').stdout.trim(), head, 'base branch untouched');

  // a second fetch works even though the task branch is still checked out in a worktree
  await ensureMirror(deps, { stateDir, repo: 'acme/widgets', cloneUrl: remote });
  assert.equal(git(mirror, 'rev-parse', 'refs/remotes/origin/inactivity/alice/1-fix').stdout.trim(), head);

  // removal
  await removeWorktree(deps, { mirrorPath: mirror, path: workDir });
  await assert.rejects(fsp.access(workDir));
  assert.ok(!git(mirror, 'worktree', 'list').stdout.includes('run1'));
});

test('removeWorktree refuses paths outside <stateDir>/work', async () => {
  const { deps, mirror, root } = await setup();
  const outside = path.join(root, 'precious');
  await fsp.mkdir(outside);
  await assert.rejects(removeWorktree(deps, { mirrorPath: mirror, path: outside }), (e) => e.code === 'git');
  await assert.rejects(removeWorktree(deps, { mirrorPath: mirror, path: path.join(root, 'state', 'work', '..', '..', 'precious') }), (e) => e.code === 'git');
  await fsp.access(outside);
});

test('createWorktree fails clearly on an unknown base branch', async () => {
  const { deps, mirror, stateDir } = await setup();
  await assert.rejects(createWorktree(deps, { mirrorPath: mirror, workDir: path.join(stateDir, 'work', 'run2'), branch: 'x/y', base: 'nope' }), /base branch 'nope' not found/);
});
