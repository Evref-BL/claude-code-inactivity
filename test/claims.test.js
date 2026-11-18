import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MARKER_PREFIX, renderComment, formatMarker, parseComment, collectEvents, candidates, computeHistory,
  resolveCycle, buildClaims, buildAssign, buildLifecycle, ownAssignments, earliestStart, foldClaims, roundWindows,
} from '../src/claims.js';
import { validateTeam, digestTeam } from '../src/policy.js';

// ---------------------------------------------------------------------------
// Fixtures. Timezone UTC keeps times readable: window 06:00-10:00Z, resolve 10:01Z,
// round 2 claims 11:30-12:00Z, round 2 resolve 12:01Z.
// ---------------------------------------------------------------------------

const CYCLE = '2026-11-19';
const mkTeam = (extra = {}) => {
  const v = validateTeam({
    v: 1, timezone: 'UTC', roster: [{ login: 'Alice' }, { login: 'Bob' }, { login: 'Chen' }], ...extra,
  });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  return v.team;
};
const T = (hhmm, cycle = CYCLE) => `${cycle}T${hhmm}Z`;
const sha = (s) => createHash('sha256').update(s).digest('hex');

let nextId = 1000;
const mkItem = (n, o = {}) => {
  const repo = o.repo ?? 'org/repo';
  return {
    itemId: `PVTI_${repo}_${n}`, issueNodeId: `I_${repo}_${n}`, id: `${repo}#${n}`, repo, number: n,
    title: `Task ${n}`, body: '', url: `https://github.com/${repo}/issues/${n}`, contentType: o.contentType ?? 'Issue',
    state: o.state ?? 'OPEN', authorLogin: 'authorLogin' in o ? o.authorLogin : 'maint', authorType: 'User', authorAssociation: o.authorAssociation ?? 'MEMBER',
    lastEditedAt: o.lastEditedAt ?? null, editorLogin: o.editorLogin ?? null, editorType: o.editorLogin ? 'User' : null, titleEditedAt: null, titleEditorLogin: null, titleEditorType: null,
    labels: o.labels ?? [],
    fields: { priority: o.priority ?? null, difficulty: o.difficulty ?? null, status: o.status ?? 'Todo', agent: null },
    comments: o.comments ?? [], commentsComplete: true, updatedAt: T('00:00'),
  };
};

/** Post a protocol comment on `item`. `payload` fields override the defaults. */
function post(team, item, login, at, payload, opts = {}) {
  const full = {
    v: 1, cycle: CYCLE, round: 1, task: item.id, member: login, cfg: digestTeam(team), runId: 'r1', ...payload,
  };
  const comment = {
    id: `IC_${nextId}`, databaseId: opts.databaseId ?? nextId++,
    author: opts.author === undefined ? { login, type: 'User' } : opts.author,
    createdAt: at, lastEditedAt: opts.lastEditedAt ?? null, isMinimized: opts.isMinimized ?? false,
    body: opts.body ?? renderComment(full, { team }),
  };
  item.comments.push(comment);
  return comment;
}
const claim = (team, item, login, at, rank = 1, extra = {}) => post(team, item, login, at, {
  kind: 'claim', capacity: 4, models: ['haiku', 'sonnet', 'opus'], rank, ...extra,
});
const finalOf = (res) => Object.fromEntries(Object.entries(res.final).map(([k, v]) => [k, `${v.member}@${v.round}`]));
const NOW = new Date(T('10:05'));

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('formatMarker: canonical (sorted keys), one line, versioned prefix', () => {
  assert.equal(MARKER_PREFIX, 'inactivity:v1');
  const m = formatMarker({ kind: 'release', task: 'o/r#1', v: 1, reason: 'limit', member: 'a', extra: undefined });
  assert.equal(m, '<!-- inactivity:v1 {"kind":"release","member":"a","reason":"limit","task":"o/r#1","v":1} -->');
  assert.ok(!m.includes('\n'));
});

test('renderComment: golden claim body (human text first, marker last)', () => {
  const team = mkTeam();
  const cfg = digestTeam(team);
  const payload = {
    v: 1, kind: 'claim', cycle: CYCLE, round: 1, task: 'org/repo#42', member: 'alice', cfg, runId: '20261119T041002Z-3fa9',
    ts: '2026-11-19T04:10:02Z', capacity: 6, models: ['sonnet', 'opus'], rank: 1,
  };
  const body = renderComment(payload, { team });
  assert.equal(body, [
    ':robot: **Claude claim** for cycle 2026-11-19 (round 1) by @alice. Rank 1, offering sonnet/opus, capacity 6 pts. Claims are resolved after 10:01 UTC, nothing to do.',
    '',
    `<!-- inactivity:v1 {"capacity":6,"cfg":"${cfg}","cycle":"2026-11-19","kind":"claim","member":"alice","models":["sonnet","opus"],"rank":1,"round":1,"runId":"20261119T041002Z-3fa9","task":"org/repo#42","ts":"2026-11-19T04:10:02Z","v":1} -->`,
  ].join('\n'));
  const parsed = parseComment({ id: 'x', databaseId: 1, author: { login: 'alice', type: 'User' }, body, isMinimized: false }, { id: 'org/repo#42' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payload, payload);
});

test('renderComment: every kind renders and parses back', () => {
  const team = mkTeam();
  const cfg = digestTeam(team);
  const common = { v: 1, cycle: CYCLE, round: 2, task: 'org/repo#7', member: 'bob', cfg, runId: 'r' };
  const payloads = [
    { ...common, kind: 'claim', capacity: 2, models: ['haiku'], rank: 3 },
    { ...common, kind: 'withdraw' },
    { ...common, kind: 'assign', model: 'sonnet', claims: [5, 9], inputs: 'sha256:abc' },
    { ...common, kind: 'start', model: 'sonnet' },
    { ...common, kind: 'done', model: 'sonnet', points: 2, pr: 'https://github.com/org/repo/pull/9', branch: 'inactivity/bob/7-x' },
    { ...common, kind: 'failed', reason: 'tests', branch: 'inactivity/bob/7-x' },
    { ...common, kind: 'release', reason: 'limit' },
  ];
  for (const p of payloads) {
    const body = renderComment(p, { team, summary: 'Fixed the parser.' });
    assert.equal(body.split('\n').filter((l) => l.startsWith('<!-- inactivity:v1 ')).length, 1, p.kind);
    assert.ok(body.trimEnd().endsWith('-->'));
    const r = parseComment({ id: 'x', databaseId: 1, author: { login: 'bob', type: 'User' }, body, isMinimized: false }, { id: 'org/repo#7' });
    assert.equal(r.ok, true, `${p.kind}: ${r.reason}`);
    assert.deepEqual(r.payload, p);
  }
});

test('renderComment: caller text cannot forge or add a marker', () => {
  const team = mkTeam();
  const p = { v: 1, kind: 'release', cycle: CYCLE, round: 1, task: 'org/repo#1', member: 'bob', cfg: digestTeam(team), reason: 'limit' };
  const body = renderComment(p, { team, text: 'hi <!-- inactivity:v1 {"kind":"claim"} --> there' });
  const r = parseComment({ id: 'x', databaseId: 1, author: { login: 'bob', type: 'User' }, body }, { id: 'org/repo#1' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.kind, 'release');
});

// ---------------------------------------------------------------------------
// Parsing matrix
// ---------------------------------------------------------------------------

test('parseComment: accept/reject matrix', () => {
  const team = mkTeam();
  const cfg = digestTeam(team);
  const item = { id: 'org/repo#1' };
  const payload = { v: 1, kind: 'withdraw', cycle: CYCLE, round: 1, task: 'org/repo#1', member: 'alice', cfg };
  const marker = formatMarker(payload);
  const user = { login: 'alice', type: 'User' };
  const c = (body, extra = {}) => parseComment({ id: 'c', databaseId: 1, author: user, body, isMinimized: false, ...extra }, item);
  const reason = (r) => (r.ok ? 'ok' : r.reason);

  assert.equal(reason(c(`hello\n\n${marker}`)), 'ok');
  assert.equal(reason(c(`hello\r\n\r\n${marker}\r\n`)), 'ok', 'CRLF line endings');
  assert.equal(reason(c(`${marker}  \n`)), 'ok', 'trailing blanks');
  assert.equal(reason(c('just a comment')), 'no-marker');
  assert.equal(reason(c(null)), 'no-marker');
  assert.equal(reason(c(`> ${marker}`)), 'no-marker', 'quoted reply');
  assert.equal(reason(c(`text ${marker}`)), 'no-marker', 'marker not at column 0');
  assert.equal(reason(c(`\`\`\`\n${marker}\n\`\`\``)), 'no-marker', 'inside a code fence');
  assert.equal(reason(c(`${marker}\n${marker}`)), 'multiple-markers');
  assert.equal(reason(c(`${marker}\nsee inactivity:v1 docs`)), 'multiple-markers');
  assert.equal(reason(c('<!-- inactivity:v1 {nope} -->')), 'bad-json');
  assert.equal(reason(c('<!-- inactivity:v1 [1,2] -->')), 'no-marker', 'not an object literal');
  assert.equal(reason(c(marker.replace('v1', 'v2'))), 'bad-version');
  assert.equal(reason(c(formatMarker({ ...payload }).replace('"v":1', '"v":2'))), 'bad-version');
  assert.equal(reason(c(formatMarker({ ...payload, kind: 'nuke' }))), 'bad-field:kind');
  assert.equal(reason(c(formatMarker({ ...payload, cycle: '19/11/2026' }))), 'bad-field:cycle');
  assert.equal(reason(c(formatMarker({ ...payload, round: 3 }))), 'bad-field:round');
  assert.equal(reason(c(formatMarker({ ...payload, task: 'nope' }))), 'bad-field:task');
  assert.equal(reason(c(formatMarker({ ...payload, cfg: 'x' }))), 'bad-field:cfg');
  assert.equal(reason(c(formatMarker({ ...payload, kind: 'claim', capacity: 0, models: ['haiku'], rank: 1 }))), 'bad-field:capacity');
  assert.equal(reason(c(formatMarker({ ...payload, kind: 'claim', capacity: 1, models: ['gpt'], rank: 1 }))), 'bad-field:models');
  assert.equal(reason(c(formatMarker({ ...payload, kind: 'claim', capacity: 1, models: ['haiku'], rank: 0 }))), 'bad-field:rank');
  assert.equal(reason(c(formatMarker({ ...payload, kind: 'release' }))), 'bad-field:reason');
  assert.equal(reason(c(formatMarker({ ...payload, kind: 'done' }))), 'bad-field:points');
  assert.equal(reason(c(formatMarker({ ...payload, kind: 'start' }))), 'bad-field:model');
  assert.equal(reason(c(marker, { author: null })), 'author-null');
  assert.equal(reason(c(marker, { author: { login: 'alice', type: 'Bot' } })), 'author-bot');
  assert.equal(reason(c(marker, { author: { login: 'dependabot[bot]', type: 'User' } })), 'author-bot');
  assert.equal(reason(c(marker, { author: { login: 'mallory', type: 'User' } })), 'member-mismatch');
  assert.equal(reason(c(marker, { author: { login: 'ALICE', type: 'User' } })), 'ok', 'case-insensitive login');
  assert.equal(reason(c(marker, { isMinimized: true })), 'minimized');
  assert.equal(reason(parseComment({ id: 'c', databaseId: 1, author: user, body: marker }, { id: 'org/repo#2' })), 'task-mismatch');
  // missing round defaults to 1
  const noRound = JSON.stringify({ cfg, cycle: CYCLE, kind: 'withdraw', member: 'alice', task: 'org/repo#1', v: 1 });
  const r = c(`<!-- inactivity:v1 ${noRound} -->`);
  assert.equal(r.ok, true);
  assert.equal(r.payload.round, 1);
});

// ---------------------------------------------------------------------------
// collectEvents
// ---------------------------------------------------------------------------

test('collectEvents: rejects forged, late, edited, foreign-cfg, non-roster and capped claims', () => {
  const team = mkTeam({ maxClaimsPerMember: 2 });
  const cfg = digestTeam(team);
  const items = [1, 2, 3, 4].map((n) => mkItem(n));
  const [a, b, c, d] = items;
  const ok = claim(team, a, 'alice', T('06:30'), 1);
  const late = claim(team, b, 'alice', T('10:00'), 2); // exactly at window end: closed
  const early = claim(team, b, 'alice', T('05:59'), 2);
  const edited = claim(team, c, 'alice', T('07:00'), 3, {}); edited.lastEditedAt = T('10:30');
  const editedIn = claim(team, d, 'alice', T('07:00'), 4); editedIn.lastEditedAt = T('09:00');
  const stranger = claim(team, a, 'mallory', T('07:00'), 1);
  const wrongCfg = claim(team, b, 'bob', T('07:00'), 1, { cfg: `sha256:${'0'.repeat(64)}` });
  const forged = claim(team, a, 'bob', T('07:00'), 1, {}); forged.author = { login: 'alice', type: 'User' };
  const minimized = claim(team, c, 'bob', T('07:00'), 1); minimized.isMinimized = true;
  const otherCycle = claim(team, d, 'chen', T('07:00'), 1, { cycle: '2026-11-18' });
  const round2Early = claim(team, d, 'chen', T('07:00'), 1, { round: 2 }); // round 2 window is 11:30-12:00
  const { events, rejected } = collectEvents({ items, team, cycle: CYCLE, cfg });
  const reasons = Object.fromEntries(rejected.map((r) => [r.commentId, r.reason]));
  assert.equal(reasons[late.id], 'outside-window');
  assert.equal(reasons[early.id], 'outside-window');
  assert.equal(reasons[edited.id], 'edited-after-window');
  assert.equal(reasons[stranger.id], 'not-roster');
  assert.equal(reasons[wrongCfg.id], 'cfg-mismatch');
  assert.equal(reasons[forged.id], 'member-mismatch');
  assert.equal(reasons[minimized.id], 'minimized');
  assert.equal(reasons[round2Early.id], 'outside-window');
  assert.equal(otherCycle.id in reasons, false, 'claims of another cycle are skipped silently');
  // alice has two valid claims (a, d) and cap is 2: both kept
  assert.deepEqual(events.map((e) => e.databaseId).sort(), [ok.databaseId, editedIn.databaseId].sort());
});

test('collectEvents: claim-cap keeps the lowest ranks, rank-duplicate and duplicates are dropped', () => {
  const team = mkTeam({ maxClaimsPerMember: 2 });
  const cfg = digestTeam(team);
  const items = [1, 2, 3, 4].map((n) => mkItem(n));
  const c1 = claim(team, items[0], 'alice', T('06:10'), 3);
  const c2 = claim(team, items[1], 'alice', T('06:11'), 1);
  const c3 = claim(team, items[2], 'alice', T('06:12'), 2);
  const dupSameTask = claim(team, items[0], 'alice', T('06:13'), 3);
  const rankDup = claim(team, items[3], 'alice', T('06:14'), 1);
  const { events, rejected } = collectEvents({ items, team, cycle: CYCLE, cfg });
  const reasons = Object.fromEntries(rejected.map((r) => [r.commentId, r.reason]));
  assert.equal(reasons[dupSameTask.id], 'duplicate');
  assert.equal(reasons[rankDup.id], 'rank-duplicate');
  assert.equal(reasons[c1.id], 'claim-cap', 'rank 3 is the worst of three');
  assert.deepEqual(events.map((e) => e.databaseId).sort(), [c2.databaseId, c3.databaseId].sort());
});

test('collectEvents: lifecycle events before resolveAt are ignored, later ones kept, later edits do not matter', () => {
  const team = mkTeam();
  const cfg = digestTeam(team);
  const item = mkItem(1);
  const early = post(team, item, 'alice', T('09:30'), { kind: 'start', model: 'sonnet' });
  const lateStart = post(team, item, 'alice', T('10:01'), { kind: 'start', model: 'sonnet' }, { lastEditedAt: T('15:00') });
  const dupStart = post(team, item, 'alice', T('10:20'), { kind: 'start', model: 'sonnet' });
  const { events, rejected } = collectEvents({ items: [item], team, cycle: CYCLE, cfg });
  const reasons = Object.fromEntries(rejected.map((r) => [r.commentId, r.reason]));
  assert.equal(reasons[early.id], 'outside-window');
  assert.equal(reasons[dupStart.id], 'duplicate');
  assert.deepEqual(events.map((e) => e.databaseId), [lateStart.databaseId]);
  assert.equal(earliestStart({ events, task: item.id, cycle: CYCLE }).databaseId, lateStart.databaseId);
  assert.equal(earliestStart({ events, task: 'org/repo#99', cycle: CYCLE }), null);
});

test('folding: withdraw removes a claim, a later claim re-adds it (new rank wins)', () => {
  const team = mkTeam();
  const cfg = digestTeam(team);
  const item = mkItem(1);
  const other = mkItem(2);
  claim(team, item, 'alice', T('06:10'), 1);
  post(team, item, 'alice', T('06:20'), { kind: 'withdraw' });
  const re = claim(team, item, 'alice', T('06:30'), 2, { capacity: 3 });
  claim(team, other, 'alice', T('06:35'), 1, { capacity: 2 });
  const { events } = collectEvents({ items: [item, other], team, cycle: CYCLE, cfg });
  const folded = foldClaims(events, team, 1);
  const alice = folded.get('alice');
  assert.equal(alice.claims.get(item.id).databaseId, re.databaseId);
  assert.equal(alice.claims.get(item.id).payload.rank, 2);
  assert.equal(alice.capacity, 2, 'capacity of the latest valid claim');
  // withdraw alone leaves nothing
  const lone = mkItem(3);
  claim(team, lone, 'bob', T('06:10'), 1);
  post(team, lone, 'bob', T('06:11'), { kind: 'withdraw' });
  const ev2 = collectEvents({ items: [lone], team, cycle: CYCLE, cfg }).events;
  assert.equal(foldClaims(ev2, team, 1).has('bob'), false);
});

test('foldClaims: capacity and models are clamped to the roster ceilings', () => {
  const team = mkTeam({ roster: [{ login: 'alice', maxCapacity: 3, models: ['haiku', 'sonnet'] }, { login: 'bob' }] });
  const cfg = digestTeam(team);
  const item = mkItem(1);
  claim(team, item, 'alice', T('06:10'), 1, { capacity: 9, models: ['sonnet', 'opus'] });
  const { events } = collectEvents({ items: [item], team, cycle: CYCLE, cfg });
  const alice = foldClaims(events, team, 1).get('alice');
  assert.equal(alice.capacity, 3);
  assert.deepEqual(alice.models, ['sonnet']);
});

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

test('candidates round 1: status, labels, pull requests, closed issues, stale Claimed (trust is NOT an input)', () => {
  const team = mkTeam();
  const cfg = digestTeam(team);
  const items = [
    mkItem(1),
    mkItem(2, { status: 'In progress' }),
    mkItem(3, { authorAssociation: 'NONE', authorLogin: 'stranger' }), // trust is per member and applied when claiming, not here
    mkItem(4, { labels: ['inactivity:skip'] }),
    mkItem(5, { contentType: 'PullRequest' }),
    mkItem(6, { state: 'CLOSED' }),
    mkItem(7, { status: 'Claimed' }), // stale: assigned yesterday, never started
    mkItem(8, { status: 'Claimed' }), // assigned yesterday and started
    mkItem(9, { status: 'Claimed' }), // claimed with no history at all
    mkItem(10, { authorAssociation: 'NONE', authorLogin: 'bob' }),
  ];
  // stale Claimed on #7
  post(team, items[6], 'alice', T('10:30', '2026-11-18'), { kind: 'assign', cycle: '2026-11-18', model: 'sonnet' });
  // started Claimed on #8
  post(team, items[7], 'alice', T('10:30', '2026-11-18'), { kind: 'assign', cycle: '2026-11-18', model: 'sonnet' });
  post(team, items[7], 'alice', T('10:40', '2026-11-18'), { kind: 'start', cycle: '2026-11-18', model: 'sonnet' });
  const { items: got } = candidates({ items, team, cycle: CYCLE, round: 1, events: collectEvents({ items, team, cycle: CYCLE, cfg }).events });
  assert.deepEqual(got.map((i) => i.number), [1, 3, 7, 10]);
  // includePullRequests lets PRs in
  const team2 = mkTeam({ includePullRequests: true });
  const got2 = candidates({ items: [mkItem(5, { contentType: 'PullRequest' })], team: team2, cycle: CYCLE, round: 1 }).items;
  assert.equal(got2.length, 1);
});

test('candidates round 1: sorted by priority, then repo, then number', () => {
  const team = mkTeam();
  const items = [
    mkItem(3, { priority: 'P2' }), mkItem(1, { priority: 'P0', repo: 'org/zeta' }), mkItem(2, { priority: 'P0', repo: 'org/alpha' }),
    mkItem(9, { priority: 'P1' }),
  ];
  const got = candidates({ items, team, cycle: CYCLE, round: 1 }).items.map((i) => i.id);
  assert.deepEqual(got, ['org/alpha#2', 'org/zeta#1', 'org/repo#9', 'org/repo#3']);
});

// ---------------------------------------------------------------------------
// Resolution: hand-checked tables
// ---------------------------------------------------------------------------

test('resolve: single claimant, priorities, capacity, models, hand-checked table', () => {
  const team = mkTeam();
  const t1 = mkItem(1, { priority: 'P0', difficulty: 'medium' }); // cost 2, sonnet
  const t2 = mkItem(2, { priority: 'P1', difficulty: 'medium' });
  const t3 = mkItem(3, { priority: 'P2', difficulty: 'hard' }); // cost 4, opus
  const t4 = mkItem(4, { priority: 'P3', difficulty: 'easy' }); // cost 1, haiku
  const t5 = mkItem(5, { priority: 'P3', difficulty: 'easy' }); // nobody claims
  // alice: capacity 4, can run everything. claims t1, t2, t3
  claim(team, t1, 'alice', T('06:30'), 1); claim(team, t2, 'alice', T('06:31'), 2); claim(team, t3, 'alice', T('06:32'), 3);
  // bob: capacity 4, haiku only. claims t3 (needs opus) and t4
  claim(team, t3, 'bob', T('07:00'), 1, { models: ['haiku'] }); claim(team, t4, 'bob', T('07:01'), 2, { models: ['haiku'] });
  const res = resolveCycle({ team, cycle: CYCLE, items: [t1, t2, t3, t4, t5], now: NOW });
  const r1 = res.rounds[1];
  assert.equal(r1.ready, true);
  // t1 (P0) -> alice (load 2); t2 (P1) -> alice (load 4); t3 (P2, opus): alice has no capacity left (4+4>4), bob lacks opus -> no-capacity? bob: model not ok
  // t4 -> bob; t5 -> no-claim
  assert.deepEqual(finalOf(res), { 'org/repo#1': 'alice@1', 'org/repo#2': 'alice@1', 'org/repo#4': 'bob@1' });
  assert.deepEqual(r1.unassigned, [{ task: 'org/repo#3', reason: 'no-capacity' }, { task: 'org/repo#5', reason: 'no-claim' }]);
  assert.deepEqual(r1.loads, { alice: 4, bob: 1 });
  assert.deepEqual(r1.assignments.map((a) => [a.task, a.member, a.model, a.points, a.rank]), [
    ['org/repo#1', 'alice', 'sonnet', 2, 1], ['org/repo#2', 'alice', 'sonnet', 2, 2], ['org/repo#4', 'bob', 'haiku', 1, 2],
  ]);
  assert.match(r1.inputsDigest, /^sha256:[0-9a-f]{64}$/);
});

test('resolve: unassigned reasons no-model / no-capacity / no-claim', () => {
  const team = mkTeam();
  const medium = mkItem(1, { difficulty: 'medium' });
  const hard = mkItem(2, { difficulty: 'hard' });
  const none = mkItem(3);
  claim(team, medium, 'alice', T('06:30'), 1, { models: ['haiku'] }); // sonnet needed
  claim(team, hard, 'bob', T('06:30'), 1, { capacity: 3 }); // opus ok, cost 4 > 3
  const res = resolveCycle({ team, cycle: CYCLE, items: [medium, hard, none], now: NOW });
  assert.deepEqual(Object.fromEntries(res.rounds[1].unassigned.map((u) => [u.task, u.reason])), {
    'org/repo#1': 'no-model', 'org/repo#2': 'no-capacity', 'org/repo#3': 'no-claim',
  });
  assert.deepEqual(res.final, {});
});

test('resolve: not ready before resolveAt (window closed but grace pending), ready at resolveAt', () => {
  const team = mkTeam();
  const t = mkItem(1);
  claim(team, t, 'alice', T('06:30'), 1);
  const at = (hhmm) => resolveCycle({ team, cycle: CYCLE, items: [t], now: new Date(T(hhmm)) });
  assert.equal(at('09:00').rounds[1].ready, false);
  assert.deepEqual(at('09:00').rounds[1].assignments, []);
  assert.equal(resolveCycle({ team, cycle: CYCLE, items: [t], now: new Date('2026-11-19T10:00:59Z') }).rounds[1].ready, false);
  assert.equal(resolveCycle({ team, cycle: CYCLE, items: [t], now: new Date('2026-11-19T10:01:00Z') }).rounds[1].ready, true);
  assert.equal(at('10:05').rounds[2].ready, false, 'round 2 not resolved yet');
  assert.deepEqual(finalOf(at('10:05')), { 'org/repo#1': 'alice@1' });
});

test('resolve: fairness, a second task goes to the member with the lower fill (not by hash or rank)', () => {
  const team = mkTeam();
  const a = mkItem(1); const b = mkItem(2);
  for (const who of ['alice', 'bob']) { claim(team, a, who, T('06:30'), 1); claim(team, b, who, T('06:31'), 2); }
  const res = resolveCycle({ team, cycle: CYCLE, items: [a, b], now: NOW });
  const owners = res.rounds[1].assignments.map((x) => x.member);
  assert.equal(new Set(owners).size, 2, 'tasks are split between the two members');
});

test('resolve: tie on fill and rank is decided by the cycle/task/login hash', () => {
  const team = mkTeam();
  const a = mkItem(1);
  claim(team, a, 'alice', T('06:30'), 1); claim(team, a, 'bob', T('06:20'), 1);
  const res = resolveCycle({ team, cycle: CYCLE, items: [a], now: NOW });
  const hash = (m) => sha(`${CYCLE}|1|org/repo#1|${m}`);
  const expected = hash('alice') < hash('bob') ? 'alice' : 'bob';
  assert.equal(res.final['org/repo#1'].member, expected);
});

test('resolve: better rank (lower number) wins when fill is equal', () => {
  const team = mkTeam();
  const a = mkItem(1);
  claim(team, a, 'alice', T('06:30'), 2); claim(team, a, 'bob', T('09:59'), 1);
  assert.equal(resolveCycle({ team, cycle: CYCLE, items: [a], now: NOW }).final['org/repo#1'].member, 'bob');
});

test('resolve: history makes yesterday\'s worker yield (integer cross-multiplied fill)', () => {
  const team = mkTeam();
  const a = mkItem(1);
  claim(team, a, 'alice', T('06:30'), 1); claim(team, a, 'bob', T('06:31'), 1);
  const res = resolveCycle({ team, cycle: CYCLE, items: [a], now: NOW, history: { alice: 8, bob: 0 } });
  assert.equal(res.final['org/repo#1'].member, 'bob');
  const res2 = resolveCycle({ team, cycle: CYCLE, items: [a], now: NOW, history: { alice: 0, bob: 8 } });
  assert.equal(res2.final['org/repo#1'].member, 'alice');
  // history weight 0 switches the effect off: back to the hash
  const team0 = mkTeam({ fairness: { historyWeightPct: 0 } });
  const b = mkItem(1);
  claim(team0, b, 'alice', T('06:30'), 1); claim(team0, b, 'bob', T('06:31'), 1);
  const hash = (m) => sha(`${CYCLE}|1|org/repo#1|${m}`);
  const expected = hash('alice') < hash('bob') ? 'alice' : 'bob';
  assert.equal(resolveCycle({ team: team0, cycle: CYCLE, items: [b], now: NOW, history: { alice: 99, bob: 0 } }).final['org/repo#1'].member, expected);
});

test('computeHistory: done events of the previous historyDays cycles, deduplicated, roster only', () => {
  const team = mkTeam();
  const item = mkItem(1);
  const d = (login, cycle, points, at, extra = {}) => post(team, item, login, at, { kind: 'done', cycle, points, model: 'sonnet', ...extra });
  d('alice', '2026-11-18', 3, T('11:00', '2026-11-18'));
  d('alice', '2026-11-18', 3, T('11:05', '2026-11-18')); // duplicate of the same (task, cycle, round)
  d('alice', '2026-11-12', 2, T('11:00', '2026-11-12'), { task: item.id }); // 7 days back: inside
  d('alice', '2026-11-11', 9, T('11:00', '2026-11-11')); // 8 days back: outside
  d('alice', CYCLE, 5, T('11:00')); // today does not count
  d('bob', '2026-11-17', 4, T('11:00', '2026-11-17'));
  // another item for a second done by alice
  const other = mkItem(2);
  post(team, other, 'alice', T('12:00', '2026-11-17'), { kind: 'done', cycle: '2026-11-17', points: 1, model: 'haiku' });
  // a forged done for bob by alice is rejected by the author check
  post(team, other, 'alice', T('12:00', '2026-11-17'), { kind: 'done', cycle: '2026-11-17', points: 50, model: 'haiku', member: 'bob' });
  // a stranger is ignored
  post(team, other, 'mallory', T('12:00', '2026-11-17'), { kind: 'done', cycle: '2026-11-17', points: 50, model: 'haiku' });
  const h = computeHistory({ items: [item, other], team, cycle: CYCLE, cfg: digestTeam(team) });
  assert.deepEqual(h, { alice: 3 + 2 + 1, bob: 4 });
  const team0 = mkTeam({ fairness: { historyDays: 0 } });
  assert.deepEqual(computeHistory({ items: [item], team: team0, cycle: CYCLE }), {});
});

test('resolve: history is computed from the comments when not given', () => {
  const team = mkTeam();
  const a = mkItem(1); const old = mkItem(9, { status: 'Done' });
  post(team, old, 'alice', T('11:00', '2026-11-18'), { kind: 'done', cycle: '2026-11-18', points: 8, model: 'sonnet' });
  claim(team, a, 'alice', T('06:30'), 1); claim(team, a, 'bob', T('06:31'), 1);
  const res = resolveCycle({ team, cycle: CYCLE, items: [a, old], now: NOW });
  assert.equal(res.final['org/repo#1'].member, 'bob');
});

// ---------------------------------------------------------------------------
// Adversarial: late / edited / duplicate / withdrawn claims
// ---------------------------------------------------------------------------

test('resolve: a late claim cannot steal a task, an edited-after-window claim is ignored', () => {
  const team = mkTeam();
  const a = mkItem(1);
  claim(team, a, 'alice', T('09:00'), 1);
  claim(team, a, 'bob', T('10:00'), 1); // 10:00 = window end, closed
  const edited = claim(team, a, 'chen', T('08:00'), 1); edited.lastEditedAt = T('10:30');
  const res = resolveCycle({ team, cycle: CYCLE, items: [a], now: NOW });
  assert.equal(res.final['org/repo#1'].member, 'alice');
  assert.deepEqual(res.rejected.map((r) => r.reason).sort(), ['edited-after-window', 'outside-window']);
});

test('resolve: withdrawn claims vanish, duplicates are harmless', () => {
  const team = mkTeam();
  const a = mkItem(1);
  claim(team, a, 'alice', T('06:30'), 1);
  post(team, a, 'alice', T('06:40'), { kind: 'withdraw' });
  claim(team, a, 'bob', T('06:50'), 1);
  claim(team, a, 'bob', T('06:51'), 1); // exact duplicate
  const res = resolveCycle({ team, cycle: CYCLE, items: [a], now: NOW });
  assert.equal(res.final['org/repo#1'].member, 'bob');
  assert.equal(res.rounds[1].loads.alice, undefined, 'a member without a surviving claim has no entry');
});

test('resolve: minimized, bot, quoted and wrong-cfg claims never count', () => {
  const team = mkTeam();
  const a = mkItem(1);
  claim(team, a, 'alice', T('06:30'), 1, {}).isMinimized = true;
  claim(team, a, 'bob', T('06:30'), 1, {}).author = { login: 'bob', type: 'Bot' };
  claim(team, a, 'chen', T('06:30'), 1, { cfg: `sha256:${'a'.repeat(64)}` });
  const quoted = claim(team, a, 'chen', T('06:31'), 1);
  quoted.body = quoted.body.split('\n').map((l) => `> ${l}`).join('\n');
  const res = resolveCycle({ team, cycle: CYCLE, items: [a], now: NOW });
  assert.deepEqual(res.final, {});
  assert.equal(res.rounds[1].unassigned[0].reason, 'no-claim');
});

test('resolve: a task with a team-policy change (cfg) mid-way ignores claims of the old policy', () => {
  const teamOld = mkTeam();
  const teamNew = mkTeam({ graceSeconds: 120 });
  const a = mkItem(1);
  claim(teamOld, a, 'alice', T('06:30'), 1);
  claim(teamNew, a, 'bob', T('06:31'), 1);
  const res = resolveCycle({ team: teamNew, cycle: CYCLE, items: [a], now: new Date(T('10:05')) });
  assert.equal(res.final['org/repo#1'].member, 'bob');
});

// ---------------------------------------------------------------------------
// Round 2
// ---------------------------------------------------------------------------

function round2Scenario() {
  const team = mkTeam();
  const t1 = mkItem(1, { priority: 'P0' }); const t2 = mkItem(2, { priority: 'P1' }); const t3 = mkItem(3, { priority: 'P2' });
  // round 1: alice gets #1, bob gets #2, #3 has no claim
  claim(team, t1, 'alice', T('06:30'), 1); claim(team, t2, 'bob', T('06:30'), 1);
  return { team, items: [t1, t2, t3], t1, t2, t3 };
}

test('round 2: release, never-started and unclaimed tasks reopen, previous assignee excluded, takeover', () => {
  const { team, items, t1, t2, t3 } = round2Scenario();
  // alice releases #1 at 10:30; bob never starts #2
  post(team, t1, 'alice', T('10:30'), { kind: 'release', reason: 'limit' });
  // round 2 claims (11:30-12:00): alice claims #1 (excluded) and #2 and #3; bob claims #1 (and #2: excluded, never wins it)
  claim(team, t1, 'alice', T('11:35'), 1, { round: 2 }); claim(team, t2, 'alice', T('11:35'), 2, { round: 2 }); claim(team, t3, 'alice', T('11:35'), 3, { round: 2 });
  claim(team, t1, 'bob', T('11:40'), 1, { round: 2 }); claim(team, t2, 'bob', T('11:40'), 2, { round: 2 });
  const beforeResolve = resolveCycle({ team, cycle: CYCLE, items, now: new Date(T('11:50')) });
  assert.equal(beforeResolve.rounds[2].ready, false);
  assert.deepEqual(finalOf(beforeResolve), { 'org/repo#2': 'bob@1' }, '#1 released and not yet retaken, #2 still bob until round 2');
  const res = resolveCycle({ team, cycle: CYCLE, items, now: new Date(T('12:05')) });
  assert.equal(res.rounds[2].ready, true);
  assert.deepEqual(res.rounds[2].assignments.map((a) => [a.task, a.member]), [['org/repo#1', 'bob'], ['org/repo#2', 'alice'], ['org/repo#3', 'alice']]);
  assert.deepEqual(finalOf(res), { 'org/repo#1': 'bob@2', 'org/repo#2': 'alice@2', 'org/repo#3': 'alice@2' });
  assert.deepEqual(res.rounds[2].loads, { alice: 4, bob: 2 }, 'round 2 starts again from zero load');
});

test('round 2: a task started before the deadline stays with its round 1 owner and is not a candidate', () => {
  const { team, items, t1, t2 } = round2Scenario();
  post(team, t2, 'bob', T('11:00'), { kind: 'start', model: 'sonnet' });
  const cand = candidates({ items, team, cycle: CYCLE, round: 2, events: collectEvents({ items, team, cycle: CYCLE, cfg: digestTeam(team) }).events,
    previous: resolveCycle({ team, cycle: CYCLE, items, now: new Date(T('10:05')) }).rounds[1] });
  assert.deepEqual(cand.items.map((i) => i.number), [1, 3], '#1 never started by alice, #3 had no claim; #2 started');
  assert.deepEqual(cand.excluded, { 'org/repo#1': ['alice'] });
  claim(team, t2, 'chen', T('11:40'), 1, { round: 2 });
  const res = resolveCycle({ team, cycle: CYCLE, items, now: new Date(T('12:05')) });
  assert.equal(res.final['org/repo#2'].member, 'bob');
  assert.equal(res.final['org/repo#2'].round, 1);
  assert.equal(res.final['org/repo#1'].member, 'alice', 'nobody took the stale task over in round 2: it stays with its round 1 owner');
});

test('task lock: a start followed by a release of the same member no longer holds the task', () => {
  const team = mkTeam();
  const cfg = digestTeam(team);
  const item = mkItem(1);
  post(team, item, 'alice', T('10:05'), { kind: 'start', model: 'sonnet' });
  post(team, item, 'alice', T('10:20'), { kind: 'failed', model: 'sonnet', reason: 'infra' });
  const evs = () => collectEvents({ items: [item], team, cycle: CYCLE, cfg }).events;
  assert.equal(earliestStart({ events: evs(), task: item.id, cycle: CYCLE }).member, 'alice', 'a failed alone is a terminal outcome, the lock stays');
  post(team, item, 'alice', T('10:21'), { kind: 'release', reason: 'infra' });
  assert.equal(earliestStart({ events: evs(), task: item.id, cycle: CYCLE }), null, 'released: nobody holds the lock');
  post(team, item, 'bob', T('10:40'), { kind: 'start', model: 'sonnet' });
  assert.equal(earliestStart({ events: evs(), task: item.id, cycle: CYCLE }).member, 'bob', 'bob can take it over');
  // a release posted BEFORE the start (pause, limit) does not free a later start
  const other = mkItem(2);
  post(team, other, 'alice', T('10:05'), { kind: 'release', reason: 'paused' });
  post(team, other, 'alice', T('10:10'), { kind: 'start', model: 'sonnet' });
  assert.equal(earliestStart({ events: collectEvents({ items: [other], team, cycle: CYCLE, cfg }).events, task: other.id, cycle: CYCLE }).member, 'alice');
});

test('round 2: a task started before the cutoff but released afterwards is claimable again', () => {
  const { team, items, t1 } = round2Scenario();
  post(team, t1, 'alice', T('10:05'), { kind: 'start', model: 'sonnet' });
  post(team, t1, 'alice', T('10:30'), { kind: 'failed', model: 'sonnet', reason: 'infra' });
  post(team, t1, 'alice', T('10:31'), { kind: 'release', reason: 'infra' });
  claim(team, t1, 'bob', T('11:40'), 1, { round: 2 });
  const res = resolveCycle({ team, cycle: CYCLE, items, now: new Date(T('12:05')) });
  assert.deepEqual(res.rounds[2].assignments.map((a) => [a.task, a.member]), [['org/repo#1', 'bob']], 'released start is ignored by startedBeforeCutoff');
  assert.equal(res.final['org/repo#1'].member, 'bob');
  // bob's start passes the gate: alice's released start is not the lock holder
  post(team, t1, 'bob', T('12:10'), { kind: 'start', model: 'sonnet', round: 2 });
  const evs = collectEvents({ items, team, cycle: CYCLE, cfg: digestTeam(team) }).events.filter((e) => e.task === t1.id);
  assert.equal(earliestStart({ events: evs, task: t1.id, cycle: CYCLE }).member, 'bob');
});

test('round 2: stale (not started, not released) task keeps its round 1 owner when nobody takes it over', () => {
  const { team, items } = round2Scenario();
  const res = resolveCycle({ team, cycle: CYCLE, items, now: new Date(T('12:05')) });
  assert.deepEqual(finalOf(res), { 'org/repo#1': 'alice@1', 'org/repo#2': 'bob@1' });
  assert.deepEqual(res.rounds[2].unassigned.map((u) => u.task).sort(), ['org/repo#1', 'org/repo#2', 'org/repo#3']);
});

test('round 2: released task nobody retakes drops from final; round 1 claims in round 2 window are rejected', () => {
  const { team, items, t1 } = round2Scenario();
  post(team, t1, 'alice', T('10:30'), { kind: 'release', reason: 'paused' });
  const res = resolveCycle({ team, cycle: CYCLE, items, now: new Date(T('12:05')) });
  assert.equal(res.final['org/repo#1'], undefined);
  claim(team, t1, 'chen', T('11:00'), 1, { round: 2 }); // before round 2 opens
  const res2 = resolveCycle({ team, cycle: CYCLE, items, now: new Date(T('12:05')) });
  assert.equal(res2.final['org/repo#1'], undefined);
  assert.ok(res2.rejected.some((r) => r.reason === 'outside-window'));
});

test('round 2 disabled: rounds[2] is null and round 2 comments are rejected', () => {
  const team = mkTeam({ round2: { enabled: false } });
  const a = mkItem(1);
  claim(team, a, 'alice', T('11:40'), 1, { round: 2 });
  const res = resolveCycle({ team, cycle: CYCLE, items: [a], now: new Date(T('13:00')) });
  assert.equal(res.rounds[2], null);
  assert.deepEqual(res.final, {});
  assert.equal(roundWindows(team, CYCLE)[2], null);
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

test('warnings: divergent foreign assign and vanished claims are reported, not obeyed', () => {
  const team = mkTeam();
  const a = mkItem(1);
  const c = claim(team, a, 'alice', T('06:30'), 1);
  post(team, a, 'alice', T('10:10'), { kind: 'assign', model: 'sonnet', claims: [c.databaseId, 424242] });
  post(team, a, 'bob', T('10:11'), { kind: 'assign', model: 'sonnet' });
  a.commentsComplete = false;
  const res = resolveCycle({ team, cycle: CYCLE, items: [a], now: NOW });
  assert.equal(res.final['org/repo#1'].member, 'alice');
  const codes = res.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ['claim-disappeared', 'comments-incomplete', 'divergence']);
});

// ---------------------------------------------------------------------------
// Builders, ownAssignments
// ---------------------------------------------------------------------------

test('buildClaims: ranked in candidate order, capped, allowlisted, feasible, skips already posted', () => {
  const team = mkTeam({ maxClaimsPerMember: 3 });
  const items = [
    mkItem(1, { priority: 'P0', difficulty: 'easy' }),
    mkItem(2, { priority: 'P0', difficulty: 'hard' }), // hard: never unless allowed
    mkItem(3, { priority: 'P1', difficulty: 'medium' }),
    mkItem(4, { priority: 'P1', difficulty: 'medium', repo: 'other/repo' }), // not allowlisted
    mkItem(5, { priority: 'P2', difficulty: 'medium' }),
    mkItem(6, { priority: 'P3', difficulty: 'easy' }),
    mkItem(7, { priority: 'P3', difficulty: 'easy' }),
  ];
  const args = { team, cycle: CYCLE, round: 1, login: 'Alice', offer: { capacity: 6, models: ['haiku', 'sonnet'] }, candidates: items, repoAllowlist: ['org/repo'], trustedAuthors: ['maint'], approval: { mode: 'none' }, runId: 'run1', ts: T('06:10') };
  const out = buildClaims(args);
  assert.deepEqual(out.map((p) => [p.task, p.rank]), [['org/repo#1', 1], ['org/repo#3', 2], ['org/repo#5', 3]]);
  assert.deepEqual(out[0], {
    v: 1, kind: 'claim', cycle: CYCLE, round: 1, task: 'org/repo#1', member: 'Alice', cfg: digestTeam(team), runId: 'run1', ts: T('06:10'),
    capacity: 6, models: ['haiku', 'sonnet'], rank: 1,
  });
  // hard allowed + opus offered
  const withHard = buildClaims({ ...args, offer: { capacity: 6, models: ['haiku', 'sonnet', 'opus'] }, hardDifficultyAllowed: true });
  assert.deepEqual(withHard.map((p) => p.task), ['org/repo#1', 'org/repo#2', 'org/repo#3']);
  // already posted: skip, continue ranks after the existing ones, and respect the cap
  const existing = [{ payload: out[0] }, { payload: out[1] }];
  const more = buildClaims({ ...args, existing });
  assert.deepEqual(more.map((p) => [p.task, p.rank]), [['org/repo#5', 3]], 'room for one more under the cap of 3');
  // withdrawn claims can be posted again
  const wd = buildClaims({ ...args, existing: [...existing, { payload: { ...out[0], kind: 'withdraw' } }] });
  assert.deepEqual(wd.map((p) => [p.task, p.rank]), [['org/repo#1', 3], ['org/repo#5', 4]], 'withdrawn task can be re-claimed, ranks continue');
  // no offer or no capacity: nothing
  assert.deepEqual(buildClaims({ ...args, offer: null }), []);
  assert.deepEqual(buildClaims({ ...args, offer: { capacity: 0, models: ['haiku'] } }), []);
  // capacity smaller than cost: medium (2) is not claimed with capacity 1
  assert.deepEqual(buildClaims({ ...args, offer: { capacity: 1, models: ['haiku', 'sonnet'] } }).map((p) => p.task), ['org/repo#1', 'org/repo#6', 'org/repo#7']);
  // every built payload round-trips through the parser
  for (const p of out) {
    const item = items.find((i) => i.id === p.task);
    assert.equal(parseComment({ id: 'c', databaseId: 1, author: { login: 'alice', type: 'User' }, body: renderComment(p, { team }) }, item).ok, true);
  }
});

test('buildClaims: roster ceilings apply and non-roster logins claim nothing', () => {
  const team = mkTeam({ roster: [{ login: 'alice', maxCapacity: 2, models: ['haiku', 'sonnet'] }, { login: 'bob' }] });
  const items = [mkItem(1, { difficulty: 'medium' })];
  const out = buildClaims({ team, cycle: CYCLE, round: 1, login: 'alice', offer: { capacity: 9, models: ['sonnet', 'opus'] }, candidates: items, repoAllowlist: { 'org/repo': {} }, trustedAuthors: ['maint'], approval: { mode: 'none' } });
  assert.equal(out[0].capacity, 2);
  assert.deepEqual(out[0].models, ['sonnet']);
  assert.deepEqual(buildClaims({ team, cycle: CYCLE, round: 1, login: 'mallory', offer: { capacity: 5, models: ['haiku'] }, candidates: items, repoAllowlist: ['org/repo'], trustedAuthors: ['maint'], approval: { mode: 'none' } }), []);
});

test('buildAssign / buildLifecycle: valid payloads, whitelisted extras, errors on bad input', () => {
  const team = mkTeam();
  const assign = buildAssign({ team, cycle: CYCLE, round: 1, login: 'alice', assignment: { task: 'org/repo#1', model: 'sonnet' }, claims: [9, 3], inputs: 'sha256:abc', runId: 'r' });
  assert.deepEqual(assign.claims, [3, 9]);
  assert.equal(assign.kind, 'assign');
  const start = buildLifecycle({ kind: 'start', team, cycle: CYCLE, round: 2, login: 'alice', task: 'org/repo#1', runId: 'r', extra: { model: 'opus', junk: 1 } });
  assert.equal(start.junk, undefined);
  assert.equal(start.round, 2);
  const done = buildLifecycle({ kind: 'done', team, cycle: CYCLE, round: 1, login: 'alice', task: 'org/repo#1', extra: { model: 'sonnet', points: 2, pr: 'https://x/pull/1', branch: 'b' } });
  assert.equal(done.points, 2);
  assert.throws(() => buildLifecycle({ kind: 'done', team, cycle: CYCLE, round: 1, login: 'alice', task: 'org/repo#1', extra: {} }), /points/);
  assert.throws(() => buildLifecycle({ kind: 'release', team, cycle: CYCLE, round: 1, login: 'alice', task: 'org/repo#1' }), /reason/);
  assert.throws(() => buildLifecycle({ kind: 'claim', team, cycle: CYCLE, round: 1, login: 'alice', task: 'org/repo#1' }), /unsupported/);
  const w = buildLifecycle({ kind: 'withdraw', team, cycle: CYCLE, round: 1, login: 'alice', task: 'org/repo#1' });
  assert.equal(w.kind, 'withdraw');
});

test('ownAssignments: only my tasks still in final, ordered by round then candidate order', () => {
  const { team, items, t1, t2, t3 } = round2Scenario();
  post(team, t1, 'alice', T('10:30'), { kind: 'release', reason: 'limit' });
  claim(team, t1, 'bob', T('11:40'), 1, { round: 2 });
  claim(team, t3, 'alice', T('11:40'), 1, { round: 2 }); claim(team, t2, 'alice', T('11:41'), 2, { round: 2 });
  const res = resolveCycle({ team, cycle: CYCLE, items, now: new Date(T('12:05')) });
  assert.deepEqual(ownAssignments(res, 'Alice').map((a) => [a.round, a.task]), [[2, 'org/repo#2'], [2, 'org/repo#3']]);
  assert.deepEqual(ownAssignments(res, 'bob').map((a) => [a.round, a.task]), [[2, 'org/repo#1']]);
  assert.deepEqual(ownAssignments(res, 'chen'), []);
});

// ---------------------------------------------------------------------------
// Properties: determinism and fairness (seeded PRNG)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
function shuffle(rng, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const minutes = (m) => `${CYCLE}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00Z`;

/** Random cycle with a record of who claimed what, for P4-P6. */
function randomCycle(rng) {
  const logins = ['aaa', 'bbb', 'ccc', 'ddd', 'zed'].slice(0, int(rng, 2, 5));
  const tiersOf = (l) => (l === 'zed' ? ['haiku', 'sonnet', 'opus'] : shuffle(rng, ['haiku', 'sonnet', 'opus']).slice(0, int(rng, 1, 3)));
  const roster = logins.map((l) => ({ login: l, maxCapacity: l === 'zed' ? 0 : 8 }));
  const team = mkTeam({ roster });
  const items = [];
  const nTasks = int(rng, 3, 12);
  for (let n = 1; n <= nTasks; n += 1) {
    items.push(mkItem(n, { repo: pick(rng, ['org/a', 'org/b']), priority: pick(rng, ['P0', 'P1', 'P2', 'P3']), difficulty: pick(rng, ['easy', 'medium', 'hard']) }));
  }
  const offers = {};
  const claimed = {};
  for (const l of logins) {
    offers[l] = { capacity: int(rng, 1, 8), models: tiersOf(l) };
    const mine = shuffle(rng, items).slice(0, int(rng, 0, Math.min(8, nTasks)));
    mine.forEach((it, i) => {
      claim(team, it, l, minutes(360 + int(rng, 0, 239)), i + 1, { capacity: offers[l].capacity, models: offers[l].models });
      (claimed[it.id] ??= new Set()).add(l);
    });
  }
  return { team, items, offers, claimed, logins };
}
const shuffled = (rng, items) => shuffle(rng, clone(items)).map((it) => ({ ...it, comments: shuffle(rng, it.comments) }));
const summary = (res) => JSON.stringify({
  final: res.final, r1: res.rounds[1].assignments, u1: res.rounds[1].unassigned, l1: res.rounds[1].loads, d1: res.rounds[1].inputsDigest,
  r2: res.rounds[2].assignments, d2: res.rounds[2].inputsDigest,
});

test('properties P1-P6 over 1000 random cycles (order independence, duplicates, capacity, claimants, models)', () => {
  const rng = mulberry32(20261119);
  const tierOfDifficulty = { easy: 'haiku', medium: 'sonnet', hard: 'opus' };
  const cost = { easy: 1, medium: 2, hard: 4 };
  for (let i = 0; i < 1000; i += 1) {
    const { team, items, offers, claimed } = randomCycle(rng);
    const res = resolveCycle({ team, cycle: CYCLE, items, now: NOW });
    const base = summary(res);
    // P1 + P3: any ordering of items and comments gives the same table and the same digest
    for (let k = 0; k < 2; k += 1) {
      assert.equal(summary(resolveCycle({ team, cycle: CYCLE, items: shuffled(rng, items), now: NOW })), base, `cycle ${i}: order independence`);
    }
    // P2: duplicated comments (same body, later, new ids) are harmless
    const dup = clone(items);
    for (const it of dup) {
      const extra = it.comments.filter(() => rng() < 0.5).map((c) => ({ ...c, id: `${c.id}d`, databaseId: c.databaseId + 100000, createdAt: c.createdAt }));
      it.comments.push(...extra);
    }
    assert.equal(summary(resolveCycle({ team, cycle: CYCLE, items: dup, now: NOW })), base, `cycle ${i}: duplicates`);
    // P4-P6
    const byMember = {};
    for (const a of res.rounds[1].assignments) {
      assert.ok(claimed[a.task]?.has(a.member), `cycle ${i}: ${a.member} did not claim ${a.task}`); // P5
      const offer = offers[a.member];
      assert.ok(offer.models.includes(a.model), `cycle ${i}: model not offered`); // P6
      assert.equal(a.model, tierOfDifficulty[a.difficulty]);
      assert.notEqual(a.member, 'zed', 'capacity 0 member never wins'); // P6
      byMember[a.member] = (byMember[a.member] ?? 0) + cost[a.difficulty];
    }
    for (const [m, load] of Object.entries(byMember)) assert.ok(load <= offers[m].capacity, `cycle ${i}: ${m} over capacity`); // P4
    assert.deepEqual(Object.fromEntries(Object.entries(res.rounds[1].loads).filter(([, v]) => v > 0)), byMember);
  }
});

test('property: two independent clients with the same comments compute identical results', () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 100; i += 1) {
    const { team, items } = randomCycle(rng);
    const clientA = resolveCycle({ team: clone(team), cycle: CYCLE, items: clone(items), now: new Date(T('10:10')) });
    const clientB = resolveCycle({ team: clone(team), cycle: CYCLE, items: shuffled(rng, items), now: new Date(T('13:00')) });
    assert.deepEqual(clientA.final, clientB.final);
    assert.equal(clientA.cfg, clientB.cfg);
    assert.equal(clientA.rounds[1].inputsDigest, clientB.rounds[1].inputsDigest);
  }
});

test('property: two-member tie is decided by the hash, independent of roster order and claim order', () => {
  const day = (i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  let aliceWins = 0;
  for (let i = 0; i < 200; i += 1) {
    const cycle = day(i);
    const outcomes = [];
    for (const order of [['alice', 'bob'], ['bob', 'alice']]) {
      const team = mkTeam({ roster: order.map((login) => ({ login })) });
      const it = mkItem(1);
      for (const [k, who] of order.entries()) {
        post(team, it, who, `${cycle}T0${6 + k}:30:00Z`, { kind: 'claim', cycle, capacity: 4, models: ['sonnet'], rank: 1 });
      }
      outcomes.push(resolveCycle({ team, cycle, items: [it], now: new Date(`${cycle}T11:00:00Z`) }).final['org/repo#1'].member);
    }
    assert.equal(outcomes[0], outcomes[1], `cycle ${cycle}`);
    const hash = (m) => sha(`${cycle}|1|org/repo#1|${m}`);
    assert.equal(outcomes[0], hash('alice') < hash('bob') ? 'alice' : 'bob');
    if (outcomes[0] === 'alice') aliceWins += 1;
  }
  assert.ok(aliceWins > 70 && aliceWins < 130, `alice won ${aliceWins}/200`);
});

test('property P7: no systematic favour for the alphabet or for whoever claims first (1000 cycles)', () => {
  const rng = mulberry32(99);
  const day = (i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
  const names = ['aaa', 'bbb', 'ccc'];
  const wins = { aaa: 0, bbb: 0, ccc: 0 };
  let firstPosterWins = 0;
  let total = 0;
  for (let i = 0; i < 1000; i += 1) {
    const cycle = day(i);
    const team = mkTeam({ roster: names.map((login) => ({ login })) });
    const items = Array.from({ length: 7 }, (_, k) => mkItem(k + 1, { priority: 'P2', difficulty: 'easy' }));
    const order = shuffle(rng, names);
    order.forEach((who, k) => {
      items.forEach((it, j) => post(team, it, who, `${cycle}T06:${String(10 + k).padStart(2, '0')}:00Z`, {
        kind: 'claim', cycle, capacity: 6, models: ['haiku', 'sonnet', 'opus'], rank: j + 1,
      }));
    });
    const res = resolveCycle({ team, cycle, items, now: new Date(`${cycle}T11:00:00Z`) });
    for (const a of res.rounds[1].assignments) {
      wins[a.member] += 1; total += 1;
      if (a.member === order[0]) firstPosterWins += 1;
    }
    assert.equal(res.rounds[1].assignments.length, 7);
  }
  assert.equal(total, 7000);
  const expected = total / 3;
  for (const n of names) assert.ok(Math.abs(wins[n] - expected) < expected * 0.08, `${n} won ${wins[n]} of ${total}`);
  assert.ok(Math.abs(firstPosterWins - expected) < expected * 0.08, `first poster won ${firstPosterWins} of ${total}`);
});

test('property P8: unequal capacities lead to loads proportional to capacities', () => {
  const day = (i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
  const caps = { aaa: 2, bbb: 4, ccc: 8 };
  for (let i = 0; i < 60; i += 1) {
    const cycle = day(i);
    const team = mkTeam({ roster: Object.keys(caps).map((login) => ({ login })) });
    const items = Array.from({ length: 7 }, (_, k) => mkItem(k + 1, { priority: 'P2', difficulty: 'easy' }));
    for (const [who, cap] of Object.entries(caps)) {
      items.forEach((it, j) => post(team, it, who, `${cycle}T06:10:00Z`, { kind: 'claim', cycle, capacity: cap, models: ['haiku'], rank: j + 1 }));
    }
    const res = resolveCycle({ team, cycle, items, now: new Date(`${cycle}T11:00:00Z`) });
    const loads = res.rounds[1].loads;
    assert.equal(loads.aaa + loads.bbb + loads.ccc, 7);
    for (const [who, cap] of Object.entries(caps)) {
      assert.ok(Math.abs(loads[who] - (7 * cap) / 14) <= 1, `${cycle}: ${who} load ${loads[who]} for capacity ${cap}`);
    }
    for (const [who, cap] of Object.entries(caps)) assert.ok(loads[who] <= cap);
  }
});

test('property: round 2 results are also order independent', () => {
  const rng = mulberry32(31337);
  for (let i = 0; i < 100; i += 1) {
    const { team, items, logins } = randomCycle(rng);
    // alice-like release for a random assigned task, plus random round 2 claims
    const first = resolveCycle({ team, cycle: CYCLE, items, now: new Date(T('10:05')) });
    for (const a of first.rounds[1].assignments.filter(() => rng() < 0.4)) {
      const it = items.find((x) => x.id === a.task);
      post(team, it, a.member, T('10:30'), { kind: 'release', reason: 'limit' });
    }
    for (const it of items) {
      for (const l of logins) if (rng() < 0.4) {
        post(team, it, l, minutes(690 + int(rng, 0, 29)), { kind: 'claim', round: 2, capacity: int(rng, 1, 8), models: ['haiku', 'sonnet', 'opus'], rank: int(rng, 1, 3) });
      }
    }
    const now = new Date(T('12:30'));
    const base = summary(resolveCycle({ team, cycle: CYCLE, items, now }));
    assert.equal(summary(resolveCycle({ team, cycle: CYCLE, items: shuffled(rng, items), now })), base);
    const r = resolveCycle({ team, cycle: CYCLE, items, now });
    const loads2 = {};
    for (const a of r.rounds[2].assignments) loads2[a.member] = (loads2[a.member] ?? 0) + a.points;
    for (const [m, l] of Object.entries(loads2)) assert.ok(l <= 8, `${m} load ${l}`);
    // a previous assignee who released can never win the same task again in round 2
    for (const a of r.rounds[2].assignments) {
      const prev = first.rounds[1].assignments.find((x) => x.task === a.task);
      if (prev) assert.notEqual(prev.member, a.member, `${a.task} went back to ${a.member}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Trust whitelist (docs/design.md 1.5): a per-member filter on what a member CLAIMS. It is not an input of resolution.
// ---------------------------------------------------------------------------

const claimArgs = (team, items, extra = {}) => ({
  team, cycle: CYCLE, round: 1, login: 'alice', offer: { capacity: 8, models: ['haiku', 'sonnet', 'opus'] }, candidates: items,
  repoAllowlist: ['org/repo'], approval: { mode: 'none' }, runId: 'run1', ts: T('06:10'), ...extra,
});

test('trust: an empty or missing whitelist claims nothing (secure by default)', () => {
  const team = mkTeam();
  const items = [mkItem(1), mkItem(2, { authorLogin: 'alice' })];
  assert.deepEqual(buildClaims(claimArgs(team, items)), []);
  assert.deepEqual(buildClaims(claimArgs(team, items, { trustedAuthors: [] })), []);
  assert.deepEqual(buildClaims(claimArgs(team, items, { trustedAuthors: undefined })), []);
  // the old gates grant nothing any more: not the association, not the roster
  assert.deepEqual(buildClaims(claimArgs(team, [mkItem(3, { authorAssociation: 'OWNER', authorLogin: 'bob' })])), []);
});

test('trust: only whitelisted authors are claimed, case-insensitively; bots and unknown accounts never by accident', () => {
  const team = mkTeam();
  const items = [
    mkItem(1, { authorLogin: 'Maint' }),
    mkItem(2, { authorLogin: 'stranger', authorAssociation: 'OWNER' }),
    mkItem(3, { authorLogin: 'dependabot' }),
    mkItem(4, { authorLogin: null }),
    mkItem(5, { authorLogin: 'carol' }),
  ];
  items[2].authorType = 'Bot';
  const claim = (list) => buildClaims(claimArgs(team, items, { trustedAuthors: list })).map((p) => p.task);
  assert.deepEqual(claim(['MAINT']), ['org/repo#1']);
  assert.deepEqual(claim(['@maint', 'Carol']), ['org/repo#1', 'org/repo#5']);
  assert.deepEqual(claim(['maint', 'dependabot']), ['org/repo#1'], 'a bare name never trusts a bot');
  assert.deepEqual(claim(['maint', 'dependabot[bot]']), ['org/repo#1', 'org/repo#3'], 'a bot only when listed with [bot]');
});

test('trust: an issue edited by a non-whitelisted editor is not claimed (bait and switch)', () => {
  const team = mkTeam();
  const items = [
    mkItem(1, { lastEditedAt: T('05:00'), editorLogin: 'mallory' }),
    mkItem(2, { lastEditedAt: T('05:00'), editorLogin: 'maint' }),
    mkItem(3),
  ];
  const got = buildClaims(claimArgs(team, items, { trustedAuthors: ['maint'] })).map((p) => p.task);
  assert.deepEqual(got, ['org/repo#2', 'org/repo#3']);
  assert.deepEqual(buildClaims(claimArgs(team, items, { trustedAuthors: ['maint', 'mallory'] })).map((p) => p.task), ['org/repo#1', 'org/repo#2', 'org/repo#3']);
});

test('trust: resolution does not depend on any whitelist; two members with different lists agree on every input', () => {
  const team = mkTeam();
  const mine = mkItem(1, { priority: 'P0', difficulty: 'easy' }); // by maint
  const theirs = mkItem(2, { priority: 'P1', difficulty: 'easy', authorLogin: 'stranger' }); // trusted by bob only
  const nobody = mkItem(3, { priority: 'P2', difficulty: 'easy', authorLogin: 'spammer' }); // trusted by nobody
  const items = [mine, theirs, nobody];
  const cand = candidates({ items, team, cycle: CYCLE, round: 1 }).items;
  assert.deepEqual(cand.map((i) => i.number), [1, 2, 3], 'candidate list is identical for everybody, it has no trust input');

  const aliceClaims = buildClaims(claimArgs(team, cand, { login: 'alice', trustedAuthors: ['maint'] }));
  const bobClaims = buildClaims(claimArgs(team, cand, { login: 'bob', trustedAuthors: ['maint', 'stranger'] }));
  assert.deepEqual(aliceClaims.map((p) => p.task), ['org/repo#1']);
  assert.deepEqual(bobClaims.map((p) => p.task), ['org/repo#1', 'org/repo#2']);
  for (const p of aliceClaims) post(team, items.find((i) => i.id === p.task), 'alice', T('06:30'), p);
  for (const p of bobClaims) post(team, items.find((i) => i.id === p.task), 'bob', T('06:31'), p);

  // "machine A" (alice) and "machine B" (bob) run the same pure function on the same board
  const a = resolveCycle({ team: clone(team), cycle: CYCLE, items: clone(items), now: NOW });
  const b = resolveCycle({ team: clone(team), cycle: CYCLE, items: shuffled(mulberry32(3), items), now: NOW });
  assert.deepEqual(a.final, b.final);
  assert.equal(a.rounds[1].inputsDigest, b.rounds[1].inputsDigest);
  // a hypothetical whitelist argument is ignored by the resolver
  const c = resolveCycle({ team, cycle: CYCLE, items: clone(items), now: NOW, trustedAuthors: [] });
  assert.deepEqual(c.final, a.final);
  assert.equal(c.rounds[1].inputsDigest, a.rounds[1].inputsDigest);

  assert.equal(a.final['org/repo#2'].member, 'bob', 'only bob trusts (and claimed) the stranger task');
  assert.ok(['alice', 'bob'].includes(a.final['org/repo#1'].member));
  assert.equal(a.final['org/repo#3'], undefined, 'a task nobody trusts gets no claim and no assignment');
  assert.deepEqual(a.rounds[1].unassigned, [{ task: 'org/repo#3', reason: 'no-claim' }]);
  assert.equal(ownAssignments(a, 'alice').some((x) => x.task === 'org/repo#2'), false);
});
