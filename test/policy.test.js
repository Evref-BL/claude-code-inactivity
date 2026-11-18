import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTeam, digestTeam, cyclePhases, cycleDateFor, difficultyOf, priorityOf, priorityWeight, costOf,
  tierFor, sortCandidates, buildOffer, modelArgs, usedToday, teamDefaults,
} from '../src/policy.js';
import * as policyModule from '../src/policy.js';
import { defaultConfig, validateConfig } from '../src/config.js';

const base = { v: 1, timezone: 'Europe/Paris', roster: [{ login: 'Alice' }, { login: 'bob', maxCapacity: 3, models: ['haiku', 'sonnet'] }] };
const mkTeam = (extra = {}) => {
  const v = validateTeam({ ...base, ...extra });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  return v.team;
};
const errPaths = (input) => validateTeam(input).errors.map((e) => e.path);
const at = (iso) => new Date(iso);
// 2026-11-19 is a Thursday; Paris is UTC+1 in November, so 06:00 local = 05:00Z.
const item = (o = {}) => ({
  repo: 'Org/Repo', number: 1, id: 'Org/Repo#1', labels: [], authorAssociation: 'MEMBER', authorLogin: 'x',
  fields: { priority: null, difficulty: null, status: 'Todo', agent: null }, ...o,
});
const cfg = (patch = {}) => {
  const c = defaultConfig();
  c.availability = { ...c.availability, ...patch };
  return c;
};

test('validateTeam: defaults are filled and roster is normalized', () => {
  const t = mkTeam();
  assert.deepEqual(t.window, { start: '06:00', end: '10:00' });
  assert.equal(t.graceSeconds, 60);
  assert.equal(t.startDeadline, '11:30');
  assert.equal(t.executionEnd, '20:00');
  assert.deepEqual(t.priorityWeights, { P0: 1000, P1: 100, P2: 10, P3: 1 });
  assert.deepEqual(t.difficultyCost, { easy: 1, medium: 2, hard: 4 });
  assert.deepEqual(t.roster[0], { login: 'alice', display: 'Alice', maxCapacity: 8, models: ['haiku', 'sonnet', 'opus'] });
  assert.deepEqual(t.roster[1].models, ['haiku', 'sonnet']);
  assert.equal(t.roster[1].maxCapacity, 3);
});

test('validateTeam: normalization is idempotent', () => {
  const t = mkTeam({ cycleDays: ['fri', 'mon'] });
  const again = validateTeam(t);
  assert.equal(again.ok, true, JSON.stringify(again.errors));
  assert.deepEqual(again.team, t);
  assert.deepEqual(t.cycleDays, ['mon', 'fri']);
});

test('validateTeam: required fields and unknown keys', () => {
  assert.ok(errPaths({ timezone: 'Europe/Paris', roster: [{ login: 'a' }] }).includes('/v'));
  assert.ok(errPaths({ v: 1, roster: [{ login: 'a' }] }).includes('/timezone'));
  assert.ok(errPaths({ v: 1, timezone: 'Mars/Base', roster: [{ login: 'a' }] }).includes('/timezone'));
  assert.ok(errPaths({ v: 1, timezone: 'Europe/Paris' }).includes('/roster'));
  assert.ok(errPaths({ v: 1, timezone: 'Europe/Paris', roster: [] }).includes('/roster'));
  assert.ok(errPaths({ ...base, extra: 1 }).includes('/extra'));
  assert.equal(validateTeam(null).team, null);
});

test('validateTeam: window and deadline ordering rules', () => {
  assert.ok(errPaths({ ...base, window: { start: '10:00', end: '10:00' } }).includes('/window/end'));
  assert.ok(errPaths({ ...base, window: { start: '11:00', end: '09:00' } }).includes('/window/end'));
  // startDeadline must be >= window.end + grace
  assert.ok(errPaths({ ...base, startDeadline: '10:00' }).includes('/startDeadline'));
  assert.ok(errPaths({ ...base, startDeadline: '10:00', graceSeconds: 0 }).length === 0);
  assert.ok(errPaths({ ...base, startDeadline: '10:00', graceSeconds: 1 }).includes('/startDeadline'));
  assert.ok(errPaths({ ...base, executionEnd: '11:30' }).includes('/executionEnd'));
  assert.ok(errPaths({ ...base, executionEnd: '12:00', round2: { durationMinutes: 60 } }).includes('/round2/durationMinutes'));
  assert.deepEqual(errPaths({ ...base, round2: { enabled: false, durationMinutes: 5 }, executionEnd: '11:31' }), []);
  assert.ok(errPaths({ ...base, window: { start: '6:00' } }).includes('/window/start'));
  assert.ok(errPaths({ ...base, graceSeconds: 601 }).includes('/graceSeconds'));
});

test('validateTeam: enums, tables and collisions', () => {
  assert.ok(errPaths({ ...base, difficultyModel: { hard: 'gpt' } }).includes('/difficultyModel/hard'));
  assert.ok(errPaths({ ...base, difficultyModel: { trivial: 'haiku' } }).includes('/difficultyModel/trivial'));
  assert.ok(errPaths({ ...base, difficultyCost: { easy: 0 } }).includes('/difficultyCost/easy'));
  assert.ok(errPaths({ ...base, effort: { opus: 'ultra' } }).includes('/effort/opus'));
  assert.ok(errPaths({ ...base, fields: { priority: 'Status' } }).includes('/fields/status'));
  assert.ok(errPaths({ ...base, statusValues: { done: 'todo' } }).includes('/statusValues/done'));
  assert.ok(errPaths({ ...base, defaultDifficulty: 'trivial' }).includes('/defaultDifficulty'));
  assert.ok(errPaths({ ...base, trustedAssociations: 'OWNER' }).includes('/trustedAssociations'));
  assert.ok(errPaths({ ...base, priorityWeights: { P0: 'x' } }).includes('/priorityWeights/P0'));
  assert.ok(errPaths({ ...base, cycleDays: [] }).includes('/cycleDays'));
  assert.ok(errPaths({ ...base, maxClaimsPerMember: 0 }).includes('/maxClaimsPerMember'));
  assert.ok(errPaths({ ...base, fairness: { historyWeightPct: 101 } }).includes('/fairness/historyWeightPct'));
});

test('validateTeam: roster errors', () => {
  assert.ok(errPaths({ ...base, roster: [{ login: 'A' }, { login: 'a' }] }).includes('/roster/1/login'));
  assert.ok(errPaths({ ...base, roster: [{}] }).includes('/roster/0/login'));
  assert.ok(errPaths({ ...base, roster: [{ login: 'a', maxCapacity: -1 }] }).includes('/roster/0/maxCapacity'));
  assert.ok(errPaths({ ...base, roster: [{ login: 'a', models: ['x'] }] }).includes('/roster/0/models/0'));
  assert.ok(errPaths({ ...base, roster: [{ login: 'a', zzz: 1 }] }).includes('/roster/0/zzz'));
});

test('digestTeam: stable across key order and sensitive to content', () => {
  const t = mkTeam();
  const shuffled = Object.fromEntries(Object.entries(t).reverse());
  shuffled.window = { end: t.window.end, start: t.window.start };
  assert.equal(digestTeam(shuffled), digestTeam(t));
  assert.match(digestTeam(t), /^sha256:[0-9a-f]{64}$/);
  // Same policy written differently normalizes to the same digest.
  const verbose = mkTeam({ window: { start: '06:00', end: '10:00' }, graceSeconds: 60, cycleDays: ['fri', 'thu', 'wed', 'tue', 'mon'] });
  assert.equal(digestTeam(verbose), digestTeam(t));
  assert.notEqual(digestTeam(mkTeam({ graceSeconds: 61 })), digestTeam(t));
});

test('cyclePhases: boundaries of round 1 (Paris, winter)', () => {
  const t = mkTeam();
  const state = (iso) => cyclePhases(t, at(iso)).rounds[1].state;
  assert.equal(state('2026-11-19T04:59:59Z'), 'pending'); // 05:59:59 local
  assert.equal(state('2026-11-19T05:00:00Z'), 'open'); // 06:00:00 local
  assert.equal(state('2026-11-19T08:59:59Z'), 'open'); // 09:59:59 local
  assert.equal(state('2026-11-19T09:00:00Z'), 'closed'); // 10:00:00 local
  assert.equal(state('2026-11-19T09:00:59Z'), 'closed');
  assert.equal(state('2026-11-19T09:01:00Z'), 'resolved'); // + grace 60 s
  const p = cyclePhases(t, at('2026-11-19T07:00:00Z'));
  assert.equal(p.cycle, '2026-11-19');
  assert.equal(p.active, true);
  assert.equal(p.rounds[1].claimStart.toISOString(), '2026-11-19T05:00:00.000Z');
  assert.equal(p.rounds[1].claimEnd.toISOString(), '2026-11-19T09:00:00.000Z');
  assert.equal(p.rounds[1].resolveAt.toISOString(), '2026-11-19T09:01:00.000Z');
  assert.equal(p.rounds[2].claimStart.toISOString(), '2026-11-19T10:30:00.000Z');
  assert.equal(p.rounds[2].claimEnd.toISOString(), '2026-11-19T11:00:00.000Z');
  assert.equal(p.rounds[2].resolveAt.toISOString(), '2026-11-19T11:01:00.000Z');
  assert.equal(p.startDeadline.toISOString(), '2026-11-19T10:30:00.000Z');
  assert.equal(p.executionEnd.toISOString(), '2026-11-19T19:00:00.000Z');
});

test('cyclePhases: execution window overlaps round 2', () => {
  const t = mkTeam();
  assert.equal(cyclePhases(t, at('2026-11-19T09:00:30Z')).executionOpen, false); // grace
  assert.equal(cyclePhases(t, at('2026-11-19T09:01:00Z')).executionOpen, true);
  const mid = cyclePhases(t, at('2026-11-19T10:45:00Z'));
  assert.equal(mid.executionOpen, true);
  assert.equal(mid.rounds[2].state, 'open');
  assert.equal(cyclePhases(t, at('2026-11-19T18:59:59Z')).executionOpen, true);
  assert.equal(cyclePhases(t, at('2026-11-19T19:00:00Z')).executionOpen, false);
});

test('cyclePhases: inactive day and round 2 disabled', () => {
  const t = mkTeam({ round2: { enabled: false } });
  const sat = cyclePhases(t, at('2026-11-21T08:00:00Z'));
  assert.equal(sat.cycle, '2026-11-21');
  assert.equal(sat.active, false);
  assert.equal(sat.executionOpen, false);
  assert.equal(sat.rounds[2], null);
  assert.equal(cyclePhases(t, at('2026-11-19T08:00:00Z')).rounds[2], null);
});

test('cyclePhases / cycleDateFor: the cycle date follows the team zone, not UTC', () => {
  const ny = mkTeam({ timezone: 'America/New_York' });
  // 2026-11-19T03:00Z is still the 18th in New York (22:00 EST).
  assert.equal(cycleDateFor(ny, at('2026-11-19T03:00:00Z')), '2026-11-18');
  const p = cyclePhases(ny, at('2026-11-19T11:30:00Z')); // 06:30 EST on the 19th
  assert.equal(p.cycle, '2026-11-19');
  assert.equal(p.rounds[1].claimStart.toISOString(), '2026-11-19T11:00:00.000Z');
  assert.equal(p.rounds[1].state, 'open');
  const kolkata = mkTeam({ timezone: 'Asia/Kolkata' }); // UTC+5:30
  const k = cyclePhases(kolkata, at('2026-11-19T00:30:00Z'));
  assert.equal(k.rounds[1].claimStart.toISOString(), '2026-11-19T00:30:00.000Z');
  assert.equal(k.rounds[1].state, 'open');
});

test('cyclePhases: window across a DST change keeps local wall-clock times', () => {
  const t = mkTeam({ cycleDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] });
  // 2026-10-25: Paris falls back (UTC+2 -> UTC+1); window 06:00 local is after the change (UTC+1).
  const fall = cyclePhases(t, at('2026-10-25T06:00:00Z'));
  assert.equal(fall.rounds[1].claimStart.toISOString(), '2026-10-25T05:00:00.000Z');
  // 2027-03-28: spring forward; 06:00 local is UTC+2.
  const spring = cyclePhases(t, at('2027-03-28T05:00:00Z'));
  assert.equal(spring.rounds[1].claimStart.toISOString(), '2027-03-28T04:00:00.000Z');
  // A window starting inside the spring-forward gap (02:30) shifts forward to 03:30 local.
  const gap = mkTeam({ cycleDays: ['sun'], window: { start: '02:30', end: '04:00' }, startDeadline: '05:00', executionEnd: '12:00' });
  const g = cyclePhases(gap, at('2027-03-28T01:00:00Z'));
  assert.equal(g.rounds[1].claimStart.toISOString(), '2027-03-28T01:30:00.000Z');
});

test('priorityOf / priorityWeight: field, label fallback, default, unknown', () => {
  const t = mkTeam();
  assert.equal(priorityOf(item({ fields: { priority: 'P1' } }), t), 'P1');
  assert.equal(priorityOf(item({ fields: { priority: 'p0' } }), t), 'P0');
  assert.equal(priorityOf(item({ labels: ['bug', 'priority:P0'] }), t), 'P0');
  assert.equal(priorityOf(item({ labels: ['Priority:p3'] }), t), 'P3');
  assert.equal(priorityOf(item({ fields: { priority: 'P3' }, labels: ['priority:P0'] }), t), 'P3');
  assert.equal(priorityOf(item(), t), 'P2');
  assert.equal(priorityOf(item({ labels: ['priority:P0', 'priority:P1'] }), t), 'P0');
  assert.equal(priorityWeight(item({ fields: { priority: 'P1' } }), t), 100);
  assert.equal(priorityWeight(item(), t), 10);
  assert.equal(priorityWeight(item({ fields: { priority: 'Urgent' } }), t), 0);
  const off = mkTeam({ labelFallbacks: false });
  assert.equal(priorityOf(item({ labels: ['priority:P0'] }), off), 'P2');
});

test('difficultyOf / costOf / tierFor', () => {
  const t = mkTeam();
  assert.equal(difficultyOf(item({ fields: { difficulty: 'hard' } }), t), 'hard');
  assert.equal(difficultyOf(item({ fields: { difficulty: 'Easy' } }), t), 'easy');
  assert.equal(difficultyOf(item({ labels: ['difficulty:easy'] }), t), 'easy');
  assert.equal(difficultyOf(item({ fields: { difficulty: 'bogus' }, labels: ['difficulty:hard'] }), t), 'hard');
  assert.equal(difficultyOf(item(), t), 'medium');
  assert.equal(difficultyOf(item({ labels: ['difficulty:easy', 'difficulty:hard'] }), t), 'hard');
  assert.equal(difficultyOf(item({ labels: ['difficulty:easy'] }), mkTeam({ labelFallbacks: false })), 'medium');
  assert.equal(difficultyOf(item(), mkTeam({ defaultDifficulty: 'easy' })), 'easy');
  assert.equal(costOf('hard', t), 4);
  assert.equal(tierFor('easy', t), 'haiku');
  assert.equal(tierFor('hard', mkTeam({ difficultyModel: { hard: 'sonnet' } })), 'sonnet');
});

test('sortCandidates: priority desc, repo asc (case-insensitive), number asc; input untouched', () => {
  const t = mkTeam();
  const mk = (repo, number, priority) => item({ repo, number, id: `${repo}#${number}`, fields: { priority } });
  const input = [mk('b/x', 1, 'P2'), mk('A/y', 5, 'P2'), mk('a/y', 2, 'P2'), mk('z/z', 9, 'P0'), mk('c/c', 1, 'P1'), mk('c/c', 1, 'Weird')];
  const copy = [...input];
  const out = sortCandidates(input, t);
  assert.deepEqual(input, copy);
  assert.deepEqual(out.map((i) => i.id), ['z/z#9', 'c/c#1', 'a/y#2', 'A/y#5', 'b/x#1', 'c/c#1']);
  assert.equal(out[1].fields.priority, 'P1');
  const rev = sortCandidates([...input].reverse(), t);
  assert.deepEqual(rev.map((i) => `${i.id}:${i.fields.priority}`), out.map((i) => `${i.id}:${i.fields.priority}`));
});

test('trustedAssociations is deprecated: accepted, ignored, warned about, and not part of the shared digest', () => {
  const plain = validateTeam({ ...base });
  const legacy = validateTeam({ ...base, trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR', 'WHATEVER'] });
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.warnings.map((w) => w.path), ['/trustedAssociations']);
  assert.match(legacy.warnings[0].message, /per-member whitelist/);
  assert.deepEqual(plain.warnings, []);
  assert.equal('trustedAssociations' in legacy.team, false);
  assert.equal('trustedAssociations' in teamDefaults(), false);
  assert.equal(digestTeam(legacy.team), digestTeam(plain.team), 'every member computes the same cfg whatever they keep in the file');
  assert.equal('isTrustedAuthor' in policyModule, false, 'trust is no longer decided by the team policy');
});

const THU = at('2026-11-19T05:10:00Z');

test('buildOffer: defaults', () => {
  const t = mkTeam();
  // dailyPoints 4, maxTasksPerDay 2 * maxCost 4 = 8, maxCapacity 8 -> 4
  assert.deepEqual(buildOffer({ config: cfg(), team: t, login: 'alice', now: THU, state: null }), { capacity: 4, models: ['haiku', 'sonnet'] });
});

test('buildOffer: login match is case-insensitive; unknown member gets nothing', () => {
  const t = mkTeam();
  assert.ok(buildOffer({ config: cfg(), team: t, login: 'ALICE', now: THU }));
  assert.equal(buildOffer({ config: cfg(), team: t, login: 'mallory', now: THU }), null);
});

test('buildOffer: credit headroom factors (floor)', () => {
  const t = mkTeam();
  const cap = (headroom, dailyPoints) => buildOffer({ config: cfg({ creditHeadroom: headroom, dailyPoints, maxTasksPerDay: 10 }), team: t, login: 'alice', now: THU }).capacity;
  assert.equal(cap('low', 5), 2);
  assert.equal(cap('normal', 5), 5);
  assert.equal(cap('high', 5), 7);
  assert.equal(buildOffer({ config: cfg({ creditHeadroom: 'low', dailyPoints: 1, maxTasksPerDay: 10 }), team: t, login: 'alice', now: THU }), null);
});

test('buildOffer: clamped by roster.maxCapacity and by remainingTasks * maxCost', () => {
  const t = mkTeam();
  assert.equal(buildOffer({ config: cfg({ dailyPoints: 20, maxTasksPerDay: 10 }), team: t, login: 'bob', now: THU }).capacity, 3);
  assert.equal(buildOffer({ config: cfg({ dailyPoints: 20, maxTasksPerDay: 1 }), team: t, login: 'alice', now: THU }).capacity, 4);
  assert.equal(buildOffer({ config: cfg({ dailyPoints: 20, maxTasksPerDay: 10 }), team: t, login: 'alice', now: THU }).capacity, 8);
});

test('buildOffer: models are the intersection of member offer and roster ceiling', () => {
  const t = mkTeam();
  const c = cfg({ models: ['opus', 'sonnet'] });
  assert.deepEqual(buildOffer({ config: c, team: t, login: 'alice', now: THU }).models, ['sonnet', 'opus']);
  assert.deepEqual(buildOffer({ config: c, team: t, login: 'bob', now: THU }).models, ['sonnet']);
  assert.equal(buildOffer({ config: cfg({ models: ['opus'] }), team: t, login: 'bob', now: THU }), null);
});

test('buildOffer: pause, pausedUntil, day off, cycle day', () => {
  const t = mkTeam();
  assert.equal(buildOffer({ config: cfg({ paused: true }), team: t, login: 'alice', now: THU }), null);
  assert.equal(buildOffer({ config: cfg({ pausedUntil: '2026-11-20T00:00:00Z' }), team: t, login: 'alice', now: THU }), null);
  assert.ok(buildOffer({ config: cfg({ pausedUntil: '2026-11-19T05:00:00Z' }), team: t, login: 'alice', now: THU }));
  assert.equal(buildOffer({ config: cfg({ days: ['mon'] }), team: t, login: 'alice', now: THU }), null);
  const sat = at('2026-11-21T08:00:00Z');
  assert.equal(buildOffer({ config: cfg({ days: ['sat'] }), team: t, login: 'alice', now: sat }), null, 'team cycleDays exclude saturday');
  assert.ok(buildOffer({ config: cfg({ days: ['sat'] }), team: mkTeam({ cycleDays: ['sat'] }), login: 'alice', now: sat }));
});

test('buildOffer: usage limit blocks until it expires', () => {
  const t = mkTeam();
  const lim = (until) => ({ limit: { until, reason: 'limit' } });
  assert.equal(buildOffer({ config: cfg(), team: t, login: 'alice', now: THU, state: lim('2026-11-19T06:00:00Z') }), null);
  assert.ok(buildOffer({ config: cfg(), team: t, login: 'alice', now: THU, state: lim('2026-11-19T05:00:00Z') }));
  assert.ok(buildOffer({ config: cfg(), team: t, login: 'alice', now: THU, state: lim(null) }));
});

test('buildOffer: daily budget uses the ledger across projects of the cycle date', () => {
  const t = mkTeam();
  const c = cfg({ dailyPoints: 6, maxTasksPerDay: 3 });
  const state = {
    cycles: {
      'p1:2026-11-19': { pointsUsed: 2, tasksStarted: 1 },
      'p2:2026-11-19': { pointsUsed: 1, tasksStarted: 1 },
      'p1:2026-11-18': { pointsUsed: 6, tasksStarted: 3 },
    },
  };
  assert.deepEqual(usedToday(state, '2026-11-19'), { pointsUsed: 3, tasksStarted: 2 });
  const o = buildOffer({ config: c, team: t, login: 'alice', now: THU, state });
  assert.equal(o.capacity, 3); // 6 - 3 = 3; remainingTasks 1 * maxCost 4 = 4
  const tight = buildOffer({ config: cfg({ dailyPoints: 20, maxTasksPerDay: 3 }), team: t, login: 'alice', now: THU, state });
  assert.equal(tight.capacity, 4); // remaining task cap
  // Daily points exhausted
  const spent = { cycles: { 'p1:2026-11-19': { pointsUsed: 6, tasksStarted: 1 } } };
  assert.equal(buildOffer({ config: c, team: t, login: 'alice', now: THU, state: spent }), null);
  // Daily task count exhausted
  const full = { cycles: { 'p1:2026-11-19': { pointsUsed: 1, tasksStarted: 3 } } };
  assert.equal(buildOffer({ config: c, team: t, login: 'alice', now: THU, state: full }), null);
  assert.equal(buildOffer({ config: cfg({ maxTasksPerDay: 0 }), team: t, login: 'alice', now: THU }), null);
  assert.equal(buildOffer({ config: cfg({ dailyPoints: 0 }), team: t, login: 'alice', now: THU }), null);
});

test('modelArgs: table by difficulty with defaults', () => {
  const t = mkTeam();
  const c = defaultConfig();
  assert.deepEqual(modelArgs({ difficulty: 'easy', team: t, config: c }), { tier: 'haiku', model: 'haiku', effort: 'low', timeoutMs: 20 * 60000, maxTurns: 40, maxBudgetUsd: 1 });
  assert.deepEqual(modelArgs({ difficulty: 'medium', team: t, config: c }), { tier: 'sonnet', model: 'sonnet', effort: 'medium', timeoutMs: 45 * 60000, maxTurns: 80, maxBudgetUsd: 3 });
  assert.deepEqual(modelArgs({ difficulty: 'hard', team: t, config: c }), { tier: 'opus', model: 'opus', effort: 'high', timeoutMs: 90 * 60000, maxTurns: 150, maxBudgetUsd: 10 });
});

test('modelArgs: overrides, config effort beats team effort, null budget', () => {
  const t = mkTeam({ effort: { opus: 'max' }, difficultyModel: { medium: 'opus' } });
  const c = validateConfig({
    version: 1, projects: [], modelOverrides: { opus: 'claude-opus-pinned' }, effort: { sonnet: 'xhigh' },
    execution: { maxBudgetUsd: null, timeoutMinutes: { medium: 12.5 } },
  }).config;
  const m = modelArgs({ difficulty: 'medium', team: t, config: c });
  assert.equal(m.tier, 'opus');
  assert.equal(m.model, 'claude-opus-pinned');
  assert.equal(m.effort, 'max'); // config.effort.opus is unset -> team
  assert.equal(m.maxBudgetUsd, null);
  assert.equal(m.timeoutMs, 750000);
  const t2 = mkTeam();
  assert.equal(modelArgs({ difficulty: 'medium', team: t2, config: c }).effort, 'xhigh');
});

test('modelArgs: tolerates a partial config object', () => {
  const t = mkTeam();
  const m = modelArgs({ difficulty: 'hard', team: t, config: {} });
  assert.equal(m.model, 'opus');
  assert.equal(m.maxTurns, 150);
  assert.equal(m.maxBudgetUsd, 10);
});
