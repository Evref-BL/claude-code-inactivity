// Shared wiring helpers for the CLI and doctor: GitHub client, team policy
// loading and board snapshot. Not part of the frozen spec (spec 9.17 only names
// cli/doctor/help); it exists so cli.js and doctor.js do not duplicate code.
//
// `ctx` is the CLI context: {deps, mod(name), config, paths, flags, global}.

/** @param {string} code @param {string} message @param {object} [details] */
export function fail(code, message, details) {
  const error = new Error(message);
  /** @type {any} */ (error).code = code;
  if (details) /** @type {any} */ (error).details = details;
  return error;
}

/** @param {any} ctx */
export function requireOnline(ctx) {
  if (ctx.global.offline) throw fail("offline", "This command needs the network but --offline was given.");
}

/** Creates the GitHub client (token from env or `gh auth token`). @param {any} ctx */
export async function makeGithub(ctx) {
  requireOnline(ctx);
  const gh = await ctx.mod("github");
  const { token } = await gh.resolveToken(ctx.deps);
  return gh.createGithub(ctx.deps, { token, apiUrl: ctx.config?.github?.apiUrl });
}

/** Login from config, cached state or viewer{login}. @param {any} ctx @param {any} github @param {any} [state] */
export async function resolveLogin(ctx, github, state) {
  if (ctx.config?.login) return ctx.config.login;
  if (state?.login) return state.login;
  return (await github.viewer()).login;
}

/** @param {any} ctx @param {string} text @param {string} origin */
async function parseTeam(ctx, value, origin) {
  const policy = await ctx.mod("policy");
  const result = policy.validateTeam(value);
  if (!result.ok) {
    throw fail("invalid-team", `Team policy from ${origin} is invalid: ${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`, { errors: result.errors });
  }
  return result.team;
}

/**
 * Team policy in effect (spec 4.3 version rule). Inline team for single-member
 * projects, else the policy file at the last commit <= window start.
 * @param {any} ctx @param {any} github @param {any} project @param {Date} now
 * @returns {Promise<{team:any, source:string, oid?:string}>}
 */
export async function loadTeam(ctx, github, project, now) {
  if (project.team) return { team: await parseTeam(ctx, project.team, `project ${project.id} (inline)`), source: "inline" };
  if (!project.policy) throw fail("no-policy", `Project ${project.id} has neither "policy" nor "team".`);
  const policy = await ctx.mod("policy");
  const path = project.policy.path ?? ".inactivity/team.json";
  const read = (until) => github.readPolicyFile({ repo: project.policy.repo, path, until: until.toISOString() });
  let file = await read(now);
  if (!file) throw fail("policy-missing", `No ${path} in ${project.policy.repo} at ${now.toISOString()}.`);
  let team = await parseTeam(ctx, JSON.parse(file.text), `${project.policy.repo}:${path}`);
  const start = policy.cyclePhases(team, now).rounds[1].claimStart;
  if (start < now) {
    file = await read(start);
    if (!file) throw fail("policy-missing", `No ${path} in ${project.policy.repo} at window start ${start.toISOString()}.`);
    team = await parseTeam(ctx, JSON.parse(file.text), `${project.policy.repo}:${path}`);
  }
  return { team, source: `${project.policy.repo}:${path}`, oid: file.oid };
}

/**
 * Everything a board-reading command needs.
 * @param {any} ctx @param {any} project @param {{github?:any, state?:any, cycle?:string}} [opts]
 */
export async function loadBoard(ctx, project, opts = {}) {
  const github = opts.github ?? (await makeGithub(ctx));
  const now = ctx.deps.now();
  const policy = await ctx.mod("policy");
  const login = await resolveLogin(ctx, github, opts.state);
  const { team, source } = await loadTeam(ctx, github, project, now);
  const projectInfo = await github.resolveProject({ owner: project.owner, number: project.number, ownerType: project.ownerType ?? undefined });
  const { items, skipped } = await github.listItems(projectInfo, team);
  const phases = policy.cyclePhases(team, now);
  const cycle = opts.cycle ?? phases.cycle;
  return { github, login, team, teamSource: source, projectInfo, items, skipped, phases, cycle, now, cfg: policy.digestTeam(team) };
}

/** The roster entry of `login`, case-insensitive. @param {any} team @param {string} login */
export function rosterEntry(team, login) {
  return (team.roster ?? []).find((m) => m.login.toLowerCase() === String(login).toLowerCase()) ?? null;
}
