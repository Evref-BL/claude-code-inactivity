// Board exposure assessment (pure; no I/O). Spec: docs/design.md section 4.7, docs/board-lockdown.md.
//
// The trust whitelist (trust.js) protects each member's Claude from tasks written by strangers. The board
// lockdown protects the board itself: only the members of the group should be able to create or edit tasks
// in the first place. The lockdown is done by humans in the GitHub UI; this module only checks what the
// API lets us see and says what is wrong.

const LOCKDOWN = 'docs/board-lockdown.md';

/**
 * @typedef {{level:'ok'|'info'|'warn'|'fail', code:string, message:string, fix?:string, repo?:string}} Finding
 */

/**
 * @param {{
 *   projectId?:string,
 *   projectInfo?:{public?:boolean|null, closed?:boolean|null}|null,
 *   access?:{public?:boolean|null, teams?:{slug:string,name:string}[]|null, repositories?:{repo:string,isPrivate:boolean|null,visibility:string|null}[]|null, collaborators?:string, status?:string, hint?:string|null}|null,
 *   repos?:{repo:string, role?:string, isPrivate?:boolean|null, visibility?:string|null, error?:string}[],
 *   allowPublicBoard?:boolean
 * }} input
 * @returns {{level:'ok'|'warn'|'fail', public:boolean|null, allowPublicBoard:boolean, teams:string[]|null, collaborators:string, findings:Finding[]}}
 */
export function assessExposure({ projectId, projectInfo, access, repos = [], allowPublicBoard = false }) {
  /** @type {Finding[]} */
  const findings = [];
  const label = projectId ? `Board ${projectId}` : 'The board';
  const isPublic = typeof access?.public === 'boolean' ? access.public : typeof projectInfo?.public === 'boolean' ? projectInfo.public : null;

  if (isPublic === true) {
    if (allowPublicBoard === true) {
      findings.push({ level: 'warn', code: 'board-public-allowed', message: `${label} is PUBLIC (allowed by allowPublicBoard): anyone on the internet can read it and its task text.`, fix: `Make it private: ${LOCKDOWN}, step 1.` });
    } else {
      findings.push({ level: 'fail', code: 'board-public', message: `${label} is PUBLIC: anyone can read it, and every claim and assignment on it.`, fix: `Set the project visibility to Private (${LOCKDOWN}, step 1). To keep it public on purpose, set allowPublicBoard to true in the config.` });
    }
  } else if (isPublic === false) {
    findings.push({ level: 'ok', code: 'board-private', message: `${label} is private.` });
  } else {
    findings.push({ level: 'warn', code: 'board-visibility-unknown', message: `${label}: visibility could not be read (public flag missing).`, fix: `Check Project > Settings > Visibility by hand (${LOCKDOWN}, step 1).` });
  }

  for (const r of repos) {
    const where = `${r.role === 'policy' ? 'policy repo' : 'repo'} ${r.repo}`;
    if (r.error) findings.push({ level: 'info', code: 'repo-unknown', repo: r.repo, message: `${where}: visibility unknown (${r.error}).` });
    else if (r.isPrivate === false || r.visibility === 'PUBLIC') {
      findings.push({ level: 'warn', code: 'repo-public', repo: r.repo, message: `${where} is PUBLIC: anyone can open issues and comment there, and claim comments are world-readable. Your trusted-author list keeps those issues from running, but the noise and the leak remain.`, fix: `Make the repo private, or restrict who can open issues and comment with interaction limits (${LOCKDOWN}, step 2).` });
    } else if (r.isPrivate === true || r.visibility === 'PRIVATE' || r.visibility === 'INTERNAL') {
      findings.push({ level: 'ok', code: 'repo-private', repo: r.repo, message: `${where} is ${String(r.visibility ?? 'private').toLowerCase()}.` });
    } else findings.push({ level: 'info', code: 'repo-unknown', repo: r.repo, message: `${where}: visibility unknown.` });
  }

  const teams = Array.isArray(access?.teams) ? access.teams.map((t) => t.slug ?? t.name) : null;
  if (access?.status === 'ok') {
    findings.push({ level: 'info', code: 'board-teams', message: teams?.length ? `Teams linked to the board: ${teams.join(', ')}.` : 'No team is linked to the board.', ...(access.hint ? { fix: access.hint } : {}) });
  } else {
    findings.push({ level: 'info', code: 'board-access-unknown', message: 'Teams and collaborators of the board: unknown.', fix: access?.hint ?? `Review Project > Settings > Manage access by hand (${LOCKDOWN}, step 1).` });
  }

  const level = findings.some((f) => f.level === 'fail') ? 'fail' : findings.some((f) => f.level === 'warn') ? 'warn' : 'ok';
  return { level, public: isPublic, allowPublicBoard: allowPublicBoard === true, teams, collaborators: access?.collaborators ?? 'unknown', findings };
}

/** Whether a project may be public: the project entry wins over the global key. @param {any} config @param {any} project */
export function allowsPublicBoard(config, project) {
  if (typeof project?.allowPublicBoard === 'boolean') return project.allowPublicBoard;
  return config?.allowPublicBoard === true;
}
