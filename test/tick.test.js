import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planProject, isPaused } from '../src/tick.js';
import { validateTeam } from '../src/policy.js';
import { cycleKey } from '../src/ledger.js';

const team = validateTeam({ v: 1, timezone: 'Europe/Paris', roster: [{ login: 'alice' }, { login: 'bob' }] }).team;
const project = { id: 'board' };
const D = (hhmm, date = '2026-11-19') => new Date(`${date}T${hhmm}:00Z`); // Paris = UTC+1 in November
const baseConfig = { availability: { paused: false, pausedUntil: null, days: ['mon', 'tue', 'wed', 'thu', 'fri'], dailyPoints: 4, maxTasksPerDay: 2, models: ['haiku', 'sonnet'], creditHeadroom: 'normal' } };
const plan = (hhmm, extra = {}) => planProject({ team, now: D(hhmm, extra.date), state: extra.state ?? { cycles: {}, leaks: [] }, project, config: extra.config ?? baseConfig, login: 'alice' });

test('planProject: no network before the window, on a day off, or after the end of the day', () => {
  assert.deepEqual([plan('04:30').needsNetwork, plan('04:30').reason], [false, 'before-window']);
  assert.deepEqual([plan('04:30', { date: '2026-11-21' }).needsNetwork, plan('04:30', { date: '2026-11-21' }).reason], [false, 'inactive-day']);
  assert.equal(plan('19:30').needsNetwork, false, '20:30 Paris: execution ended');
  assert.equal(plan('19:30').reason, 'execution-ended');
});

test('planProject: claim while open (once), resolve after the grace period, execute what is pending', () => {
  assert.deepEqual(plan('05:10').claimRounds, [1]);
  assert.equal(plan('05:10').needsNetwork, true);
  const key = cycleKey('board', '2026-11-19');
  const claimed = { cycles: { [key]: { claimed: { 1: { tasks: ['a/b#1'] }, 2: null }, resolved: { 1: null, 2: null }, assigned: {} } }, leaks: [] };
  assert.deepEqual(plan('05:30', { state: claimed }).claimRounds, []);
  assert.equal(plan('09:00', { state: claimed }).reason, 'grace-period');
  assert.equal(plan('09:00', { state: claimed }).needsNetwork, false);
  assert.deepEqual(plan('09:05', { state: claimed }).resolveRounds, [1]);
  const resolved = { cycles: { [key]: { claimed: { 1: { tasks: [] }, 2: null }, resolved: { 1: { at: 'x' }, 2: null }, assigned: { 'a/b#1': { round: 1, startedAt: null, outcome: null } } } }, leaks: [] };
  const exec = plan('09:30', { state: resolved });
  assert.equal(exec.canRun, true);
  assert.equal(exec.needsNetwork, true);
  const finished = { cycles: { [key]: { ...resolved.cycles[key], assigned: { 'a/b#1': { round: 1, startedAt: 'x', outcome: 'done' } } } }, leaks: [] };
  assert.equal(plan('09:30', { state: finished }).canRun, false);
});

test('planProject: a usage limit blocks execution, a missing offer blocks claiming', () => {
  const key = cycleKey('board', '2026-11-19');
  const state = {
    limit: { until: '2026-11-19T14:00:00Z', reason: 'limit' },
    cycles: { [key]: { claimed: { 1: { tasks: [] }, 2: null }, resolved: { 1: { at: 'x' }, 2: null }, assigned: { 'a/b#1': { round: 1, startedAt: null, outcome: null } } } },
    leaks: [],
  };
  const p = plan('09:30', { state });
  assert.equal(p.canRun, false);
  assert.equal(p.reason, 'limit');
  const noOffer = plan('05:10', { config: { availability: { ...baseConfig.availability, dailyPoints: 0 } } });
  assert.deepEqual(noOffer.claimRounds, []);
});

test('isPaused: flag or future pausedUntil', () => {
  assert.equal(isPaused({ availability: { paused: true } }, D('05:00')), true);
  assert.equal(isPaused({ availability: { paused: false, pausedUntil: '2026-11-20T00:00:00Z' } }, D('05:00')), true);
  assert.equal(isPaused({ availability: { paused: false, pausedUntil: '2026-11-18T00:00:00Z' } }, D('05:00')), false);
  assert.equal(isPaused({ availability: {} }, D('05:00')), false);
});
