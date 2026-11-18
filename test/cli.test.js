// CLI tests. The sibling modules (config, policy, claims, github, ...) are
// replaced by in-memory fakes through main()'s third argument, so this file
// passes standalone: no network, no gh, no claude, no Pharo.
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GLOBAL_FLAGS, commands, main, parseArgv, parseDuration, readmeCommandTable } from "../src/cli.js";
import { renderHelp } from "../src/help.js";
import { parseVersion, versionAtLeast } from "../src/doctor.js";

const NOW = new Date("2026-11-19T04:10:00Z");

// ---------------------------------------------------------------------------
// Fakes

function fakeConfigModule() {
  // approval "none": these tests are about claims and resolution, the approval gate has its own tests (approval.test.js)
  const defaults = () => ({ version: 1, login: null, approval: "none", projects: [], availability: {}, execution: { mutationDelayMs: 0 } });
  return {
    resolvePaths(env) {
      const home = env.INACTIVITY_HOME;
      return { configHome: home, configPath: path.join(home, "config.json"), stateDir: path.join(home, "state") };
    },
    async loadConfig(deps, { path: p }) {
      let text;
      try {
        text = await fsp.readFile(p, "utf8");
      } catch {
        const error = new Error(`no config at ${p}`);
        error.code = "no-config";
        throw error;
      }
      const config = { ...defaults(), ...JSON.parse(text) };
      const errors = config.version === 1 ? [] : [{ path: "/version", message: "must be 1" }];
      return { config, errors };
    },
    validateConfig(obj) {
      const errors = [];
      if (obj?.version !== 1) errors.push({ path: "/version", message: "must be 1" });
      if (!Array.isArray(obj?.projects)) errors.push({ path: "/projects", message: "must be an array" });
      return { ok: errors.length === 0, errors, config: obj };
    },
    async saveConfig(deps, config, { path: p }) {
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, JSON.stringify(config, null, 2));
    },
    setByPath(config, key, value) {
      const copy = structuredClone(config);
      const parts = key.split(".");
      let node = copy;
      for (const part of parts.slice(0, -1)) node = node[part] ??= {};
      node[parts.at(-1)] = value;
      return copy;
    },
    defaultConfig: defaults,
  };
}

function fakePolicyModule() {
  const phases = (state = "open") => ({
    cycle: "2026-11-19",
    active: true,
    rounds: {
      1: { round: 1, claimStart: new Date("2026-11-19T05:00:00Z"), claimEnd: new Date("2026-11-19T09:00:00Z"), resolveAt: new Date("2026-11-19T09:01:00Z"), state },
      2: null,
    },
    executionOpen: false,
    executionEnd: new Date("2026-11-19T19:00:00Z"),
  });
  return {
    validateTeam(obj) {
      if (!obj?.timezone || !Array.isArray(obj.roster) || !obj.roster.length) return { ok: false, errors: [{ path: "/roster", message: "required" }], team: null };
      return { ok: true, errors: [], team: { v: 1, ...obj, fields: {}, statusValues: { ready: "Todo", claimed: "Claimed", inProgress: "In progress", inReview: "In review", blocked: "Blocked", done: "Done" } } };
    },
    digestTeam: () => "sha256:fake",
    cyclePhases: () => phases(),
    cycleDateFor: () => "2026-11-19",
    difficultyOf: () => "medium",
    priorityOf: () => "P2",
    costOf: () => 2,
    tierFor: () => "sonnet",
    buildOffer: () => ({ capacity: 6, models: ["sonnet"] }),
  };
}

const ITEM = { itemId: "PVTI_1", issueNodeId: "I_1", id: "o/r#1", repo: "o/r", number: 1, title: "Fix parser", url: "https://github.com/o/r/issues/1", contentType: "Issue", authorLogin: "maint", authorType: "User", comments: [] };

function setup(overrides = {}) {
  const calls = { comments: [], statuses: [], runTask: [], runTick: [], installScheduler: [], uninstallScheduler: [], copyApp: [], warmup: [], cleanup: [], saveState: [], lockReleased: 0 };
  const mods = {
    config: fakeConfigModule(),
    policy: fakePolicyModule(),
    github: {
      async resolveToken() {
        return { token: "ghp_faketoken", source: "GH_TOKEN" };
      },
      createGithub() {
        return {
          async viewer() {
            return { login: "alice", databaseId: 1 };
          },
          async scopes() {
            return ["repo", "project"];
          },
          async resolveProject() {
            return { id: "P1", title: "Board", ownerType: "organization", fields: { Status: { id: "F1", dataType: "SINGLE_SELECT", options: { Todo: "a", Claimed: "b", "In progress": "c", "In review": "d", Blocked: "e", Done: "f" } } } };
          },
          async listItems() {
            return { items: [ITEM], skipped: [{ itemId: "x", reason: "draft-issue" }] };
          },
          async postComment(nodeId, body) {
            calls.comments.push({ nodeId, body });
            return { id: "C1", databaseId: 1, body };
          },
          async setStatus(...args) {
            calls.statuses.push(args);
          },
        };
      },
    },
    claims: {
      collectEvents: () => ({ events: [], rejected: [] }),
      candidates: ({ items }) => ({ items, excluded: {} }),
      computeHistory: () => ({}),
      resolveCycle: ({ cycle }) => ({
        cycle,
        cfg: "sha256:fake",
        rounds: { 1: { round: 1, ready: true, assignments: [], unassigned: [], rejected: [{ commentId: "c9", reason: "not-roster" }], inputsDigest: "sha256:in" }, 2: null },
        final: { "o/r#1": { member: "alice", model: "sonnet", round: 1, points: 2 } },
        warnings: [],
      }),
      buildClaims: ({ candidates, round, login }) => candidates.map((c, i) => ({ kind: "claim", task: c.id, rank: i + 1, round, member: login })),
      buildAssign: ({ assignment }) => ({ kind: "assign", task: assignment.task }),
      renderComment: (payload) => `fake ${payload.kind} ${payload.task}`,
      ownAssignments: () => [{ task: "o/r#1", member: "alice", model: "sonnet", difficulty: "medium", points: 2, rank: 1 }],
    },
    ledger: {
      async loadState() {
        return { v: 1, login: "alice", limit: { until: null, reason: null }, cycles: {}, leaks: [{ runId: "r1" }] };
      },
      async saveState(deps, dir, state) {
        calls.saveState.push(state);
      },
      cycleKey: (id, cycle) => `${id}:${cycle}`,
      async acquireLock() {
        return { release: async () => { calls.lockReleased += 1; } };
      },
      async readLedger() {
        return [{ event: "end", runId: "r0" }];
      },
    },
    runner: {
      async runTask(deps, opts) {
        calls.runTask.push(opts);
        return overrides.runRecord ?? { runId: "20261119T041000Z-aaaa", outcome: "done", reason: null, pr: "https://github.com/o/r/pull/9", branch: "inactivity/alice/1-fix", costUsd: 0.5, numTurns: 12, runDir: "/tmp/run" };
      },
      async cleanupLeaks(deps, opts) {
        calls.cleanup.push(opts);
        return { removed: ["r1"], skipped: [] };
      },
    },
    tick: {
      async runTick(deps, opts) {
        calls.runTick.push({ ...opts, depsNow: deps.now() });
        return { now: opts.now.toISOString(), skipped: "idle", projects: [] };
      },
    },
    schedule: {
      renderScheduler: (opts) => ({ files: [{ path: "/x/job", content: "job", mode: 0o644 }], install: [], uninstall: [], notes: ["note"], opts }),
      async installScheduler(deps, plan, o) {
        calls.installScheduler.push({ plan, o });
        return { files: plan.files.length };
      },
      async uninstallScheduler(deps, plan, o) {
        calls.uninstallScheduler.push({ plan, o });
        return { removed: true };
      },
      async copyApp(deps, o) {
        calls.copyApp.push(o);
        return path.join(o.stateDir, "app", "current");
      },
      async schedulerStatus() {
        return { installed: true, scriptPath: "/x/bin/inactivity.js", current: true };
      },
    },
    pharo: {
      plexusCommand: () => ["npx", "--yes", "@evref-bl/plexus@0.16.0"],
      async probe() {
        return { ok: true, templates: [{ name: "Pharo 14.0 - 64bit (stable)" }], detail: "" };
      },
      async warmup(deps, config, templates) {
        calls.warmup.push(templates);
        return { warmed: templates };
      },
    },
    time: { isValidTimeZone: (z) => z !== "Nope/Zone" },
    ...overrides.mods,
  };
  return { mods, calls };
}

async function harness(t, overrides = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "pd-cli-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const out = [];
  const err = [];
  const execCalls = [];
  const { mods, calls } = setup(overrides);
  const deps = {
    exec: overrides.exec ?? (async (cmd, args) => {
      execCalls.push([cmd, ...args]);
      if (cmd === "git") return { code: 0, stdout: "git version 2.50.0\n", stderr: "" };
      if (cmd === "claude" && args[0] === "--version") return { code: 0, stdout: "2.1.300 (Claude Code)\n", stderr: "" };
      if (cmd === "claude" && args[0] === "-p") return { code: 0, stdout: "{}", stderr: "" };
      if (cmd === "claude" && args[0] === "auth") return { code: 0, stdout: "logged in", stderr: "" };
      if (cmd === "npx") return { code: 0, stdout: "10.0.0\n", stderr: "" };
      if (cmd === "gh") return { code: 1, stdout: "", stderr: "" };
      if (cmd === "which" || cmd === "where") return { code: 0, stdout: `/usr/local/bin/${args[0]}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    }),
    now: () => new Date(NOW),
    fs: fsp,
    env: { INACTIVITY_HOME: home, PATH: "/usr/bin" },
    fetch: async () => {
      throw new Error("network is forbidden in tests");
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    platform: "linux",
    homedir: () => home,
    sleep: async () => {},
    randomHex: () => "abcd",
    proc: { execPath: "/usr/bin/node", pid: 1, uid: 1000 },
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  };
  const run = async (...args) => {
    out.length = 0;
    err.length = 0;
    const code = await main(args.flat(), deps, mods);
    const stdout = out.join("");
    let json = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      /* text mode */
    }
    return { code, stdout, stderr: err.join(""), json };
  };
  return { home, run, calls, mods, deps, execCalls };
}

const INLINE_TEAM = { v: 1, timezone: "Europe/Paris", roster: [{ login: "alice" }] };

async function withProject(h) {
  await h.run("init", "--json");
  const team = path.join(h.home, "team.json");
  await fsp.writeFile(team, JSON.stringify(INLINE_TEAM));
  const r = await h.run("projects", "add", "--owner", "Evref-BL", "--number", "3", "--id", "p1", "--team-file", team, "--repo", "o/r", "--json");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const trusted = await h.run("trust", "add", "maint", "--json");
  assert.equal(trusted.code, 0, trusted.stdout + trusted.stderr);
}

// ---------------------------------------------------------------------------
// Parsing and help

test("parseArgv accepts global flags before and after the command", () => {
  const a = parseArgv(["--json", "--project", "p1", "tick", "--dry-run"], commands);
  assert.equal(a.command.name, "tick");
  assert.deepEqual([a.flags.json, a.flags.project, a.flags["dry-run"]], [true, "p1", true]);
  const b = parseArgv(["claim", "--round=2", "-q", "--now", "2026-01-01T00:00:00Z"], commands);
  assert.deepEqual([b.flags.round, b.flags.quiet, b.flags.now], [2, true, "2026-01-01T00:00:00Z"]);
});

test("parseArgv handles repeated list flags, positionals and errors", () => {
  const a = parseArgv(["projects", "add", "--repo", "a/b", "--repo", "c/d=https://x/y.git", "--number", "7"], commands);
  assert.deepEqual(a.positionals, ["add"]);
  assert.deepEqual(a.flags.repo, ["a/b", "c/d=https://x/y.git"]);
  assert.equal(a.flags.number, 7);
  assert.throws(() => parseArgv(["tick", "--bogus"], commands), /Unknown option --bogus/);
  assert.throws(() => parseArgv(["nope"], commands), /Unknown command/);
  assert.throws(() => parseArgv(["claim", "--round"], commands), /needs a value/);
  assert.throws(() => parseArgv(["claim", "--round", "x"], commands), /needs a number/);
});

test("--help, --version, no args and usage errors", async (t) => {
  const h = await harness(t);
  const help = await h.run("--help");
  assert.equal(help.code, 0);
  for (const c of commands) assert.match(help.stdout, new RegExp(`\\n  ${c.name}\\s`));
  assert.equal(help.stdout, `${renderHelp(commands, GLOBAL_FLAGS, JSON.parse(await fsp.readFile(new URL("../package.json", import.meta.url), "utf8")).version)}\n`);
  assert.equal((await h.run()).code, 2);
  const version = await h.run("--version");
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
  const cmdHelp = await h.run("claim", "--help");
  assert.equal(cmdHelp.code, 0);
  assert.match(cmdHelp.stdout, /--force-window/);
  const bad = await h.run("frobnicate", "--json");
  assert.equal(bad.code, 2);
  assert.deepEqual([bad.json.ok, bad.json.code], [false, "usage"]);
});

test("every command appears in the generated README table", () => {
  const table = readmeCommandTable();
  for (const c of commands) assert.ok(table.includes(c.usage.replace(/\|/g, "\\|")), c.name);
  assert.equal(commands.length, new Set(commands.map((c) => c.name)).size);
});

test("parseDuration and doctor version helpers", () => {
  assert.equal(parseDuration("3d", NOW).toISOString(), "2026-11-22T04:10:00.000Z");
  assert.equal(parseDuration("90m", NOW).toISOString(), "2026-11-19T05:40:00.000Z");
  assert.throws(() => parseDuration("soon", NOW), /duration/);
  assert.deepEqual(parseVersion("2.1.300 (Claude Code)"), [2, 1, 300]);
  assert.ok(versionAtLeast([2, 1, 259], [2, 1, 259]));
  assert.ok(!versionAtLeast([2, 0, 999], [2, 1, 0]));
});

// ---------------------------------------------------------------------------
// init / config / projects / team

test("init creates config and refuses to overwrite without --force", async (t) => {
  const h = await harness(t);
  const first = await h.run("init", "--json");
  assert.equal(first.code, 0);
  assert.equal(first.json.command, "init");
  assert.ok((await fsp.stat(first.json.configPath)).isFile());
  const second = await h.run("init", "--json");
  assert.equal(second.code, 1);
  assert.equal(second.json.code, "config-exists");
  assert.equal((await h.run("init", "--force", "--json")).code, 0);
});

test("--home overrides INACTIVITY_HOME", async (t) => {
  const h = await harness(t);
  const other = path.join(h.home, "other");
  const r = await h.run("init", "--home", other, "--json");
  assert.equal(r.json.configPath, path.join(other, "config.json"));
});

test("config path/show/validate/set", async (t) => {
  const h = await harness(t);
  assert.equal((await h.run("config", "show", "--json")).json.code, "no-config");
  await h.run("init");
  const p = await h.run("config", "path", "--json");
  assert.equal(p.json.configPath, path.join(h.home, "config.json"));
  assert.equal((await h.run("config", "validate", "--json")).json.ok, true);
  const set = await h.run("config", "set", "availability.dailyPoints", "6", "--json");
  assert.equal(set.code, 0);
  assert.equal(JSON.parse(await fsp.readFile(path.join(h.home, "config.json"), "utf8")).availability.dailyPoints, 6);
  const dry = await h.run("config", "set", "availability.dailyPoints", "9", "--dry-run", "--json");
  assert.equal(dry.json.saved, false);
  assert.equal(JSON.parse(await fsp.readFile(path.join(h.home, "config.json"), "utf8")).availability.dailyPoints, 6);
  const invalid = await h.run("config", "set", "version", "2", "--json");
  assert.equal(invalid.code, 1);
  assert.equal(invalid.json.code, "invalid-config");
  assert.equal(JSON.parse(await fsp.readFile(path.join(h.home, "config.json"), "utf8")).version, 1);
  assert.equal((await h.run("config", "set", "onlykey", "--json")).code, 2);
});

test("projects add/list/remove and validation", async (t) => {
  const h = await harness(t);
  await h.run("init");
  assert.equal((await h.run("projects", "add", "--owner", "o", "--number", "1", "--json")).code, 2);
  const added = await h.run("projects", "add", "--owner", "Evref-BL", "--number", "3", "--policy-repo", "Evref-BL/MCP", "--repo", "Evref-BL/MCP=https://github.com/Evref-BL/MCP.git", "--repo", "Evref-BL/Sandbox", "--json");
  assert.equal(added.code, 0, added.stdout);
  assert.equal(added.json.project.id, "evref-bl-3");
  assert.deepEqual(added.json.project.repos["Evref-BL/MCP"], { cloneUrl: "https://github.com/Evref-BL/MCP.git" });
  assert.equal((await h.run("projects", "add", "--owner", "Evref-BL", "--number", "3", "--policy-repo", "a/b", "--json")).json.code, "project-exists");
  const list = await h.run("projects", "list", "--json");
  assert.deepEqual(list.json.projects[0].repos, ["Evref-BL/MCP", "Evref-BL/Sandbox"]);
  assert.equal((await h.run("projects", "add", "--owner", "o", "--number", "2", "--policy-repo", "a/b", "--repo", "bad", "--json")).code, 2);
  assert.equal((await h.run("projects", "remove", "evref-bl-3", "--json")).code, 0);
  assert.equal((await h.run("projects", "remove", "evref-bl-3", "--json")).json.code, "unknown-project");
});

test("projects add --team-file inlines a validated team; invalid team is refused", async (t) => {
  const h = await harness(t);
  await h.run("init");
  const bad = path.join(h.home, "bad.json");
  await fsp.writeFile(bad, JSON.stringify({ v: 1 }));
  const r1 = await h.run("projects", "add", "--owner", "o", "--number", "1", "--team-file", bad, "--json");
  assert.equal(r1.json.code, "invalid-team");
  await withProject(h);
  const listed = await h.run("projects", "list", "--json");
  assert.equal(listed.json.projects[0].policy, "inline");
});

test("team init, check and offline show failure", async (t) => {
  const h = await harness(t);
  const out = path.join(h.home, "team.json");
  const init = await h.run("team", "init", "--timezone", "Europe/Paris", "--member", "alice", "--member", "bob", "--out", out, "--json");
  assert.equal(init.code, 0);
  assert.equal(init.json.team.roster.length, 2);
  assert.equal(JSON.parse(await fsp.readFile(out, "utf8")).timezone, "Europe/Paris");
  const check = await h.run("team", "check", out, "--json");
  assert.deepEqual([check.json.ok, check.json.cfg], [true, "sha256:fake"]);
  await fsp.writeFile(out, JSON.stringify({ v: 1 }));
  const badCheck = await h.run("team", "check", out, "--json");
  assert.equal(badCheck.code, 1);
  assert.equal(badCheck.json.ok, false);
});

// ---------------------------------------------------------------------------
// doctor

test("doctor passes with fakes and exits 3 when a check fails", async (t) => {
  const h = await harness(t);
  await withProject(h);
  const good = await h.run("doctor", "--json");
  assert.equal(good.code, 0, good.stdout);
  const ids = good.json.checks.map((c) => c.id);
  for (const id of ["node", "config", "projects", "git", "claude-cli", "claude-auth", "github-token", "plexus", "scheduler", "state-dir"]) assert.ok(ids.includes(id), id);
  assert.equal(good.json.checks.find((c) => c.id === "gh-cli").level, "ok");
  assert.equal(good.json.checks.find((c) => c.id === "claude-smoke").level, "skip");
  assert.ok(!h.execCalls.some((c) => c.includes("-p")), "no claude -p without --smoke-claude");

  const noPharo = await h.run("doctor", "--skip-pharo", "--json");
  assert.equal(noPharo.json.checks.find((c) => c.id === "plexus").level, "skip");

  const oldClaude = await harness(t, {
    exec: async (cmd, args) => {
      if (cmd === "claude" && args[0] === "--version") return { code: 0, stdout: "2.0.1\n", stderr: "" };
      return { code: 0, stdout: "x\n", stderr: "" };
    },
  });
  await withProject(oldClaude);
  const bad = await oldClaude.run("doctor", "--skip-pharo", "--json");
  assert.equal(bad.code, 3);
  assert.equal(bad.json.checks.find((c) => c.id === "claude-cli").level, "fail");
});

test("doctor reports a missing config as a failed check, not a crash", async (t) => {
  const h = await harness(t);
  const r = await h.run("doctor", "--skip-pharo", "--json");
  assert.equal(r.code, 3);
  assert.equal(r.json.checks.find((c) => c.id === "config").level, "fail");
});

test("doctor --smoke-claude spends one headless call; --online checks GitHub", async (t) => {
  const h = await harness(t);
  await withProject(h);
  const r = await h.run("doctor", "--smoke-claude", "--online", "--skip-pharo", "--json");
  assert.equal(r.json.checks.find((c) => c.id === "claude-smoke").level, "ok");
  assert.equal(r.json.checks.find((c) => c.id === "github-viewer").level, "ok");
  assert.equal(r.json.checks.find((c) => c.id === "github-scopes").level, "ok");
  assert.equal(r.json.checks.find((c) => c.id === "projects-online").level, "ok");
  assert.ok(h.execCalls.some((c) => c[0] === "claude" && c.includes("--max-turns")));
});

test("doctor text mode prints one line per check", async (t) => {
  const h = await harness(t);
  await withProject(h);
  const r = await h.run("doctor", "--skip-pharo");
  assert.match(r.stdout, /\[ok  \] node:/);
});

// ---------------------------------------------------------------------------
// tick / --now guard

test("tick forwards options and applies --now to the clock", async (t) => {
  const h = await harness(t);
  await withProject(h);
  const r = await h.run("tick", "--dry-run", "--now", "2026-11-20T04:10:00Z", "--project", "p1", "--json");
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.dryRun, true);
  const call = h.calls.runTick[0];
  assert.equal(call.dryRun, true);
  assert.equal(call.only, "p1");
  assert.equal(call.now.toISOString(), "2026-11-20T04:10:00.000Z");
  assert.equal(call.depsNow.toISOString(), "2026-11-20T04:10:00.000Z");
});

test("--now without --dry-run is refused unless --yes", async (t) => {
  const h = await harness(t);
  await withProject(h);
  const refused = await h.run("tick", "--now", "2026-11-20T04:10:00Z", "--json");
  assert.equal(refused.code, 1);
  assert.equal(refused.json.code, "now-needs-dry-run");
  assert.equal(h.calls.runTick.length, 0);
  assert.equal((await h.run("tick", "--now", "2026-11-20T04:10:00Z", "--yes", "--json")).code, 0);
  assert.equal((await h.run("tick", "--now", "garbage", "--dry-run", "--json")).code, 2);
});

test("config dryRun default makes tick a dry run", async (t) => {
  const h = await harness(t);
  await withProject(h);
  await h.run("config", "set", "dryRun", "true");
  await h.run("tick", "--json");
  assert.equal(h.calls.runTick[0].dryRun, true);
});

// ---------------------------------------------------------------------------
// claim / resolve / run / status

test("claim posts ranked comments; --dry-run posts nothing", async (t) => {
  const h = await harness(t);
  await withProject(h);
  const dry = await h.run("claim", "--dry-run", "--json");
  assert.equal(dry.code, 0, dry.stdout);
  assert.equal(h.calls.comments.length, 0);
  assert.deepEqual(dry.json.projects[0].posted, [{ task: "o/r#1", rank: 1, dryRun: true }]);
  const real = await h.run("claim", "--json");
  assert.equal(real.json.projects[0].posted[0].task, "o/r#1");
  assert.deepEqual(h.calls.comments, [{ nodeId: "I_1", body: "fake claim o/r#1" }]);
});

test("claim outside an open window does nothing; --force-window needs --dry-run", async (t) => {
  const closed = fakePolicyModule();
  closed.cyclePhases = () => ({ cycle: "2026-11-19", rounds: { 1: { state: "closed" }, 2: null }, executionOpen: false });
  const h = await harness(t, { mods: { policy: closed } });
  await withProject(h);
  const r = await h.run("claim", "--json");
  assert.deepEqual(r.json.projects[0].skipped, [{ task: null, reason: "round-not-open" }]);
  assert.equal(h.calls.comments.length, 0);
  const forced = await h.run("claim", "--force-window", "--json");
  assert.equal(forced.json.projects[0].error.code, "window-closed");
  const forcedDry = await h.run("claim", "--force-window", "--dry-run", "--json");
  assert.equal(forcedDry.json.projects[0].posted.length, 1);
  assert.equal(h.calls.comments.length, 0);
});

test("claim --offline fails with code offline", async (t) => {
  const h = await harness(t);
  await withProject(h);
  const r = await h.run("claim", "--offline", "--json");
  assert.equal(r.code, 1);
  assert.equal(r.json.code, "offline");
});

test("resolve prints the table read-only; --post-assign posts and sets status", async (t) => {
  const h = await harness(t);
  await withProject(h);
  const ro = await h.run("resolve", "--json");
  assert.equal(ro.code, 0);
  assert.equal(h.calls.comments.length, 0);
  assert.equal(ro.json.projects[0].final["o/r#1"].member, "alice");
  assert.equal(ro.json.projects[0].rejected[0].reason, "not-roster");
  const dry = await h.run("resolve", "--post-assign", "--dry-run", "--json");
  assert.equal(h.calls.comments.length, 0);
  assert.deepEqual(dry.json.projects[0].assignPosted, [{ task: "o/r#1", dryRun: true }]);
  await h.run("resolve", "--post-assign", "--json");
  assert.equal(h.calls.comments.length, 1);
  assert.equal(h.calls.comments[0].body, "fake assign o/r#1");
  assert.equal(h.calls.statuses.length, 1);
  const only2 = await h.run("resolve", "--round", "2", "--json");
  assert.deepEqual(Object.keys(only2.json.projects[0].rounds), ["2"]);
});

test("run executes my next task and maps outcomes to exit codes", async (t) => {
  const h = await harness(t);
  await withProject(h);
  const ok = await h.run("run", "--json");
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(ok.json.pr, "https://github.com/o/r/pull/9");
  assert.equal(h.calls.runTask[0].task.id, "o/r#1");
  assert.equal(h.calls.runTask[0].forced, false);
  assert.equal(h.calls.lockReleased, 1);

  const failedTask = await harness(t, { runRecord: { runId: "r", outcome: "failed", reason: "tests", pr: "u" } });
  await withProject(failedTask);
  const f = await failedTask.run("run", "--json");
  assert.equal(f.code, 4);
  assert.equal(f.json.ok, false);

  const infra = await harness(t, { runRecord: { runId: "r", outcome: "failed", reason: "pharo-env" } });
  await withProject(infra);
  const i = await infra.run("run", "--json");
  assert.equal(i.code, 1);
  assert.equal(i.json.code, "pharo-env");
});

test("run --item on an unassigned task needs --force or --dry-run", async (t) => {
  const h = await harness(t, {
    mods: { claims: { ...setup().mods.claims, ownAssignments: () => [] } },
  });
  await withProject(h);
  const refused = await h.run("run", "--item", "o/r#1", "--json");
  assert.equal(refused.json.code, "not-assigned");
  assert.equal(h.calls.runTask.length, 0);
  const forced = await h.run("run", "--item", "o/r#1", "--force", "--model", "haiku", "--json");
  assert.equal(forced.code, 0, forced.stdout);
  assert.equal(h.calls.runTask[0].forced, true);
  assert.equal(h.calls.runTask[0].assignment.model, "haiku");
  const dry = await h.run("run", "--item", "o/r#1", "--dry-run", "--json");
  assert.equal(dry.code, 0);
  assert.equal(h.calls.runTask.at(-1).dryRun, true);
  assert.equal((await h.run("run", "--item", "nonsense", "--json")).code, 2);
});

test("status works offline from local state and online from the board", async (t) => {
  const h = await harness(t);
  await withProject(h);
  const off = await h.run("status", "--offline", "--json");
  assert.equal(off.code, 0);
  assert.equal(off.json.projects[0].note, "offline");
  assert.equal(off.json.leaks, 1);
  assert.equal(off.json.runs.length, 1);
  const on = await h.run("status", "--json");
  const p = on.json.projects[0];
  assert.equal(p.cycle, "2026-11-19");
  assert.equal(p.candidates[0].task, "o/r#1");
  assert.equal(p.mine[0].task, "o/r#1");
  assert.equal(p.skipped[0].reason, "draft-issue");
  assert.equal(h.calls.comments.length, 0);
});

// ---------------------------------------------------------------------------
// pause / schedule / warmup / cleanup

test("pause and resume edit availability in the config", async (t) => {
  const h = await harness(t);
  await h.run("init");
  const read = async () => JSON.parse(await fsp.readFile(path.join(h.home, "config.json"), "utf8")).availability;
  assert.deepEqual(await h.run("pause", "--json").then((r) => [r.json.paused, r.json.pausedUntil]), [true, null]);
  assert.equal((await read()).paused, true);
  const timed = await h.run("pause", "--for", "3d", "--json");
  assert.equal(timed.json.pausedUntil, "2026-11-22T04:10:00.000Z");
  assert.equal((await read()).paused, false);
  assert.equal((await h.run("pause", "--for", "1d", "--until", "2026-12-01", "--json")).code, 2);
  await h.run("resume", "--json");
  assert.deepEqual(await read(), { paused: false, pausedUntil: null });
  await h.run("pause", "--dry-run");
  assert.equal((await read()).paused, false);
});

test("schedule print is read-only; install needs --yes; uninstall delegates", async (t) => {
  const h = await harness(t);
  await withProject(h);
  const print = await h.run("schedule", "print", "--platform", "darwin", "--json");
  assert.equal(print.code, 0);
  assert.equal(print.json.plan.opts.platform, "darwin");
  assert.equal(print.json.plan.opts.label, "io.inactivity.tick");
  assert.match(print.json.plan.opts.env.PATH, /\/opt\/homebrew\/bin/);
  assert.equal(h.calls.installScheduler.length, 0);

  const unconfirmed = await h.run("schedule", "install", "--platform", "linux-cron", "--json");
  assert.equal(unconfirmed.json.needsConfirmation, true);
  assert.equal(h.calls.installScheduler.length, 0);

  const done = await h.run("schedule", "install", "--platform", "linux-cron", "--interval", "15", "--yes", "--json");
  assert.equal(done.code, 0, done.stdout);
  assert.equal(h.calls.copyApp.length, 1);
  assert.equal(h.calls.installScheduler[0].o.dryRun, false);
  assert.equal(h.calls.installScheduler[0].plan.opts.intervalMinutes, 15);
  assert.ok(h.calls.installScheduler[0].plan.opts.scriptPath.endsWith(path.join("app", "current", "bin", "inactivity.js")));
  assert.equal(JSON.parse(await fsp.readFile(path.join(h.home, "config.json"), "utf8")).claude.path, "/usr/local/bin/claude");

  const dry = await h.run("schedule", "install", "--platform", "linux-cron", "--dry-run", "--json");
  assert.equal(h.calls.copyApp.length, 1, "dry-run does not copy the app");
  assert.equal(h.calls.installScheduler.at(-1).o.dryRun, true);
  assert.equal(dry.json.installed, false);

  const noCopy = await h.run("schedule", "install", "--no-copy", "--yes", "--platform", "linux-cron", "--json");
  assert.equal(h.calls.copyApp.length, 1);
  assert.ok(noCopy.json.scriptPath.endsWith(path.join("bin", "inactivity.js")));

  await h.run("schedule", "uninstall", "--platform", "linux-cron", "--json");
  assert.equal(h.calls.uninstallScheduler.length, 1);
  assert.equal((await h.run("schedule", "install", "--interval", "2", "--yes", "--platform", "linux-cron", "--json")).code, 2);
  assert.equal((await h.run("schedule", "install", "--platform", "amiga", "--json")).code, 2);
});

test("warmup and cleanup delegate and respect --dry-run", async (t) => {
  const h = await harness(t);
  await withProject(h);
  assert.equal((await h.run("warmup", "--json")).json.code, "no-template");
  const w = await h.run("warmup", "--template", "Pharo 14.0 - 64bit (stable)", "--json");
  assert.deepEqual(h.calls.warmup, [["Pharo 14.0 - 64bit (stable)"]]);
  assert.equal(w.code, 0);
  await h.run("warmup", "--template", "T", "--dry-run", "--json");
  assert.equal(h.calls.warmup.length, 1);

  const dry = await h.run("cleanup", "--dry-run", "--json");
  assert.equal(h.calls.cleanup.length, 0);
  assert.equal(dry.json.leaks.length, 1);
  const real = await h.run("cleanup", "--older-than", "6", "--json");
  assert.equal(h.calls.cleanup[0].olderThanHours, 6);
  assert.deepEqual(real.json.removed, ["r1"]);
  assert.deepEqual(h.calls.saveState.at(-1).leaks, []);
  assert.equal(h.calls.lockReleased, 1);
});

test("unknown --project is reported", async (t) => {
  const h = await harness(t);
  await withProject(h);
  const r = await h.run("tick", "--project", "nope", "--json");
  assert.equal(r.json.code, "unknown-project");
});

test("text mode (no --json) prints readable output, errors go to stderr", async (t) => {
  const h = await harness(t);
  const ok = await h.run("init");
  assert.match(ok.stdout, /configPath: /);
  const err = await h.run("init");
  assert.equal(err.code, 1);
  assert.equal(err.stdout, "");
  assert.match(err.stderr, /already exists/);
});

test("doctor warns when loaded user settings widen the unattended agent, and says nothing is loaded by default", async (t) => {
  const { runDoctor } = await import("../src/doctor.js");
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "pd-doc-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.mkdir(path.join(home, ".claude"), { recursive: true });
  await fsp.writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(*)", "Read(./x)"] }, hooks: { PreToolUse: [] } }));
  const deps = {
    exec: async () => ({ code: 0, stdout: "2.1.300\n", stderr: "" }), now: () => new Date(NOW), fs: fsp, env: { PATH: "/usr/bin" },
    platform: "linux", homedir: () => home, randomHex: () => "abcd", log: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const level = async (config) => (await runDoctor(deps, { config, skipPharo: true, paths: { configPath: path.join(home, "c.json"), stateDir: path.join(home, "state") } })).checks.find((c) => c.id === "claude-settings");
  const off = await level({ claude: { loadUserSettings: false }, projects: [] });
  assert.equal(off.level, "ok");
  const on = await level({ claude: { loadUserSettings: true }, projects: [] });
  assert.equal(on.level, "warn");
  assert.deepEqual(on.detail.allow, ["Bash(*)"]);
  assert.deepEqual(on.detail.hooks, ["PreToolUse"]);
});

// ---------------------------------------------------------------------------
// trust whitelist and board lockdown checks (docs/design.md 1.5, 4.7, docs/board-lockdown.md)

test("trust add/list/remove: validated, normalized, de-duplicated, per member and local", async (t) => {
  const h = await harness(t);
  await h.run("init");
  const read = async () => JSON.parse(await fsp.readFile(path.join(h.home, "config.json"), "utf8")).trustedAuthors;
  const empty = await h.run("trust", "list", "--json");
  assert.deepEqual([empty.code, empty.json.trustedAuthors, empty.json.count], [0, [], 0]);
  assert.match(empty.json.warning, /nothing is claimed or executed/);

  const added = await h.run("trust", "add", "@Alice", "bob", "ALICE", "--json");
  assert.equal(added.code, 0, added.stdout);
  assert.deepEqual(added.json.added, ["alice", "bob"]);
  assert.deepEqual(added.json.alreadyTrusted, ["alice"]);
  assert.deepEqual(await read(), ["alice", "bob"]);
  assert.match(added.json.note, /not shared/);
  const again = await h.run("trust", "add", "BOB", "--json");
  assert.deepEqual([again.json.added, again.json.alreadyTrusted, again.json.saved], [[], ["bob"], false]);

  const bot = await h.run("trust", "add", "Dependabot[bot]", "--json");
  assert.deepEqual(bot.json.added, ["dependabot[bot]"]);
  assert.match(bot.json.warning, /GitHub App/);

  const listed = await h.run("trust", "list", "--json");
  assert.deepEqual(listed.json.trustedAuthors, ["alice", "bob", "dependabot[bot]"]);
  assert.equal(listed.json.warning, undefined);

  const removed = await h.run("trust", "remove", "Alice", "carol", "--json");
  assert.deepEqual([removed.json.removed, removed.json.notFound], [["alice"], ["carol"]]);
  assert.deepEqual(await read(), ["bob", "dependabot[bot]"]);
  const last = await h.run("trust", "remove", "bob", "dependabot[bot]", "--json");
  assert.match(last.json.warning, /now empty/);
  assert.deepEqual(await read(), []);

  const text = await h.run("trust", "add", "zed");
  assert.match(text.stdout, /added: zed/);
});

test("trust: syntax errors and missing arguments are usage errors; --dry-run saves nothing", async (t) => {
  const h = await harness(t);
  await h.run("init");
  const before = await fsp.readFile(path.join(h.home, "config.json"), "utf8");
  for (const args of [["trust"], ["trust", "add"], ["trust", "remove"], ["trust", "nope"], ["trust", "add", "bad login"], ["trust", "add", "ok", "-bad"], ["trust", "add", "a--b"], ["trust", "add", "org/team"]]) {
    const r = await h.run(...args, "--json");
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.json.code, "usage");
  }
  const dry = await h.run("trust", "add", "alice", "--dry-run", "--json");
  assert.deepEqual([dry.code, dry.json.dryRun, dry.json.saved, dry.json.added], [0, true, false, ["alice"]]);
  assert.equal(await fsp.readFile(path.join(h.home, "config.json"), "utf8"), before);
  // without a config the command points to init
  const bare = await harness(t);
  const none = await bare.run("trust", "list", "--json");
  assert.equal(none.json.code, "no-config");
});

test("doctor: an empty trusted-authors list is a warning with the fix, a filled one is ok", async (t) => {
  const h = await harness(t);
  await h.run("init");
  const empty = await h.run("doctor", "--skip-pharo", "--json");
  const check = empty.json.checks.find((c) => c.id === "trusted-authors");
  assert.equal(check.level, "warn");
  assert.match(check.message, /nothing will ever be claimed or executed/);
  assert.match(check.fix, /inactivity trust add/);
  await h.run("trust", "add", "alice", "--json");
  const filled = await h.run("doctor", "--skip-pharo", "--json");
  const ok = filled.json.checks.find((c) => c.id === "trusted-authors");
  assert.equal(ok.level, "ok");
  assert.match(ok.message, /alice/);
});

test("doctor: approval-mode is ok when local, warns when none (with the fix) and when approvals.json is unreadable", async (t) => {
  const h = await harness(t);
  await h.run("init");
  const raw = async (patch) => fsp.writeFile(path.join(h.home, "config.json"), JSON.stringify({ version: 1, projects: [], ...patch }));
  const check = async () => (await h.run("doctor", "--skip-pharo", "--json")).json.checks.find((c) => c.id === "approval-mode");
  await raw({ approval: "local" });
  const local = await check();
  assert.equal(local.level, "ok");
  assert.match(local.message, /exact content/);
  await fsp.mkdir(path.join(h.home, "state"), { recursive: true });
  await fsp.writeFile(path.join(h.home, "state", "approvals.json"), "{broken");
  const corrupt = await check();
  assert.equal(corrupt.level, "warn");
  assert.match(corrupt.message, /unreadable/);
  await fsp.rm(path.join(h.home, "state", "approvals.json"));
  await raw({ approval: "none" });
  const none = await check();
  assert.equal(none.level, "warn");
  assert.match(none.message, /without you reading it/);
  assert.match(none.fix, /config set approval "local"/);
});

/** The default fake GitHub module with a board that is (or is not) public and repos of a given visibility. */
function boardMods({ isPublic, repoPrivate = true, teams = [{ slug: "core", name: "Core" }], accessFails = false }) {
  const base = setup().mods.github;
  return {
    github: {
      ...base,
      createGithub(...args) {
        const g = base.createGithub(...args);
        return {
          ...g,
          async resolveProject() {
            return { ...(await g.resolveProject()), public: isPublic };
          },
          async projectAccess(project) {
            if (accessFails) return { public: project.public, teams: null, repositories: null, collaborators: "unknown", status: "unknown", hint: "token cannot see the access list" };
            return { public: project.public, teams, repositories: [], collaborators: "unknown", status: "ok", hint: "review Manage access by hand" };
          },
          async repoInfo() {
            return { id: "R1", defaultBranch: "main", cloneUrl: "x", isPrivate: repoPrivate, visibility: repoPrivate ? "PRIVATE" : "PUBLIC" };
          },
        };
      },
    },
  };
}

test("projects check: a PUBLIC board fails unless allowPublicBoard is true; teams are listed when readable", async (t) => {
  const h = await harness(t, { mods: boardMods({ isPublic: true }) });
  await withProject(h);
  const r = await h.run("projects", "check", "p1", "--json");
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.exposure.level, "fail");
  assert.equal(r.json.exposure.public, true);
  assert.deepEqual(r.json.exposure.teams, ["core"]);
  assert.ok(r.json.problems.some((p) => /PUBLIC/.test(p)));

  // explicit per-project opt-in turns it into a warning
  await h.run("config", "set", "projects.0.allowPublicBoard", "true", "--json");
  const allowed = await h.run("projects", "check", "p1", "--json");
  assert.equal(allowed.code, 0, allowed.stdout);
  assert.equal(allowed.json.exposure.level, "warn");
  assert.ok(allowed.json.exposure.findings.some((f) => f.code === "board-public-allowed"));
});

test("projects check: a private board passes; unreadable access is 'unknown' with a hint; a public repo warns", async (t) => {
  const priv = await harness(t, { mods: boardMods({ isPublic: false, accessFails: true }) });
  await withProject(priv);
  const r = await priv.run("projects", "check", "p1", "--json");
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.exposure.level, "ok");
  assert.equal(r.json.exposure.collaborators, "unknown");
  const unknown = r.json.exposure.findings.find((f) => f.code === "board-access-unknown");
  assert.match(unknown.fix, /cannot see/);
  assert.deepEqual(r.json.trust.trustedAuthors, ["maint"]);

  const pubRepo = await harness(t, { mods: boardMods({ isPublic: false, repoPrivate: false }) });
  await withProject(pubRepo);
  const w = await pubRepo.run("projects", "check", "p1", "--json");
  assert.equal(w.code, 0, "a public repo is a warning, not a failure");
  assert.equal(w.json.exposure.level, "warn");
  assert.ok(w.json.exposure.findings.some((f) => f.code === "repo-public"));
});

test("doctor --online: board-exposure fails on a public board and passes on a private one", async (t) => {
  const pub = await harness(t, { mods: boardMods({ isPublic: true }) });
  await withProject(pub);
  const bad = await pub.run("doctor", "--online", "--skip-pharo", "--json");
  const check = bad.json.checks.find((c) => c.id === "board-exposure");
  assert.equal(check.level, "fail");
  assert.match(check.message, /PUBLIC/);
  assert.match(check.fix, /board-lockdown\.md/);
  assert.equal(bad.code, 3);

  await pub.run("config", "set", "allowPublicBoard", "true", "--json");
  const tolerated = await pub.run("doctor", "--online", "--skip-pharo", "--json");
  assert.equal(tolerated.json.checks.find((c) => c.id === "board-exposure").level, "warn");

  const priv = await harness(t, { mods: boardMods({ isPublic: false }) });
  await withProject(priv);
  const good = await priv.run("doctor", "--online", "--skip-pharo", "--json");
  assert.equal(good.json.checks.find((c) => c.id === "board-exposure").level, "ok");
  assert.equal(good.json.checks.find((c) => c.id === "projects-online").level, "ok");
});

test("claim: only tasks from my trusted authors are posted, and the empty list is explained", async (t) => {
  const h = await harness(t);
  await withProject(h); // trusts "maint", the author of the fake task
  const ok = await h.run("claim", "--json");
  assert.deepEqual(ok.json.projects[0].posted.map((p) => p.task), ["o/r#1"]);
  await h.run("trust", "remove", "maint", "--json");
  const none = await h.run("claim", "--json");
  assert.deepEqual(none.json.projects[0].posted, []);
  assert.equal(none.json.projects[0].skipped[0].reason, "empty-trust-list");
  assert.match(none.json.projects[0].skipped[0].hint, /trust add/);
  await h.run("trust", "add", "someone-else", "--json");
  const other = await h.run("claim", "--json");
  assert.deepEqual(other.json.projects[0].posted, []);
  assert.deepEqual(other.json.projects[0].skipped.map((x) => [x.task, x.reason, x.author]), [["o/r#1", "untrusted-author", "maint"]]);
});

test("resolve --post-assign never acknowledges a task from an untrusted author", async (t) => {
  const h = await harness(t);
  await withProject(h);
  await h.run("trust", "remove", "maint", "--json");
  await h.run("trust", "add", "someone-else", "--json");
  const r = await h.run("resolve", "--post-assign", "--json");
  assert.equal(r.json.projects[0].assignPosted.length, 0);
  assert.equal(r.json.projects[0].assignSkipped[0].reason, "untrusted-author");
  assert.equal(h.calls.comments.length, 0);
  assert.equal(h.calls.statuses.length, 0);
});

test("run: an untrusted-author release is an error with the explanation, never a success", async (t) => {
  const h = await harness(t, { runRecord: { runId: "r1", outcome: "released", reason: "untrusted-author", detail: "the author @x is not in your trusted authors" } });
  await withProject(h);
  const r = await h.run("run", "--json");
  assert.equal(r.code, 1);
  assert.equal(r.json.code, "untrusted-author");
  assert.match(r.json.error, /Nothing was executed/);
});

test("status lists the tasks skipped as untrusted, with the author", async (t) => {
  const h = await harness(t);
  await withProject(h);
  await h.run("trust", "remove", "maint", "--json");
  await h.run("trust", "add", "someone-else", "--json");
  const s = await h.run("status", "--json");
  assert.deepEqual(s.json.trust.trustedAuthors, ["someone-else"]);
  assert.deepEqual(s.json.projects[0].candidates, []);
  assert.deepEqual(s.json.projects[0].skippedUntrusted.map((u) => [u.task, u.reason, u.author]), [["o/r#1", "untrusted-author", "maint"]]);
  await h.run("trust", "remove", "someone-else", "--json");
  const empty = await h.run("status", "--json");
  assert.match(empty.json.trust.warning, /No trusted author/);
});

test("team check reports the deprecated trustedAssociations key as a warning, not an error", async (t) => {
  const h = await harness(t, { mods: { policy: { ...setup().mods.policy, validateTeam: (obj) => ({ ok: true, errors: [], warnings: obj.trustedAssociations ? [{ path: "/trustedAssociations", message: "deprecated" }] : [], team: { v: 1, ...obj } }) } } });
  const file = path.join(h.home, "t.json");
  await fsp.mkdir(h.home, { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ ...INLINE_TEAM, trustedAssociations: ["OWNER"] }));
  const r = await h.run("team", "check", file, "--json");
  assert.equal(r.code, 0);
  assert.equal(r.json.warnings[0].path, "/trustedAssociations");
});
