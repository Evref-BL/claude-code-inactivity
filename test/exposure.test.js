import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assessExposure, allowsPublicBoard } from '../src/exposure.js';
import { createGithub } from '../src/github.js';
import { checkExposure } from '../src/context.js';

const fixture = (name) => {
  const { _comment, ...rest } = JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'));
  return rest;
};
const codes = (r) => r.findings.map((f) => f.code);
const level = (r, code) => r.findings.find((f) => f.code === code)?.level;

test('a public board fails unless allowPublicBoard is explicitly true', () => {
  const info = { public: true };
  const strict = assessExposure({ projectId: 'board', projectInfo: info });
  assert.equal(strict.level, 'fail');
  assert.equal(level(strict, 'board-public'), 'fail');
  assert.match(strict.findings[0].fix, /board-lockdown\.md/);
  const allowed = assessExposure({ projectId: 'board', projectInfo: info, allowPublicBoard: true });
  assert.equal(allowed.level, 'warn');
  assert.equal(level(allowed, 'board-public-allowed'), 'warn');
  // only the boolean true counts
  assert.equal(assessExposure({ projectInfo: info, allowPublicBoard: 'true' }).level, 'fail');
});

test('a private board is ok; a board whose flag is missing is a warning, never silently fine', () => {
  const priv = assessExposure({ projectInfo: { public: false } });
  assert.equal(priv.level, 'ok');
  assert.equal(priv.public, false);
  const unknown = assessExposure({ projectInfo: { public: null } });
  assert.equal(unknown.level, 'warn');
  assert.deepEqual(codes(unknown).filter((c) => c.startsWith('board-')), ['board-visibility-unknown', 'board-access-unknown']);
  // access.public wins over a stale projectInfo
  assert.equal(assessExposure({ projectInfo: { public: false }, access: { public: true } }).level, 'fail');
});

test('public repositories warn, private ones are ok, unreadable ones are unknown', () => {
  const r = assessExposure({
    projectInfo: { public: false },
    repos: [
      { repo: 'acme/app', role: 'task', isPrivate: true, visibility: 'PRIVATE' },
      { repo: 'acme/docs', role: 'task', isPrivate: false, visibility: 'PUBLIC' },
      { repo: 'acme/policy', role: 'policy', isPrivate: false, visibility: 'PUBLIC' },
      { repo: 'acme/secret', role: 'task', error: 'not found' },
      { repo: 'acme/internal', role: 'task', isPrivate: true, visibility: 'INTERNAL' },
    ],
  });
  assert.equal(r.level, 'warn');
  const byRepo = Object.fromEntries(r.findings.filter((f) => f.code.startsWith('repo-')).map((f) => [f.repo, f.code]));
  assert.equal(byRepo['acme/app'], 'repo-private');
  assert.equal(byRepo['acme/docs'], 'repo-public');
  assert.equal(byRepo['acme/policy'], 'repo-public');
  assert.equal(byRepo['acme/secret'], 'repo-unknown');
  assert.equal(byRepo['acme/internal'], 'repo-private');
});

test('teams are listed when readable; otherwise unknown with a hint', () => {
  const ok = assessExposure({ projectInfo: { public: false }, access: { public: false, status: 'ok', teams: [{ slug: 'core', name: 'Core' }], collaborators: 'unknown', hint: 'review by hand' } });
  assert.deepEqual(ok.teams, ['core']);
  assert.match(ok.findings.find((f) => f.code === 'board-teams').message, /core/);
  assert.equal(ok.collaborators, 'unknown');
  const unknown = assessExposure({ projectInfo: { public: false }, access: { status: 'unknown', teams: null, hint: 'token cannot see it' } });
  assert.equal(unknown.teams, null);
  assert.equal(unknown.findings.find((f) => f.code === 'board-access-unknown').fix, 'token cannot see it');
  assert.equal(unknown.level, 'ok', 'not being able to list collaborators is information, not a failure');
});

test('allowsPublicBoard: project entry overrides the global key, default is false', () => {
  assert.equal(allowsPublicBoard({}, {}), false);
  assert.equal(allowsPublicBoard({ allowPublicBoard: true }, {}), true);
  assert.equal(allowsPublicBoard({ allowPublicBoard: true }, { allowPublicBoard: false }), false);
  assert.equal(allowsPublicBoard({ allowPublicBoard: false }, { allowPublicBoard: true }), true);
});

// --- end to end with GitHub fixtures (no network) --------------------------------------

function ghWith(routes) {
  const deps = {
    env: {}, now: () => new Date('2026-11-19T04:00:00Z'), sleep: async () => {}, log: { debug() {}, info() {}, warn() {}, error() {} },
    exec: async () => { throw new Error('no gh'); },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      const out = routes[body.operationName];
      if (out === undefined) throw new Error(`unrouted ${body.operationName}`);
      const text = JSON.stringify(typeof out === 'function' ? out(body.variables) : out);
      return { status: 200, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
    },
  };
  return createGithub(deps, { token: 'ghp_x' });
}

test('checkExposure: a public board from fixtures fails; a private one with a public task repo warns', async () => {
  const project = { id: 'board', owner: 'acme', number: 3, policy: { repo: 'acme/policy' }, repos: { 'acme/app': {} } };
  const repoInfo = (v) => (v.name === 'app' ? fixture('gh-repo-info') : fixture('gh-repo-info-public'));

  let github = ghWith({ ResolveProjectOrg: fixture('gh-project-org-public'), ProjectAccess: fixture('gh-project-access-public'), RepoInfo: repoInfo });
  let info = await github.resolveProject({ owner: 'acme', number: 3, ownerType: 'organization' });
  let report = await checkExposure({ config: {} }, github, project, info);
  assert.equal(report.level, 'fail');
  assert.equal(report.public, true);
  assert.ok(codes(report).includes('board-public'));
  // opting in downgrades to a warning
  report = await checkExposure({ config: { allowPublicBoard: true } }, github, project, info);
  assert.equal(report.level, 'warn');
  report = await checkExposure({ config: { allowPublicBoard: true } }, github, { ...project, allowPublicBoard: false }, info);
  assert.equal(report.level, 'fail', 'the project entry wins');

  github = ghWith({ ResolveProjectOrg: fixture('gh-project-org'), ProjectAccess: fixture('gh-project-access'), RepoInfo: repoInfo });
  info = await github.resolveProject({ owner: 'acme', number: 3, ownerType: 'organization' });
  report = await checkExposure({ config: {} }, github, project, info);
  assert.equal(report.level, 'warn', 'policy repo is public in this fixture');
  assert.ok(codes(report).includes('board-private'));
  assert.ok(codes(report).includes('repo-public'));
  assert.deepEqual(report.teams, ['core']);
});

test('checkExposure degrades to unknown when the access query is refused', async () => {
  const project = { id: 'board', owner: 'acme', number: 3, repos: {}, policy: { repo: 'acme/policy' } };
  const github = ghWith({
    ResolveProjectOrg: fixture('gh-project-org'),
    ProjectAccess: { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] },
    RepoInfo: { errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] },
  });
  const info = await github.resolveProject({ owner: 'acme', number: 3, ownerType: 'organization' });
  const report = await checkExposure({ config: {} }, github, project, info);
  assert.equal(report.level, 'ok');
  assert.ok(codes(report).includes('board-access-unknown'));
  assert.ok(codes(report).includes('repo-unknown'));
  assert.equal(report.teams, null);
});

// fix hints must point at the right section of docs/board-lockdown.md (review finding)
const lockdownDoc = readFileSync(fileURLToPath(new URL('../docs/board-lockdown.md', import.meta.url)), 'utf8');
const sectionTitle = (n) => lockdownDoc.match(new RegExp(`^## ${n}\\. (.+)$`, 'm'))?.[1] ?? '';

test('exposure fix hints reference the matching board-lockdown.md step', () => {
  const stepOf = (f) => Number(/board-lockdown\.md, step (\d)/.exec(f.fix ?? '')?.[1]);
  const r = assessExposure({ projectId: 'b', access: { status: 'error' }, repos: [{ repo: 'acme/docs', isPrivate: false, visibility: 'PUBLIC' }] });
  const repoPublic = r.findings.find((f) => f.code === 'repo-public');
  assert.equal(stepOf(repoPublic), 2);
  assert.match(sectionTitle(2), /issues/i);
  assert.match(lockdownDoc, /Interaction limits/);
  const access = r.findings.find((f) => f.code === 'board-access-unknown');
  assert.equal(stepOf(access), 1);
  assert.match(sectionTitle(1), /project private/i);
  assert.match(lockdownDoc, /Manage access/);
  for (const code of ['board-public', 'board-visibility-unknown']) {
    const f = assessExposure({ projectId: 'b', projectInfo: { public: code === 'board-public' ? true : null } }).findings.find((x) => x.code === code);
    assert.equal(stepOf(f), 1);
  }
});

test('board-lockdown.md internal step references point at the right section', () => {
  const auto = lockdownDoc.split('\n').find((l) => /Auto-add to project/.test(l)) + lockdownDoc.split('\n').find((l) => /only the group can open issues in/.test(l));
  assert.match(auto, /step 2 below/);
  assert.doesNotMatch(lockdownDoc, /step 3 below/);
});

test('token advice is consistent: classic PAT is the verified default, fine-grained is conditional', () => {
  const tokens = lockdownDoc.slice(lockdownDoc.indexOf('## 4. Accounts and tokens'), lockdownDoc.indexOf('## 5.'));
  assert.match(tokens, /classic personal access token/);
  assert.match(tokens, /only if you have\s+verified/);
  assert.match(tokens, /single resource owner/);
  assert.match(tokens, /user-owned/);
  assert.doesNotMatch(tokens, /Prefer a\s+\*\*fine-grained/);
});
