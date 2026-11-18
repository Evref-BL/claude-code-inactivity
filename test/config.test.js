import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolvePaths, loadConfig, validateConfig, saveConfig, setByPath, defaultConfig,
} from '../src/config.js';

const minimal = { version: 1, projects: [] };
const teamInline = { v: 1, timezone: 'Europe/Paris', roster: [{ login: 'alice' }] };
const project = (extra = {}) => ({ id: 'p1', owner: 'o', number: 3, policy: { repo: 'o/r' }, ...extra });
const errPaths = (r) => r.errors.map((e) => e.path);

test('resolvePaths: INACTIVITY_HOME wins and nests state', () => {
  const r = resolvePaths({ INACTIVITY_HOME: '/h', XDG_CONFIG_HOME: '/x' }, 'linux', '/home/u');
  assert.deepEqual(r, { configHome: '/h', configPath: '/h/config.json', stateDir: '/h/state' });
});

test('resolvePaths: INACTIVITY_STATE overrides the state dir only', () => {
  const r = resolvePaths({ INACTIVITY_HOME: '/h', INACTIVITY_STATE: '/s' }, 'darwin', '/Users/u');
  assert.equal(r.stateDir, '/s');
  assert.equal(r.configPath, '/h/config.json');
});

test('resolvePaths: XDG then home fallbacks (posix)', () => {
  const x = resolvePaths({ XDG_CONFIG_HOME: '/xc', XDG_STATE_HOME: '/xs' }, 'linux', '/home/u');
  assert.equal(x.configHome, '/xc/inactivity');
  assert.equal(x.stateDir, '/xs/inactivity');
  const d = resolvePaths({}, 'darwin', '/Users/u');
  assert.equal(d.configPath, '/Users/u/.config/inactivity/config.json');
  assert.equal(d.stateDir, '/Users/u/.local/state/inactivity');
});

test('resolvePaths: Windows uses APPDATA and LOCALAPPDATA', () => {
  const r = resolvePaths({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u');
  assert.equal(r.configHome, 'C:\\Users\\u\\AppData\\Roaming\\inactivity');
  assert.equal(r.configPath, 'C:\\Users\\u\\AppData\\Roaming\\inactivity\\config.json');
  assert.equal(r.stateDir, 'C:\\Users\\u\\AppData\\Local\\inactivity');
  const f = resolvePaths({}, 'win32', 'C:\\Users\\u');
  assert.equal(f.stateDir, 'C:\\Users\\u\\AppData\\Local\\inactivity');
});

test('resolvePaths: empty env values are ignored', () => {
  const r = resolvePaths({ INACTIVITY_HOME: '', XDG_CONFIG_HOME: '' }, 'linux', '/home/u');
  assert.equal(r.configHome, '/home/u/.config/inactivity');
});

test('defaultConfig is valid and independent between calls', () => {
  const a = defaultConfig();
  const v = validateConfig(a);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  a.availability.days.push('sat');
  assert.deepEqual(defaultConfig().availability.days, ['mon', 'tue', 'wed', 'thu', 'fri']);
});

test('validateConfig: minimal config gets every default', () => {
  const v = validateConfig(minimal);
  assert.equal(v.ok, true);
  assert.equal(v.config.availability.dailyPoints, 4);
  assert.deepEqual(v.config.availability.models, ['haiku', 'sonnet']);
  assert.equal(v.config.execution.mutationDelayMs, 1500);
  assert.equal(v.config.execution.timeoutMinutes.hard, 90);
  assert.equal(v.config.claude.path, 'claude');
  assert.equal(v.config.github.apiUrl, 'https://api.github.com');
  assert.equal(v.config.schedule.intervalMinutes, 10);
  assert.deepEqual(v.config.effort, {});
  assert.deepEqual(v.config.modelOverrides, {});
});

test('validateConfig: project defaults and repo cloneUrl', () => {
  const v = validateConfig({ ...minimal, projects: [project({ repos: { 'o/r': {}, 'o/s': { cloneUrl: 'git@x:o/s.git', baseBranch: 'dev' } } })] });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const p = v.config.projects[0];
  assert.equal(p.enabled, true);
  assert.equal(p.ownerType, null);
  assert.deepEqual(p.policy, { repo: 'o/r', path: '.inactivity/team.json' });
  assert.deepEqual(p.repos['o/r'], { cloneUrl: 'https://github.com/o/r.git', baseBranch: null });
  assert.equal(p.repos['o/s'].baseBranch, 'dev');
});

test('validateConfig: inline team is validated and normalized with pointer prefix', () => {
  const ok = validateConfig({ ...minimal, projects: [{ id: 'p', owner: 'o', number: 1, team: teamInline }] });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.config.projects[0].team.window.start, '06:00');
  const bad = validateConfig({ ...minimal, projects: [{ id: 'p', owner: 'o', number: 1, team: { ...teamInline, window: { start: '10:00', end: '09:00' } } }] });
  assert.ok(errPaths(bad).includes('/projects/0/team/window/end'));
});

test('validateConfig: error paths are JSON pointers', () => {
  const cases = [
    [{ projects: [] }, '/version'],
    [{ version: 1 }, '/projects'],
    [{ version: 1, projects: {} }, '/projects'],
    [{ ...minimal, bogus: 1 }, '/bogus'],
    [{ ...minimal, login: 5 }, '/login'],
    [{ ...minimal, projects: [project({ id: 'Bad Id' })] }, '/projects/0/id'],
    [{ ...minimal, projects: [project({ owner: '' })] }, '/projects/0/owner'],
    [{ ...minimal, projects: [project({ number: 0 })] }, '/projects/0/number'],
    [{ ...minimal, projects: [project({ ownerType: 'team' })] }, '/projects/0/ownerType'],
    [{ ...minimal, projects: [project({ policy: { repo: 'nope' } })] }, '/projects/0/policy/repo'],
    [{ ...minimal, projects: [project({ team: teamInline })] }, '/projects/0'],
    [{ ...minimal, projects: [{ id: 'p', owner: 'o', number: 1 }] }, '/projects/0'],
    [{ ...minimal, projects: [project({ repos: { bad: {} } })] }, '/projects/0/repos/bad'],
    [{ ...minimal, projects: [project({ repos: { 'o/r': { x: 1 } } })] }, '/projects/0/repos/o/r/x'],
    [{ ...minimal, projects: [project(), project()] }, '/projects/1/id'],
    [{ ...minimal, availability: { dailyPoints: -1 } }, '/availability/dailyPoints'],
    [{ ...minimal, availability: { maxTasksPerRun: 0 } }, '/availability/maxTasksPerRun'],
    [{ ...minimal, availability: { days: ['mon', 'funday'] } }, '/availability/days/1'],
    [{ ...minimal, availability: { models: ['gpt'] } }, '/availability/models/0'],
    [{ ...minimal, availability: { creditHeadroom: 'huge' } }, '/availability/creditHeadroom'],
    [{ ...minimal, availability: { pausedUntil: 'tomorrow-ish' } }, '/availability/pausedUntil'],
    [{ ...minimal, availability: { nope: 1 } }, '/availability/nope'],
    [{ ...minimal, modelOverrides: { gpt: 'x' } }, '/modelOverrides/gpt'],
    [{ ...minimal, effort: { opus: 'extreme' } }, '/effort/opus'],
    [{ ...minimal, execution: { timeoutMinutes: { easy: 0 } } }, '/execution/timeoutMinutes/easy'],
    [{ ...minimal, execution: { maxTurns: { easy: 1.5 } } }, '/execution/maxTurns/easy'],
    [{ ...minimal, execution: { mutationDelayMs: -5 } }, '/execution/mutationDelayMs'],
    [{ ...minimal, permissions: { denyPharoTools: 'image_evaluate' } }, '/permissions/denyPharoTools'],
    [{ ...minimal, pharo: { plexusCommand: [] } }, '/pharo/plexusCommand'],
    [{ ...minimal, pharo: { display: 'gui' } }, '/pharo/display'],
    [{ ...minimal, claude: { allowApiKey: 'yes' } }, '/claude/allowApiKey'],
    [{ ...minimal, git: { remote: '' } }, '/git/remote'],
    [{ ...minimal, schedule: { intervalMinutes: 2 } }, '/schedule/intervalMinutes'],
    [{ ...minimal, dryRun: 'no' }, '/dryRun'],
  ];
  for (const [input, expected] of cases) {
    const v = validateConfig(input);
    assert.equal(v.ok, false, `expected failure for ${expected}`);
    assert.ok(errPaths(v).includes(expected), `${expected} missing from ${JSON.stringify(v.errors)}`);
  }
});

test('validateConfig: non-object input', () => {
  const v = validateConfig([]);
  assert.equal(v.ok, false);
  assert.equal(v.config.version, 1);
});

test('validateConfig: partial execution tables merge over defaults; null budget omits the flag', () => {
  const v = validateConfig({ ...minimal, execution: { timeoutMinutes: { easy: 5 }, maxBudgetUsd: null } });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.config.execution.timeoutMinutes, { easy: 5, medium: 45, hard: 90 });
  assert.equal(v.config.execution.maxBudgetUsd, null);
});

test('validateConfig: normalization is idempotent', () => {
  const first = validateConfig({ ...minimal, availability: { days: ['fri', 'mon'], models: ['sonnet', 'haiku'] }, projects: [project()] });
  const second = validateConfig(first.config);
  assert.equal(second.ok, true, JSON.stringify(second.errors));
  assert.deepEqual(second.config, first.config);
  assert.deepEqual(first.config.availability.days, ['mon', 'fri']);
  assert.deepEqual(first.config.availability.models, ['haiku', 'sonnet']);
});

test('validateConfig: apiUrl trailing slash is trimmed; $schema is tolerated', () => {
  const v = validateConfig({ $schema: 'x', ...minimal, github: { apiUrl: 'https://ghe.example/api/v3/' } });
  assert.equal(v.ok, true);
  assert.equal(v.config.github.apiUrl, 'https://ghe.example/api/v3');
});

test('setByPath: sets nested keys without mutating the input', () => {
  const c = defaultConfig();
  const n = setByPath(c, 'availability.dailyPoints', 9);
  assert.equal(n.availability.dailyPoints, 9);
  assert.equal(c.availability.dailyPoints, 4);
  const m = setByPath(c, 'modelOverrides.opus', 'claude-opus-x');
  assert.equal(m.modelOverrides.opus, 'claude-opus-x');
  const arr = setByPath({ projects: [{ enabled: true }] }, 'projects.0.enabled', false);
  assert.equal(arr.projects[0].enabled, false);
  const created = setByPath({}, 'a.0.b', 1);
  assert.deepEqual(created, { a: [{ b: 1 }] });
});

test('setByPath: rejects empty segments, prototype keys, and non-object intermediates', () => {
  const c = defaultConfig();
  assert.throws(() => setByPath(c, 'a..b', 1), { code: 'bad-key' });
  assert.throws(() => setByPath(c, '__proto__.x', 1), { code: 'bad-key' });
  assert.throws(() => setByPath(c, 'dryRun.x', 1), { code: 'bad-key' });
  assert.equal({}.x, undefined);
});

async function withTmp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-config-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
const mkDeps = (dir) => ({ env: { INACTIVITY_HOME: dir }, platform: process.platform, homedir: () => '/nowhere', fs });

test('loadConfig: missing file -> no-config', async () => {
  await withTmp(async (dir) => {
    await assert.rejects(loadConfig(mkDeps(dir)), { code: 'no-config' });
  });
});

test('loadConfig: bad JSON -> bad-config', async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(path.join(dir, 'config.json'), '{nope');
    await assert.rejects(loadConfig(mkDeps(dir)), { code: 'bad-config' });
  });
});

test('saveConfig then loadConfig round-trips through INACTIVITY_HOME', async () => {
  await withTmp(async (dir) => {
    const home = path.join(dir, 'nested', 'home');
    const deps = mkDeps(home);
    const cfg = setByPath(defaultConfig(), 'availability.dailyPoints', 7);
    const written = await saveConfig(deps, cfg);
    assert.equal(written, path.join(home, 'config.json'));
    const loaded = await loadConfig(deps);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.config.availability.dailyPoints, 7);
    assert.deepEqual((await fs.readdir(home)).filter((f) => f.includes('tmp')), []);
  });
});

test('saveConfig: refuses invalid config and leaves the file untouched', async () => {
  await withTmp(async (dir) => {
    const deps = mkDeps(dir);
    await saveConfig(deps, defaultConfig());
    const before = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
    await assert.rejects(saveConfig(deps, { version: 1, projects: [], dryRun: 'x' }), { code: 'invalid-config' });
    assert.equal(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), before);
  });
});

test('loadConfig: validation errors are returned, not thrown', async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 2, projects: [] }));
    const r = await loadConfig(mkDeps(dir), { path: path.join(dir, 'config.json') });
    assert.deepEqual(r.errors.map((e) => e.path), ['/version']);
  });
});
