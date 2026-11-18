// inactivity CLI (spec section 6). Hand-rolled parser; the exported
// `commands` table is the single source of usage text, errors and the README.
//
// Sibling modules (config, policy, claims, github, ...) are loaded lazily and
// can be replaced through the third argument of main() (`mods`), which is how
// the tests run this file without the other modules.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "./doctor.js";
import { commandsMarkdownTable, formatText, renderCommandHelp, renderHelp } from "./help.js";
import { checkExposure, fail, loadBoard, loadTeam, makeGithub, requireOnline } from "./context.js";
import { ensurePrivateDir } from "./util.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIX_HOURS = 6 * 3600 * 1000;
const INFRA_REASONS = new Set(["limit", "overloaded", "auth", "pharo-env", "git", "push", "internal", "lost-lock"]);

/** @type {Record<string, import('./help.js').FlagDef>} */
export const GLOBAL_FLAGS = {
  json: { type: "boolean", description: "One JSON document on stdout, logs on stderr." },
  "dry-run": { type: "boolean", description: "No comment, mutation, push, claude or image side effect." },
  offline: { type: "boolean", description: "Forbid network access." },
  project: { type: "string", value: "id", description: "Restrict to one configured project." },
  now: { type: "string", value: "ISO", description: "Simulate the clock (needs --dry-run or --yes)." },
  home: { type: "string", value: "dir", description: "Override INACTIVITY_HOME." },
  yes: { type: "boolean", description: "Confirm a side effect (schedule install, --now)." },
  quiet: { type: "boolean", alias: "q", description: "Less logging on stderr." },
  verbose: { type: "boolean", alias: "v", description: "More logging on stderr." },
  help: { type: "boolean", alias: "h", description: "Show help." },
  version: { type: "boolean", description: "Print the version." },
};

// ---------------------------------------------------------------------------
// Argument parsing

/**
 * @param {string[]} tokens
 * @param {Record<string, import('./help.js').FlagDef>} defs
 */
export function parseTokens(tokens, defs) {
  const aliases = new Map(Object.entries(defs).filter(([, d]) => d.alias).map(([n, d]) => [d.alias, n]));
  /** @type {Record<string, any>} */ const flags = {};
  /** @type {string[]} */ const positionals = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    let name;
    let inline;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      inline = eq === -1 ? undefined : token.slice(eq + 1);
    } else if (/^-[A-Za-z]$/.test(token)) {
      name = aliases.get(token.slice(1));
      if (!name) throw fail("usage", `Unknown option ${token}.`);
    } else {
      positionals.push(token);
      continue;
    }
    const def = defs[name];
    if (!def) throw fail("usage", `Unknown option --${name}.`);
    if (def.type === "boolean") {
      if (inline !== undefined && !["true", "false"].includes(inline)) throw fail("usage", `--${name} takes no value.`);
      flags[name] = inline !== "false";
      continue;
    }
    let value = inline;
    if (value === undefined) {
      value = tokens[i + 1];
      if (value === undefined || (value.startsWith("--") && value.length > 2)) throw fail("usage", `--${name} needs a value.`);
      i += 1;
    }
    if (def.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) throw fail("usage", `--${name} needs a number, got "${value}".`);
      flags[name] = n;
    } else if (def.type === "list") {
      (flags[name] ??= []).push(value);
    } else flags[name] = value;
  }
  return { flags, positionals };
}

/**
 * Finds the command (first positional after global flags), then parses with
 * global + command flags so global flags work before or after the command.
 * @param {string[]} argv
 * @param {import('./help.js').CommandDef[]} table
 */
export function parseArgv(argv, table) {
  let commandIndex = -1;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("-")) {
      const name = token.startsWith("--") ? token.slice(2).split("=")[0] : Object.entries(GLOBAL_FLAGS).find(([, d]) => d.alias === token.slice(1))?.[0];
      const def = name ? GLOBAL_FLAGS[name] : undefined;
      if (def && def.type !== "boolean" && !token.includes("=")) i += 1;
      continue;
    }
    commandIndex = i;
    break;
  }
  if (commandIndex === -1) {
    const { flags } = parseTokens(argv, GLOBAL_FLAGS);
    return { command: null, flags, positionals: [] };
  }
  const command = table.find((c) => c.name === argv[commandIndex]);
  if (!command) throw fail("usage", `Unknown command "${argv[commandIndex]}". Run \`inactivity --help\`.`);
  const rest = [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)];
  const { flags, positionals } = parseTokens(rest, { ...GLOBAL_FLAGS, ...command.flags });
  return { command, flags, positionals };
}

// ---------------------------------------------------------------------------
// Context

/**
 * @param {any} deps
 * @param {Record<string, any>} mods
 * @param {Record<string, any>} flags
 * @param {string[]} positionals
 */
function createContext(deps, mods, flags, positionals) {
  const global = {
    json: Boolean(flags.json),
    dryRun: Boolean(flags["dry-run"]),
    offline: Boolean(flags.offline),
    project: flags.project ?? null,
    now: flags.now ?? null,
    home: flags.home ?? null,
    yes: Boolean(flags.yes),
  };
  let effective = deps;
  if (global.home) effective = { ...effective, env: { ...effective.env, INACTIVITY_HOME: global.home } };
  if (global.now) {
    const at = new Date(global.now);
    if (Number.isNaN(at.getTime())) throw fail("usage", `--now needs an ISO instant, got "${global.now}".`);
    effective = { ...effective, now: () => new Date(at.getTime()) };
  }
  const ctx = {
    deps: effective,
    mods,
    flags,
    positionals,
    global,
    config: /** @type {any} */ (null),
    paths: /** @type {any} */ (null),
    dryRun: global.dryRun,
    /** @param {string} name */
    async mod(name) {
      if (!mods[name]) mods[name] = await import(new URL(`./${name}.js`, import.meta.url).href);
      return mods[name];
    },
    stdout(text) {
      (effective.stdout?.write ? effective.stdout.write.bind(effective.stdout) : (s) => globalThis.process.stdout.write(s))(text);
    },
    stderr(text) {
      (effective.stderr?.write ? effective.stderr.write.bind(effective.stderr) : (s) => globalThis.process.stderr.write(s))(text);
    },
    /** Prints a result (JSON or text). @param {any} result @param {(r:any)=>string} [text] */
    print(result, text) {
      if (global.json) ctx.stdout(`${JSON.stringify(result, null, 2)}\n`);
      else ctx.stdout(`${(text ?? formatText)(result)}\n`);
    },
    async resolvePaths() {
      if (!ctx.paths) {
        const config = await ctx.mod("config");
        ctx.paths = config.resolvePaths(effective.env, effective.platform, effective.homedir());
      }
      return ctx.paths;
    },
    /** Normalized config, `--project` filter applied. */
    async loadConfig() {
      const paths = await ctx.resolvePaths();
      const configMod = await ctx.mod("config");
      const { config, errors } = await configMod.loadConfig(effective, { path: paths.configPath });
      if (errors?.length) throw fail("invalid-config", `Invalid config: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`, { errors });
      ctx.config = filterProjects(config, global.project);
      ctx.dryRun = global.dryRun || Boolean(config.dryRun);
      return ctx.config;
    },
    /** Raw (non-normalized) config JSON so edits do not write defaults back. */
    async readRaw() {
      const paths = await ctx.resolvePaths();
      let text;
      try {
        text = await effective.fs.readFile(paths.configPath, "utf8");
      } catch (error) {
        if (/** @type {any} */ (error)?.code === "ENOENT") throw fail("no-config", `No config at ${paths.configPath}. Run \`inactivity init\`.`);
        throw error;
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        throw fail("invalid-config", `${paths.configPath} is not valid JSON: ${/** @type {any} */ (error).message}`);
      }
    },
    async saveRaw(raw) {
      const paths = await ctx.resolvePaths();
      const configMod = await ctx.mod("config");
      const result = configMod.validateConfig(raw);
      if (!result.ok) throw fail("invalid-config", `Refusing to write an invalid config: ${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`, { errors: result.errors });
      await configMod.saveConfig(effective, raw, { path: paths.configPath });
    },
  };
  return ctx;
}

/** @param {any} config @param {string|null} id */
function filterProjects(config, id) {
  if (!id) return config;
  const projects = (config.projects ?? []).filter((p) => p.id === id);
  if (!projects.length) throw fail("unknown-project", `No configured project "${id}".`);
  return { ...config, projects };
}

/** @param {any} ctx */
function enabledProjects(ctx) {
  const projects = (ctx.config.projects ?? []).filter((p) => p.enabled !== false);
  if (!projects.length) throw fail("no-project", "No enabled project. Run `inactivity projects add ...`.");
  return projects;
}

/** Runs fn for each project; one failing project does not hide the others. @param {any} ctx @param {(p:any)=>Promise<any>} fn */
async function perProject(ctx, fn) {
  const out = [];
  for (const project of enabledProjects(ctx)) {
    try {
      out.push({ id: project.id, ...(await fn(project)) });
    } catch (error) {
      out.push({ id: project.id, error: { code: /** @type {any} */ (error)?.code ?? "internal", message: /** @type {any} */ (error)?.message ?? String(error) } });
    }
  }
  return out;
}

const loadState = async (ctx) => (await ctx.mod("ledger")).loadState(ctx.deps, (await ctx.resolvePaths()).stateDir);

/** Guards --now against real side effects. @param {any} ctx @param {boolean} sideEffects */
function guardNow(ctx, sideEffects) {
  if (ctx.global.now && sideEffects && !ctx.dryRun && !ctx.global.yes) {
    throw fail("now-needs-dry-run", "--now simulates the clock: use it with --dry-run, or add --yes to really post and run.");
  }
}

const events = async (ctx, board) => (await ctx.mod("claims")).collectEvents({ items: board.items, team: board.team, cycle: board.cycle, cfg: board.cfg });

/** Pure board resolution shared by resolve/run/status. */
async function resolveBoard(ctx, board) {
  const claims = await ctx.mod("claims");
  const history = claims.computeHistory({ items: board.items, team: board.team, cycle: board.cycle, cfg: board.cfg });
  return claims.resolveCycle({ team: board.team, cycle: board.cycle, items: board.items, now: board.now, history });
}

// ---------------------------------------------------------------------------
// Commands

async function cmdInit(ctx) {
  const paths = await ctx.resolvePaths();
  const { fs } = ctx.deps;
  let present = false;
  try {
    await fs.access(paths.configPath);
    present = true;
  } catch {
    /* absent */
  }
  if (present && !ctx.flags.force) throw fail("config-exists", `${paths.configPath} already exists (use --force to overwrite).`);
  if (ctx.dryRun) return { ok: true, command: "init", dryRun: true, configPath: paths.configPath, statePath: paths.stateDir };
  const configMod = await ctx.mod("config");
  await ensurePrivateDir(fs, paths.stateDir);
  await configMod.saveConfig(ctx.deps, configMod.defaultConfig(), { path: paths.configPath });
  return { ok: true, command: "init", configPath: paths.configPath, statePath: paths.stateDir };
}

/** @param {string} text */
function parseValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function cmdConfig(ctx) {
  const [sub, key, value] = ctx.positionals;
  const paths = await ctx.resolvePaths();
  const configMod = await ctx.mod("config");
  switch (sub) {
    case "path":
      return { ok: true, command: "config", configPath: paths.configPath, statePath: paths.stateDir };
    case "show": {
      const config = await ctx.loadConfig();
      return { ok: true, command: "config", config };
    }
    case "validate": {
      const result = configMod.validateConfig(await ctx.readRaw());
      return { ok: result.ok, command: "config", errors: result.errors, _exit: result.ok ? 0 : 1 };
    }
    case "set": {
      if (!key || value === undefined) throw fail("usage", "Usage: inactivity config set <dotted.key> <json-value>");
      // Switching the per-ticket approval off removes the member's last line of defence against a malicious ticket: explicit opt-in.
      if (key === "approval" && parseValue(value) === "none" && !ctx.global.yes) {
        throw fail("needs-confirmation", 'approval "none" disables your manual per-ticket approval: any task from a trusted author will be claimed and run on your Claude account without you reading it. Re-run with --yes to confirm.');
      }
      const next = configMod.setByPath(await ctx.readRaw(), key, parseValue(value));
      const result = configMod.validateConfig(next);
      if (!result.ok) throw fail("invalid-config", `Not saved, the result would be invalid: ${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`, { errors: result.errors });
      if (!ctx.dryRun) await configMod.saveConfig(ctx.deps, next, { path: paths.configPath });
      return { ok: true, command: "config", key, value: parseValue(value), saved: !ctx.dryRun, ...(ctx.dryRun ? { dryRun: true } : {}), ...(key === "approval" && parseValue(value) === "none" ? { warning: 'Approval is OFF: tasks from your trusted authors are claimed and run without you reading them. Turn it back on with `inactivity config set approval "local"`.' } : {}) };
    }
    default:
      throw fail("usage", "Usage: inactivity config path|show|validate|set <dotted.key> <json-value>");
  }
}

/**
 * `trust add|remove|list`: this member's own whitelist of GitHub logins (config `trustedAuthors`). Local to this
 * machine, never shared and never part of team.json. Empty by default: nothing is claimed or run until logins are added.
 */
async function cmdTrust(ctx) {
  const [sub, ...args] = ctx.positionals;
  const trust = await ctx.mod("trust");
  const raw = await ctx.readRaw();
  const current = Array.isArray(raw.trustedAuthors) ? raw.trustedAuthors : [];
  const normalized = () => {
    if (!args.length) throw fail("usage", `Usage: inactivity trust ${sub} <login>...`);
    return args.map((arg) => {
      const n = trust.normalizeLogin(arg);
      if (!n.ok) throw fail("usage", n.error);
      return n.login;
    });
  };
  const save = async (next) => {
    if (!ctx.dryRun) await ctx.saveRaw({ ...raw, trustedAuthors: next });
  };
  const base = { ok: true, command: "trust", saved: false };
  const dry = ctx.dryRun ? { dryRun: true } : {};
  switch (sub) {
    case "add": {
      const wanted = normalized();
      const have = new Set(current.map((x) => String(x).toLowerCase()));
      const added = [];
      const already = [];
      for (const login of wanted) {
        if (have.has(login) || added.includes(login)) already.push(login);
        else added.push(login);
      }
      const next = [...current, ...added];
      await save(next);
      const bots = added.filter((l) => l.endsWith("[bot]"));
      return {
        ...base, action: "add", added, alreadyTrusted: already, trustedAuthors: next, saved: !ctx.dryRun && added.length > 0, ...dry,
        ...(bots.length ? { warning: `${bots.join(", ")} ${bots.length > 1 ? "are GitHub Apps" : "is a GitHub App"}: every issue it opens will be executed on this machine.` } : {}),
        note: "Your own list: kept in your config only, not shared with the team. Applies to the author and to the last editor of each task.",
      };
    }
    case "remove": {
      const wanted = new Set(normalized());
      const removed = current.filter((x) => wanted.has(String(x).toLowerCase())).map((x) => String(x).toLowerCase());
      const next = current.filter((x) => !wanted.has(String(x).toLowerCase()));
      const notFound = [...wanted].filter((l) => !removed.includes(l));
      await save(next);
      return { ...base, action: "remove", removed, notFound, trustedAuthors: next, saved: !ctx.dryRun && removed.length > 0, ...dry, ...(next.length === 0 ? { warning: `The list is now empty: nothing will be claimed or executed. ${trust.TRUST_HINT}` } : {}) };
    }
    case "list": {
      const list = [...trust.trustSet(current)];
      return { ...base, action: "list", trustedAuthors: list, count: list.length, ...(list.length === 0 ? { warning: `No trusted author: nothing is claimed or executed. ${trust.TRUST_HINT}` } : {}) };
    }
    default:
      throw fail("usage", "Usage: inactivity trust add <login>... | remove <login>... | list");
  }
}

/** @param {string} id */
const sanitizeId = (id) => id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

async function cmdProjects(ctx) {
  const [sub, arg] = ctx.positionals;
  switch (sub) {
    case "add": {
      const f = ctx.flags;
      if (!f.owner || !f.number) throw fail("usage", "projects add needs --owner and --number.");
      if (Boolean(f["policy-repo"]) === Boolean(f["team-file"])) throw fail("usage", "Give exactly one of --policy-repo or --team-file.");
      const raw = await ctx.readRaw();
      const id = f.id ?? sanitizeId(`${f.owner}-${f.number}`);
      if ((raw.projects ?? []).some((p) => p.id === id)) throw fail("project-exists", `Project "${id}" already exists (use another --id or remove it first).`);
      /** @type {any} */ const project = { id, owner: f.owner, ownerType: f["owner-type"] ?? null, number: f.number };
      if (f["policy-repo"]) project.policy = { repo: f["policy-repo"], ...(f["policy-path"] ? { path: f["policy-path"] } : {}) };
      else {
        let teamRaw;
        try {
          teamRaw = JSON.parse(await ctx.deps.fs.readFile(f["team-file"], "utf8"));
        } catch (error) {
          throw fail("invalid-team", `Cannot read team file ${f["team-file"]}: ${/** @type {any} */ (error).message}`);
        }
        const result = (await ctx.mod("policy")).validateTeam(teamRaw);
        if (!result.ok) throw fail("invalid-team", `Team file is invalid: ${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`, { errors: result.errors });
        project.team = teamRaw;
      }
      project.repos = {};
      for (const spec of f.repo ?? []) {
        const eq = spec.indexOf("=");
        const repo = eq === -1 ? spec : spec.slice(0, eq);
        if (!/^[^/=\s]+\/[^/=\s]+$/.test(repo)) throw fail("usage", `--repo must look like owner/name[=cloneUrl], got "${spec}".`);
        project.repos[repo] = eq === -1 ? {} : { cloneUrl: spec.slice(eq + 1) };
      }
      const next = { ...raw, projects: [...(raw.projects ?? []), project] };
      if (!ctx.dryRun) await ctx.saveRaw(next);
      else (await ctx.mod("config")).validateConfig(next);
      return { ok: true, command: "projects", action: "add", project, saved: !ctx.dryRun, ...(ctx.dryRun ? { dryRun: true } : {}), ...(Object.keys(project.repos).length ? {} : { warning: "No --repo given: nothing will be executed until you add repos to the allowlist." }) };
    }
    case "list": {
      const raw = await ctx.readRaw();
      return { ok: true, command: "projects", projects: (raw.projects ?? []).map((p) => ({ id: p.id, enabled: p.enabled !== false, owner: p.owner, number: p.number, policy: p.policy?.repo ?? (p.team ? "inline" : null), repos: Object.keys(p.repos ?? {}) })) };
    }
    case "remove": {
      if (!arg) throw fail("usage", "Usage: inactivity projects remove <id>");
      const raw = await ctx.readRaw();
      if (!(raw.projects ?? []).some((p) => p.id === arg)) throw fail("unknown-project", `No configured project "${arg}".`);
      const next = { ...raw, projects: raw.projects.filter((p) => p.id !== arg) };
      if (!ctx.dryRun) await ctx.saveRaw(next);
      return { ok: true, command: "projects", action: "remove", id: arg, saved: !ctx.dryRun, ...(ctx.dryRun ? { dryRun: true } : {}) };
    }
    case "check": {
      if (!arg) throw fail("usage", "Usage: inactivity projects check <id>");
      ctx.global.project = arg;
      const config = await ctx.loadConfig();
      requireOnline(ctx);
      const project = config.projects[0];
      const board = await loadBoard(ctx, project);
      const byType = {};
      for (const item of board.items) byType[item.contentType] = (byType[item.contentType] ?? 0) + 1;
      const skipped = {};
      for (const s of board.skipped) skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
      const f = board.team.fields ?? {};
      const names = [f.priority ?? "Priority", f.difficulty ?? "Difficulty", f.status ?? "Status", f.agent ?? "Agent"];
      const fields = Object.fromEntries(Object.entries(board.projectInfo.fields ?? {}).map(([n, d]) => [n, d.options ? Object.keys(d.options) : d.dataType]));
      const problems = [];
      const statusField = board.projectInfo.fields?.[f.status ?? "Status"];
      if (!statusField) problems.push(`Required field "${f.status ?? "Status"}" is missing.`);
      else for (const v of Object.values(board.team.statusValues ?? {})) if (!Object.keys(statusField.options ?? {}).includes(v)) problems.push(`Status option "${v}" is missing.`);
      for (const n of names) if (!board.projectInfo.fields?.[n]) problems.push(`Field "${n}" absent (optional: labels or defaults apply).`);
      const onRoster = (board.team.roster ?? []).some((m) => m.login.toLowerCase() === board.login.toLowerCase());
      if (!onRoster) problems.push(`${board.login} is not on the team roster.`);
      // Board lockdown (docs/board-lockdown.md): a public board is a failure unless allowPublicBoard is true.
      const exposure = await checkExposure(ctx, board.github, project, board.projectInfo);
      for (const finding of exposure.findings) if (finding.level === "fail") problems.push(finding.message);
      // Trust whitelist: with no trusted author nothing is claimed or executed.
      const trust = await ctx.mod("trust");
      const trusted = [...trust.trustSet(config.trustedAuthors)];
      const { untrusted } = trust.partitionByTrust(board.items, trusted);
      if (!trusted.length) problems.push(`No trusted author configured (optional to fix here, but nothing is claimed or executed until you run: inactivity trust add <login>).`);
      const hard = problems.filter((p) => !p.includes("optional"));
      return {
        ok: hard.length === 0, command: "projects", action: "check", id: project.id, title: board.projectInfo.title, login: board.login, teamSource: board.teamSource, cfg: board.cfg, cycle: board.cycle, fields, itemsByType: byType, skipped, onRoster, problems,
        exposure, trust: { trustedAuthors: trusted, itemsFromUntrustedAuthors: untrusted.length }, _exit: hard.length ? 1 : 0,
      };
    }
    default:
      throw fail("usage", "Usage: inactivity projects add|list|remove|check ...");
  }
}

async function cmdTeam(ctx) {
  const [sub, arg] = ctx.positionals;
  const policy = await ctx.mod("policy");
  switch (sub) {
    case "init": {
      const f = ctx.flags;
      const timezone = f.timezone ?? ctx.deps.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
      const members = f.member?.length ? f.member : [ctx.deps.env.GITHUB_ACTOR ?? "REPLACE-WITH-GITHUB-LOGIN"];
      const result = policy.validateTeam({ v: 1, timezone, roster: members.map((login) => ({ login })) });
      if (!result.ok) throw fail("invalid-team", result.errors.map((e) => `${e.path} ${e.message}`).join("; "), { errors: result.errors });
      const text = `${JSON.stringify(result.team, null, 2)}\n`;
      if (f.out && !ctx.dryRun) await ctx.deps.fs.writeFile(f.out, text);
      return { ok: true, command: "team", action: "init", team: result.team, ...(f.out ? { written: !ctx.dryRun, out: f.out } : {}), hint: "Commit this file as .inactivity/team.json in the policy repo of the board." };
    }
    case "check": {
      if (!arg) throw fail("usage", "Usage: inactivity team check <file>");
      let obj;
      try {
        obj = JSON.parse(await ctx.deps.fs.readFile(arg, "utf8"));
      } catch (error) {
        throw fail("invalid-team", `Cannot read ${arg}: ${/** @type {any} */ (error).message}`);
      }
      const result = policy.validateTeam(obj);
      return { ok: result.ok, command: "team", action: "check", errors: result.errors, ...(result.warnings?.length ? { warnings: result.warnings } : {}), ...(result.ok ? { cfg: policy.digestTeam(result.team) } : {}), _exit: result.ok ? 0 : 1 };
    }
    case "show": {
      const config = await ctx.loadConfig();
      requireOnline(ctx);
      const github = await makeGithub(ctx);
      const teams = await perProject(ctx, async (project) => {
        const { team, source, oid } = await loadTeam(ctx, github, project, ctx.deps.now());
        return { source, oid: oid ?? null, cfg: policy.digestTeam(team), cycle: policy.cyclePhases(team, ctx.deps.now()).cycle, team };
      });
      void config;
      return { ok: true, command: "team", action: "show", projects: teams };
    }
    default:
      throw fail("usage", "Usage: inactivity team init|show|check ...");
  }
}

async function cmdDoctor(ctx) {
  const paths = await ctx.resolvePaths();
  let config = null;
  let configProblem = null;
  try {
    config = await ctx.loadConfig();
  } catch (error) {
    configProblem = { code: /** @type {any} */ (error).code, message: /** @type {any} */ (error).message, errors: /** @type {any} */ (error).details?.errors };
  }
  const report = await runDoctor(ctx.deps, { config, configProblem, online: Boolean(ctx.flags.online), skipPharo: Boolean(ctx.flags["skip-pharo"]), smokeClaude: Boolean(ctx.flags["smoke-claude"]), paths, ctx });
  return { ok: report.ok, command: "doctor", checks: report.checks, _exit: report.ok ? 0 : 3 };
}

function doctorText(result) {
  const lines = result.checks.map((c) => `[${c.level.padEnd(4)}] ${c.id}: ${c.message}${c.fix && c.level !== "ok" ? `\n         fix: ${c.fix}` : ""}`);
  const fails = result.checks.filter((c) => c.level === "fail").length;
  const warns = result.checks.filter((c) => c.level === "warn").length;
  return `${lines.join("\n")}\n\n${fails ? `${fails} failing check(s)` : "No failing check"}${warns ? `, ${warns} warning(s)` : ""}.`;
}

async function cmdTick(ctx) {
  guardNow(ctx, true);
  const config = await ctx.loadConfig();
  const tick = await ctx.mod("tick");
  const result = await tick.runTick(ctx.deps, { config, dryRun: ctx.dryRun, only: ctx.global.project ?? undefined, now: ctx.deps.now() });
  const failed = (result.projects ?? []).some((p) => p.errors?.length);
  return { ...result, ok: !failed, command: "tick", ...(ctx.dryRun ? { dryRun: true } : {}), ...(failed ? { _exit: 1 } : {}) };
}

/** Round to act on: --round, else the open one. @param {any} board @param {any} flags */
function pickRound(board, flags) {
  if (flags.round) return flags.round;
  if (board.phases.rounds[1]?.state === "open") return 1;
  if (board.phases.rounds[2]?.state === "open") return 2;
  return null;
}

async function cmdClaim(ctx) {
  guardNow(ctx, true);
  const config = await ctx.loadConfig();
  const [claims, policy] = await Promise.all([ctx.mod("claims"), ctx.mod("policy")]);
  const state = await loadState(ctx);
  const github = await makeGithub(ctx);
  const projects = await perProject(ctx, async (project) => {
    const board = await loadBoard(ctx, project, { github, state, cycle: ctx.flags.cycle });
    const round = pickRound(board, ctx.flags) ?? (ctx.flags["force-window"] ? 1 : null);
    const phase = round ? board.phases.rounds[round] : null;
    if (!round || (phase?.state !== "open" && !ctx.flags["force-window"])) return { cycle: board.cycle, posted: [], skipped: [{ task: null, reason: "round-not-open" }] };
    if (ctx.flags["force-window"] && !ctx.dryRun && phase?.state !== "open") throw fail("window-closed", "--force-window is only allowed with --dry-run: a claim outside the window would be ignored by everyone.");
    const offer = policy.buildOffer({ config, team: board.team, login: board.login, now: board.now, state, round });
    if (!offer) return { cycle: board.cycle, round, posted: [], skipped: [{ task: null, reason: "no-offer" }] };
    const { events: evs } = await events(ctx, board);
    const previous = round === 2 ? (await resolveBoard(ctx, board)).rounds?.[1] : undefined;
    const cands = claims.candidates({ items: board.items, team: board.team, cycle: board.cycle, round, events: evs, previous });
    // Trust gate 1 of 3: only tasks from authors (and last editors) on MY whitelist are claimed.
    const trust = await ctx.mod("trust");
    const { trusted: trustedItems, untrusted } = trust.partitionByTrust(cands.items, config.trustedAuthors);
    const untrustedSkips = untrusted.map((u) => ({ task: u.task, reason: u.reason === "empty-trust-list" ? "empty-trust-list" : "untrusted-author", author: u.author, ...(u.editor ? { editor: u.editor } : {}) }));
    if (untrusted.length && trust.trustSet(config.trustedAuthors).size === 0) return { cycle: board.cycle, round, offer, posted: [], skipped: [{ task: null, reason: "empty-trust-list", hint: trust.TRUST_HINT }, ...untrustedSkips] };
    // Approval gate 1 of 3: only tasks I approved at their current content are claimed.
    const approvalMod = await ctx.mod("approval");
    const approval = await loadApprovalContext(ctx, config);
    const approvalSplit = approvalMod.partitionByApproval(trustedItems, approval);
    const pendingSkips = approvalSplit.pending.map((p) => ({ task: p.task, reason: p.reason, hash: approvalMod.shortHash(p.hash) }));
    const existing = evs.filter((e) => e.member?.toLowerCase() === board.login.toLowerCase() && e.round === round);
    const payloads = claims.buildClaims({ team: board.team, cycle: board.cycle, round, login: board.login, offer, candidates: approvalSplit.approved, repoAllowlist: Object.keys(project.repos ?? {}), existing, hardDifficultyAllowed: config.availability?.hardDifficultyAllowed === true, trustedAuthors: config.trustedAuthors, approval });
    const posted = [];
    const byTask = new Map(board.items.map((i) => [i.id, i]));
    for (const payload of payloads) {
      const item = byTask.get(payload.task);
      if (ctx.dryRun) {
        posted.push({ task: payload.task, rank: payload.rank, dryRun: true });
        continue;
      }
      if (posted.length) await ctx.deps.sleep(config.execution?.mutationDelayMs ?? 1500);
      await github.postComment(item.issueNodeId, claims.renderComment(payload, { team: board.team }));
      posted.push({ task: payload.task, rank: payload.rank, commentUrl: item.url });
    }
    const postedIds = new Set(posted.map((p) => p.task));
    const untrustedIds = new Set(untrusted.map((u) => u.task));
    const pendingIds = new Set(pendingSkips.map((p) => p.task));
    const skippedTasks = [...cands.items.filter((i) => !postedIds.has(i.id) && !untrustedIds.has(i.id) && !pendingIds.has(i.id)).map((i) => ({ task: i.id, reason: "not-selected" })), ...untrustedSkips, ...pendingSkips];
    return { cycle: board.cycle, round, offer, posted, skipped: skippedTasks, ...(pendingSkips.length ? { pendingApproval: pendingSkips.length, hint: approvalMod.APPROVAL_HINT } : {}) };
  });
  return { ok: true, command: "claim", ...(ctx.dryRun ? { dryRun: true } : {}), projects };
}

async function cmdResolve(ctx) {
  guardNow(ctx, Boolean(ctx.flags["post-assign"]));
  await ctx.loadConfig();
  const claims = await ctx.mod("claims");
  const state = await loadState(ctx);
  const github = await makeGithub(ctx);
  const projects = await perProject(ctx, async (project) => {
    const board = await loadBoard(ctx, project, { github, state, cycle: ctx.flags.cycle });
    const resolution = await resolveBoard(ctx, board);
    const rounds = ctx.flags.round ? { [ctx.flags.round]: resolution.rounds[ctx.flags.round] ?? null } : resolution.rounds;
    const rejected = Object.values(resolution.rounds).flatMap((r) => r?.rejected ?? []);
    const result = { cycle: resolution.cycle, rounds, final: resolution.final, rejected, warnings: resolution.warnings ?? [] };
    if (ctx.flags["post-assign"]) {
      const mine = claims.ownAssignments(resolution, board.login);
      const { events: evs } = await events(ctx, board);
      const byTask = new Map(board.items.map((i) => [i.id, i]));
      const posted = [];
      const assignSkipped = [];
      const trust = await ctx.mod("trust");
      for (const assignment of mine) {
        // Trust gate 2 of 3: never acknowledge (and set Status = Claimed on) a task that is not from MY trusted authors.
        const candidate = byTask.get(assignment.task);
        const verdict = trust.checkItemTrust(candidate ?? {}, ctx.config.trustedAuthors);
        if (!verdict.trusted) {
          assignSkipped.push({ task: assignment.task, reason: verdict.reason, detail: verdict.detail });
          continue;
        }
        // Approval gate 2 of 3: the task must still be approved at its current content.
        const approvalMod = await ctx.mod("approval");
        const approvalVerdict = approvalMod.checkItemApproval(candidate ?? {}, await loadApprovalContext(ctx, ctx.config));
        if (!approvalVerdict.approved) {
          assignSkipped.push({ task: assignment.task, reason: "not-approved", why: approvalVerdict.reason, detail: approvalVerdict.detail });
          continue;
        }
        const round = resolution.final[assignment.task]?.round ?? 1;
        const already = evs.some((e) => e.kind === "assign" && e.task === assignment.task && e.round === round && e.member?.toLowerCase() === board.login.toLowerCase());
        if (already) continue;
        if (ctx.dryRun) {
          posted.push({ task: assignment.task, dryRun: true });
          continue;
        }
        const roundResult = resolution.rounds[round];
        const payload = claims.buildAssign({ team: board.team, cycle: board.cycle, round, login: board.login, assignment, claims: roundResult?.claimIds ?? [], inputs: roundResult?.inputsDigest, runId: `cli-${ctx.deps.randomHex()}` });
        const item = byTask.get(assignment.task);
        await github.postComment(item.issueNodeId, claims.renderComment(payload, { team: board.team }));
        try {
          await github.setStatus(board.projectInfo, board.team, item.itemId, { status: board.team.statusValues.claimed, agent: `@${board.login}` });
        } catch (error) {
          ctx.deps.log.warn(`setStatus failed for ${assignment.task}: ${/** @type {any} */ (error).message}`);
        }
        posted.push({ task: assignment.task });
        await ctx.deps.sleep(ctx.config.execution?.mutationDelayMs ?? 1500);
      }
      result.assignPosted = posted;
      if (assignSkipped.length) result.assignSkipped = assignSkipped;
    }
    return result;
  });
  return { ok: true, command: "resolve", ...(ctx.dryRun ? { dryRun: true } : {}), projects };
}

async function cmdRun(ctx) {
  guardNow(ctx, true);
  const config = await ctx.loadConfig();
  const [claims, policy, ledger, runner] = await Promise.all([ctx.mod("claims"), ctx.mod("policy"), ctx.mod("ledger"), ctx.mod("runner")]);
  const paths = await ctx.resolvePaths();
  const state = await loadState(ctx);
  const github = await makeGithub(ctx);
  const wanted = ctx.flags.item;
  if (wanted && !/^[^/\s]+\/[^#\s]+#\d+$/.test(wanted)) throw fail("usage", "--item must look like owner/repo#number.");
  const lock = ctx.dryRun ? null : await ledger.acquireLock(ctx.deps, { stateDir: paths.stateDir, command: "run", staleMs: SIX_HOURS });
  if (!ctx.dryRun && !lock) throw fail("locked", "Another inactivity process holds the lock.");
  try {
    let found = null;
    for (const project of enabledProjects(ctx)) {
      const board = await loadBoard(ctx, project, { github, state, cycle: ctx.flags.cycle });
      const resolution = await resolveBoard(ctx, board);
      const mine = claims.ownAssignments(resolution, board.login);
      const doneOrStarted = (task) => state.cycles?.[ledger.cycleKey(project.id, board.cycle)]?.assigned?.[task]?.startedAt;
      let assignment = wanted ? mine.find((a) => a.task === wanted) : mine.find((a) => !doneOrStarted(a.task));
      let forced = false;
      if (wanted && !assignment) {
        const item = board.items.find((i) => i.id === wanted);
        if (!item) continue;
        if (!ctx.dryRun && !ctx.flags.force) throw fail("not-assigned", `${wanted} is not assigned to you for cycle ${board.cycle}. Use --force for a manual override (it bypasses the claim checks) or --dry-run.`);
        const difficulty = policy.difficultyOf(item, board.team);
        assignment = { task: wanted, member: board.login, model: policy.tierFor(difficulty, board.team), difficulty, points: policy.costOf(difficulty, board.team), rank: 1 };
        forced = true;
      }
      if (!assignment) continue;
      if (ctx.flags.model) assignment = { ...assignment, model: ctx.flags.model };
      found = { project, board, assignment, forced, round: resolution.final?.[assignment.task]?.round ?? 1 };
      break;
    }
    if (!found) throw fail("no-task", wanted ? `${wanted} was not found on the board.` : "None of your assigned tasks is waiting to run.");
    const { project, board, assignment, forced, round } = found;
    const task = board.items.find((i) => i.id === assignment.task);
    const record = await runner.runTask(ctx.deps, { config, project, team: board.team, task, projectInfo: board.projectInfo, github, login: board.login, cycle: board.cycle, round, assignment, dryRun: ctx.dryRun, keep: Boolean(ctx.flags.keep), noPr: Boolean(ctx.flags["no-pr"]), forced: forced || Boolean(ctx.flags.force) });
    const result = { command: "run", ...(ctx.dryRun ? { dryRun: true } : {}), runId: record.runId, outcome: record.outcome, reason: record.reason ?? null, pr: record.pr ?? null, branch: record.branch ?? null, costUsd: record.costUsd ?? null, numTurns: record.numTurns ?? null, runDir: record.runDir ?? null };
    if (!ctx.dryRun && record.runId) await recordManualRun(ctx, project, board, assignment, round, record);
    if (record.reason === "untrusted-author") return { ok: false, code: "untrusted-author", error: `${task.id} was not run: ${record.detail ?? "its author is not in your trusted authors"}. Nothing was executed.`, ...result, _exit: 1 };
    if (record.reason === "not-approved") return { ok: false, code: "not-approved", error: `${task.id} was not run: ${record.detail ?? "you have not approved its current content"}. Nothing was executed (--force does not bypass the approval).`, ...result, _exit: 1 };
    const taskLevel = ["failed", "blocked"].includes(record.outcome);
    if (taskLevel && INFRA_REASONS.has(record.reason)) return { ok: false, code: record.reason, error: `Run ${record.runId} stopped on an infrastructure problem (${record.reason}).`, ...result, _exit: 1 };
    return { ok: !taskLevel, ...result, _exit: taskLevel ? 4 : 0 };
  } finally {
    await lock?.release?.();
  }
}

/**
 * Keep state.json (tick bookkeeping) in step with a run started by hand, so the next tick neither
 * re-runs the task nor forgets the points it consumed.
 */
async function recordManualRun(ctx, project, board, assignment, round, record) {
  const ledger = await ctx.mod("ledger");
  const stateDir = (await ctx.resolvePaths()).stateDir;
  const state = await ledger.loadState(ctx.deps, stateDir);
  const key = ledger.cycleKey(project.id, board.cycle);
  const cs = (state.cycles[key] ??= { claimed: { 1: null, 2: null }, resolved: { 1: null, 2: null }, assigned: {}, pointsUsed: 0, tasksStarted: 0 });
  const consumed = !["skipped", "released"].includes(record.outcome) || record.reason === "limit";
  cs.assigned[assignment.task] = { round, model: assignment.model, difficulty: assignment.difficulty, points: assignment.points, assignPosted: true, startedAt: record.startedAt ?? ctx.deps.now().toISOString(), outcome: record.outcome, reason: record.reason ?? null, runId: record.runId };
  if (consumed) {
    cs.pointsUsed += assignment.points ?? 0;
    cs.tasksStarted += 1;
  }
  await ledger.saveState(ctx.deps, stateDir, state);
}

async function cmdStatus(ctx) {
  const config = await ctx.loadConfig();
  const [claims, policy, ledger] = await Promise.all([ctx.mod("claims"), ctx.mod("policy"), ctx.mod("ledger")]);
  const paths = await ctx.resolvePaths();
  const state = await loadState(ctx);
  const runs = await ledger.readLedger(ctx.deps, paths.stateDir, { limit: ctx.flags.runs ?? 10 });
  let scheduler = null;
  try {
    scheduler = await (await ctx.mod("schedule")).schedulerStatus(ctx.deps, { platform: ctx.deps.platform, stateDir: paths.stateDir, home: ctx.deps.homedir() });
  } catch (error) {
    scheduler = { error: /** @type {any} */ (error).message };
  }
  const github = ctx.global.offline ? null : await makeGithub(ctx).catch((error) => ({ error }));
  const approval = await loadApprovalContext(ctx, config);
  const projects = await perProject(ctx, async (project) => {
    if (!github || github.error) return { board: null, note: github?.error ? `GitHub unavailable: ${github.error.message}` : "offline" };
    const board = await loadBoard(ctx, project, { github, state, cycle: ctx.flags.cycle });
    const resolution = await resolveBoard(ctx, board);
    const { events: evs } = await events(ctx, board);
    const cands = claims.candidates({ items: board.items, team: board.team, cycle: board.cycle, round: 1, events: evs });
    const trust = await ctx.mod("trust");
    const split = trust.partitionByTrust(cands.items, config.trustedAuthors);
    const approvalMod = await ctx.mod("approval");
    const approvalSplit = approvalMod.partitionByApproval(split.trusted, approval);
    const key = ledger.cycleKey(project.id, board.cycle);
    const local = state.cycles?.[key]?.assigned ?? {};
    const mine = claims.ownAssignments(resolution, board.login).map((a) => ({ ...a, local: local[a.task] ?? null }));
    return {
      cycle: board.cycle,
      login: board.login,
      phases: { 1: board.phases.rounds[1], 2: board.phases.rounds[2], executionOpen: board.phases.executionOpen, executionEnd: board.phases.executionEnd },
      offer: policy.buildOffer({ config, team: board.team, login: board.login, now: board.now, state, round: 1 }),
      candidates: split.trusted.map((i) => ({ task: i.id, title: i.title, priority: policy.priorityOf(i, board.team), difficulty: policy.difficultyOf(i, board.team) })),
      pendingApproval: approvalSplit.pending.map((p) => ({ task: p.task, title: p.item.title, author: p.item.authorLogin ?? null, state: p.reason === "changed-since-approval" ? "changed-since-approval" : "pending", hash: approvalMod.shortHash(p.hash) })),
      approved: approvalSplit.approved.map((i) => ({ task: i.id, title: i.title, hash: approvalMod.shortHash(approvalMod.contentHash(i)) })),
      skippedUntrusted: split.untrusted.map((u) => ({ task: u.task, title: u.item.title, reason: u.reason, who: u.who, author: u.author, ...(u.editor ? { editor: u.editor } : {}) })),
      resolution: { final: resolution.final, unassigned: resolution.rounds[1]?.unassigned ?? [] },
      mine,
      skipped: board.skipped,
    };
  });
  const trusted = [...(await ctx.mod("trust")).trustSet(config.trustedAuthors)];
  const trust = { trustedAuthors: trusted, ...(trusted.length === 0 ? { warning: "No trusted author: nothing is claimed or executed. Run `inactivity trust add <login>`." } : {}) };
  const pendingTotal = projects.reduce((n, p) => n + (p.pendingApproval?.length ?? 0), 0);
  const approvalInfo = {
    mode: approval.mode,
    approvedEntries: Object.keys(approval.store.approvals).length,
    pending: pendingTotal,
    ...(approval.mode === "none" ? { warning: "Approval mode is none: tasks from your trusted authors run without you reading them." } : pendingTotal > 0 ? { warning: `${pendingTotal} task(s) await your approval and will not be claimed. Run \`inactivity review\`.` } : {}),
  };
  return { ok: true, command: "status", now: ctx.deps.now().toISOString(), trust, approval: approvalInfo, limit: state.limit ?? { until: null, reason: null }, leaks: state.leaks?.length ?? 0, scheduler, runs, projects };
}

/** @param {string} text @param {Date} now */
export function parseDuration(text, now) {
  const m = /^(\d+)\s*(m|h|d|w)$/.exec(text.trim());
  if (!m) throw fail("usage", `--for needs a duration like 90m, 12h, 3d or 2w, got "${text}".`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]];
  return new Date(now.getTime() + Number(m[1]) * unit);
}

async function cmdPause(ctx) {
  const raw = await ctx.readRaw();
  let until = null;
  if (ctx.flags.until && ctx.flags.for) throw fail("usage", "Give --until or --for, not both.");
  if (ctx.flags.for) until = parseDuration(ctx.flags.for, ctx.deps.now());
  else if (ctx.flags.until) {
    const text = ctx.flags.until;
    until = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00`) : new Date(text);
    if (Number.isNaN(until.getTime())) throw fail("usage", `--until needs an ISO instant or YYYY-MM-DD, got "${text}".`);
  }
  const availability = { ...(raw.availability ?? {}), paused: until === null, pausedUntil: until ? until.toISOString() : null };
  if (!ctx.dryRun) await ctx.saveRaw({ ...raw, availability });
  return { ok: true, command: "pause", paused: availability.paused, pausedUntil: availability.pausedUntil, saved: !ctx.dryRun, ...(ctx.dryRun ? { dryRun: true } : {}), note: "The next tick withdraws open-window claims and releases unstarted assignments." };
}

async function cmdResume(ctx) {
  const raw = await ctx.readRaw();
  const availability = { ...(raw.availability ?? {}), paused: false, pausedUntil: null };
  if (!ctx.dryRun) await ctx.saveRaw({ ...raw, availability });
  return { ok: true, command: "resume", paused: false, pausedUntil: null, saved: !ctx.dryRun, ...(ctx.dryRun ? { dryRun: true } : {}) };
}

/** @param {any} ctx @param {string|undefined} requested */
async function detectPlatform(ctx, requested) {
  if (requested) {
    if (!["darwin", "linux-systemd", "linux-cron", "win32"].includes(requested)) throw fail("usage", `Unknown --platform "${requested}" (darwin|linux-systemd|linux-cron|win32).`);
    return requested;
  }
  const p = ctx.deps.platform;
  if (p === "darwin" || p === "win32") return p;
  try {
    const r = await ctx.deps.exec("systemctl", ["--user", "--version"], { timeoutMs: 10_000 });
    if (r.code === 0) return "linux-systemd";
  } catch {
    /* no systemd */
  }
  return "linux-cron";
}

/** @param {any} ctx @param {string} name */
async function whichAbsolute(ctx, name) {
  if (name.includes("/") || name.includes("\\")) return name;
  try {
    const r = await ctx.deps.exec(ctx.deps.platform === "win32" ? "where" : "which", [name], { timeoutMs: 10_000 });
    const first = r.code === 0 ? r.stdout.split(/\r?\n/).find(Boolean) : null;
    return first?.trim() || null;
  } catch {
    return null;
  }
}

/** PATH of the installing shell plus the usual tool directories. @param {any} deps */
function capturePath(deps) {
  const sep = deps.platform === "win32" ? ";" : ":";
  const extras = deps.platform === "win32" ? [] : [join(deps.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const parts = [...(deps.env.PATH ?? "").split(sep).filter(Boolean), ...extras];
  return [...new Set(parts)].join(sep);
}

async function cmdSchedule(ctx) {
  const [sub] = ctx.positionals;
  if (!["install", "uninstall", "print"].includes(sub ?? "")) throw fail("usage", "Usage: inactivity schedule install|uninstall|print");
  const paths = await ctx.resolvePaths();
  const schedule = await ctx.mod("schedule");
  const platform = await detectPlatform(ctx, ctx.flags.platform);
  let config = null;
  try {
    config = await ctx.loadConfig();
  } catch (error) {
    if (sub === "install") throw error;
  }
  const interval = ctx.flags.interval ?? config?.schedule?.intervalMinutes ?? 10;
  if (!Number.isInteger(interval) || interval < 5 || interval > 60) throw fail("usage", "--interval must be an integer between 5 and 60.");
  const runningScript = join(ROOT, "bin", "inactivity.js");
  const buildPlan = (scriptPath) => schedule.renderScheduler({ platform, nodePath: ctx.deps.proc.execPath, scriptPath, intervalMinutes: interval, env: { PATH: capturePath(ctx.deps) }, stateDir: paths.stateDir, label: "io.inactivity.tick", home: ctx.deps.homedir() });
  if (sub === "print") return { ok: true, command: "schedule", action: "print", platform, plan: buildPlan(ctx.flags["no-copy"] ? runningScript : join(paths.stateDir, "app", "current", "bin", "inactivity.js")) };
  if (sub === "uninstall") {
    const plan = buildPlan(join(paths.stateDir, "app", "current", "bin", "inactivity.js"));
    const done = await schedule.uninstallScheduler(ctx.deps, plan, { dryRun: ctx.dryRun });
    return { ok: true, command: "schedule", action: "uninstall", platform, ...(ctx.dryRun ? { dryRun: true } : {}), result: done };
  }
  // install
  const plan0 = buildPlan(ctx.flags["no-copy"] ? runningScript : join(paths.stateDir, "app", "current", "bin", "inactivity.js"));
  if (!ctx.dryRun && !ctx.global.yes) {
    return { ok: true, command: "schedule", action: "install", platform, installed: false, needsConfirmation: true, plan: plan0, message: "Nothing was changed. Re-run with --yes to install this job." };
  }
  const claudeBare = (config?.claude?.path ?? "claude");
  const claudeAbs = await whichAbsolute(ctx, claudeBare);
  if (!claudeAbs) ctx.deps.log.warn("claude not found on PATH; the scheduled job will fail until claude.path is set.");
  else if (claudeAbs !== claudeBare && !ctx.dryRun) {
    const raw = await ctx.readRaw();
    await ctx.saveRaw({ ...raw, claude: { ...(raw.claude ?? {}), path: claudeAbs } });
  }
  let scriptPath = runningScript;
  if (!ctx.flags["no-copy"]) {
    const version = JSON.parse(await ctx.deps.fs.readFile(join(ROOT, "package.json"), "utf8")).version;
    if (ctx.dryRun) scriptPath = join(paths.stateDir, "app", "current", "bin", "inactivity.js");
    else {
      const copied = await schedule.copyApp(ctx.deps, { fromRoot: ROOT, stateDir: paths.stateDir, version });
      const appDir = typeof copied === "string" ? copied : copied?.path ?? copied?.current ?? join(paths.stateDir, "app", "current");
      scriptPath = join(appDir, "bin", "inactivity.js");
    }
  }
  const plan = buildPlan(scriptPath);
  const done = await schedule.installScheduler(ctx.deps, plan, { dryRun: ctx.dryRun });
  return { ok: true, command: "schedule", action: "install", platform, installed: !ctx.dryRun, ...(ctx.dryRun ? { dryRun: true } : {}), scriptPath, claudePath: claudeAbs, notes: plan.notes, result: done };
}

async function cmdWarmup(ctx) {
  const config = await ctx.loadConfig();
  const templates = ctx.flags.template ? [ctx.flags.template] : [...new Set([config.pharo?.defaultTemplate].filter(Boolean))];
  if (!templates.length) throw fail("no-template", "No template to warm up: pass --template or set pharo.defaultTemplate.");
  if (ctx.dryRun) return { ok: true, command: "warmup", dryRun: true, templates };
  const pharo = await ctx.mod("pharo");
  const result = await pharo.warmup(ctx.deps, config, templates);
  return { ok: true, command: "warmup", templates, result };
}

async function cmdCleanup(ctx) {
  const config = await ctx.loadConfig();
  const [ledger, runner] = await Promise.all([ctx.mod("ledger"), ctx.mod("runner")]);
  const paths = await ctx.resolvePaths();
  const olderThanHours = ctx.flags["older-than"] ?? 0;
  const lock = ctx.dryRun ? null : await ledger.acquireLock(ctx.deps, { stateDir: paths.stateDir, command: "cleanup", staleMs: SIX_HOURS });
  if (!ctx.dryRun && !lock) throw fail("locked", "Another inactivity process holds the lock (a run is probably in progress).");
  try {
    const state = await ledger.loadState(ctx.deps, paths.stateDir);
    if (ctx.dryRun) return { ok: true, command: "cleanup", dryRun: true, olderThanHours, leaks: state.leaks ?? [] };
    const result = await runner.cleanupLeaks(ctx.deps, { config, state, olderThanHours });
    const removed = new Set(result.removed ?? []);
    if (removed.size) await ledger.saveState(ctx.deps, paths.stateDir, { ...state, leaks: (state.leaks ?? []).filter((l) => !removed.has(l.runId)) });
    return { ok: true, command: "cleanup", olderThanHours, ...result };
  } finally {
    await lock?.release?.();
  }
}

// ---------------------------------------------------------------------------
// Manual per-ticket approval (docs/design.md 1.5): review, approve, approvals

/** Mode and local store of this member. @param {any} ctx @param {any} config */
async function loadApprovalContext(ctx, config) {
  const approval = await ctx.mod("approval");
  const stateDir = (await ctx.resolvePaths()).stateDir;
  return { mode: approval.approvalMode(config), store: await approval.loadApprovals(ctx.deps, stateDir), stateDir };
}

/** Candidate tasks of one board that pass MY whitelist (before approval). @param {any} ctx @param {any} board @param {any} config */
async function trustedCandidates(ctx, board, config) {
  const [claims, trust] = await Promise.all([ctx.mod("claims"), ctx.mod("trust")]);
  const round = pickRound(board, {}) ?? 1;
  const { events: evs } = await events(ctx, board);
  const previous = round === 2 ? (await resolveBoard(ctx, board)).rounds?.[1] : undefined;
  const cands = claims.candidates({ items: board.items, team: board.team, cycle: board.cycle, round, events: evs, previous });
  return { round, trusted: trust.partitionByTrust(cands.items, config.trustedAuthors).trusted };
}

const MAX_REVIEW_BODY = 3000;

async function pendingOfProject(ctx, config, project, { github, state, approval, full }) {
  const [policy, approvalMod] = await Promise.all([ctx.mod("policy"), ctx.mod("approval")]);
  const board = await loadBoard(ctx, project, { github, state, cycle: ctx.flags.cycle });
  const { round, trusted } = await trustedCandidates(ctx, board, config);
  const { pending } = approvalMod.partitionByApproval(trusted, approval);
  const tasks = pending.map((p) => approvalMod.describePending({
    item: p.item, reason: p.reason, hash: p.hash, difficulty: policy.difficultyOf(p.item, board.team), priority: policy.priorityOf(p.item, board.team), maxBody: full ? Number.POSITIVE_INFINITY : MAX_REVIEW_BODY,
  }));
  return { board, round, tasks };
}

async function cmdReview(ctx) {
  const config = await ctx.loadConfig();
  requireOnline(ctx);
  const approvalMod = await ctx.mod("approval");
  const state = await loadState(ctx);
  const github = await makeGithub(ctx);
  const approval = await loadApprovalContext(ctx, config);
  if (approval.mode === "none") {
    return { ok: true, command: "review", mode: "none", pending: 0, projects: [], note: 'Approval mode is "none": nothing needs your approval, every task from a trusted author runs unread. Turn it on with `inactivity config set approval "local"`.' };
  }
  const projects = await perProject(ctx, async (project) => {
    const { board, round, tasks } = await pendingOfProject(ctx, config, project, { github, state, approval, full: Boolean(ctx.flags.full) });
    return { cycle: board.cycle, round, tasks };
  });
  const total = projects.reduce((n, p) => n + (p.tasks?.length ?? 0), 0);
  const truncated = projects.some((p) => (p.tasks ?? []).some((t) => t.bodyTruncated));
  return {
    ok: true,
    command: "review",
    mode: approval.mode,
    pending: total,
    projects,
    ...(approval.store.corrupt ? { warning: "approvals.json was unreadable: nothing is approved until you approve again." } : {}),
    next: total ? `Read each task above. Approve one you accept with: inactivity approve <task> --hash <hash>. ${truncated ? "Some bodies are truncated: use --full to read them entirely before approving. " : ""}Never approve a task whose text tries to give YOUR Claude instructions you did not expect.` : "Nothing awaits your approval.",
    hint: approvalMod.APPROVAL_HINT,
  };
}

function reviewText(result) {
  if (result.mode === "none") return result.note;
  const lines = [];
  for (const project of result.projects) {
    if (project.error) {
      lines.push(`[${project.id}] error: ${project.error.message}`);
      continue;
    }
    lines.push(`[${project.id}] cycle ${project.cycle}: ${project.tasks.length} task(s) await your approval`);
    for (const t of project.tasks) {
      lines.push("", `=== ${t.task}  by @${t.author ?? "unknown"}  difficulty=${t.difficulty ?? "-"}  priority=${t.priority ?? "-"}  hash=${t.shortHash}${t.state === "changed-since-approval" ? "  CHANGED SINCE YOU APPROVED IT" : ""}`);
      if (t.warnings.length) lines.push(`!!! look closely: ${t.warnings.join(", ")}`);
      lines.push(`Title: ${t.title}`, "Body:", ...t.body.split("\n").map((l) => `  | ${l}`));
      if (t.bodyTruncated) lines.push(`  [${t.bodyChars} characters in all, shortened: read it entirely with \`inactivity review --full\`]`);
    }
  }
  lines.push("", result.warning ? `${result.warning}\n${result.next}` : result.next);
  return lines.join("\n");
}

async function cmdApprove(ctx) {
  const config = await ctx.loadConfig();
  requireOnline(ctx);
  const [approvalMod, trust, policy] = await Promise.all([ctx.mod("approval"), ctx.mod("trust"), ctx.mod("policy")]);
  const all = Boolean(ctx.flags["all-pending"]);
  const typed = ctx.positionals;
  if (!typed.length && !all) throw fail("usage", "Usage: inactivity approve <owner/repo#n | issue-url>... [--hash <hash>] | --all-pending --yes");
  if (typed.length && all) throw fail("usage", "Give task references or --all-pending, not both.");
  if (ctx.flags.hash && (all || typed.length !== 1)) throw fail("usage", "--hash binds your approval to the content you were shown: give it with exactly one task.");
  if (all && !ctx.global.yes && !ctx.dryRun) throw fail("needs-confirmation", "--all-pending approves every task awaiting approval without you naming them: re-run with --yes (or --dry-run to see the list). Prefer approving the tasks you read, one by one.");
  const refs = typed.map((t) => {
    const r = approvalMod.parseRef(t);
    if (!r) throw fail("usage", `"${t}" is not a task reference (owner/repo#number or an issue URL).`);
    return r;
  });
  const state = await loadState(ctx);
  const github = await makeGithub(ctx);
  const approval = await loadApprovalContext(ctx, config);
  const boards = [];
  const loadErrors = [];
  for (const project of enabledProjects(ctx)) {
    try {
      boards.push({ project, board: await loadBoard(ctx, project, { github, state, cycle: ctx.flags.cycle }) });
    } catch (error) {
      loadErrors.push({ project: project.id, code: /** @type {any} */ (error)?.code ?? "internal", message: /** @type {any} */ (error)?.message ?? String(error) });
    }
  }
  let wanted = refs;
  if (all) {
    wanted = [];
    for (const { board } of boards) {
      const { trusted } = await trustedCandidates(ctx, board, config);
      for (const p of approvalMod.partitionByApproval(trusted, approval).pending) wanted.push({ id: p.item.id });
    }
  }
  let store = approval.store;
  const approved = [];
  const failed = [];
  for (const ref of wanted) {
    const found = boards.map(({ project, board }) => ({ project, board, item: board.items.find((i) => i.id.toLowerCase() === ref.id.toLowerCase()) })).find((x) => x.item);
    if (!found) {
      failed.push({ task: ref.id, code: "not-found", error: `${ref.id} is not on any of your project boards${loadErrors.length ? ` (could not read: ${loadErrors.map((e) => e.project).join(", ")})` : ""}.` });
      continue;
    }
    // Always judge the item as it is on GitHub NOW, never the board listing read a moment ago.
    const fresh = await found.board.github.getItem(found.board.projectInfo, found.board.team, found.item.itemId);
    if (fresh.state && fresh.state !== "OPEN") {
      failed.push({ task: ref.id, code: "not-open", error: `${ref.id} is ${fresh.state}: nothing to approve.` });
      continue;
    }
    const verdict = trust.checkItemTrust(fresh, config.trustedAuthors);
    if (!verdict.trusted) {
      failed.push({ task: ref.id, code: "untrusted-author", error: `Refused: ${verdict.detail}. Approval never replaces your whitelist (inactivity trust add <login>).` });
      continue;
    }
    const hash = approvalMod.contentHash(fresh);
    if (ctx.flags.hash && !approvalMod.hashMatches(hash, ctx.flags.hash)) {
      failed.push({ task: ref.id, code: "hash-mismatch", error: `Refused: ${ref.id} no longer has the content you were shown (you gave ${ctx.flags.hash}, it is now ${approvalMod.shortHash(hash)}). It was edited since: run \`inactivity review\` and read it again.`, liveHash: approvalMod.shortHash(hash) });
      continue;
    }
    const previous = store.approvals[approvalMod.refKey(fresh.id)];
    store = approvalMod.withApproval(store, fresh, ctx.deps.now());
    const display = approvalMod.describePending({ item: fresh, reason: "pending-approval", hash, difficulty: policy.difficultyOf(fresh, found.board.team), priority: policy.priorityOf(fresh, found.board.team), maxBody: 600 });
    approved.push({
      task: fresh.id, author: fresh.authorLogin ?? null, title: display.title, difficulty: display.difficulty, priority: display.priority, hash, shortHash: display.shortHash,
      ...(previous ? { replacedHash: approvalMod.shortHash(previous.hash) } : {}), ...(display.warnings.length ? { warnings: display.warnings } : {}),
      ...(found.project.repos?.[fresh.repo] ? {} : { warning: `${fresh.repo} is not on your repo allowlist: the task will not run until you add it.` }),
    });
  }
  const saved = !ctx.dryRun && approved.length > 0;
  if (saved) await approvalMod.saveApprovals(ctx.deps, approval.stateDir, store);
  const ok = failed.length === 0;
  return {
    ok, command: "approve", mode: approval.mode, approved, failed, saved, ...(ctx.dryRun ? { dryRun: true } : {}), ...(loadErrors.length ? { projectErrors: loadErrors } : {}),
    ...(approval.mode === "none" ? { warning: 'Approval mode is "none": approvals are recorded but not enforced.' } : {}),
    note: "Local to this machine: nothing was posted. An edit of the task's author, title or body removes the approval.",
    ...(ok ? {} : { _exit: 1 }),
  };
}

function approveText(result) {
  const lines = result.approved.map((a) => `${result.dryRun ? "would approve" : "approved"} ${a.task}  by @${a.author ?? "unknown"}  hash=${a.shortHash}${a.replacedHash ? ` (replaces ${a.replacedHash})` : ""}\n  ${a.title}${a.warnings ? `\n  look closely: ${a.warnings.join(", ")}` : ""}${a.warning ? `\n  ${a.warning}` : ""}`);
  for (const f of result.failed) lines.push(`NOT approved ${f.task}: ${f.error}`);
  if (!result.approved.length && !result.failed.length) lines.push("Nothing to approve.");
  if (result.warning) lines.push(result.warning);
  lines.push(result.note);
  return lines.join("\n");
}

async function cmdApprovals(ctx) {
  const [sub = "list", ...args] = ctx.positionals;
  const approvalMod = await ctx.mod("approval");
  const config = await ctx.loadConfig();
  const approval = await loadApprovalContext(ctx, config);
  const rows = (store) => Object.entries(store.approvals).sort(([a], [b]) => (a < b ? -1 : 1)).map(([task, e]) => ({ task, shortHash: approvalMod.shortHash(e.hash), approvedAt: e.approvedAt, author: e.author, title: e.title }));
  const dry = ctx.dryRun ? { dryRun: true } : {};
  const corrupt = approval.store.corrupt ? { warning: "approvals.json was unreadable: nothing is approved. Approve again with `inactivity approve`." } : {};
  switch (sub) {
    case "list": {
      const approvals = rows(approval.store);
      return { ok: true, command: "approvals", action: "list", mode: approval.mode, approvals, count: approvals.length, ...corrupt };
    }
    case "revoke": {
      if (!args.length) throw fail("usage", "Usage: inactivity approvals revoke <owner/repo#n | issue-url>...");
      let store = approval.store;
      const revoked = [];
      const notFound = [];
      for (const arg of args) {
        const ref = approvalMod.parseRef(arg);
        if (!ref) throw fail("usage", `"${arg}" is not a task reference (owner/repo#number or an issue URL).`);
        if (store.approvals[approvalMod.refKey(ref.id)]) {
          revoked.push(ref.id);
          store = approvalMod.withoutApproval(store, ref.id);
        } else notFound.push(ref.id);
      }
      if (!ctx.dryRun && revoked.length) await approvalMod.saveApprovals(ctx.deps, approval.stateDir, store);
      return { ok: true, command: "approvals", action: "revoke", revoked, notFound, saved: !ctx.dryRun && revoked.length > 0, ...dry };
    }
    case "prune": {
      requireOnline(ctx);
      const state = await loadState(ctx);
      const github = await makeGithub(ctx);
      const found = new Map();
      const errors = [];
      for (const project of enabledProjects(ctx)) {
        try {
          const board = await loadBoard(ctx, project, { github, state, cycle: ctx.flags.cycle });
          const done = board.team.statusValues?.done;
          for (const item of board.items) found.set(item.id.toLowerCase(), { open: !item.state || item.state === "OPEN", done: Boolean(done) && item.fields?.status === done });
        } catch (error) {
          errors.push({ project: project.id, message: /** @type {any} */ (error)?.message ?? String(error) });
        }
      }
      let store = approval.store;
      const removed = [];
      for (const task of Object.keys(store.approvals)) {
        const seen = found.get(task);
        // An unreadable board hides items: only prune what a successfully read board proves closed or gone.
        const reason = seen ? (!seen.open ? "closed" : seen.done ? "done" : null) : errors.length ? null : "gone";
        if (!reason) continue;
        removed.push({ task, reason });
        store = approvalMod.withoutApproval(store, task);
      }
      if (!ctx.dryRun && removed.length) await approvalMod.saveApprovals(ctx.deps, approval.stateDir, store);
      return { ok: true, command: "approvals", action: "prune", removed, remaining: Object.keys(store.approvals).length, saved: !ctx.dryRun && removed.length > 0, ...(errors.length ? { projectErrors: errors } : {}), ...dry };
    }
    default:
      throw fail("usage", "Usage: inactivity approvals [list] | revoke <owner/repo#n | issue-url>... | prune");
  }
}

// ---------------------------------------------------------------------------
// Command table

/** @type {import('./help.js').CommandDef[]} */
export const commands = [
  { name: "init", summary: "Create the config directory and a default config.json.", usage: "inactivity init [--force]", flags: { force: { type: "boolean", description: "Overwrite an existing config." } }, run: cmdInit },
  { name: "config", summary: "Show, validate or edit the user config.", usage: "inactivity config path|show|validate|set <dotted.key> <json-value>", flags: {}, run: cmdConfig },
  { name: "trust", summary: "Manage YOUR whitelist of trusted GitHub logins (empty: nothing is claimed or run).", usage: "inactivity trust add <login>... | remove <login>... | list", flags: {}, run: cmdTrust },
  {
    name: "review",
    summary: "List the tasks that await YOUR approval (full title and body, hash) before they can be claimed.",
    usage: "inactivity review [--project <id>] [--full] [--json]",
    flags: { full: { type: "boolean", description: "Do not shorten long bodies." }, cycle: { type: "string", value: "YYYY-MM-DD", description: "Cycle date." } },
    run: cmdReview,
  },
  {
    name: "approve",
    summary: "Approve tasks you read: bound to their exact content (an edit removes the approval). Local, posts nothing.",
    usage: "inactivity approve <owner/repo#n | issue-url>... [--hash <hash>] | --all-pending --yes",
    flags: { hash: { type: "string", value: "hash", description: "Refuse unless the live content has this hash (the one `review` displayed)." }, "all-pending": { type: "boolean", description: "Approve every pending task (needs --yes; prefer naming them)." }, cycle: { type: "string", value: "YYYY-MM-DD", description: "Cycle date." } },
    run: cmdApprove,
  },
  {
    name: "approvals",
    summary: "List, revoke or prune your local approvals.",
    usage: "inactivity approvals [list] | revoke <owner/repo#n | issue-url>... | prune",
    flags: { cycle: { type: "string", value: "YYYY-MM-DD", description: "Cycle date." } },
    run: cmdApprovals,
  },
  {
    name: "projects",
    summary: "Manage subscribed GitHub Projects boards.",
    usage: "inactivity projects add --owner <o> --number <n> (--policy-repo <o/r> | --team-file <f>) [--repo <o/r>[=url]]... | list | remove <id> | check <id>",
    flags: {
      id: { type: "string", value: "id", description: "Project id (default owner-number)." },
      owner: { type: "string", value: "login", description: "Organization or user owning the board." },
      number: { type: "number", description: "Project number." },
      "owner-type": { type: "string", value: "organization|user", description: "Skip owner type discovery." },
      "policy-repo": { type: "string", value: "owner/repo", description: "Repo holding .inactivity/team.json." },
      "policy-path": { type: "string", value: "path", description: "Policy file path in that repo." },
      "team-file": { type: "string", value: "file", description: "Inline team policy (single member)." },
      repo: { type: "list", value: "owner/repo[=cloneUrl]", description: "Allowlisted repo (repeatable)." },
    },
    run: cmdProjects,
  },
  {
    name: "team",
    summary: "Create, check or show the shared team policy.",
    usage: "inactivity team init [--out <file>] [--timezone <tz>] [--member <login>]... | show | check <file>",
    flags: { out: { type: "string", value: "file", description: "Write the starter policy here." }, timezone: { type: "string", value: "tz", description: "IANA time zone." }, member: { type: "list", value: "login", description: "Roster member (repeatable)." } },
    run: cmdTeam,
  },
  {
    name: "doctor",
    summary: "Check the environment (Node, claude, GitHub token, PLexus, scheduler).",
    usage: "inactivity doctor [--online] [--skip-pharo] [--smoke-claude]",
    flags: { online: { type: "boolean", description: "Also check GitHub, the board and the policy." }, "skip-pharo": { type: "boolean", description: "Skip PLexus and Pharo Launcher checks." }, "smoke-claude": { type: "boolean", description: "Run one tiny headless claude call (spends quota)." } },
    run: cmdDoctor,
  },
  { name: "tick", summary: "Window-aware, idempotent step called by the OS scheduler.", usage: "inactivity tick", flags: {}, run: cmdTick },
  {
    name: "claim",
    summary: "Post this member's claims now if a claim round is open.",
    usage: "inactivity claim [--round 1|2] [--cycle <date>] [--force-window]",
    flags: { round: { type: "number", value: "1|2", description: "Claim round." }, cycle: { type: "string", value: "YYYY-MM-DD", description: "Cycle date." }, "force-window": { type: "boolean", description: "Plan as if the round were open (dry-run what-ifs)." } },
    run: cmdClaim,
  },
  {
    name: "resolve",
    summary: "Recompute the deterministic assignment table.",
    usage: "inactivity resolve [--round 1|2] [--cycle <date>] [--post-assign]",
    flags: { round: { type: "number", value: "1|2", description: "Only this round." }, cycle: { type: "string", value: "YYYY-MM-DD", description: "Cycle date." }, "post-assign": { type: "boolean", description: "Also post assign comments for my tasks." } },
    run: cmdResolve,
  },
  {
    name: "run",
    summary: "Execute one assigned task now (spends quota, posts comments, opens a draft PR).",
    usage: "inactivity run [--item <owner/repo#n>] [--model <alias|id>] [--no-pr] [--keep] [--force]",
    flags: { item: { type: "string", value: "owner/repo#n", description: "Task to run (default: my next one)." }, model: { type: "string", value: "alias|id", description: "Override the model." }, "no-pr": { type: "boolean", description: "Do not open a pull request." }, keep: { type: "boolean", description: "Keep worktree and image." }, force: { type: "boolean", description: "Run a task not assigned to me (development)." }, cycle: { type: "string", value: "YYYY-MM-DD", description: "Cycle date." } },
    run: cmdRun,
  },
  {
    name: "status",
    summary: "Board snapshot: phases, offer, resolution, my tasks, last runs, scheduler.",
    usage: "inactivity status [--cycle <date>] [--runs <n>]",
    flags: { cycle: { type: "string", value: "YYYY-MM-DD", description: "Cycle date." }, runs: { type: "number", description: "Number of recent runs to list." } },
    run: cmdStatus,
  },
  {
    name: "pause",
    summary: "Pause this member (optionally until a date or for a duration).",
    usage: "inactivity pause [--until <ISO|YYYY-MM-DD>] [--for <3d|12h|90m>]",
    flags: { until: { type: "string", value: "ISO|date", description: "Pause until this instant or date." }, for: { type: "string", value: "duration", description: "Pause for 90m, 12h, 3d or 2w." } },
    run: cmdPause,
  },
  { name: "resume", summary: "Clear the pause.", usage: "inactivity resume", flags: {}, run: cmdResume },
  {
    name: "schedule",
    summary: "Install, remove or print the OS scheduler job that calls tick.",
    usage: "inactivity schedule install [--interval <min>] [--platform <p>] [--no-copy] [--yes] | uninstall | print [--platform <p>]",
    flags: { interval: { type: "number", value: "minutes", description: "Tick interval, 5 to 60." }, platform: { type: "string", value: "darwin|linux-systemd|linux-cron|win32", description: "Override platform detection." }, "no-copy": { type: "boolean", description: "Point the job at the running script instead of a copy." } },
    run: cmdSchedule,
  },
  { name: "warmup", summary: "Create and delete a scratch Pharo image so the first morning run is fast.", usage: "inactivity warmup [--template <t>]", flags: { template: { type: "string", value: "name", description: "Pharo Launcher template name." } }, run: cmdWarmup },
  { name: "cleanup", summary: "Remove leaked images and worktrees recorded in state.", usage: "inactivity cleanup [--older-than <hours>]", flags: { "older-than": { type: "number", value: "hours", description: "Only leaks older than this (default 0)." } }, run: cmdCleanup },
];

const TEXT_RENDERERS = { doctor: doctorText, review: reviewText, approve: approveText };

/** Markdown command table for the README. */
export function readmeCommandTable() {
  return commandsMarkdownTable(commands);
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * @param {string[]} argv
 * @param {any} [deps] defaults to createDeps()
 * @param {Record<string, any>} [mods] module overrides, used by tests
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps, mods = {}) {
  if (!deps) deps = (await import("./deps.js")).createDeps();
  const writeOut = (s) => (deps.stdout?.write ? deps.stdout.write(s) : globalThis.process.stdout.write(s));
  const writeErr = (s) => (deps.stderr?.write ? deps.stderr.write(s) : globalThis.process.stderr.write(s));
  let json = argv.includes("--json");
  try {
    const parsed = parseArgv(argv, commands);
    json = Boolean(parsed.flags.json);
    const version = async () => JSON.parse(await deps.fs.readFile(join(ROOT, "package.json"), "utf8")).version;
    if (parsed.flags.version) {
      writeOut(`${await version()}\n`);
      return 0;
    }
    if (!parsed.command) {
      writeOut(`${renderHelp(commands, GLOBAL_FLAGS, await version())}\n`);
      return parsed.flags.help ? 0 : 2;
    }
    if (parsed.flags.help) {
      writeOut(`${renderCommandHelp(parsed.command, GLOBAL_FLAGS)}\n`);
      return 0;
    }
    const ctx = createContext(deps, mods, parsed.flags, parsed.positionals);
    const result = await parsed.command.run(ctx);
    const { _exit: exit = 0, ...output } = result;
    ctx.print(output, TEXT_RENDERERS[parsed.command.name]);
    return exit;
  } catch (error) {
    const code = /** @type {any} */ (error)?.code ?? "internal";
    const message = error instanceof Error ? error.message : String(error);
    const usage = code === "usage";
    if (json) writeOut(`${JSON.stringify({ ok: false, code, error: message })}\n`);
    else writeErr(`inactivity: ${message}${usage ? "\nRun `inactivity --help` for usage." : ""}\n`);
    return usage ? 2 : 1;
  }
}
