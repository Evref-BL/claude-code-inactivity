import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLogin, actorKey, trustSet, isTrustedActor, checkItemTrust, isTrustedItem, partitionByTrust, TRUST_HINT,
} from '../src/trust.js';
import { validateConfig, defaultConfig } from '../src/config.js';

const item = (o = {}) => ({
  id: 'org/repo#1', authorLogin: 'alice', authorType: 'User', lastEditedAt: null, editorLogin: null, editorType: null,
  titleEditedAt: null, titleEditorLogin: null, titleEditorType: null, authorAssociation: 'OWNER', ...o,
});

test('normalizeLogin: trims, drops @, lower-cases, validates GitHub login syntax', () => {
  assert.deepEqual(normalizeLogin('  @Alice-Dev '), { ok: true, login: 'alice-dev' });
  assert.deepEqual(normalizeLogin('Dependabot[bot]'), { ok: true, login: 'dependabot[bot]' });
  assert.deepEqual(normalizeLogin('a'), { ok: true, login: 'a' });
  for (const bad of ['', '  ', '-alice', 'al ice', 'al_ice', 'alice/bob', 'a--b', 'x'.repeat(40), '@', '[bot]', 'ali!ce', 'org/team', 42, null]) {
    assert.equal(normalizeLogin(bad).ok, false, String(bad));
  }
  assert.match(/** @type {any} */ (normalizeLogin('a b')).error, /not a valid GitHub login/);
});

test('actorKey: bots are distinct from humans, unknown actors have no key', () => {
  assert.equal(actorKey('Alice', 'User'), 'alice');
  assert.equal(actorKey('Alice'), 'alice');
  assert.equal(actorKey('dependabot', 'Bot'), 'dependabot[bot]');
  assert.equal(actorKey('dependabot[bot]', 'User'), 'dependabot[bot]');
  assert.equal(actorKey('ghost-user', 'Mannequin'), null);
  assert.equal(actorKey('acme', 'Organization'), null);
  assert.equal(actorKey(null, 'User'), null);
  assert.equal(actorKey('', 'User'), null);
});

test('trustSet ignores invalid entries and de-duplicates case-insensitively', () => {
  assert.deepEqual([...trustSet(['Alice', 'alice', '@ALICE', 'bad login', 7, 'Bob'])], ['alice', 'bob']);
  assert.equal(trustSet(undefined).size, 0);
  assert.equal(trustSet('alice').size, 0);
  assert.equal(isTrustedActor(['Alice'], 'aLiCe', 'User'), true);
  assert.equal(isTrustedActor(['alice'], 'alice', 'Bot'), false);
});

test('checkItemTrust: an empty whitelist trusts nobody and says how to fix it', () => {
  for (const list of [[], undefined, null, ['not a login']]) {
    const v = checkItemTrust(item(), list);
    assert.equal(v.trusted, false);
    assert.equal(v.reason, 'empty-trust-list');
    assert.match(v.detail, /inactivity trust add/);
  }
  assert.match(TRUST_HINT, /trust list/);
});

test('checkItemTrust: author must be whitelisted; association and roster never matter', () => {
  assert.equal(checkItemTrust(item({ authorLogin: 'ALICE' }), ['alice']).trusted, true);
  const v = checkItemTrust(item({ authorLogin: 'mallory', authorAssociation: 'OWNER' }), ['alice']);
  assert.deepEqual([v.trusted, v.reason, v.who, v.login], [false, 'untrusted-author', 'author', 'mallory']);
  assert.equal(checkItemTrust(item({ authorLogin: null, authorType: null }), ['alice']).trusted, false);
  assert.equal(checkItemTrust(item({ authorType: 'Mannequin' }), ['alice']).trusted, false);
});

test('checkItemTrust: bots only when listed with [bot]', () => {
  const bot = item({ authorLogin: 'dependabot', authorType: 'Bot' });
  assert.equal(checkItemTrust(bot, ['dependabot']).trusted, false);
  assert.equal(checkItemTrust(bot, ['dependabot[bot]']).trusted, true);
  assert.equal(checkItemTrust(item({ authorLogin: 'dependabot[bot]', authorType: undefined }), ['dependabot[bot]']).trusted, true);
  // and a human cannot hide behind a bot entry
  assert.equal(checkItemTrust(item({ authorLogin: 'dependabot', authorType: 'User' }), ['dependabot[bot]']).trusted, false);
});

test('checkItemTrust: the last body editor and the last renamer must be whitelisted too', () => {
  const edited = (extra) => item({ lastEditedAt: '2026-11-19T05:00:00Z', editorLogin: 'alice', editorType: 'User', ...extra });
  assert.equal(checkItemTrust(edited(), ['alice']).trusted, true, 'self edit');
  const stranger = checkItemTrust(edited({ editorLogin: 'mallory' }), ['alice']);
  assert.deepEqual([stranger.trusted, stranger.who, stranger.login], [false, 'editor', 'mallory']);
  assert.equal(checkItemTrust(edited({ editorLogin: 'Mallory' }), ['alice', 'MALLORY']).trusted, true);
  assert.equal(checkItemTrust(edited({ editorLogin: null }), ['alice']).trusted, false, 'unknown editor');
  assert.equal(checkItemTrust(edited({ editorLogin: 'alice', editorType: 'Bot' }), ['alice']).trusted, false);
  const renamed = checkItemTrust(item({ titleEditedAt: '2026-11-19T05:00:00Z', titleEditorLogin: 'mallory', titleEditorType: 'User' }), ['alice']);
  assert.deepEqual([renamed.trusted, renamed.who], [false, 'title-editor']);
  assert.equal(checkItemTrust(item({ titleEditedAt: '2026-11-19T05:00:00Z', titleEditorLogin: null }), ['alice']).trusted, false);
  // items without the new fields (older callers) are judged on the author only
  assert.equal(isTrustedItem({ authorLogin: 'alice' }, ['alice']), true);
});

test('partitionByTrust: reports who and why for every skipped task', () => {
  const items = [
    item({ id: 'o/r#1' }),
    item({ id: 'o/r#2', authorLogin: 'mallory' }),
    item({ id: 'o/r#3', lastEditedAt: '2026-11-19T05:00:00Z', editorLogin: 'eve', editorType: 'User' }),
  ];
  const { trusted, untrusted } = partitionByTrust(items, ['alice']);
  assert.deepEqual(trusted.map((i) => i.id), ['o/r#1']);
  assert.deepEqual(untrusted.map((u) => [u.task, u.reason, u.who, u.author, u.editor]), [
    ['o/r#2', 'untrusted-author', 'author', 'mallory', null],
    ['o/r#3', 'untrusted-author', 'editor', 'alice', 'eve'],
  ]);
  const none = partitionByTrust(items, []);
  assert.equal(none.trusted.length, 0);
  assert.ok(none.untrusted.every((u) => u.reason === 'empty-trust-list'));
});

// --- config: trustedAuthors / allowPublicBoard ------------------------------------

test('config: trustedAuthors defaults to empty, is normalized and validated', () => {
  assert.deepEqual(defaultConfig().trustedAuthors, []);
  assert.equal(defaultConfig().allowPublicBoard, false);
  assert.equal(validateConfig({ version: 1, projects: [] }).ok, true);
  assert.deepEqual(validateConfig({ version: 1, projects: [] }).config.trustedAuthors, []);
  const v = validateConfig({ version: 1, projects: [], trustedAuthors: ['@Alice', 'alice', 'Bob', 'dependabot[bot]'] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.config.trustedAuthors, ['alice', 'bob', 'dependabot[bot]']);
  const bad = validateConfig({ version: 1, projects: [], trustedAuthors: ['alice', 'not a login', 5] });
  assert.deepEqual(bad.errors.map((e) => e.path), ['/trustedAuthors/1', '/trustedAuthors/2']);
  assert.deepEqual(validateConfig({ version: 1, projects: [], trustedAuthors: 'alice' }).errors.map((e) => e.path), ['/trustedAuthors']);
  // idempotent
  assert.deepEqual(validateConfig(v.config).config.trustedAuthors, v.config.trustedAuthors);
});

test('config: allowPublicBoard is a boolean at the top level and per project', () => {
  assert.equal(validateConfig({ version: 1, projects: [], allowPublicBoard: true }).config.allowPublicBoard, true);
  assert.deepEqual(validateConfig({ version: 1, projects: [], allowPublicBoard: 'yes' }).errors.map((e) => e.path), ['/allowPublicBoard']);
  const p = { id: 'p', owner: 'o', number: 1, policy: { repo: 'o/r' } };
  const v = validateConfig({ version: 1, projects: [{ ...p, allowPublicBoard: true }, { ...p, id: 'q' }] });
  assert.equal(v.ok, true);
  assert.equal(v.config.projects[0].allowPublicBoard, true);
  assert.equal('allowPublicBoard' in v.config.projects[1], false, 'absent stays absent: the global default applies');
  assert.deepEqual(validateConfig({ version: 1, projects: [{ ...p, allowPublicBoard: 1 }] }).errors.map((e) => e.path), ['/projects/0/allowPublicBoard']);
});
