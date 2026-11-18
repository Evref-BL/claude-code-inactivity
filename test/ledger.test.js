import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createDeps } from '../src/deps.js';
import { acquireLock, loadState, saveState, cycleKey, newRun, appendLedger, readLedger, writeRun, readRun } from '../src/ledger.js';
import { memClock, tmpDirs } from './support/fakes.js';

const tmp = tmpDirs();
after(() => tmp.cleanup());

async function setup() {
  const dir = await tmp.make('pd-ledger-');
  const clock = memClock('2026-11-19T09:00:00Z');
  let n = 0;
  const deps = createDeps({ now: clock.now, randomHex: () => (n++).toString(16).padStart(4, '0') });
  return { dir, clock, deps };
}

test('lock: exclusive while the owner lives, released explicitly', async () => {
  const { dir, deps } = await setup();
  const a = await acquireLock(deps, { stateDir: dir, command: 'tick' });
  assert.ok(a);
  const info = JSON.parse(await fsp.readFile(path.join(dir, 'lock'), 'utf8'));
  assert.equal(info.pid, process.pid);
  assert.equal(info.command, 'tick');
  assert.equal(await acquireLock(deps, { stateDir: dir, command: 'run' }), null, 'held by a live process');
  await a.release();
  await a.release(); // idempotent
  const b = await acquireLock(deps, { stateDir: dir, command: 'run' });
  assert.ok(b);
  await b.release();
});

test('lock: a dead owner or an old lock is stale and taken over', async () => {
  const { dir, clock, deps } = await setup();
  await fsp.writeFile(path.join(dir, 'lock'), JSON.stringify({ pid: 2 ** 22 + 12345, hostname: (await import('node:os')).hostname(), startedAt: clock.iso(), command: 'tick' }));
  const taken = await acquireLock(deps, { stateDir: dir, command: 'tick' });
  assert.ok(taken, 'dead pid');
  await taken.release();
  await fsp.writeFile(path.join(dir, 'lock'), JSON.stringify({ pid: process.pid, hostname: 'other-host', startedAt: '2026-11-18T00:00:00Z', command: 'tick' }));
  const old = await acquireLock(deps, { stateDir: dir, command: 'tick', staleMs: 3600_000 });
  assert.ok(old, 'older than staleMs');
  await old.release();
  await fsp.writeFile(path.join(dir, 'lock'), '{half written');
  assert.ok(await acquireLock(deps, { stateDir: dir, command: 'tick' }), 'unreadable lock');
});

test('state: defaults, atomic round trip, pruning of old cycles', async () => {
  const { dir, deps } = await setup();
  const fresh = await loadState(deps, dir);
  assert.deepEqual(fresh, { v: 1, login: null, limit: { until: null, reason: null }, teamCache: {}, cycles: {}, leaks: [], lastTickAt: null });
  fresh.login = 'alice';
  fresh.cycles[cycleKey('board', '2026-11-19')] = { pointsUsed: 2 };
  fresh.cycles[cycleKey('board', '2026-11-01')] = { pointsUsed: 9 };
  await saveState(deps, dir, fresh);
  const back = await loadState(deps, dir);
  assert.equal(back.login, 'alice');
  assert.deepEqual(Object.keys(back.cycles), ['board:2026-11-19'], 'cycles older than 14 days are pruned');
  assert.deepEqual((await fsp.readdir(dir)).filter((f) => f.includes('tmp')), []);
});

test('runs and ledger: run ids, run.json, append-only ledger', async () => {
  const { dir, deps } = await setup();
  const r1 = await newRun(deps, { stateDir: dir });
  assert.match(r1.runId, /^20261119T090000Z-[0-9a-f]{4}$/);
  assert.equal(r1.runDir, path.join(dir, 'runs', r1.runId));
  const r2 = await newRun(deps, { stateDir: dir });
  assert.notEqual(r1.runId, r2.runId);
  await writeRun(deps, r1.runDir, { runId: r1.runId, outcome: 'done' });
  assert.deepEqual(await readRun(deps, r1.runDir), { runId: r1.runId, outcome: 'done' });
  assert.equal(await readRun(deps, r2.runDir), null);
  assert.deepEqual(await readLedger(deps, dir), []);
  for (let i = 0; i < 5; i += 1) await appendLedger(deps, dir, { event: i % 2 ? 'end' : 'start', i });
  await fsp.appendFile(path.join(dir, 'ledger.jsonl'), '{torn line\n');
  assert.deepEqual((await readLedger(deps, dir, { limit: 3 })).map((e) => e.i), [2, 3, 4]);
  assert.equal((await readLedger(deps, dir, { limit: 0 })).length, 5);
});

const mode = async (p) => (await fsp.stat(p)).mode & 0o777;

test('persistence is owner-only: state dir, runs, lock, state.json, run.json, ledger', { skip: process.platform === 'win32' }, async () => {
  const { dir, deps } = await setup();
  const state = path.join(dir, 'nested', 'state');
  await fsp.mkdir(state, { recursive: true, mode: 0o755 });
  await fsp.chmod(state, 0o755); // an existing, world-readable state dir is tightened
  const lock = await acquireLock(deps, { stateDir: state, command: 'tick' });
  assert.equal(await mode(state), 0o700);
  assert.equal(await mode(path.join(state, 'lock')), 0o600);
  await lock.release();
  await saveState(deps, state, await loadState(deps, state));
  assert.equal(await mode(path.join(state, 'state.json')), 0o600);
  const run = await newRun(deps, { stateDir: state });
  await writeRun(deps, run.runDir, { runId: run.runId });
  await appendLedger(deps, state, { event: 'start' });
  assert.equal(await mode(path.join(state, 'runs')), 0o700);
  assert.equal(await mode(run.runDir), 0o700);
  assert.equal(await mode(path.join(run.runDir, 'run.json')), 0o600);
  assert.equal(await mode(path.join(state, 'ledger.jsonl')), 0o600);
});

test('realExec tee target is created 0600 and runClaude redacts tokens out of the stored stream', { skip: process.platform === 'win32' }, async () => {
  const { dir } = await setup();
  const { realExec } = await import('../src/deps.js');
  const { runClaude } = await import('../src/claudeRun.js');
  const tee = path.join(dir, 'claude.stream.jsonl');
  const secret = `ghp_${'a1B2'.repeat(6)}`;
  const script = `process.stdout.write(JSON.stringify({type:'user',content:'token ${secret} and Authorization: Bearer abcdef123456'})+'\\n')`;
  await runClaude({ exec: realExec, now: () => new Date(), fs: fsp }, { cwd: dir, prompt: 'p', args: ['-e', script], env: { PATH: process.env.PATH }, timeoutMs: 10000, claudePath: process.execPath, teePath: tee });
  assert.equal(await mode(tee), 0o600);
  const text = await fsp.readFile(tee, 'utf8');
  assert.ok(!text.includes(secret) && !text.includes('abcdef123456'), text);
  assert.ok(text.includes('[redacted]'));
});
