import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderScheduler,
  installScheduler,
  uninstallScheduler,
  copyApp,
  schedulerStatus,
  detectPlatform,
  decideTick,
  mergeCrontab,
  removeFromCrontab,
  formatCommands,
  systemdQuote,
  shQuote,
  CRON_BEGIN,
  CRON_END,
} from '../src/schedule.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.join(here, 'golden');

async function golden(name, actual) {
  const p = path.join(goldenDir, name);
  if (process.env.UPDATE_GOLDEN) {
    await fsp.mkdir(goldenDir, { recursive: true });
    await fsp.writeFile(p, actual);
  }
  const expected = await fsp.readFile(p, 'utf8');
  assert.equal(actual, expected, `golden mismatch: ${name}`);
}

const base = {
  nodePath: '/usr/local/bin/node',
  scriptPath: '/home/alice/.local/state/inactivity/app/current/bin/inactivity.js',
  intervalMinutes: 10,
  env: { PATH: '/home/alice/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
  stateDir: '/home/alice/.local/state/inactivity',
  home: '/home/alice',
};

// ---------------------------------------------------------------------------
// Generators (golden)
// ---------------------------------------------------------------------------

test('launchd plist golden', async () => {
  const plan = renderScheduler({ ...base, platform: 'darwin', home: '/Users/alice', uid: 501,
    nodePath: '/opt/homebrew/bin/node',
    scriptPath: '/Users/alice/.local/state/inactivity/app/current/bin/inactivity.js',
    stateDir: '/Users/alice/.local/state/inactivity' });
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].path, '/Users/alice/Library/LaunchAgents/io.inactivity.tick.plist');
  await golden('launchd.plist', plan.files[0].content);
  assert.deepEqual(plan.install.map((c) => c.args), [
    ['bootout', 'gui/501/io.inactivity.tick'],
    ['bootstrap', 'gui/501', '/Users/alice/Library/LaunchAgents/io.inactivity.tick.plist'],
  ]);
  assert.equal(plan.install[0].ignoreFailure, true);
  assert.deepEqual(plan.uninstall[0].args, ['bootout', 'gui/501/io.inactivity.tick']);
  assert.ok(plan.notes.some((n) => n.includes('pmset repeat wakeorpoweron MTWRF 05:55:00')));
});

test('launchd plist escapes XML and honours spaces and INACTIVITY_HOME', () => {
  const plan = renderScheduler({ ...base, platform: 'darwin', uid: 501, home: '/Users/A & B',
    scriptPath: '/Users/A & B/app <x>/bin/inactivity.js', pharoHome: '/Users/A & B/pd' });
  const c = plan.files[0].content;
  assert.ok(c.includes('<string>/Users/A &amp; B/app &lt;x&gt;/bin/inactivity.js</string>'));
  assert.ok(c.includes('<key>INACTIVITY_HOME</key>'));
  assert.ok(!c.includes('A & B'));
});

test('systemd service and timer golden', async () => {
  const plan = renderScheduler({ ...base, platform: 'linux-systemd' });
  const [service, timer] = plan.files;
  assert.equal(service.path, '/home/alice/.config/systemd/user/inactivity.service');
  assert.equal(timer.path, '/home/alice/.config/systemd/user/inactivity.timer');
  await golden('inactivity.service', service.content);
  await golden('inactivity.timer', timer.content);
  assert.deepEqual(plan.install.map((c) => c.args), [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', 'inactivity.timer'],
  ]);
  assert.ok(plan.notes.some((n) => n.includes('loginctl enable-linger $USER')));
});

test('systemd quoting for paths with spaces and percent signs', () => {
  const plan = renderScheduler({ ...base, platform: 'linux-systemd', home: '/home/a b',
    scriptPath: '/home/a b/100%/bin/inactivity.js' });
  const svc = plan.files[0].content;
  assert.ok(svc.includes('ExecStart=/usr/local/bin/node "/home/a b/100%%/bin/inactivity.js" tick --json'));
  assert.equal(systemdQuote('plain'), 'plain');
  assert.equal(systemdQuote('a"b'), '"a\\"b"');
});

test('timer interval is parameterised', () => {
  const plan = renderScheduler({ ...base, platform: 'linux-systemd', intervalMinutes: 30 });
  assert.ok(plan.files[1].content.includes('OnCalendar=*:0/30'));
});

test('crontab golden', async () => {
  const plan = renderScheduler({ ...base, platform: 'linux-cron' });
  assert.deepEqual(plan.files, []);
  await golden('crontab', plan.cron.block);
  assert.ok(plan.cron.block.startsWith(CRON_BEGIN + '\n'));
  assert.ok(plan.cron.block.endsWith(CRON_END + '\n'));
});

test('crontab quoting for spaces and percent', () => {
  const plan = renderScheduler({ ...base, platform: 'linux-cron', scriptPath: "/h/my dir/it's/100%/p.js" });
  assert.ok(plan.cron.block.includes(`'/h/my dir/it'\\''s/100\\%/p.js'`));
  assert.equal(shQuote('a b'), "'a b'");
});

test('windows schtasks golden', async () => {
  const plan = renderScheduler({ ...base, platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\Users\\alice\\AppData\\Local\\inactivity\\app\\current\\bin\\inactivity.js',
    stateDir: 'C:\\Users\\alice\\AppData\\Local\\inactivity', home: 'C:\\Users\\alice' });
  await golden('schtasks.txt', formatCommands(plan.install) + formatCommands(plan.uninstall));
  const args = plan.install[0].args;
  assert.deepEqual(args.slice(0, 8), ['/Create', '/TN', 'ClaudeCodeInActivity', '/SC', 'MINUTE', '/MO', '10', '/TR']);
  assert.equal(args.at(-1), '/F');
});

test('renderScheduler validates options', () => {
  assert.throws(() => renderScheduler({ ...base, platform: 'plan9' }), { code: 'bad-platform' });
  assert.throws(() => renderScheduler({ ...base, platform: 'darwin', nodePath: '' }), { code: 'bad-schedule-options' });
  assert.throws(() => renderScheduler({ ...base, platform: 'darwin', intervalMinutes: 0 }), { code: 'bad-schedule-options' });
});

// ---------------------------------------------------------------------------
// crontab merge
// ---------------------------------------------------------------------------

test('mergeCrontab is idempotent and preserves foreign lines', () => {
  const block = renderScheduler({ ...base, platform: 'linux-cron' }).cron.block;
  const existing = '0 1 * * * backup.sh\n';
  const once = mergeCrontab(existing, block);
  const twice = mergeCrontab(once, block);
  assert.equal(once, twice);
  assert.ok(once.startsWith('0 1 * * * backup.sh\n'));
  assert.equal(once.split(CRON_BEGIN).length, 2);
  const newer = block.replace('*/10', '*/20');
  const replaced = mergeCrontab(once, newer);
  assert.ok(replaced.includes('*/20') && !replaced.includes('*/10'));
  assert.equal(mergeCrontab('', block), block);
  assert.equal(removeFromCrontab(once), existing);
  assert.equal(removeFromCrontab(block), '');
});

// ---------------------------------------------------------------------------
// install / uninstall with fakes
// ---------------------------------------------------------------------------

function fakeFs() {
  const files = new Map();
  const modes = new Map();
  return {
    files,
    modes,
    async mkdir() {},
    async writeFile(p, c, o) { files.set(p, c); if (o?.mode) modes.set(p, o.mode); },
    async chmod(p, m) { modes.set(p, m); },
    async readFile(p) { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p); },
    async rm(p) { files.delete(p); },
  };
}

function fakeExec(handler) {
  const calls = [];
  const fn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const r = handler(cmd, args, opts);
    if (r === undefined) throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 0, ...r };
  };
  fn.calls = calls;
  return fn;
}

test('installScheduler writes files and runs commands in order (darwin)', async () => {
  const fs = fakeFs();
  const exec = fakeExec((cmd, args) => (args[0] === 'bootout' ? { code: 3 } : {}));
  const plan = renderScheduler({ ...base, platform: 'darwin', uid: 501, home: '/Users/alice' });
  const res = await installScheduler({ fs, exec }, plan, {});
  assert.equal(res.dryRun, false);
  assert.ok(fs.files.has(plan.files[0].path));
  assert.equal(fs.modes.get(plan.files[0].path), 0o644);
  assert.deepEqual(exec.calls.map((c) => c.args[0]), ['bootout', 'bootstrap']);
  assert.equal(res.commands[0].ok, false); // bootout failure ignored
});

test('installScheduler: failing non-ignorable command throws', async () => {
  const fs = fakeFs();
  const exec = fakeExec(() => ({ code: 1, stderr: 'boom' }));
  const plan = renderScheduler({ ...base, platform: 'linux-systemd' });
  await assert.rejects(installScheduler({ fs, exec }, plan, {}), { code: 'schedule-command-failed' });
});

test('installScheduler dry run touches nothing', async () => {
  const fs = fakeFs();
  const exec = fakeExec(() => undefined);
  const plan = renderScheduler({ ...base, platform: 'linux-systemd' });
  const res = await installScheduler({ fs, exec }, plan, { dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(exec.calls.length, 0);
  assert.equal(fs.files.size, 0);
  assert.equal(res.files.length, 2);
});

test('cron install reads crontab -l then writes merged text via stdin', async () => {
  const fs = fakeFs();
  let current = '5 5 * * * keep-me\n';
  const exec = fakeExec((cmd, args, opts) => {
    if (args[0] === '-l') return { stdout: current };
    if (args[0] === '-') { current = opts.stdin; return {}; }
    return undefined;
  });
  const plan = renderScheduler({ ...base, platform: 'linux-cron' });
  await installScheduler({ fs, exec }, plan, {});
  await installScheduler({ fs, exec }, plan, {});
  assert.equal(current.split(CRON_BEGIN).length, 2);
  assert.ok(current.includes('keep-me'));
  await uninstallScheduler({ fs, exec }, plan, {});
  assert.equal(current, '5 5 * * * keep-me\n');
});

test('cron install tolerates "no crontab for user"', async () => {
  const fs = fakeFs();
  let written = null;
  const exec = fakeExec((cmd, args, opts) => {
    if (args[0] === '-l') return { code: 1, stderr: 'no crontab for alice' };
    if (args[0] === '-') { written = opts.stdin; return {}; }
  });
  await installScheduler({ fs, exec }, renderScheduler({ ...base, platform: 'linux-cron' }), {});
  assert.ok(written.startsWith(CRON_BEGIN));
});

test('cron uninstall of the only block removes the crontab', async () => {
  const plan = renderScheduler({ ...base, platform: 'linux-cron' });
  const exec = fakeExec((cmd, args) => (args[0] === '-l' ? { stdout: plan.cron.block } : args[0] === '-r' ? {} : undefined));
  await uninstallScheduler({ fs: fakeFs(), exec }, plan, {});
  assert.deepEqual(exec.calls.map((c) => c.args[0]), ['-l', '-r']);
});

test('uninstallScheduler removes files and ignores missing units', async () => {
  const fs = fakeFs();
  const plan = renderScheduler({ ...base, platform: 'linux-systemd' });
  for (const f of plan.files) fs.files.set(f.path, f.content);
  const exec = fakeExec(() => ({ code: 5 }));
  const res = await uninstallScheduler({ fs, exec }, plan, {});
  assert.equal(fs.files.size, 0);
  assert.equal(res.dryRun, false);
  assert.deepEqual(exec.calls.map((c) => c.args.slice(0, 2).join(' ')), ['--user disable', '--user daemon-reload']);
});

test('windows install/uninstall commands', async () => {
  const exec = fakeExec(() => ({}));
  const plan = renderScheduler({ ...base, platform: 'win32' });
  await installScheduler({ fs: fakeFs(), exec }, plan, {});
  await uninstallScheduler({ fs: fakeFs(), exec }, plan, {});
  assert.equal(exec.calls[0].cmd, 'schtasks');
  assert.deepEqual(exec.calls[1].args, ['/Delete', '/TN', 'ClaudeCodeInActivity', '/F']);
});

test('detectPlatform', async () => {
  assert.equal(await detectPlatform({ platform: 'darwin' }), 'darwin');
  assert.equal(await detectPlatform({ platform: 'win32' }), 'win32');
  assert.equal(await detectPlatform({ platform: 'linux', exec: fakeExec(() => ({ code: 0 })) }), 'linux-systemd');
  assert.equal(await detectPlatform({ platform: 'linux', exec: fakeExec(() => ({ code: 1 })) }), 'linux-cron');
  assert.equal(await detectPlatform({ platform: 'linux', exec: async () => { throw new Error('ENOENT'); } }), 'linux-cron');
});

// ---------------------------------------------------------------------------
// copyApp (real fs, tmp dir)
// ---------------------------------------------------------------------------

test('copyApp copies the app and repoints current atomically', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pd-sched-'));
  try {
    const root = path.join(tmp, 'plugin root');
    await fsp.mkdir(path.join(root, 'bin'), { recursive: true });
    await fsp.mkdir(path.join(root, 'src'), { recursive: true });
    await fsp.writeFile(path.join(root, 'bin', 'inactivity.js'), 'v1');
    await fsp.writeFile(path.join(root, 'src', 'a.js'), 'a');
    await fsp.writeFile(path.join(root, 'package.json'), '{}');
    const stateDir = path.join(tmp, 'state');
    const deps = { fs: fsp, platform: 'linux', randomHex: () => 'abcd' };
    const r1 = await copyApp(deps, { fromRoot: root, stateDir, version: '0.1.0' });
    assert.equal(await fsp.readFile(r1.scriptPath, 'utf8'), 'v1');
    assert.equal(await fsp.readlink(r1.current), '0.1.0');
    await fsp.writeFile(path.join(root, 'bin', 'inactivity.js'), 'v2');
    const r2 = await copyApp(deps, { fromRoot: root, stateDir, version: '0.2.0' });
    assert.equal(await fsp.readFile(r2.scriptPath, 'utf8'), 'v2');
    assert.equal(await fsp.readFile(path.join(stateDir, 'app', '0.1.0', 'bin', 'inactivity.js'), 'utf8'), 'v1');
    const leftovers = (await fsp.readdir(path.join(stateDir, 'app'))).filter((n) => n.startsWith('current.tmp'));
    assert.deepEqual(leftovers, []);
    // win32 flavour copies instead of symlinking
    const rw = await copyApp({ ...deps, platform: 'win32' }, { fromRoot: root, stateDir, version: '0.3.0' });
    assert.equal((await fsp.lstat(rw.current)).isSymbolicLink(), false);
    assert.equal(await fsp.readFile(rw.scriptPath, 'utf8'), 'v2');
    await assert.rejects(copyApp(deps, { fromRoot: root, stateDir, version: '../x' }), { code: 'bad-version' });
    await assert.rejects(copyApp(deps, { fromRoot: tmp, stateDir, version: '1' }), { code: 'bad-app-root' });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// schedulerStatus
// ---------------------------------------------------------------------------

test('schedulerStatus reads back what render produced', async () => {
  for (const platform of ['darwin', 'linux-systemd']) {
    const fs = fakeFs();
    const opts = { ...base, platform, uid: 501, scriptPath: '/x y/app/current/bin/inactivity.js' };
    const plan = renderScheduler(opts);
    for (const f of plan.files) fs.files.set(f.path, f.content);
    const st = await schedulerStatus({ fs, exec: fakeExec(() => undefined) }, opts);
    assert.equal(st.installed, true, platform);
    assert.equal(st.scriptPath, opts.scriptPath, platform);
    assert.equal(st.current, true, platform);
    const stale = await schedulerStatus({ fs, exec: fakeExec(() => undefined) }, { ...opts, scriptPath: '/other.js' });
    assert.equal(stale.current, false);
  }
  const none = await schedulerStatus({ fs: fakeFs(), exec: fakeExec(() => undefined) }, { ...base, platform: 'darwin' });
  assert.equal(none.installed, false);
});

test('schedulerStatus cron and windows', async () => {
  const opts = { ...base, platform: 'linux-cron', scriptPath: '/a b/p.js' };
  const block = renderScheduler(opts).cron.block;
  const st = await schedulerStatus({ exec: fakeExec(() => ({ stdout: block })) }, opts);
  assert.deepEqual([st.installed, st.scriptPath, st.current], [true, '/a b/p.js', true]);
  const w = { ...base, platform: 'win32', scriptPath: 'C:\\pd\\p.js' };
  const stdout = 'Task To Run:  "C:\\node.exe" "C:\\pd\\p.js" tick --json\n';
  const sw = await schedulerStatus({ exec: fakeExec(() => ({ stdout })) }, w);
  assert.deepEqual([sw.installed, sw.current], [true, true]);
  const miss = await schedulerStatus({ exec: fakeExec(() => ({ code: 1 })) }, w);
  assert.equal(miss.installed, false);
});

// ---------------------------------------------------------------------------
// decideTick
// ---------------------------------------------------------------------------

const D = (iso) => new Date(iso);
/** Phases for a cycle with window 06:00-10:00 UTC, grace 60 s, deadline 11:30, round 2 30 min, end 20:00. */
function phasesAt(nowIso, { active = true, round2 = true } = {}) {
  const now = D(nowIso).getTime();
  const day = '2026-11-19';
  const mk = (round, s, e, grace) => {
    const claimStart = D(`${day}T${s}:00Z`);
    const claimEnd = D(`${day}T${e}:00Z`);
    const resolveAt = new Date(claimEnd.getTime() + grace * 1000);
    const state = now < claimStart ? 'pending' : now < claimEnd ? 'open' : now < resolveAt ? 'closed' : 'resolved';
    return { round, claimStart, claimEnd, resolveAt, state };
  };
  const r1 = mk(1, '06:00', '10:00', 60);
  return {
    cycle: day,
    active,
    rounds: { 1: r1, 2: round2 ? mk(2, '11:30', '12:00', 60) : null },
    startDeadline: D(`${day}T11:30:00Z`),
    executionEnd: D(`${day}T20:00:00Z`),
    executionOpen: now >= r1.resolveAt.getTime() && now < D(`${day}T20:00:00Z`).getTime(),
  };
}
const tickAt = (iso, extra = {}) => decideTick({ phases: phasesAt(iso, extra.p), now: D(iso), ...extra });

test('decideTick: idle before window, inactive day, paused', () => {
  const a = tickAt('2026-11-19T05:50:00Z');
  assert.deepEqual([a.phase, a.reason, a.needsNetwork], ['idle', 'before-window', false]);
  const b = tickAt('2026-11-19T07:00:00Z', { p: { active: false } });
  assert.deepEqual([b.phase, b.reason, b.needsNetwork], ['idle', 'inactive-day', false]);
  const c = tickAt('2026-11-19T07:00:00Z', { paused: true });
  assert.deepEqual([c.phase, c.reason], ['idle', 'paused']);
});

test('decideTick: claim inside the window, wait once claims are posted', () => {
  const a = tickAt('2026-11-19T06:10:00Z');
  assert.equal(a.phase, 'claim');
  assert.deepEqual(a.claimRounds, [1]);
  assert.equal(a.needsNetwork, true);
  const cs = { claimed: { 1: { postedAt: 'x', tasks: [] }, 2: null }, resolved: { 1: null, 2: null }, assigned: {} };
  const b = tickAt('2026-11-19T07:00:00Z', { cycleState: cs });
  assert.deepEqual([b.phase, b.reason, b.needsNetwork], ['wait', 'window-pending', false]);
  const c = tickAt('2026-11-19T10:00:30Z', { cycleState: cs });
  assert.deepEqual([c.phase, c.reason], ['wait', 'grace-period']);
});

test('decideTick: no offer means no claim', () => {
  const a = tickAt('2026-11-19T06:10:00Z', { hasOffer: false });
  assert.equal(a.phase, 'wait');
});

test('decideTick: resolve after grace, then execute', () => {
  const cs = { claimed: { 1: { postedAt: 'x', tasks: [] }, 2: null }, resolved: { 1: null, 2: null }, assigned: {} };
  const a = tickAt('2026-11-19T10:01:00Z', { cycleState: cs });
  assert.deepEqual([a.phase, a.resolveRounds], ['resolve', [1]]);
  const cs2 = { ...cs, resolved: { 1: { at: 'x', inputsDigest: 'd' }, 2: null },
    assigned: { 'o/r#2': { startedAt: null, outcome: null }, 'o/r#1': { startedAt: null, outcome: null },
      'o/r#3': { startedAt: '2026-11-19T10:05:00Z', outcome: null } } };
  const b = tickAt('2026-11-19T10:10:00Z', { cycleState: cs2 });
  assert.deepEqual([b.phase, b.executeTasks], ['execute', ['o/r#1', 'o/r#2']]);
});

test('decideTick: catch-up after a sleeping machine', () => {
  // Machine wakes at 10:30: window missed, nothing claimed, but a resolution is still computed.
  const cs = { claimed: { 1: null, 2: null }, resolved: { 1: null, 2: null }, assigned: {} };
  const a = tickAt('2026-11-19T10:30:00Z', { cycleState: cs });
  assert.deepEqual([a.phase, a.claimRounds, a.resolveRounds], ['resolve', [], [1]]);
  // Wakes at 09:50: still inside the window, still claims.
  const b = tickAt('2026-11-19T09:50:00Z', { cycleState: cs });
  assert.deepEqual([b.phase, b.claimRounds], ['claim', [1]]);
  // Wakes at 11:45 (round 2 open, round 1 unresolved locally): claim round 2 and resolve round 1 in one tick.
  const c = tickAt('2026-11-19T11:45:00Z', { cycleState: cs });
  assert.deepEqual([c.phase, c.claimRounds, c.resolveRounds], ['claim', [2], [1]]);
  // Wakes at 12:30, both rounds resolved remotely, nothing local: resolve both, no claims.
  const d = tickAt('2026-11-19T12:30:00Z', { cycleState: cs });
  assert.deepEqual([d.phase, d.claimRounds, d.resolveRounds], ['resolve', [], [1, 2]]);
});

test('decideTick: claim phase still lists pending executions', () => {
  const cs = { claimed: { 1: { postedAt: 'x', tasks: [] }, 2: null }, resolved: { 1: { at: 'x', inputsDigest: 'd' }, 2: null },
    assigned: { 'o/r#1': { startedAt: null, outcome: null } } };
  const a = tickAt('2026-11-19T11:40:00Z', { cycleState: cs });
  assert.deepEqual([a.phase, a.claimRounds, a.executeTasks], ['claim', [2], ['o/r#1']]);
});

test('decideTick: usage limit blocks execution until it expires', () => {
  const cs = { claimed: { 1: { postedAt: 'x', tasks: [] }, 2: { postedAt: 'y', tasks: [] } },
    resolved: { 1: { at: 'x', inputsDigest: 'd' }, 2: { at: 'x', inputsDigest: 'd' } },
    assigned: { 'o/r#1': { startedAt: null, outcome: null } } };
  const limited = tickAt('2026-11-19T13:00:00Z', { cycleState: cs, limitUntil: '2026-11-19T15:00:00Z' });
  assert.deepEqual([limited.phase, limited.reason], ['wait', 'limit']);
  const expired = tickAt('2026-11-19T15:00:00Z', { cycleState: cs, limitUntil: '2026-11-19T15:00:00Z' });
  assert.equal(expired.phase, 'execute');
});

test('decideTick: done when everything is finished or the day ended', () => {
  const cs = { claimed: { 1: { postedAt: 'x', tasks: [] }, 2: { postedAt: 'y', tasks: [] } },
    resolved: { 1: { at: 'x', inputsDigest: 'd' }, 2: { at: 'x', inputsDigest: 'd' } },
    assigned: { 'o/r#1': { startedAt: 'a', outcome: 'done' } } };
  const a = tickAt('2026-11-19T13:00:00Z', { cycleState: cs });
  assert.deepEqual([a.phase, a.reason, a.needsNetwork], ['done', 'all-resolved', false]);
  const b = tickAt('2026-11-19T20:00:00Z', { cycleState: null });
  assert.deepEqual([b.phase, b.reason], ['done', 'execution-ended']);
  const c = tickAt('2026-11-19T21:00:00Z', { hasLeaks: true });
  assert.equal(c.reason, 'janitor-only');
});

test('decideTick: round 2 disabled', () => {
  const cs = { claimed: { 1: { postedAt: 'x', tasks: [] }, 2: null },
    resolved: { 1: { at: 'x', inputsDigest: 'd' }, 2: null }, assigned: {} };
  const a = tickAt('2026-11-19T11:45:00Z', { cycleState: cs, p: { round2: false } });
  assert.equal(a.phase, 'done');
});

test('decideTick is pure: same input, same output, input untouched', () => {
  const cs = { claimed: { 1: null, 2: null }, resolved: { 1: null, 2: null }, assigned: {} };
  const snapshot = JSON.stringify(cs);
  const x = tickAt('2026-11-19T06:10:00Z', { cycleState: cs });
  const y = tickAt('2026-11-19T06:10:00Z', { cycleState: cs });
  assert.deepEqual(x, y);
  assert.equal(JSON.stringify(cs), snapshot);
});
