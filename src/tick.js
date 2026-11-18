// `inactivity tick`: the only thing the OS scheduler calls (docs/design.md section 8.1).
// Idempotent and window-aware. Per project: claim while a round is open, resolve (the same
// pure function on every machine) once a round is resolved, post `assign` for my tasks, then
// run them one by one through runner.runTask. Local bookkeeping lives in state.json (4.5).
//
// All IO goes through `deps`. Sibling modules are the real ones unless `deps.modules` overrides them.

import { resolvePaths } from './config.js';
import { loadTeam, makeGithub } from './context.js';
import { cycleKey, acquireLock, loadState, saveState } from './ledger.js';
import { decideTick } from './schedule.js';
import { sha256Hex, errorCode } from './util.js';
import * as claimsMod from './claims.js';
import * as policyMod from './policy.js';
import * as runnerMod from './runner.js';
import * as trustMod from './trust.js';
import { allowsPublicBoard } from './exposure.js';

const SIX_HOURS = 6 * 3600 * 1000;
/** A claim is not posted within this margin (plus the mutation delay) of the end of its window. */
const CLAIM_SAFETY_MS = 5000;
const lower = (s) => String(s ?? '').toLowerCase();

/** @param {any} config @param {Date} now */
export function isPaused(config, now) {
  const av = config?.availability ?? {};
  if (av.paused) return true;
  if (av.pausedUntil) {
    const until = Date.parse(av.pausedUntil);
    if (Number.isFinite(until) && until > now.getTime()) return true;
  }
  return false;
}

/**
 * Pure planning step: what does this tick need to do for one project? (docs 8.1 steps 3a-3b)
 * @param {{team:any, now:Date, state:any, project:{id:string}, config?:any, login?:string|null}} p
 */
export function planProject({ team, now, state, project, config, login }) {
  const phases = policyMod.cyclePhases(team, now);
  const key = cycleKey(project.id, phases.cycle);
  const cycleState = state?.cycles?.[key] ?? null;
  const open = [1, 2].find((r) => phases.rounds[r]?.state === 'open') ?? 1;
  const hasOffer = config && login ? policyMod.buildOffer({ config, team, login, now, state, round: open }) !== null : true;
  const decision = decideTick({
    phases,
    now,
    cycleState,
    hasOffer,
    paused: config ? isPaused(config, now) : false,
    limitUntil: state?.limit?.until ?? null,
    hasLeaks: (state?.leaks?.length ?? 0) > 0,
  });
  return {
    phases,
    cycle: phases.cycle,
    key,
    decision,
    needsNetwork: decision.needsNetwork,
    claimRounds: decision.claimRounds,
    resolveRounds: decision.resolveRounds,
    canRun: decision.executeTasks.length > 0,
    reason: decision.reason,
  };
}

function emptyCycleState() {
  return { claimed: { 1: null, 2: null }, resolved: { 1: null, 2: null }, assigned: {}, pointsUsed: 0, tasksStarted: 0 };
}

const SKIP_REASON = {
  'inactive-day': 'inactive-day',
  paused: 'paused',
  limit: 'limit',
  'before-window': 'idle',
  'execution-ended': 'idle',
  'janitor-only': 'idle',
  'all-resolved': 'idle',
  'window-pending': 'idle',
  'grace-period': 'idle',
};

/**
 * @param {any} deps
 * @param {{config:any, dryRun?:boolean, only?:string, now?:Date, stateDir?:string}} opts
 */
export async function runTick(deps, { config, dryRun = false, only, now, stateDir }) {
  const at = now ?? deps.now();
  const dir = stateDir ?? deps.stateDir ?? resolvePaths(deps.env, deps.platform, deps.homedir()).stateDir;
  const summary = { ok: true, now: at.toISOString(), projects: [] };

  const lock = dryRun ? null : await acquireLock(deps, { stateDir: dir, command: 'tick', staleMs: SIX_HOURS });
  if (!dryRun && !lock) return { ...summary, skipped: 'locked' };
  try {
    const state = await loadState(deps, dir);
    const env = createTickEnv(deps, { config, dryRun, state, stateDir: dir });
    const projects = (config.projects ?? []).filter((p) => p.enabled !== false && (!only || p.id === only));
    for (const project of projects) {
      const entry = { id: project.id, cycle: null, rounds: {}, actions: [], errors: [] };
      summary.projects.push(entry);
      try {
        // `now` is a simulation override; otherwise each project sees the real clock (an earlier project may have run long)
        await tickProject(env, project, entry, now ?? deps.now());
      } catch (error) {
        entry.errors.push({ code: errorCode(error), message: String(/** @type {Error} */ (error)?.message ?? error) });
        deps.log?.warn?.(`tick: project ${project.id}: ${/** @type {Error} */ (error)?.message ?? error}`);
      }
    }
    await janitor(env, summary);
    state.lastTickAt = deps.now().toISOString();
    if (!dryRun) await saveState(deps, dir, state);
    const idle = summary.projects.length > 0 && summary.projects.every((p) => p.actions.length === 0 && p.errors.length === 0 && p.reason);
    if (idle && summary.projects.every((p) => SKIP_REASON[p.reason])) {
      const first = summary.projects.map((p) => SKIP_REASON[p.reason]).find((r) => r !== 'idle') ?? 'idle';
      summary.skipped = first;
    }
    return summary;
  } finally {
    await lock?.release();
  }
}

/** Shared per-tick context (lazy GitHub client, login, ...). */
function createTickEnv(deps, { config, dryRun, state, stateDir }) {
  const mods = {
    claims: deps.modules?.claims ?? claimsMod,
    policy: deps.modules?.policy ?? policyMod,
    runner: deps.modules?.runner ?? runnerMod,
    trust: deps.modules?.trust ?? trustMod,
  };
  const ctx = {
    deps,
    config,
    flags: {},
    global: { offline: false },
    mod: async (name) => deps.modules?.[name] ?? import(`./${name}.js`),
  };
  const env = {
    deps, config, dryRun, state, stateDir, mods, ctx,
    github: null,
    login: config.login ?? state.login ?? null,
    jittered: false,
    async getGithub() {
      if (!env.github) env.github = await makeGithub(ctx);
      return env.github;
    },
    async getLogin() {
      if (!env.login) {
        env.login = (await (await env.getGithub()).viewer()).login;
        state.login = env.login;
      }
      return env.login;
    },
    /** Deterministic per-member delay before the first network call (no API burst at :00). */
    async jitter(capMs = Infinity) {
      if (env.jittered || dryRun) return;
      env.jittered = true;
      const login = env.login ?? 'anonymous';
      const delay = Math.min((Number.parseInt(sha256Hex(lower(login)).slice(0, 8), 16) % 30) * 1000, Math.max(0, capMs));
      if (delay > 0 || capMs === Infinity) await deps.sleep(delay);
    },
    runId: () => `tick-${deps.randomHex()}`,
    save: async () => {
      if (!dryRun) await saveState(deps, stateDir, state);
    },
  };
  return env;
}

/** Team policy: inline, cached for this cycle, or fetched (one network read). */
async function getTeam(env, project, at) {
  const { state, mods } = env;
  if (project.team) {
    const v = mods.policy.validateTeam(project.team);
    if (!v.ok) throw Object.assign(new Error(`inline team of ${project.id} is invalid: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`), { code: 'invalid-team' });
    return v.team;
  }
  const cache = state.teamCache?.[project.id];
  if (cache?.team) {
    const ph = mods.policy.cyclePhases(cache.team, at);
    const beforeWindow = at.getTime() < ph.rounds[1].claimStart.getTime();
    if (cache.cycle === ph.cycle || beforeWindow) return cache.team;
  }
  await env.jitter();
  const github = await env.getGithub();
  const { team } = await loadTeam(env.ctx, github, project, at);
  state.teamCache ??= {};
  state.teamCache[project.id] = {
    cycle: mods.policy.cyclePhases(team, at).cycle,
    fetchedAt: env.deps.now().toISOString(),
    digest: mods.policy.digestTeam(team),
    team,
  };
  return team;
}

function pendingAssigned(cs) {
  return Object.entries(cs?.assigned ?? {}).filter(([, a]) => !a.startedAt && !a.outcome);
}

async function tickProject(env, project, entry, at) {
  const { deps, config, state, mods, dryRun } = env;
  const team = await getTeam(env, project, at);
  const plan = planProject({ team, now: at, state, project, config, login: env.login });
  const { phases } = plan;
  entry.cycle = plan.cycle;
  entry.rounds = { 1: phases.rounds[1].state, 2: phases.rounds[2]?.state ?? null };
  entry.reason = plan.reason;

  const paused = isPaused(config, at);
  const cs = state.cycles[plan.key] ?? null;
  const livePosted = [1, 2].filter((r) => phases.rounds[r]?.state === 'open' && cs?.claimed?.[r]);
  const pauseWork = paused && phases.active && (livePosted.length > 0 || pendingAssigned(cs).length > 0);
  if (!pauseWork && !plan.needsNetwork) {
    return; // nothing to do and no network: `entry.reason` says why
  }
  entry.reason = undefined;

  // No point sleeping through a claim window: cap the jitter so that it ends well before the nearest one.
  const windowLeftMs = Math.min(Infinity, ...plan.claimRounds.map((r) => phases.rounds[r].claimEnd.getTime() - at.getTime()));
  await env.jitter(windowLeftMs - 2 * CLAIM_SAFETY_MS);
  const github = await env.getGithub();
  const login = await env.getLogin();
  const projectInfo = await github.resolveProject({ owner: project.owner, number: project.number, ownerType: project.ownerType ?? undefined });
  if (projectInfo.public === true && !allowsPublicBoard(config, project)) {
    deps.log?.warn?.(`tick: project board ${project.id} is PUBLIC: anyone can read it. Make it private (docs/board-lockdown.md) or set allowPublicBoard.`);
  }
  const { items, skipped } = await github.listItems(projectInfo, team);
  if (skipped.length) entry.skipped = skipped.length;
  const incomplete = await completeComments({ deps, github, projectInfo, team, items, entry });
  const byId = new Map(items.map((i) => [i.id, i]));
  const cfg = mods.policy.digestTeam(team);
  const cycleState = (state.cycles[plan.key] ??= emptyCycleState());
  const mutationDelayMs = config.execution?.mutationDelayMs ?? 1500;
  let mutations = 0;
  const spaced = async () => {
    if (mutations++ > 0 && mutationDelayMs > 0) await deps.sleep(mutationDelayMs);
  };
  const stamp = () => deps.now().toISOString();
  const stage = { deps, config, state, mods, dryRun, team, project, projectInfo, github, login, items, byId, cfg, cycleState, plan, entry, spaced, stamp, env, incomplete };

  if (!dryRun) await recoverCrashed(stage);
  if (paused) {
    await pauseStage(stage);
    return;
  }
  for (const r of plan.claimRounds) await claimStage(stage, r);
  const resolved = await resolveStage(stage, plan.resolveRounds);
  void resolved;
  await executeStage(stage);
}

/**
 * `listItems` only carries the newest comments of each item. Claims, assignments and `done` events are the
 * OLDEST comments of a busy issue, so every incomplete item is re-read with all its comment pages before
 * anything is computed from it (resolution must see the same inputs on every machine).
 * Items that cannot be completed stay in the list, and their ids are returned: the resolution is
 * postponed to the next tick while any is left.
 * @returns {Promise<Set<string>>} ids of the items whose comments are still incomplete
 */
async function completeComments({ deps, github, projectInfo, team, items, entry }) {
  const incomplete = new Set();
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].commentsComplete !== false) continue;
    try {
      items[i] = await github.getItem(projectInfo, team, items[i].itemId);
      if (items[i].commentsComplete === false) incomplete.add(items[i].id);
    } catch (error) {
      incomplete.add(items[i].id);
      deps.log?.warn?.(`tick: comments of ${items[i].id} could not be completed: ${/** @type {Error} */ (error)?.message ?? error}`);
    }
  }
  if (incomplete.size) entry.incompleteComments = incomplete.size;
  return incomplete;
}

// ---------------------------------------------------------------------------

async function postEvent(stage, item, payload, text) {
  const { mods, team, github } = stage;
  await stage.spaced();
  return github.postComment(item.issueNodeId, mods.claims.renderComment(payload, { team, text }));
}

function myEvents(stage, events, round) {
  const me = lower(stage.login);
  return events.filter((e) => lower(e.member) === me && (round === undefined || e.round === round));
}

/**
 * A crash or kill after `startedAt` was saved and before any outcome leaves an assignment that no run owns
 * (this tick holds the global lock, so none is alive). Reconcile it with the board:
 * - a terminal comment of mine already exists: adopt it;
 * - a `start` but no terminal comment: post `failed` + `release` (reason `crashed`), status back to Todo, budget refunded;
 * - no `start` at all (died before posting it): forget the start so that the task runs again, budget refunded.
 */
async function recoverCrashed(stage) {
  const { mods, team, plan, cycleState, byId, entry } = stage;
  const orphans = Object.entries(cycleState.assigned).filter(([, a]) => a.startedAt && !a.outcome);
  if (orphans.length === 0) return;
  const { events } = mods.claims.collectEvents({ items: stage.items, team, cycle: plan.cycle, cfg: stage.cfg });
  const refund = (a) => {
    cycleState.pointsUsed = Math.max(0, cycleState.pointsUsed - a.points);
    cycleState.tasksStarted = Math.max(0, cycleState.tasksStarted - 1);
  };
  for (const [task, a] of orphans) {
    const item = byId.get(task);
    if (item && stage.incomplete?.has(item.id)) continue; // cannot tell what happened yet: next tick
    const mine = myEvents(stage, events).filter((e) => e.task === task).sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt) || x.databaseId - y.databaseId);
    const startIndex = mine.findIndex((e) => e.kind === 'start');
    const after = startIndex < 0 ? [] : mine.slice(startIndex + 1);
    if (mine.some((e) => e.kind === 'done')) {
      a.outcome = 'done';
      entry.actions.push({ type: 'recover', task, round: a.round, detail: 'done-found' });
    } else if (after.some((e) => e.kind === 'release')) {
      a.outcome = 'released';
      a.reason = 'crashed';
      refund(a);
      entry.actions.push({ type: 'recover', task, round: a.round, detail: 'release-found' });
    } else if (after.some((e) => e.kind === 'failed')) {
      a.outcome = 'failed';
      a.reason = 'crashed';
      entry.actions.push({ type: 'recover', task, round: a.round, detail: 'failed-found' });
    } else if (startIndex < 0) {
      a.startedAt = null;
      refund(a);
      entry.actions.push({ type: 'recover', task, round: a.round, detail: 'restart' });
    } else if (!item) {
      a.outcome = 'released';
      a.reason = 'crashed';
      refund(a);
      entry.actions.push({ type: 'recover', task, round: a.round, detail: 'missing-item' });
    } else {
      const failed = mods.claims.buildLifecycle({ kind: 'failed', team, cycle: plan.cycle, round: a.round, login: stage.login, task, runId: a.runId ?? stage.env.runId(), extra: { model: a.model, reason: 'crashed' } });
      try {
        await postEvent(stage, item, failed);
        await releaseTask(stage, item, a, 'crashed');
      } catch (error) {
        entry.errors.push({ code: errorCode(error), message: `crash recovery failed for ${task}: ${/** @type {Error} */ (error).message}` });
        continue; // outcome stays unset: retried on the next tick
      }
      refund(a);
      entry.actions.push({ type: 'recover', task, round: a.round, detail: 'crashed' });
    }
  }
  await stage.env.save();
}

/** Paused: withdraw open-window claims, release unstarted assignments. */
async function pauseStage(stage) {
  const { mods, team, plan, cycleState, byId, login, entry, dryRun } = stage;
  const { events } = mods.claims.collectEvents({ items: stage.items, team, cycle: plan.cycle, cfg: stage.cfg });
  for (const r of [1, 2]) {
    if (plan.phases.rounds[r]?.state !== 'open' || !cycleState.claimed[r]) continue;
    const live = mods.claims.foldClaims(events, team, r).get(lower(login))?.claims ?? new Map();
    for (const [task] of live) {
      const item = byId.get(task);
      if (!item) continue;
      entry.actions.push({ type: 'withdraw', task, round: r, ...(dryRun ? { detail: 'dry-run' } : {}) });
      if (dryRun) continue;
      const payload = mods.claims.buildLifecycle({ kind: 'withdraw', team, cycle: plan.cycle, round: r, login, task, runId: stage.env.runId() });
      await postEvent(stage, item, payload);
    }
    if (!dryRun) cycleState.claimed[r] = null;
  }
  for (const [task, a] of pendingAssigned(cycleState)) {
    const item = byId.get(task);
    entry.actions.push({ type: 'release', task, round: a.round, detail: 'paused', ...(dryRun ? { dryRun: true } : {}) });
    if (dryRun) continue;
    if (item) await releaseTask(stage, item, a, 'paused');
    else a.outcome = 'released';
  }
  await stage.env.save();
}

async function releaseTask(stage, item, a, reason) {
  const { mods, team, plan, login, github, projectInfo, entry } = stage;
  const payload = mods.claims.buildLifecycle({ kind: 'release', team, cycle: plan.cycle, round: a.round, login, task: item.id, runId: stage.env.runId(), extra: { reason } });
  await postEvent(stage, item, payload);
  try {
    await stage.spaced();
    await github.setStatus(projectInfo, team, item.itemId, { status: team.statusValues.ready, agent: '' });
  } catch (error) {
    entry.errors.push({ code: errorCode(error), message: `status reset failed for ${item.id}: ${/** @type {Error} */ (error).message}` });
  }
  a.outcome = 'released';
  a.reason = reason;
}

/** Post this member's claims for an open round. */
async function claimStage(stage, round) {
  const { mods, config, team, plan, cycleState, state, login, items, byId, entry, dryRun, project } = stage;
  const claimEnd = plan.phases.rounds[round]?.claimEnd?.getTime() ?? Infinity;
  // The tick's clock was read before the jitter and the network calls: re-check the real clock before every post.
  const margin = CLAIM_SAFETY_MS + (config.execution?.mutationDelayMs ?? 1500);
  const tooLate = () => stage.deps.now().getTime() >= claimEnd - margin;
  if (!dryRun && tooLate()) {
    entry.actions.push({ type: 'noop', round, detail: 'claim-too-late' });
    return;
  }
  let offer = mods.policy.buildOffer({ config, team, login, now: stage.deps.now(), state, round });
  if (offer && round === 2) {
    // Round 2 re-declares the REMAINING capacity: tasks won in round 1 and not yet run still count.
    const pending = pendingAssigned(cycleState).reduce((sum, [, a]) => sum + a.points, 0);
    const capacity = offer.capacity - pending;
    offer = capacity >= 1 ? { ...offer, capacity } : null;
  }
  if (!offer) {
    entry.actions.push({ type: 'noop', round, detail: 'no-offer' });
    return;
  }
  const { events } = mods.claims.collectEvents({ items, team, cycle: plan.cycle, cfg: stage.cfg });
  const previous = round === 2
    ? mods.claims.resolveCycle({ team, cycle: plan.cycle, items, now: stage.deps.now(), history: mods.claims.computeHistory({ items, team, cycle: plan.cycle, cfg: stage.cfg }) }).rounds[1]
    : undefined;
  const cands = mods.claims.candidates({ items, team, cycle: plan.cycle, round, events, previous });
  // Trust gate 1 of 3: only tasks written (and last edited) by people on MY whitelist are ever claimed.
  const trust = mods.trust.partitionByTrust(cands.items, config.trustedAuthors);
  if (trust.untrusted.length > 0) {
    entry.untrusted = trust.untrusted.slice(0, 50).map((u) => ({ task: u.task, round, reason: u.reason, who: u.who, author: u.author, editor: u.editor }));
    if (mods.trust.trustSet(config.trustedAuthors).size === 0) {
      stage.deps.log?.warn?.(`tick: project ${project.id}: ${trust.untrusted.length} candidate task(s) but no trusted author is configured, so nothing is claimed. ${mods.trust.TRUST_HINT}`);
      entry.actions.push({ type: 'noop', round, detail: { reason: 'empty-trust-list', hint: mods.trust.TRUST_HINT, tasks: trust.untrusted.length } });
      return;
    }
    stage.deps.log?.info?.(`tick: project ${project.id}: ${trust.untrusted.length} candidate task(s) skipped, author not in trustedAuthors`);
  }
  const payloads = mods.claims.buildClaims({
    team,
    cycle: plan.cycle,
    round,
    login,
    offer,
    // an item whose comments are incomplete may hide my own earlier claim: do not claim it blindly
    candidates: cands.items.filter((i) => !stage.incomplete?.has(i.id)),
    repoAllowlist: Object.keys(project.repos ?? {}),
    existing: myEvents(stage, events, round),
    hardDifficultyAllowed: config.availability?.hardDifficultyAllowed === true,
    trustedAuthors: config.trustedAuthors,
    runId: stage.env.runId(),
    ts: stage.stamp(),
  });
  if (payloads.length === 0) {
    entry.actions.push({ type: 'noop', round, detail: trust.trusted.length === 0 && trust.untrusted.length > 0 ? { reason: 'untrusted-author', tasks: trust.untrusted.length } : 'no-claimable-task' });
    return;
  }
  const tasks = [];
  for (const payload of payloads) {
    const item = byId.get(payload.task);
    const action = { type: 'claim', task: payload.task, round, detail: { rank: payload.rank, capacity: payload.capacity, models: payload.models }, ...(dryRun ? { dryRun: true } : {}) };
    if (!dryRun) {
      if (tooLate()) {
        entry.actions.push({ type: 'noop', task: payload.task, round, detail: 'claim-too-late' });
        break;
      }
      const posted = await postEvent(stage, item, payload);
      // The server's clock decides: a claim created at or after the end of the window is ignored by everybody.
      const created = Date.parse(posted?.createdAt ?? '');
      if (Number.isFinite(created) && created >= claimEnd) {
        stage.deps.log?.warn?.(`tick: claim on ${payload.task} was created outside the window (server clock)`);
        entry.actions.push({ type: 'noop', task: payload.task, round, detail: 'claim-too-late' });
        break;
      }
    }
    entry.actions.push(action);
    tasks.push(payload.task);
  }
  // Only claims that really made it into the window count: otherwise the member would believe in them and never retry.
  if (tasks.length > 0) cycleState.claimed[round] = { postedAt: stage.stamp(), tasks };
  await stage.env.save();
}

/** Resolve every newly resolved round, post `assign` for my tasks (5.6.1). */
async function resolveStage(stage, rounds) {
  const { mods, config, team, plan, cycleState, state, login, items, byId, github, projectInfo, entry, dryRun } = stage;
  if (rounds.length === 0) return null;
  if (stage.incomplete?.size) {
    // Some comments could not be read: claims, assigns and `done` history may be missing. Never resolve on partial input.
    entry.actions.push({ type: 'noop', detail: { warning: 'comments-incomplete', tasks: [...stage.incomplete].slice(0, 20) } });
    return null;
  }
  const history = mods.claims.computeHistory({ items, team, cycle: plan.cycle, cfg: stage.cfg });
  const resolution = mods.claims.resolveCycle({ team, cycle: plan.cycle, items, now: stage.deps.now(), history });
  const { events } = mods.claims.collectEvents({ items, team, cycle: plan.cycle, cfg: stage.cfg });
  const mine = mods.claims.ownAssignments(resolution, login);
  for (const w of resolution.warnings ?? []) entry.actions.push({ type: 'noop', detail: { warning: w.code, task: w.task } });

  for (const r of rounds) {
    const result = resolution.rounds[r];
    if (!result?.ready) continue;
    entry.actions.push({ type: 'resolve', round: r, detail: { assigned: result.assignments.length, unassigned: result.unassigned.length, inputs: result.inputsDigest } });
    for (const a of mine.filter((x) => x.round === r)) {
      const item = byId.get(a.task);
      if (!item) continue;
      const known = cycleState.assigned[a.task];
      if (known && known.round === r) continue;
      // Trust gate 2 of 3: an assignment arrives, verify the task again against MY whitelist (it may have changed
      // since I claimed, or the issue may have been edited). Not trusted: release it with a reason, run nothing.
      const verdict = mods.trust.checkItemTrust(item, config.trustedAuthors);
      if (!verdict.trusted) {
        entry.actions.push({ type: 'release', task: a.task, round: r, detail: { reason: 'untrusted-author', who: verdict.who, login: verdict.login }, ...(dryRun ? { dryRun: true } : {}) });
        if (!dryRun) {
          const payload = mods.claims.buildLifecycle({ kind: 'release', team, cycle: plan.cycle, round: r, login, task: a.task, runId: stage.env.runId(), extra: { reason: 'untrusted-author' } });
          await postEvent(stage, item, payload);
          cycleState.assigned[a.task] = { round: r, model: a.model, difficulty: a.difficulty, points: a.points, assignPosted: false, startedAt: null, outcome: 'released', reason: 'untrusted-author', runId: null };
        }
        continue;
      }
      const already = myEvents(stage, events, r).some((e) => e.kind === 'assign' && e.task === a.task);
      entry.actions.push({ type: 'assign', task: a.task, round: r, detail: { model: a.model, points: a.points }, ...(dryRun ? { dryRun: true } : {}) });
      if (!dryRun && !already) {
        const payload = mods.claims.buildAssign({
          team, cycle: plan.cycle, round: r, login, assignment: a, claims: result.claimIds ?? [], inputs: result.inputsDigest, runId: stage.env.runId(), ts: stage.stamp(),
        });
        await postEvent(stage, item, payload);
      }
      if (!dryRun) {
        try {
          await stage.spaced();
          await github.setStatus(projectInfo, team, item.itemId, { status: team.statusValues.claimed, agent: `@${login}` });
        } catch (error) {
          entry.errors.push({ code: errorCode(error), message: `status update failed for ${a.task}: ${/** @type {Error} */ (error).message}` });
        }
      }
      cycleState.assigned[a.task] = { round: r, model: a.model, difficulty: a.difficulty, points: a.points, assignPosted: !dryRun, startedAt: null, outcome: null, runId: null };
    }
    cycleState.resolved[r] = { at: stage.stamp(), inputsDigest: result.inputsDigest };
  }
  // A task I was assigned earlier may now belong to someone else (released, round 2): drop it.
  const stillMine = new Set(mine.map((a) => a.task));
  for (const [task, a] of Object.entries(cycleState.assigned)) {
    if (!a.startedAt && !a.outcome && !stillMine.has(task)) {
      a.outcome = 'superseded';
      entry.actions.push({ type: 'noop', task, round: a.round, detail: 'superseded' });
    }
  }
  await stage.env.save();
  return resolution;
}

/** Run my assigned tasks, one at a time, within the daily caps. */
async function executeStage(stage) {
  const { mods, config, team, plan, cycleState, state, login, byId, github, projectInfo, entry, dryRun, project, deps } = stage;
  const maxPerRun = config.availability?.maxTasksPerRun ?? 1;
  let started = 0;
  for (const [task, a] of pendingAssigned(cycleState)) {
    if (started >= maxPerRun) break;
    const now = deps.now();
    const phases = mods.policy.cyclePhases(team, now, plan.cycle);
    if (!phases.executionOpen) break;
    const limitUntil = state.limit?.until ? Date.parse(state.limit.until) : NaN;
    if (Number.isFinite(limitUntil) && limitUntil > now.getTime()) {
      entry.actions.push({ type: 'noop', detail: 'limit' });
      break;
    }
    const item = byId.get(task);
    if (!item || !project.repos?.[item.repo]) {
      a.outcome = item ? 'repo-not-allowed' : 'missing';
      entry.actions.push({ type: 'noop', task, round: a.round, detail: a.outcome });
      continue;
    }
    const offer = mods.policy.buildOffer({ config, team, login, now, state, round: a.round });
    if (!offer || offer.capacity < a.points || !offer.models.includes(a.model)) {
      entry.actions.push({ type: 'noop', task, round: a.round, detail: 'caps' });
      continue;
    }
    started += 1;
    if (!dryRun) {
      a.startedAt = now.toISOString();
      cycleState.pointsUsed += a.points;
      cycleState.tasksStarted += 1;
      await stage.env.save();
    }
    const record = await mods.runner.runTask(deps, {
      config, project, team, task: item, projectInfo, github, login, cycle: plan.cycle, round: a.round,
      assignment: { task, member: login, model: a.model, difficulty: a.difficulty, points: a.points, rank: 1 },
      dryRun, state, stateDir: stage.env.stateDir,
    });
    entry.actions.push({ type: 'run', task, round: a.round, detail: { runId: record.runId, outcome: record.outcome, reason: record.reason ?? null, pr: record.pr ?? null, ...(dryRun ? { dryRun: true } : {}) } });
    if (dryRun) continue;
    a.outcome = record.outcome;
    a.runId = record.runId;
    a.reason = record.reason ?? null;
    if (record.outcome === 'skipped' || (record.outcome === 'released' && record.reason !== 'limit')) {
      // Nothing was consumed: give the budget back.
      cycleState.pointsUsed = Math.max(0, cycleState.pointsUsed - a.points);
      cycleState.tasksStarted = Math.max(0, cycleState.tasksStarted - 1);
    }
    await stage.env.save();
    if (record.reason === 'limit') {
      // Stop for the day (until reset) and give the unstarted tasks back for round 2.
      for (const [otherTask, other] of pendingAssigned(cycleState)) {
        const otherItem = byId.get(otherTask);
        entry.actions.push({ type: 'release', task: otherTask, round: other.round, detail: 'limit' });
        if (otherItem) await releaseTask(stage, otherItem, other, 'limit');
        else other.outcome = 'released';
      }
      await stage.env.save();
      break;
    }
  }
}

/** Remove leaked images/worktrees recorded in state (never anything unrecorded). */
async function janitor(env, summary) {
  const { state, deps, config, dryRun, mods } = env;
  if (dryRun || !(state.leaks?.length > 0)) return;
  try {
    const res = await mods.runner.cleanupLeaks(deps, { config, state, olderThanHours: 6 });
    if (res.removed.length || res.skipped.length) {
      const target = summary.projects[0] ?? summary.projects[summary.projects.push({ id: null, cycle: null, rounds: {}, actions: [], errors: [] }) - 1];
      target.actions.push({ type: 'janitor', detail: { removed: res.removed, skipped: res.skipped.map((s) => s.runId) } });
    }
  } catch (error) {
    deps.log?.warn?.(`tick: janitor failed: ${/** @type {Error} */ (error).message}`);
  }
}
