// `inactivity doctor`: environment checks (spec 6.3). Every check is
// isolated: an exception inside one becomes a `fail` entry, never a crash.
import { join } from "node:path";
import { checkExposure, loadTeam, makeGithub, resolveLogin, rosterEntry } from "./context.js";
import { PRIVATE_FILE_MODE, ensurePrivateDir } from "./util.js";

export const MIN_NODE = [22, 12, 0];
export const MIN_CLAUDE = [2, 1, 259];
const SIX_HOURS = 6 * 3600 * 1000;
const FIVE_GB = 5 * 1024 ** 3;

/** @param {string} text @returns {number[]|null} */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** @param {number[]} a @param {number[]} b */
export function versionAtLeast(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

const ok = (id, message, detail) => ({ id, level: "ok", message, ...(detail !== undefined ? { detail } : {}) });
const make = (level) => (id, message, extra = {}) => ({ id, level, message, ...extra });
const warn = make("warn");
const failed = make("fail");
const skip = make("skip");

/** @param {any} deps @param {string} cmd @param {string[]} args @param {any} [opts] */
async function tryExec(deps, cmd, args, opts) {
  try {
    return await deps.exec(cmd, args, { timeoutMs: 60_000, ...opts });
  } catch (error) {
    return { code: null, signal: null, stdout: "", stderr: String(/** @type {any} */ (error)?.message ?? error), timedOut: false, durationMs: 0, spawnError: /** @type {any} */ (error)?.code ?? "spawn-failed" };
  }
}

/** @param {any} deps @param {string} path */
async function exists(deps, path) {
  try {
    await deps.fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {any} deps
 * @param {{config?:any, configProblem?:{code?:string,message:string,errors?:any[]}|null, online?:boolean, skipPharo?:boolean, smokeClaude?:boolean,
 *   paths?:{configPath:string, stateDir:string}, mod?:(name:string)=>Promise<any>, ctx?:any}} options
 * @returns {Promise<{ok:boolean, checks:any[]}>}
 */
export async function runDoctor(deps, options = {}) {
  const { config, configProblem = null, online = false, skipPharo = false, smokeClaude = false } = options;
  const ctx = options.ctx ?? {
    deps,
    config,
    paths: options.paths,
    global: { offline: false },
    flags: {},
    mod: options.mod ?? ((name) => import(`./${name}.js`)),
  };
  const checks = [];
  const add = async (id, fn) => {
    try {
      const result = await fn();
      for (const check of Array.isArray(result) ? result : [result]) if (check) checks.push(check);
    } catch (error) {
      checks.push(failed(id, String(/** @type {any} */ (error)?.message ?? error)));
    }
  };
  const projects = (config?.projects ?? []).filter((p) => p.enabled !== false);
  const claudePath = config?.claude?.path ?? "claude";
  const claudeEnv = config?.claude?.configDir ? { ...deps.env, CLAUDE_CONFIG_DIR: config.claude.configDir } : undefined;

  await add("node", async () => {
    const version = deps.nodeVersion ?? globalThis.process?.versions?.node ?? "0.0.0";
    const parsed = parseVersion(version);
    return parsed && versionAtLeast(parsed, MIN_NODE)
      ? ok("node", `Node ${version}`)
      : failed("node", `Node ${version} is too old (need >= ${MIN_NODE.join(".")}).`, { fix: "Install Node 22.12 or newer." });
  });

  await add("config", async () => {
    if (configProblem) {
      return failed("config", configProblem.message, {
        detail: configProblem.errors,
        fix: configProblem.code === "no-config" ? "Run `inactivity init`." : "Run `inactivity config validate` and fix the listed paths.",
      });
    }
    return config ? ok("config", options.paths?.configPath ? `Config loaded from ${options.paths.configPath}` : "Config loaded") : failed("config", "No config loaded.", { fix: "Run `inactivity init`." });
  });

  await add("projects", async () => {
    if (!config) return skip("projects", "No config.");
    if (!projects.length) return failed("projects", "No enabled project.", { fix: "Run `inactivity projects add ...`." });
    const problems = [];
    for (const p of projects) {
      if (Boolean(p.policy) === Boolean(p.team)) problems.push(`${p.id}: exactly one of "policy" or "team" is required`);
      if (!p.repos || !Object.keys(p.repos).length) problems.push(`${p.id}: "repos" allowlist is empty (nothing would ever be executed)`);
    }
    return problems.length ? failed("projects", problems.join("; "), { detail: problems }) : ok("projects", `${projects.length} enabled project(s)`);
  });

  await add("trusted-authors", async () => {
    if (!config) return skip("trusted-authors", "No config.");
    const trust = await ctx.mod("trust");
    const list = [...trust.trustSet(config.trustedAuthors)];
    if (list.length === 0) {
      return warn("trusted-authors", "No trusted author is configured: nothing will ever be claimed or executed on this machine (secure by default).", {
        fix: "Run `inactivity trust add <github-login>...` with the logins whose tasks you accept (yourself, teammates you vouch for). It is your own list: it is never shared and the team roster does not imply trust.",
      });
    }
    const bots = list.filter((l) => l.endsWith("[bot]"));
    return ok("trusted-authors", `${list.length} trusted author(s): ${list.join(", ")}`, bots.length ? { bots, note: "GitHub Apps are on the list: every issue they open will be executed." } : undefined);
  });

  await add("timezone", async () => {
    const time = await ctx.mod("time");
    const zones = projects.filter((p) => p.team?.timezone).map((p) => p.team.timezone);
    if (!zones.length) return skip("timezone", "Team time zones come from the policy repo; checked by projects-online.");
    const bad = zones.filter((z) => !time.isValidTimeZone(z));
    return bad.length ? failed("timezone", `Unknown time zone: ${bad.join(", ")}`) : ok("timezone", zones.join(", "));
  });

  await add("git", async () => {
    const r = await tryExec(deps, "git", ["--version"]);
    return r.code === 0 ? ok("git", r.stdout.trim()) : failed("git", "git is not available.", { fix: "Install git." });
  });

  await add("claude-cli", async () => {
    const r = await tryExec(deps, claudePath, ["--version"], { env: claudeEnv });
    if (r.code !== 0) return failed("claude-cli", `Cannot run \`${claudePath} --version\`.`, { fix: "Install Claude Code and make sure `claude` is on PATH (or set claude.path)." });
    const v = parseVersion(r.stdout);
    if (!v || !versionAtLeast(v, MIN_CLAUDE)) {
      return failed("claude-cli", `Claude Code ${r.stdout.trim()} is older than ${MIN_CLAUDE.join(".")} (needed for --permission-prompts).`, { fix: "Update Claude Code." });
    }
    return ok("claude-cli", `${r.stdout.trim()} (${claudePath})`);
  });

  await add("claude-auth", async () => {
    const r = await tryExec(deps, claudePath, ["auth", "status"], { env: claudeEnv });
    return r.code === 0
      ? ok("claude-auth", "Claude Code is logged in.")
      : failed("claude-auth", "`claude auth status` failed.", { fix: "Run `claude auth login` (or, for unattended machines, `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN in the scheduler environment)." });
  });

  await add("claude-settings", async () => {
    if (config?.claude?.loadUserSettings !== true) return ok("claude-settings", "User-level Claude settings are not loaded by unattended runs (claude.loadUserSettings is false).");
    const dir = config?.claude?.configDir ?? deps.env.CLAUDE_CONFIG_DIR ?? join(deps.homedir(), ".claude");
    let text;
    try {
      text = await deps.fs.readFile(join(dir, "settings.json"), "utf8");
    } catch {
      return ok("claude-settings", `No user settings in ${dir}.`);
    }
    let settings;
    try {
      settings = JSON.parse(text);
    } catch {
      return warn("claude-settings", `${join(dir, "settings.json")} is not valid JSON.`);
    }
    const allow = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow.map(String) : [];
    const broad = allow.filter((rule) => /^Bash(\(|$)/.test(rule) || /^mcp__pharo(__\*)?$/.test(rule) || /^(Read|Edit|Write)$/.test(rule));
    const hooks = settings?.hooks && typeof settings.hooks === "object" ? Object.keys(settings.hooks) : [];
    if (broad.length === 0 && hooks.length === 0) return ok("claude-settings", "User settings loaded, no broad allow rule or hook found.");
    return warn("claude-settings", "claude.loadUserSettings is true and your user settings widen the unattended agent.", {
      detail: { allow: broad.slice(0, 10), hooks },
      fix: "Set claude.loadUserSettings to false (the default), or remove the Bash/Read/Edit/Write/mcp__pharo allow rules and hooks from your user settings.",
    });
  });

  await add("anthropic-api-key", async () =>
    deps.env.ANTHROPIC_API_KEY
      ? warn("anthropic-api-key", config?.claude?.allowApiKey ? "ANTHROPIC_API_KEY is set and claude.allowApiKey is true: runs are billed to the API, not the subscription." : "ANTHROPIC_API_KEY is set; inactivity strips it from the agent environment so the subscription is used.", { fix: "Unset it in the scheduler environment if you want to be sure." })
      : ok("anthropic-api-key", "ANTHROPIC_API_KEY is not set."),
  );

  await add("claude-smoke", async () => {
    if (!smokeClaude) return skip("claude-smoke", "Not requested (spends a little quota): use --smoke-claude.");
    const r = await tryExec(deps, claudePath, ["-p", "Reply with OK", "--model", "haiku", "--max-turns", "1", "--permission-prompts", "none", "--output-format", "json"], { env: claudeEnv, timeoutMs: 120_000 });
    return r.code === 0 ? ok("claude-smoke", "Headless claude answered.") : failed("claude-smoke", "Headless claude smoke test failed.", { detail: (r.stderr || r.stdout).slice(-500) });
  });

  let tokenOk = false;
  await add("github-token", async () => {
    const gh = await ctx.mod("github");
    try {
      const { source } = await gh.resolveToken(deps);
      tokenOk = true;
      return ok("github-token", `GitHub token found (${source}).`);
    } catch (error) {
      return failed("github-token", String(/** @type {any} */ (error)?.message ?? "No GitHub token."), { fix: "Run `gh auth login -s repo -s project`, or export a classic PAT (scopes repo, project) as GH_TOKEN. Never paste it in a chat." });
    }
  });

  await add("gh-cli", async () => {
    const r = await tryExec(deps, "gh", ["--version"]);
    return ok("gh-cli", r.code === 0 ? "gh is installed (optional)." : "gh is not installed (optional: a GH_TOKEN is enough).");
  });

  if (online && !ctx.global.offline) {
    let github = null;
    let login = null;
    await add("github-viewer", async () => {
      if (!tokenOk) return skip("github-viewer", "No token.");
      github = await makeGithub(ctx);
      login = await resolveLogin(ctx, github);
      return ok("github-viewer", `Authenticated as ${login}.`);
    });
    await add("github-scopes", async () => {
      if (!github) return skip("github-scopes", "No GitHub client.");
      const scopes = await github.scopes();
      if (scopes === null) return skip("github-scopes", "Fine-grained token: scopes are not reported.", { fix: "Fine-grained tokens are unverified for Projects v2, have a single resource owner and cannot reach user-owned projects (use a classic PAT with repo + project there). If you keep it, make sure it grants Issues, Pull requests (write), Contents (write) and Projects (read and write) on the repos and the org, and that `projects check` works." });
      const missing = ["repo", "project"].filter((s) => !scopes.includes(s));
      return missing.length ? failed("github-scopes", `Missing scopes: ${missing.join(", ")}.`, { detail: scopes, fix: "gh auth refresh -s repo -s project (or create a new classic PAT)." }) : ok("github-scopes", scopes.join(", "));
    });
    await add("board-exposure", async () => {
      if (!github) return skip("board-exposure", "No GitHub client.");
      const problems = [];
      const warnings = [];
      const notes = [];
      let fix;
      for (const project of projects) {
        try {
          const info = await github.resolveProject({ owner: project.owner, number: project.number, ownerType: project.ownerType ?? undefined });
          const report = await checkExposure(ctx, github, project, info);
          for (const f of report.findings) {
            if (f.level === "fail") { problems.push(`${project.id}: ${f.message}`); fix ??= f.fix; } else if (f.level === "warn") { warnings.push(`${project.id}: ${f.message}`); fix ??= f.fix; } else if (f.level === "info") notes.push(`${project.id}: ${f.message}`);
          }
        } catch (error) {
          warnings.push(`${project.id}: exposure not checked (${/** @type {any} */ (error)?.message ?? error})`);
        }
      }
      if (problems.length) return failed("board-exposure", problems.concat(warnings).join("; "), { detail: problems.concat(warnings), fix });
      if (warnings.length) return warn("board-exposure", warnings.join("; "), { detail: warnings, fix });
      return ok("board-exposure", `${projects.length} board(s) not public`, notes.length ? notes : undefined);
    });
    await add("projects-online", async () => {
      if (!github) return skip("projects-online", "No GitHub client.");
      const problems = [];
      const notes = [];
      for (const project of projects) {
        try {
          const now = deps.now();
          const { team } = await loadTeam(ctx, github, project, now);
          const info = await github.resolveProject({ owner: project.owner, number: project.number, ownerType: project.ownerType ?? undefined });
          const names = { priority: team.fields?.priority ?? "Priority", difficulty: team.fields?.difficulty ?? "Difficulty", status: team.fields?.status ?? "Status", agent: team.fields?.agent ?? "Agent" };
          if (!info.fields?.[names.status]) problems.push(`${project.id}: field "${names.status}" is missing`);
          else {
            const options = Object.keys(info.fields[names.status].options ?? {});
            for (const value of Object.values(team.statusValues ?? {})) if (!options.includes(value)) problems.push(`${project.id}: Status option "${value}" is missing`);
          }
          for (const key of ["priority", "difficulty"]) if (!info.fields?.[names[key]]) notes.push(`${project.id}: field "${names[key]}" absent (labels used as fallback)`);
          if (login && !rosterEntry(team, login)) problems.push(`${project.id}: ${login} is not on the roster`);
        } catch (error) {
          problems.push(`${project.id}: ${/** @type {any} */ (error)?.message ?? error}`);
        }
      }
      return problems.length ? failed("projects-online", problems.join("; "), { detail: problems }) : ok("projects-online", `${projects.length} project(s) resolved`, notes.length ? notes : undefined);
    });
  } else {
    checks.push(skip("projects-online", "Use --online to check the board, policy and roster."));
  }

  if (skipPharo) {
    checks.push(skip("plexus", "Skipped (--skip-pharo)."));
  } else {
    await add("npx", async () => {
      const pharo = await ctx.mod("pharo");
      const cmd = pharo.plexusCommand(config ?? {});
      if (cmd[0] !== "npx") return skip("npx", `Custom plexus command (${cmd.join(" ")}).`);
      const r = await tryExec(deps, "npx", ["--version"]);
      return r.code === 0 ? ok("npx", `npx ${r.stdout.trim()}`) : failed("npx", "npx is not available.", { fix: "Install Node with npm, or set pharo.plexusCommand to a locally installed `plexus`." });
    });
    await add("plexus", async () => {
      const pharo = await ctx.mod("pharo");
      const probe = await pharo.probe(deps, config ?? {});
      if (!probe.ok) return failed("plexus", `PLexus probe failed: ${probe.detail ?? "unknown"}`, { fix: "Check network access to npm, that Pharo Launcher is installed, then `inactivity warmup`." });
      const names = (probe.templates ?? []).map((t) => (typeof t === "string" ? t : t.name));
      const wanted = config?.pharo?.defaultTemplate;
      if (wanted && !names.includes(wanted)) return failed("plexus", `Template "${wanted}" not offered by PLexus.`, { detail: names, fix: "Fix pharo.defaultTemplate (exact name as printed by `plexus image templates`)." });
      return ok("plexus", `${names.length} template(s) available`);
    });
    await add("pharo-launcher", async () => {
      if (deps.platform !== "darwin") return skip("pharo-launcher", "Detection only on macOS; the plexus probe is authoritative.");
      return (await exists(deps, "/Applications/PharoLauncher.app")) ? ok("pharo-launcher", "/Applications/PharoLauncher.app") : warn("pharo-launcher", "PharoLauncher.app not found in /Applications.", { fix: "Install Pharo Launcher (the plexus probe decides whether it still works)." });
    });
  }

  await add("scheduler", async () => {
    const schedule = await ctx.mod("schedule");
    const status = await schedule.schedulerStatus(deps, { platform: deps.platform, stateDir: options.paths?.stateDir, home: deps.homedir() });
    if (!status.installed) return warn("scheduler", "No scheduler job installed.", { fix: "Run `inactivity schedule install`." });
    if (status.current === false) return warn("scheduler", `Scheduled copy is not current (${status.scriptPath}).`, { fix: "Re-run `inactivity schedule install` after a plugin update." });
    return ok("scheduler", `Installed (${status.scriptPath})`);
  });

  await add("state-dir", async () => {
    const stateDir = options.paths?.stateDir;
    if (!stateDir) return skip("state-dir", "No state directory resolved.");
    await ensurePrivateDir(deps.fs, stateDir);
    const probeFile = join(stateDir, `.doctor-${deps.randomHex()}`);
    await deps.fs.writeFile(probeFile, "ok", { mode: PRIVATE_FILE_MODE });
    await deps.fs.rm(probeFile, { force: true });
    const notes = [];
    let level = "ok";
    try {
      const lock = JSON.parse(await deps.fs.readFile(join(stateDir, "lock"), "utf8"));
      const age = deps.now().getTime() - new Date(lock.startedAt).getTime();
      let alive = true;
      try {
        globalThis.process?.kill(lock.pid, 0);
      } catch {
        alive = false;
      }
      if (!alive || age > SIX_HOURS) {
        level = "warn";
        notes.push("stale lock file (removed automatically by the next run)");
      } else notes.push(`lock held by pid ${lock.pid}`);
    } catch {
      /* no lock */
    }
    try {
      const state = JSON.parse(await deps.fs.readFile(join(stateDir, "state.json"), "utf8"));
      if (state.leaks?.length) {
        level = "warn";
        notes.push(`${state.leaks.length} leaked run(s) recorded: run \`inactivity cleanup\``);
      }
    } catch {
      /* no state yet */
    }
    return { id: "state-dir", level, message: `${stateDir} writable${notes.length ? `; ${notes.join("; ")}` : ""}` };
  });

  await add("disk", async () => {
    const stateDir = options.paths?.stateDir;
    if (!stateDir || typeof deps.fs.statfs !== "function") return skip("disk", "Free space not measurable.");
    const s = await deps.fs.statfs(stateDir);
    const free = Number(s.bavail) * Number(s.bsize);
    const gb = (free / 1024 ** 3).toFixed(1);
    return free < FIVE_GB ? warn("disk", `Only ${gb} GB free in the state directory.`, { fix: "Pharo images and worktrees need room; free some space." }) : ok("disk", `${gb} GB free`);
  });

  return { ok: !checks.some((c) => c.level === "fail"), checks };
}
