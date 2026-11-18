// runner.js: execute ONE won task end to end (design.md section 7).
// All IO goes through the injected `deps`; sibling modules (pharo, claudeRun,
// gitwork, ledger, claims, policy) are resolved lazily and can be overridden
// with `deps.modules` (used by tests).

import path from 'node:path';
import {
  buildPrBody,
  buildSystemPrompt,
  buildUserPrompt,
  sanitizeLine,
  sanitizeText,
} from './prompt.js';
import { PRIVATE_FILE_MODE, redact } from './util.js';
import { checkItemTrust } from './trust.js';

export const DEFAULT_FORBIDDEN_PATHS = ['.github/**', '.inactivity.json', '**/.git/**', '*.pem', '.env*'];
export const DEFAULT_MAX_CHANGED_FILES = 200;
export const MAX_DIFF_BYTES = 5 * 1024 * 1024;
export const STEP_NAMES = [
  'run-record', 'start-gate', 'git', 'project', 'pharo', 'prompt', 'claude',
  'classify', 'verify', 'diff', 'commit', 'push', 'pr', 'report', 'cleanup',
];

const PRIVATE_FILE = { mode: PRIVATE_FILE_MODE };

const MODULE_FILES = {
  pharo: './pharo.js',
  claudeRun: './claudeRun.js',
  gitwork: './gitwork.js',
  ledger: './ledger.js',
  claims: './claims.js',
  approval: './approval.js',
  policy: './policy.js',
  configMod: './config.js',
};

/** Reasons that are about the task (board status Blocked); everything else is infra (released, Todo). */
const TASK_REASONS = new Set(['tests', 'no-change', 'policy-violation', 'timeout', 'max_turns', 'budget', 'agent-blocked']);

/**
 * @param {any} deps
 * @returns {Promise<Record<string, any>>}
 */
export async function loadModules(deps) {
  const overrides = deps.modules ?? {};
  const out = {};
  for (const [key, file] of Object.entries(MODULE_FILES)) {
    if (overrides[key]) out[key] = overrides[key];
    else if (key !== 'configMod') out[key] = await import(new URL(file, import.meta.url).href);
  }
  if (overrides.configMod) out.configMod = overrides.configMod;
  return out;
}

class StepFailure extends Error {
  /** @param {string} reason @param {string} [detail] */
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
    this.detail = detail ?? '';
  }
}

/** A deliberate stop that is not a failure (gate refused, lost lock). `outcome` is 'skipped' unless the task was released. */
class Abort extends Error {
  constructor(reason, detail, outcome = 'skipped') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
    this.detail = detail ?? '';
    this.outcome = outcome;
  }
}

function failure(reason, detail) {
  return new StepFailure(reason, detail);
}

function asFailure(err, defaultReason) {
  if (err instanceof StepFailure) return err;
  const code = err && typeof err === 'object' ? err.code : undefined;
  const reason = code === 'auth' ? 'auth' : defaultReason;
  const message = sanitizeLine(err instanceof Error ? err.message : String(err), 300);
  return new StepFailure(reason, message);
}

const lower = (s) => String(s ?? '').toLowerCase();

function makeRunId(deps) {
  const iso = deps.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${iso}-${deps.randomHex()}`;
}

async function resolveStateDir(deps, params, mods) {
  if (params.stateDir) return params.stateDir;
  if (deps.stateDir) return deps.stateDir;
  const cfg = mods.configMod ?? (await import(new URL('./config.js', import.meta.url).href));
  return cfg.resolvePaths(deps.env, deps.platform, deps.homedir()).stateDir;
}

/**
 * Read and normalise `.inactivity.json` from a worktree (3.3), with the
 * beta autodetect fallback for the baseline.
 * @returns {Promise<{pharo:{template:string, category:string|null}, baseline:{name:string, sourceDirectory:string, group:string|null, repository:string|null}, verify:{expression:string|null, mcp:object|null}, forbiddenPaths:string[], maxChangedFiles:number, extraInstructions:string|null, warnings:string[]}>}
 */
export async function readProjectDeclaration(deps, worktree, config) {
  const warnings = [];
  let raw = {};
  let text = null;
  try {
    text = await deps.fs.readFile(path.join(worktree, '.inactivity.json'), 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw failure('pharo-env', `cannot read .inactivity.json: ${err?.message ?? err}`);
  }
  if (text !== null) {
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw failure('pharo-env', `bad-project-file: ${err.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('pharo-env', 'bad-project-file: not an object');
    if (raw.version !== undefined && raw.version !== 1) throw failure('pharo-env', `bad-project-file: unsupported version ${raw.version}`);
  }
  const baseline = { ...(raw.baseline ?? {}) };
  const sourceDirectory = typeof baseline.sourceDirectory === 'string' && baseline.sourceDirectory ? baseline.sourceDirectory : 'src';
  let name = typeof baseline.name === 'string' && baseline.name ? baseline.name : null;
  if (!name) {
    let entries = [];
    try {
      entries = await deps.fs.readdir(path.join(worktree, sourceDirectory));
    } catch {
      entries = [];
    }
    const found = entries.map(String).filter((e) => /^BaselineOf.+/.test(e)).sort()[0];
    if (!found) throw failure('pharo-env', 'no-baseline');
    name = found.replace(/^BaselineOf/, '');
    warnings.push('autodetected-baseline');
  }
  const template = raw.pharo?.template ?? config?.pharo?.defaultTemplate;
  if (!template) throw failure('pharo-env', 'no-template');
  return {
    pharo: { template, category: raw.pharo?.category ?? null },
    baseline: { name, sourceDirectory, group: baseline.group ?? null, repository: baseline.repository ?? null },
    verify: { expression: raw.verify?.expression ?? null, mcp: raw.verify?.mcp ?? null },
    forbiddenPaths: Array.isArray(raw.forbiddenPaths) ? raw.forbiddenPaths.map(String) : [],
    maxChangedFiles: Number.isInteger(raw.maxChangedFiles) && raw.maxChangedFiles > 0 ? raw.maxChangedFiles : DEFAULT_MAX_CHANGED_FILES,
    extraInstructions: typeof raw.extraInstructions === 'string' ? raw.extraInstructions : null,
    warnings,
  };
}

function resolveModel(ma, assignment, config, team) {
  const tier = assignment?.model ?? ma.tier;
  if (tier === ma.tier) return { tier, model: ma.model, effort: ma.effort };
  return {
    tier,
    model: config.modelOverrides?.[tier] ?? tier,
    effort: config.effort?.[tier] ?? team.effort?.[tier] ?? ma.effort,
  };
}

function resultText(parsed) {
  if (typeof parsed?.result?.result === 'string') return parsed.result.result;
  if (Array.isArray(parsed?.texts)) return parsed.texts.join('\n');
  return '';
}

function infraReleaseReason(reason) {
  return ['limit', 'untrusted-author', 'not-approved'].includes(reason) ? reason : 'infra';
}

/**
 * Execute one task. Never throws except on programmer error; cleanup runs in `finally`.
 * Optional extras beyond the spec: `stateDir`, `state` (the caller's live state object, mutated in place and saved).
 * @param {any} deps
 * @param {any} params
 */
export async function runTask(deps, params) {
  const {
    config, project, team, task, projectInfo, github, login, cycle, round = 1,
    assignment, dryRun = false, keep = false, forced = false, noPr = false,
  } = params;
  const mods = await loadModules(deps);
  const { pharo, claudeRun, gitwork, ledger, claims, policy, approval } = mods;
  const stateDir = await resolveStateDir(deps, params, mods);
  const difficulty = assignment?.difficulty ?? policy.difficultyOf(task, team);
  const ma = policy.modelArgs({ difficulty, team, config });
  const chosen = resolveModel(ma, assignment, config, team);
  const statusValues = team.statusValues ?? {};
  const repoEntry = project?.repos?.[task.repo];
  const branchPrefix = config.git?.branchPrefix ?? 'inactivity';
  const remote = config.git?.remote ?? 'origin';
  const mutationDelayMs = config.execution?.mutationDelayMs ?? 1500;
  const nowMs = () => deps.now().getTime();

  /** @type {any} */
  const record = {
    runId: null,
    project: project?.id ?? null,
    task: task.id,
    member: login,
    cycle,
    round,
    model: chosen.model,
    effort: chosen.effort,
    difficulty,
    scope: null,
    branch: null,
    baseCommit: null,
    headCommit: null,
    startedAt: deps.now().toISOString(),
    endedAt: null,
    steps: [],
    outcome: null,
    reason: null,
    detail: null,
    pr: null,
    costUsd: null,
    numTurns: null,
    claudeExit: null,
    limit: { until: null },
    verify: { ran: false, passed: null },
    unverified: false,
    warnings: [],
    runDir: null,
  };

  if (!repoEntry) {
    record.runId = makeRunId(deps);
    record.outcome = 'skipped';
    record.reason = 'repo-not-allowed';
    record.endedAt = deps.now().toISOString();
    return record;
  }

  // ---- dry run: compute the plan, perform nothing --------------------------
  if (dryRun) {
    record.runId = makeRunId(deps);
    record.scope = pharo.scopeFor(task.repo, task.number, record.runId);
    record.outcome = 'dry-run';
    record.endedAt = deps.now().toISOString();
    const plan = {
      dryRun: true,
      scope: record.scope,
      worktree: path.join(stateDir, 'work', record.runId),
      branchPrefix: `${branchPrefix}/${login}/`,
      model: chosen.model,
      effort: chosen.effort,
      timeoutMs: ma.timeoutMs,
      maxTurns: ma.maxTurns,
      maxBudgetUsd: ma.maxBudgetUsd ?? null,
      steps: STEP_NAMES,
    };
    try {
      plan.argv = claudeRun.buildClaudeArgs(claudeOptions('<runDir>'));
    } catch {
      plan.argv = null;
    }
    record.plan = plan;
    return record;
  }

  function claudeOptions(runDir) {
    return {
      model: chosen.model,
      effort: chosen.effort,
      runDir,
      mcpConfigPath: path.join(runDir, 'mcp.json'),
      systemPromptFile: path.join(runDir, 'system.md'),
      maxTurns: ma.maxTurns,
      maxBudgetUsd: ma.maxBudgetUsd ?? null,
      extraAllowedTools: config.permissions?.extraAllowedTools ?? [],
      extraDisallowedTools: config.permissions?.extraDisallowedTools ?? [],
      denyPharoTools: config.permissions?.denyPharoTools ?? [],
      allowPharoTools: config.permissions?.allowPharoTools ?? [],
      allowImageEvaluate: config.permissions?.allowImageEvaluate === true,
      loadUserSettings: config.claude?.loadUserSettings === true,
      claudeConfigDir: config.claude?.configDir ?? null,
    };
  }

  // ---- real run ------------------------------------------------------------
  const ctx = {
    startPosted: false,
    imageTouched: false,
    workDir: null,
    worktreeCreated: false,
    mirrorPath: null,
    endpointUrl: null,
    base: null,
    decl: null,
    leakRegistered: false,
    pushedBranch: false,
  };
  let mutations = 0;
  let state = params.state ?? null;
  let runDir = null;
  // Title and body that passed the trust gate. Everything executed or published comes from THIS copy (freshly
  // read from GitHub), never from the possibly stale `task`: otherwise an edit made after the check would run.
  let work = task;

  const persist = async () => {
    if (!runDir) return;
    try {
      await ledger.writeRun(deps, runDir, record);
    } catch (err) {
      deps.log.warn(`run.json write failed: ${err?.message ?? err}`);
    }
  };

  const step = async (name, defaultReason, fn) => {
    const t0 = nowMs();
    try {
      const value = await fn();
      record.steps.push({ name, ok: true, ms: nowMs() - t0 });
      await persist();
      return value;
    } catch (err) {
      const isAbort = err instanceof Abort;
      const f = isAbort ? err : asFailure(err, defaultReason);
      record.steps.push({ name, ok: false, ms: nowMs() - t0, detail: f.detail || f.message });
      await persist();
      throw f;
    }
  };

  const withState = async (mutate) => {
    try {
      if (!state) state = await ledger.loadState(deps, stateDir);
      mutate(state);
      await ledger.saveState(deps, stateDir, state);
      return true;
    } catch (err) {
      deps.log.warn(`state update failed: ${err?.message ?? err}`);
      return false;
    }
  };

  const pause = async () => {
    if (mutations++ > 0 && mutationDelayMs > 0) await deps.sleep(mutationDelayMs);
  };

  const postLifecycle = async (kind, extra, text) => {
    const payload = claims.buildLifecycle({
      kind, team, cycle, round, login, task: task.id, runId: record.runId, extra: extra ?? {},
    });
    const body = claims.renderComment(payload, { team, text });
    await pause();
    return github.postComment(task.issueNodeId, body);
  };

  const setStatus = async (fields) => {
    try {
      await pause();
      await github.setStatus(projectInfo, team, task.itemId, fields);
    } catch (err) {
      record.warnings.push(`status-update-failed: ${sanitizeLine(err?.message ?? err, 120)}`);
      deps.log.warn(`status update failed: ${err?.message ?? err}`);
    }
  };

  const eventsOf = (item) => claims.collectEvents({ items: [item], team, cycle, cfg: policy.digestTeam(team) }).events;

  async function checkApproval(item) {
    const mode = approval.approvalMode(config);
    if (mode === 'none') return { approved: true };
    return approval.checkItemApproval(item, { mode, store: await approval.loadApprovals(deps, stateDir) });
  }

  function checkGate(fresh) {
    if (fresh.state && fresh.state !== 'OPEN') throw new Abort('not-open', fresh.state);
    if ((fresh.labels ?? []).includes('inactivity:skip')) throw new Abort('skip-label');
    const status = fresh.fields?.status ?? null;
    const allowed = [statusValues.ready, statusValues.claimed].filter(Boolean);
    if (status && allowed.length && !allowed.includes(status)) throw new Abort('status-changed', status);
    const events = eventsOf(fresh).filter((e) => e.task === task.id);
    if (events.some((e) => e.kind === 'done' && e.payload?.cycle === cycle)) throw new Abort('already-done');
    const first = claims.earliestStart({ events, task: task.id, cycle });
    if (first && lower(first.member) !== lower(login)) throw new Abort('started-by-other', first.member);
    const laterAssign = events.find((e) => e.kind === 'assign' && e.round > round && lower(e.member) !== lower(login));
    if (laterAssign) throw new Abort('assigned-in-later-round', laterAssign.member);
  }

  async function takenBranches(mirrorPath) {
    // local branches of earlier runs and branches already on the remote
    const res = await deps.exec('git', ['-C', mirrorPath, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branchPrefix}/`, `refs/remotes/origin/${branchPrefix}/`]);
    if (res.code !== 0) return [];
    return String(res.stdout).split('\n').map((l) => l.trim().replace(/^origin\//, '')).filter(Boolean);
  }

  /** Main flow; returns a `fin` describing the final outcome or throws StepFailure/Abort. */
  async function mainFlow() {
    // 1. run record
    await step('run-record', 'internal', async () => {
      const run = await ledger.newRun(deps, { stateDir, project: project?.id ?? null, task: task.id, member: login, cycle, round });
      record.runId = run.runId;
      record.runDir = run.runDir;
      runDir = run.runDir;
      record.scope = pharo.scopeFor(task.repo, task.number, run.runId);
      ctx.workDir = path.join(stateDir, 'work', run.runId);
      ctx.leakRegistered = await withState((s) => {
        s.leaks = s.leaks ?? [];
        s.leaks.push({ runId: run.runId, scope: record.scope, worktree: ctx.workDir, mirror: null, startedAt: record.startedAt });
      });
      await ledger.appendLedger(deps, stateDir, {
        event: 'start', at: record.startedAt, runId: run.runId, project: record.project, task: task.id,
        member: login, cycle, round, model: record.model, difficulty, title: sanitizeLine(work.title, 120),
      });
    });

    // 2. start gate
    await step('start-gate', 'internal', async () => {
      const fresh = await github.getItem(projectInfo, team, task.itemId);
      if (!forced) checkGate(fresh);
      // Trust gate 3 of 3 (never bypassed, `--force` included): the author AND the last editor of the freshly
      // fetched issue must be on THIS member's whitelist, otherwise nothing runs.
      const verdict = checkItemTrust(fresh, config.trustedAuthors);
      if (!verdict.trusted) {
        if (forced) throw new Abort('untrusted-author', verdict.detail);
        try {
          await postLifecycle('release', { reason: 'untrusted-author' });
          await setStatus({ status: statusValues.ready ?? 'Todo', agent: '' });
        } catch (err) {
          deps.log.warn(`release(untrusted-author) failed: ${err?.message ?? err}`);
        }
        throw new Abort('untrusted-author', verdict.detail, 'released');
      }
      // Approval gate 3 of 3 (never bypassed, `--force` included): this member must have approved the CONTENT of the
      // freshly fetched item (author, title, body). Read from disk now: a revocation or an edit counts immediately.
      const approved = await checkApproval(fresh);
      if (!approved.approved) {
        if (forced) throw new Abort('not-approved', approved.detail);
        try {
          await postLifecycle('release', { reason: 'not-approved' });
          await setStatus({ status: statusValues.ready ?? 'Todo', agent: '' });
        } catch (err) {
          deps.log.warn(`release(not-approved) failed: ${err?.message ?? err}`);
        }
        throw new Abort('not-approved', approved.detail, 'released');
      }
      work = { ...task, title: fresh.title, body: fresh.body };
      await postLifecycle('start', { model: chosen.tier });
      ctx.startPosted = true;
      // Second read, after `start` is posted: it detects a lost lock, and an edit made in between.
      const after = await github.getItem(projectInfo, team, task.itemId);
      const verdictAfter = checkItemTrust(after, config.trustedAuthors);
      if (!verdictAfter.trusted) throw failure('untrusted-author', verdictAfter.detail);
      const approvedAfter = await checkApproval(after);
      if (!approvedAfter.approved) throw failure('not-approved', approvedAfter.detail);
      work = { ...task, title: after.title, body: after.body };
      if (!forced) {
        const first = claims.earliestStart({ events: eventsOf(after).filter((e) => e.task === task.id), task: task.id, cycle });
        if (first && lower(first.member) !== lower(login)) {
          try {
            await postLifecycle('release', { reason: 'lost-lock' });
          } catch (err) {
            deps.log.warn(`release(lost-lock) failed: ${err?.message ?? err}`);
          }
          throw new Abort('lost-lock', first.member);
        }
      }
      await setStatus({ status: statusValues.inProgress ?? 'In progress', agent: `@${login}` });
    });

    // 3. git
    await step('git', 'git', async () => {
      let base = repoEntry.baseBranch ?? null;
      if (!base) base = (await github.repoInfo(task.repo)).defaultBranch;
      ctx.base = base;
      const cloneUrl = repoEntry.cloneUrl ?? `https://github.com/${task.repo}.git`;
      ctx.mirrorPath = await gitwork.ensureMirror(deps, { stateDir, repo: task.repo, cloneUrl });
      await withState((s) => {
        const leak = (s.leaks ?? []).find((l) => l.runId === record.runId);
        if (leak) leak.mirror = ctx.mirrorPath;
      });
      const taken = await takenBranches(ctx.mirrorPath);
      record.branch = gitwork.branchName({ prefix: branchPrefix, login, number: task.number, title: work.title, taken });
      ctx.worktreeCreated = true; // removal is attempted even if createWorktree fails halfway
      const wt = await gitwork.createWorktree(deps, { mirrorPath: ctx.mirrorPath, workDir: ctx.workDir, branch: record.branch, base });
      ctx.workDir = wt.path ?? ctx.workDir;
      record.baseCommit = wt.baseCommit ?? null;
    });

    // 4. project declaration
    ctx.decl = await step('project', 'pharo-env', async () => {
      const decl = await readProjectDeclaration(deps, ctx.workDir, config);
      record.warnings.push(...decl.warnings);
      return decl;
    });
    const decl = ctx.decl;

    // 5. pharo environment
    await step('pharo', 'pharo-env', async () => {
      ctx.imageTouched = true;
      await pharo.createTaskImage(deps, config, { scope: record.scope, template: decl.pharo.template, category: decl.pharo.category });
      const started = await pharo.startTaskImage(deps, config, {
        scope: record.scope, timeoutSeconds: config.pharo?.imageStartTimeoutSeconds ?? 600,
      });
      ctx.endpointUrl = started.endpointUrl;
      const load = await pharo.loadBaseline(deps, { endpointUrl: ctx.endpointUrl, baseline: decl.baseline, checkout: ctx.workDir });
      if (!load?.ok) throw failure('pharo-env', `load-failed: ${sanitizeLine(String(load?.text ?? '').slice(-300), 300)}`);
    });

    // 6. prompt files
    const userPrompt = await step('prompt', 'internal', async () => {
      const system = buildSystemPrompt({ task: work, repoConfig: decl, difficulty });
      const user = buildUserPrompt({ task: work, difficulty });
      await deps.fs.writeFile(path.join(runDir, 'system.md'), system, PRIVATE_FILE);
      await deps.fs.writeFile(path.join(runDir, 'prompt.md'), user, PRIVATE_FILE);
      await deps.fs.writeFile(path.join(runDir, 'mcp.json'), `${JSON.stringify(pharo.claudeMcpConfig(config, record.scope, deps.env), null, 2)}\n`, PRIVATE_FILE);
      return user;
    });

    // 7 + 8. claude, classification
    const run = await step('claude', 'internal', async () => {
      const args = claudeRun.buildClaudeArgs(claudeOptions(runDir));
      const env = claudeRun.buildClaudeEnv(deps.env, config);
      const res = await claudeRun.runClaude(deps, {
        cwd: ctx.workDir,
        prompt: userPrompt,
        args,
        env,
        timeoutMs: ma.timeoutMs,
        claudePath: config.claude?.path ?? 'claude',
        teePath: path.join(runDir, 'claude.stream.jsonl'),
      });
      record.claudeExit = res.exec?.code ?? null;
      record.numTurns = res.parsed?.result?.num_turns ?? null;
      record.costUsd = res.parsed?.result?.total_cost_usd ?? null;
      if (res.exec?.stderr) {
        try {
          await deps.fs.writeFile(path.join(runDir, 'claude.stderr.log'), redact(String(res.exec.stderr)), PRIVATE_FILE);
        } catch { /* best effort */ }
      }
      return res;
    });

    const outcome = run.outcome ?? { kind: 'error', detail: 'no outcome' };
    const kind = outcome.kind;
    const resultBlock = await step('classify', 'internal', async () => {
      if (!['limit', 'auth', 'overloaded'].includes(kind) && (kind === 'success' || run.parsed?.init)) {
        const init = claudeRun.verifyInit(run.parsed);
        if (!init.ok) throw failure('pharo-env', `mcp-not-connected: ${(init.problems ?? []).join('; ')}`);
      }
      return claudeRun.extractResultBlock(resultText(run.parsed));
    });
    record.detail = outcome.detail ? sanitizeLine(outcome.detail, 300) : null;

    // Infra-type outcomes: nothing to publish.
    if (kind === 'auth' || kind === 'overloaded') return { outcome: 'released', reason: kind, detail: outcome.detail };
    if (kind === 'error') return { outcome: 'released', reason: 'internal', detail: outcome.detail };

    // 9. verification (dispatcher side)
    const verify = await step('verify', 'internal', async () => {
      if (kind === 'limit') return { ran: false, passed: null, text: '', skipped: true };
      const v = decl.verify;
      let result;
      if (!v.expression && !v.mcp) {
        record.unverified = true;
        result = { ran: false, passed: null, text: '' };
      } else {
        try {
          const r = await pharo.runVerify(deps, { endpointUrl: ctx.endpointUrl, verify: v });
          result = { ran: !!r.ran, passed: r.passed ?? null, text: String(r.text ?? '') };
        } catch (err) {
          result = { ran: false, passed: false, text: `verification error: ${err?.message ?? err}`, error: true };
        }
        try {
          await deps.fs.writeFile(path.join(runDir, 'verify.txt'), redact(result.text), PRIVATE_FILE);
        } catch { /* best effort */ }
      }
      record.verify = { ran: result.ran, passed: result.passed };
      return result;
    });

    // 10. diff gate
    const diff = await step('diff', 'git', () => gitwork.checkDiff(deps, {
      path: ctx.workDir,
      forbidden: [...DEFAULT_FORBIDDEN_PATHS, ...decl.forbiddenPaths],
      maxFiles: decl.maxChangedFiles,
      maxBytes: MAX_DIFF_BYTES,
    }));

    if (kind === 'limit') {
      const until = outcome.resetsAt ?? policy.cyclePhases(team, deps.now()).executionEnd.toISOString();
      record.limit = { until };
      const fin = { outcome: 'released', reason: 'limit', detail: outcome.detail, limitUntil: until };
      if (diff.ok) {
        await step('commit', 'git', async () => { await commitWork(diff, resultBlock, 'WIP (usage limit hit) '); });
        await step('push', 'push', async () => { await pushWork(); });
        fin.branch = record.branch;
      }
      return fin;
    }

    if (!diff.ok) {
      const reason = diff.reason === 'policy-violation' ? 'policy-violation' : 'no-change';
      return { outcome: 'failed', reason, detail: diff.detail };
    }

    // Decide the board outcome before publishing.
    /** @type {{outcome:string, reason:string|null}} */
    let decided;
    if (kind === 'success') {
      if (verify.ran === false && !record.unverified) decided = { outcome: 'failed', reason: 'tests' };
      else if (verify.ran && !verify.passed) decided = { outcome: 'failed', reason: 'tests' };
      else if (resultBlock?.status === 'blocked') decided = { outcome: 'blocked', reason: 'agent-blocked' };
      else decided = { outcome: 'done', reason: null };
    } else {
      decided = { outcome: 'failed', reason: kind }; // timeout | max_turns | budget
    }

    // 11-12. commit, push
    await step('commit', 'git', async () => { await commitWork(diff, resultBlock, ''); });
    await step('push', 'push', async () => { await pushWork(); });

    // 13. pull request
    await step('pr', 'push', async () => {
      record.outcome = decided.outcome;
      record.reason = decided.reason;
      if (noPr) return; // `run --no-pr`: the branch is pushed, no pull request is opened
      const body = buildPrBody({ task: work, run: record, resultBlock, verify: record.unverified ? null : verify });
      const pr = await github.createPullRequest({
        repo: task.repo,
        base: ctx.base,
        head: record.branch,
        title: `${sanitizeLine(work.title, 200)} (#${task.number})`,
        body,
        draft: true,
      });
      record.pr = pr.url;
      const labels = ['inactivity'];
      if (decided.outcome !== 'done') labels.push('inactivity:needs-human');
      try {
        await github.addLabels(task.repo, pr.nodeId, labels);
      } catch (err) {
        record.warnings.push(`labels-failed: ${sanitizeLine(err?.message ?? err, 120)}`);
      }
    });
    return { ...decided, detail: outcome.detail, branch: record.branch, pr: record.pr, resultBlock };
  }

  async function commitWork(diff, resultBlock, prefix) {
    const summary = sanitizeText(resultBlock?.summary ?? '', 600) || 'Automated change by inactivity.';
    record.headCommit = await gitwork.commitAll(deps, {
      path: ctx.workDir,
      login,
      title: sanitizeLine(`${prefix}${work.title}`, 200),
      number: task.number,
      summary,
      runId: record.runId,
    });
  }

  async function pushWork() {
    await gitwork.push(deps, { path: ctx.workDir, remote, branch: record.branch, base: ctx.base });
    ctx.pushedBranch = true;
  }

  // ---- drive ---------------------------------------------------------------
  /** @type {any} */
  let fin;
  try {
    fin = await mainFlow();
  } catch (err) {
    if (err instanceof Abort) {
      fin = { outcome: err.outcome ?? 'skipped', reason: err.reason, detail: err.detail };
    } else {
      const f = asFailure(err, 'internal');
      fin = {
        outcome: TASK_REASONS.has(f.reason) ? 'failed' : 'released',
        reason: f.reason,
        detail: f.detail,
        branch: ctx.pushedBranch ? record.branch : null,
      };
    }
  }

  record.outcome = fin.outcome;
  record.reason = fin.reason ?? null;
  if (fin.detail) record.detail = sanitizeLine(fin.detail, 300);
  record.pr = fin.pr ?? record.pr;

  try {
    // 14. report
    if (ctx.startPosted && fin.outcome !== 'skipped') {
      await step('report', 'internal', async () => {
        const model = chosen.tier;
        const branchExtra = ctx.pushedBranch && record.branch ? { branch: record.branch } : {};
        if (fin.outcome === 'done') {
          const summary = sanitizeText(fin.resultBlock?.summary ?? '', 600);
          const where = record.pr ? `Draft PR: ${record.pr}` : `Branch: ${record.branch}`;
          const text = `:robot: **Done** by @${login} (model: ${model}). ${where}${summary ? `\n\n${summary}` : ''}`;
          await postLifecycle('done', { model, points: assignment?.points ?? policy.costOf(difficulty, team), pr: record.pr, branch: record.branch }, text);
          await setStatus({ status: statusValues.inReview ?? 'In review' });
        } else if (fin.outcome === 'failed' || fin.outcome === 'blocked') {
          const extra = { model, reason: fin.reason, ...branchExtra };
          if (record.pr) extra.pr = record.pr;
          await postLifecycle('failed', extra);
          await setStatus({ status: statusValues.blocked ?? 'Blocked' });
        } else {
          await postLifecycle('failed', { model, reason: fin.reason, ...branchExtra });
          await postLifecycle('release', { reason: infraReleaseReason(fin.reason) });
          await setStatus({ status: statusValues.ready ?? 'Todo', agent: '' });
        }
      }).catch((err) => {
        record.warnings.push(`report-failed: ${sanitizeLine(err?.message ?? err, 160)}`);
      });
    }
    if (fin.limitUntil) {
      await withState((s) => { s.limit = { until: fin.limitUntil, reason: 'limit' }; });
    }
  } catch (err) {
    deps.log.warn(`reporting failed: ${err?.message ?? err}`);
  } finally {
    // 15. cleanup, always
    await cleanup();
    record.endedAt = deps.now().toISOString();
    try {
      if (record.runId && runDir) {
        await ledger.appendLedger(deps, stateDir, {
          event: 'end', at: record.endedAt, runId: record.runId, project: record.project, task: task.id,
          member: login, outcome: record.outcome, reason: record.reason, pr: record.pr, branch: record.branch,
          costUsd: record.costUsd, numTurns: record.numTurns,
        });
      }
    } catch (err) {
      deps.log.warn(`ledger end write failed: ${err?.message ?? err}`);
    }
    await persist();
  }
  return record;

  async function cleanup() {
    const t0 = nowMs();
    const info = { image: null, worktree: null, kept: [] };
    let imageOk = true;
    let worktreeOk = true;
    if (ctx.imageTouched && !keep) {
      try {
        const r = await pharo.disposeTaskImage(deps, config, record.scope);
        info.image = r;
        imageOk = !(r?.leftovers?.length);
      } catch (err) {
        imageOk = false;
        info.image = { error: String(err?.message ?? err) };
      }
    } else if (ctx.imageTouched) {
      info.kept.push('image');
    }
    const keepWorktree = keep || (config.git?.keepWorktreeOnFailure && record.outcome !== 'done');
    if (ctx.worktreeCreated && !keepWorktree) {
      try {
        await gitwork.removeWorktree(deps, { mirrorPath: ctx.mirrorPath, path: ctx.workDir });
        info.worktree = { removed: true };
      } catch (err) {
        worktreeOk = false;
        info.worktree = { removed: false, error: String(err?.message ?? err) };
      }
    } else if (ctx.worktreeCreated) {
      info.kept.push('worktree');
    }
    record.cleanup = info;
    if (ctx.leakRegistered && ((imageOk && worktreeOk) || info.kept.length)) {
      // Kept things are the user's explicit choice: the janitor must not delete them later.
      await withState((s) => {
        s.leaks = (s.leaks ?? []).filter((l) => l.runId !== record.runId);
      });
    }
    record.steps.push({ name: 'cleanup', ok: imageOk && worktreeOk, ms: nowMs() - t0 });
  }
}

/**
 * Janitor: remove leaked images/worktrees recorded in `state.leaks` (never anything unrecorded).
 * Mutates `state.leaks` in place (removed entries are dropped); the caller saves the state.
 * @param {any} deps
 * @param {{config:any, state:any, olderThanHours?:number, stateDir?:string}} params
 * @returns {Promise<{removed:string[], skipped:{runId:string, reason:string}[]}>}
 */
export async function cleanupLeaks(deps, { config, state, olderThanHours = 6 }) {
  const mods = await loadModules(deps);
  const { pharo, gitwork } = mods;
  const cutoff = deps.now().getTime() - olderThanHours * 3600 * 1000;
  const removed = [];
  const skipped = [];
  const keepers = [];
  for (const leak of state.leaks ?? []) {
    const started = Date.parse(leak.startedAt ?? '');
    if (Number.isFinite(started) && started > cutoff) {
      skipped.push({ runId: leak.runId, reason: 'too-recent' });
      keepers.push(leak);
      continue;
    }
    let ok = true;
    let reason = '';
    try {
      const r = await pharo.disposeTaskImage(deps, config, leak.scope);
      if (r?.leftovers?.length) { ok = false; reason = `image-leftovers: ${r.leftovers.join(',')}`; }
    } catch (err) {
      ok = false;
      reason = `image: ${err?.message ?? err}`;
    }
    if (leak.worktree) {
      let exists = true;
      try {
        await deps.fs.stat(leak.worktree);
      } catch {
        exists = false;
      }
      if (exists) {
        if (!leak.mirror) {
          ok = false;
          reason = reason || 'no-mirror';
        } else {
          try {
            await gitwork.removeWorktree(deps, { mirrorPath: leak.mirror, path: leak.worktree });
          } catch (err) {
            ok = false;
            reason = reason || `worktree: ${err?.message ?? err}`;
          }
        }
      }
    }
    if (ok) removed.push(leak.runId);
    else {
      skipped.push({ runId: leak.runId, reason });
      keepers.push(leak);
    }
  }
  state.leaks = keepers;
  return { removed, skipped };
}
