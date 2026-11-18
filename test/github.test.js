import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createGithub, resolveToken, GithubError, extractFields } from '../src/github.js'

const TOKEN = 'ghp_SECRETSECRETSECRETSECRETSECRET123456'
const fixture = (name) => {
  const { _comment, ...rest } = JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'))
  return rest
}

const TEAM = { fields: { priority: 'Priority', difficulty: 'Difficulty', status: 'Status', agent: 'Agent' }, includePullRequests: false }

/** Minimal fake HTTP response. */
function response(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  return { status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, text: async () => text, json: async () => JSON.parse(text) }
}

/**
 * Fake deps. `routes`: operationName -> response body | fn(variables, call) | array of bodies (consumed in order).
 * `http`: optional queue of raw responses/errors returned before routing (failNext style).
 */
function makeDeps({ routes = {}, http = [], env = {}, execReply } = {}) {
  const calls = []
  const sleeps = []
  const logs = []
  const queues = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]))
  const deps = {
    env,
    now: () => new Date('2026-11-19T04:00:00Z'),
    sleep: async (ms) => { sleeps.push(ms) },
    log: Object.fromEntries(['debug', 'info', 'warn', 'error'].map((l) => [l, (...a) => logs.push(a.join(' '))])),
    exec: async (cmd, args) => {
      calls.push({ exec: [cmd, ...args] })
      if (!execReply) { const e = new Error('spawn gh ENOENT'); e.code = 'ENOENT'; throw e }
      return execReply
    },
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null
      calls.push({ url, init, body })
      if (http.length) {
        const next = http.shift()
        if (next instanceof Error) throw next
        return next
      }
      if (!body) return response(200, {}, { 'x-oauth-scopes': 'repo, project' })
      const route = queues[body.operationName]
      if (route === undefined) throw new Error(`unrouted operation ${body.operationName}`)
      const out = typeof route === 'function' ? route(body.variables, calls) : Array.isArray(route) ? route.shift() : route
      if (out === undefined) throw new Error(`route exhausted ${body.operationName}`)
      return response(200, out)
    },
  }
  return { deps, calls, sleeps, logs }
}

const gh = (opts, apiUrl) => {
  const ctx = makeDeps(opts)
  return { ...ctx, github: createGithub(ctx.deps, { token: TOKEN, apiUrl }) }
}
const ops = (calls) => calls.filter((c) => c.body).map((c) => c.body.operationName)

// --- token ------------------------------------------------------------------

test('resolveToken order: GH_TOKEN, GITHUB_TOKEN, gh', async () => {
  let { deps } = makeDeps({ env: { GH_TOKEN: ' a ', GITHUB_TOKEN: 'b' } })
  assert.deepEqual(await resolveToken(deps), { token: 'a', source: 'GH_TOKEN' })
  ;({ deps } = makeDeps({ env: { GITHUB_TOKEN: 'b' } }))
  assert.deepEqual(await resolveToken(deps), { token: 'b', source: 'GITHUB_TOKEN' })
  let ctx = makeDeps({ execReply: { code: 0, stdout: 'ghp_x\n', stderr: '' } })
  assert.deepEqual(await resolveToken(ctx.deps), { token: 'ghp_x', source: 'gh' })
  assert.deepEqual(ctx.calls[0].exec, ['gh', 'auth', 'token'])
})

test('resolveToken: gh missing or failing gives no-token', async () => {
  await assert.rejects(resolveToken(makeDeps().deps), { code: 'no-token' })
  await assert.rejects(resolveToken(makeDeps({ execReply: { code: 1, stdout: '', stderr: 'not logged in' } }).deps), { code: 'no-token' })
  await assert.rejects(resolveToken(makeDeps({ execReply: { code: 0, stdout: '  \n', stderr: '' } }).deps), (e) => e instanceof GithubError)
})

// --- viewer / scopes --------------------------------------------------------

test('viewer returns login and databaseId; request is a named operation with bearer token', async () => {
  const { github, calls } = gh({ routes: { ViewerLogin: fixture('gh-viewer') } })
  assert.deepEqual(await github.viewer(), { login: 'alice', databaseId: 1234 })
  assert.equal(calls[0].url, 'https://api.github.com/graphql')
  assert.equal(calls[0].body.operationName, 'ViewerLogin')
  assert.match(calls[0].body.query, /query ViewerLogin/)
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`)
})

test('GHES apiUrl maps to /api/graphql', async () => {
  const { github, calls } = gh({ routes: { ViewerLogin: fixture('gh-viewer') } }, 'https://ghe.example.com/api/v3/')
  await github.viewer()
  assert.equal(calls[0].url, 'https://ghe.example.com/api/graphql')
})

test('scopes parses x-oauth-scopes, null for fine-grained, 401 -> auth', async () => {
  let { github, calls } = gh({ http: [response(200, {}, { 'x-oauth-scopes': 'repo, project ,read:org' })] })
  assert.deepEqual(await github.scopes(), ['repo', 'project', 'read:org'])
  assert.equal(calls[0].url, 'https://api.github.com/user')
  ;({ github } = gh({ http: [response(200, {})] }))
  assert.equal(await github.scopes(), null)
  ;({ github } = gh({ http: [response(401, { message: 'Bad credentials' })] }))
  await assert.rejects(github.scopes(), { code: 'auth' })
})

// --- project resolution -----------------------------------------------------

test('resolveProject: org found, builds fields and options maps', async () => {
  const { github, calls } = gh({ routes: { ResolveProjectOrg: fixture('gh-project-org') } })
  const p = await github.resolveProject({ owner: 'acme', number: 3, ownerType: null })
  assert.equal(p.id, 'PVT_1')
  assert.equal(p.ownerType, 'organization')
  assert.deepEqual(p.fields.Status.options, { Todo: 'OPT_todo', Claimed: 'OPT_claimed', 'In review': 'OPT_review' })
  assert.equal(p.fields.Agent.dataType, 'TEXT')
  assert.deepEqual(calls[0].body.variables, { owner: 'acme', number: 3 })
})

test('resolveProject: org NOT_FOUND falls back to user when ownerType is null', async () => {
  const { github, calls } = gh({ routes: { ResolveProjectOrg: fixture('gh-project-org-notfound'), ResolveProjectUser: fixture('gh-project-user') } })
  const p = await github.resolveProject({ owner: 'alice', number: 1 })
  assert.equal(p.ownerType, 'user')
  assert.deepEqual(ops(calls), ['ResolveProjectOrg', 'ResolveProjectUser'])
})

test('resolveProject: explicit ownerType does not try the other, and missing project is not-found', async () => {
  const { github, calls } = gh({ routes: { ResolveProjectUser: { data: { user: { projectV2: null } } } } })
  await assert.rejects(github.resolveProject({ owner: 'alice', number: 9, ownerType: 'user' }), { code: 'not-found' })
  assert.deepEqual(ops(calls), ['ResolveProjectUser'])
})

// --- items ------------------------------------------------------------------

const PROJECT = { id: 'PVT_1', title: 'Backlog', ownerType: 'organization', fields: {} }

test('listItems paginates 3 pages, extracts fields and skips non executable items', async () => {
  const { github, calls } = gh({ routes: { ProjectItems: [fixture('gh-items-page1'), fixture('gh-items-page2'), fixture('gh-items-page3')] } })
  const { items, skipped } = await github.listItems(PROJECT, TEAM)
  assert.deepEqual(calls.map((c) => c.body.variables.cursor), [null, 'cur1', 'cur2'])
  assert.deepEqual(items.map((i) => i.number), [1, 2, 7])
  assert.deepEqual(skipped, [
    { itemId: 'PVTI_3', reason: 'draft-issue' },
    { itemId: 'PVTI_4', reason: 'archived' },
    { itemId: 'PVTI_5', reason: 'pull-request' },
    { itemId: 'PVTI_6', reason: 'redacted' },
  ])
  const first = items[0]
  assert.equal(first.id, 'acme/app#1')
  assert.equal(first.itemId, 'PVTI_1')
  assert.equal(first.issueNodeId, 'I_1')
  assert.equal(first.contentType, 'Issue')
  assert.equal(first.authorLogin, 'alice')
  assert.equal(first.authorAssociation, 'MEMBER')
  assert.deepEqual(first.labels, ['bug', 'priority:P1'])
  // field name match is case-insensitive ("difficulty" in the fixture)
  assert.deepEqual(first.fields, { priority: 'P1', difficulty: 'easy', status: 'Todo', agent: '@bob' })
  assert.deepEqual(items[1].fields, { priority: null, difficulty: null, status: 'Claimed', agent: null })
  assert.equal(first.comments.length, 1)
  assert.equal(first.comments[0].author.login, 'bob')
  assert.equal(first.commentsComplete, true)
  assert.equal(items[2].commentsComplete, false)
})

test('listItems includes pull requests when team.includePullRequests', async () => {
  const { github } = gh({ routes: { ProjectItems: [fixture('gh-items-page1'), fixture('gh-items-page2'), fixture('gh-items-page3')] } })
  const { items, skipped } = await github.listItems(PROJECT, { ...TEAM, includePullRequests: true })
  assert.deepEqual(items.map((i) => [i.number, i.contentType]), [[1, 'Issue'], [2, 'Issue'], [5, 'PullRequest'], [7, 'Issue']])
  assert.equal(skipped.some((s) => s.reason === 'pull-request'), false)
})

test('extractFields honours custom field names', () => {
  const nodes = [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Ready', field: { name: 'Etat' } }]
  assert.equal(extractFields(nodes, { fields: { status: 'Etat' } }).status, 'Ready')
  assert.equal(extractFields(nodes, TEAM).status, null)
})

test('getItem fetches all older comment pages and prepends them', async () => {
  const { github, calls } = gh({ routes: { ProjectItem: fixture('gh-item-single'), IssueComments: fixture('gh-comments-older') } })
  const item = await github.getItem(PROJECT, TEAM, 'PVTI_7')
  assert.deepEqual(ops(calls), ['ProjectItem', 'IssueComments'])
  assert.deepEqual(calls[1].body.variables, { id: 'I_7', before: 'older1' })
  assert.deepEqual(item.comments.map((c) => c.databaseId), [9010, 9011, 9030, 9031])
  assert.equal(item.comments[1].author.type, 'Bot')
  assert.equal(item.comments[3].author, null)
  assert.equal(item.commentsComplete, true)
})

test('getItem: missing node is not-found; skipped item is item-skipped', async () => {
  let { github } = gh({ routes: { ProjectItem: { data: { node: null } } } })
  await assert.rejects(github.getItem(PROJECT, TEAM, 'x'), { code: 'not-found' })
  ;({ github } = gh({ routes: { ProjectItem: { data: { node: { id: 'PVTI_4', type: 'ISSUE', isArchived: true, content: { __typename: 'Issue' } } } } } }))
  await assert.rejects(github.getItem(PROJECT, TEAM, 'x'), { code: 'item-skipped' })
})

// --- comments / status ------------------------------------------------------

test('postComment returns a normalized Comment', async () => {
  const { github, calls } = gh({ routes: { AddComment: fixture('gh-add-comment') } })
  const c = await github.postComment('I_7', 'posted body')
  assert.deepEqual(calls[0].body.variables, { subjectId: 'I_7', body: 'posted body' })
  assert.equal(c.databaseId, 9040)
  assert.deepEqual(c.author, { login: 'alice', type: 'User' })
  assert.equal(c.isMinimized, false)
  assert.equal(c.lastEditedAt, null)
})

const FULL_PROJECT = {
  id: 'PVT_1', title: 'B', ownerType: 'organization',
  fields: {
    Status: { id: 'F_status', dataType: 'SINGLE_SELECT', options: { Todo: 'OPT_todo', Claimed: 'OPT_claimed' } },
    Agent: { id: 'F_agent', dataType: 'TEXT' },
  },
}
const OK_UPDATE = { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } }

test('setStatus resolves ids and sends select and text mutations', async () => {
  const { github, calls } = gh({ routes: { UpdateItemSelect: OK_UPDATE, UpdateItemText: OK_UPDATE } })
  await github.setStatus(FULL_PROJECT, TEAM, 'PVTI_1', { status: 'claimed', agent: '@alice' })
  assert.deepEqual(ops(calls), ['UpdateItemSelect', 'UpdateItemText'])
  assert.deepEqual(calls[0].body.variables, { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_status', optionId: 'OPT_claimed' })
  assert.deepEqual(calls[1].body.variables, { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'F_agent', text: '@alice' })
})

test('setStatus: unknown option throws before any mutation; missing Agent field is skipped', async () => {
  let { github, calls } = gh()
  await assert.rejects(github.setStatus(FULL_PROJECT, TEAM, 'PVTI_1', { status: 'Nope', agent: '@a' }), { code: 'unknown-option' })
  assert.equal(calls.length, 0)
  const noAgent = { ...FULL_PROJECT, fields: { Status: FULL_PROJECT.fields.Status } }
  ;({ github, calls } = gh({ routes: { UpdateItemSelect: OK_UPDATE } }))
  await github.setStatus(noAgent, TEAM, 'PVTI_1', { status: 'Todo', agent: '@a' })
  assert.deepEqual(ops(calls), ['UpdateItemSelect'])
  ;({ github } = gh())
  await assert.rejects(github.setStatus({ ...FULL_PROJECT, fields: {} }, TEAM, 'i', { status: 'Todo' }), { code: 'unknown-field' })
})

// --- policy / repo / PR / labels -------------------------------------------

test('readPolicyFile: commit at timestamp, then blob at oid:path', async () => {
  const { github, calls } = gh({ routes: { PolicyCommit: fixture('gh-policy-commit'), PolicyBlob: fixture('gh-policy-blob') } })
  const r = await github.readPolicyFile({ repo: 'acme/policy', path: '.inactivity/team.json', until: new Date('2026-11-19T05:00:00Z') })
  assert.deepEqual(r, { text: '{"v":1}\n', oid: 'abc123', committedDate: '2026-11-10T09:00:00Z' })
  assert.deepEqual(calls[0].body.variables, { owner: 'acme', name: 'policy', path: '.inactivity/team.json', until: '2026-11-19T05:00:00.000Z' })
  assert.equal(calls[1].body.variables.expression, 'abc123:.inactivity/team.json')
})

test('readPolicyFile: no commit or no blob gives null; unknown repo is not-found', async () => {
  let { github } = gh({ routes: { PolicyCommit: fixture('gh-policy-commit-none') } })
  assert.equal(await github.readPolicyFile({ repo: 'a/b', path: 'p', until: '2026-01-01T00:00:00Z' }), null)
  ;({ github } = gh({ routes: { PolicyCommit: fixture('gh-policy-commit'), PolicyBlob: { data: { repository: { object: null } } } } }))
  assert.equal(await github.readPolicyFile({ repo: 'a/b', path: 'p', until: '2026-01-01T00:00:00Z' }), null)
  ;({ github } = gh({ routes: { PolicyCommit: { data: { repository: null } } } }))
  await assert.rejects(github.readPolicyFile({ repo: 'a/b', path: 'p', until: 'x' }), { code: 'not-found' })
  await assert.rejects(github.readPolicyFile({ repo: 'bad', path: 'p', until: 'x' }), GithubError)
})

test('repoInfo and createPullRequest', async () => {
  const { github, calls } = gh({ routes: { RepoInfo: fixture('gh-repo-info'), CreatePullRequest: fixture('gh-create-pr') } })
  assert.deepEqual(await github.repoInfo('acme/app'), { id: 'R_1', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/app.git', isPrivate: true, visibility: 'PRIVATE' })
  const pr = await github.createPullRequest({ repo: 'acme/app', base: 'main', head: 'inactivity/alice/1-x', title: 'T', body: 'B', draft: true })
  assert.deepEqual(pr, { url: 'https://github.com/acme/app/pull/12', number: 12, nodeId: 'PR_1' })
  const v = calls.at(-1).body.variables
  assert.deepEqual(v, { repositoryId: 'R_1', base: 'main', head: 'inactivity/alice/1-x', title: 'T', body: 'B', draft: true })
})

test('addLabels applies known labels only (case-insensitive) and is best effort', async () => {
  let { github, calls } = gh({ routes: { RepoLabels: fixture('gh-labels'), AddLabels: { data: { addLabelsToLabelable: { labelable: { __typename: 'PullRequest' } } } } } })
  assert.deepEqual(await github.addLabels('acme/app', 'PR_1', ['INACTIVITY', 'missing']), ['inactivity'])
  assert.deepEqual(calls.at(-1).body.variables, { labelableId: 'PR_1', labelIds: ['L_1'] })
  ;({ github, calls } = gh({ routes: { RepoLabels: fixture('gh-labels') } }))
  assert.deepEqual(await github.addLabels('acme/app', 'PR_1', ['nothing']), [])
  assert.deepEqual(ops(calls), ['RepoLabels'])
  ;({ github } = gh({ routes: { RepoLabels: { data: null, errors: [{ message: 'boom' }] } } }))
  assert.deepEqual(await github.addLabels('acme/app', 'PR_1', ['x']), [])
  ;({ github } = gh({ http: [response(401, { message: 'Bad credentials' })] }))
  await assert.rejects(github.addLabels('acme/app', 'PR_1', ['x']), { code: 'auth' })
})

// --- error mapping ----------------------------------------------------------

test('GraphQL errors array on HTTP 200 is mapped by type', async () => {
  const cases = [
    [{ type: 'INSUFFICIENT_SCOPES', message: "Your token has not been granted the required scopes: ['read:project']" }, 'scope'],
    [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }, 'scope'],
    [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }, 'not-found'],
    [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }, 'rate-limit'],
    [{ type: 'VALIDATION', message: 'weird' }, 'graphql'],
  ]
  for (const [err, code] of cases) {
    const { github } = gh({ routes: { ViewerLogin: { data: null, errors: [err] } } })
    await assert.rejects(github.viewer(), { code })
  }
  const { github } = gh({ routes: { ViewerLogin: { errors: [{ message: 'x' }] } } })
  await assert.rejects(github.viewer(), { code: 'graphql' })
})

test('HTTP 401 -> auth, 404 -> not-found, 403 plain -> scope, 400 -> graphql', async () => {
  for (const [status, code] of [[401, 'auth'], [404, 'not-found'], [403, 'scope'], [400, 'graphql']]) {
    const { github } = gh({ http: [response(status, { message: 'm' })] })
    await assert.rejects(github.viewer(), { code })
  }
})

test('429 with retry-after sleeps and retries, then succeeds', async () => {
  const { github, sleeps, calls } = gh({
    http: [response(429, { message: 'slow down' }, { 'retry-after': '7' })],
    routes: { ViewerLogin: fixture('gh-viewer') },
  })
  assert.equal((await github.viewer()).login, 'alice')
  assert.deepEqual(sleeps, [7000])
  assert.equal(calls.length, 2)
})

test('403 with x-ratelimit-remaining 0 waits until x-ratelimit-reset', async () => {
  const reset = Math.floor(new Date('2026-11-19T04:00:30Z').getTime() / 1000)
  const { github, sleeps } = gh({
    http: [response(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset })],
    routes: { ViewerLogin: fixture('gh-viewer') },
  })
  await github.viewer()
  assert.deepEqual(sleeps, [31000])
})

test('rate limit: gives up after 3 retries; very long waits fail immediately', async () => {
  const limited = () => response(429, { message: 'x' }, { 'retry-after': '1' })
  let { github, sleeps } = gh({ http: [limited(), limited(), limited(), limited()] })
  await assert.rejects(github.viewer(), { code: 'rate-limit' })
  assert.equal(sleeps.length, 3)
  ;({ github, sleeps } = gh({ http: [response(429, {}, { 'retry-after': '3600' })] }))
  await assert.rejects(github.viewer(), { code: 'rate-limit' })
  assert.equal(sleeps.length, 0)
})

test('5xx retried twice then succeeds; persistent 5xx and fetch failures -> network', async () => {
  let { github, calls } = gh({ http: [response(502, 'bad gateway'), response(503, {})], routes: { ViewerLogin: fixture('gh-viewer') } })
  assert.equal((await github.viewer()).login, 'alice')
  assert.equal(calls.length, 3)
  ;({ github, calls } = gh({ http: [response(500, {}), response(500, {}), response(500, {})] }))
  await assert.rejects(github.viewer(), { code: 'network' })
  assert.equal(calls.length, 3)
  ;({ github } = gh({ http: [new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET')] }))
  await assert.rejects(github.viewer(), { code: 'network' })
})

test('non JSON body on 200 is a graphql error, not a crash', async () => {
  const { github } = gh({ http: [response(200, '<html>oops</html>')] })
  await assert.rejects(github.viewer(), { code: 'graphql' })
})

// --- secrets ----------------------------------------------------------------

test('token never appears in error messages or logs', async () => {
  const { github, logs } = gh({
    http: [response(401, { message: `Bad credentials for ${TOKEN}` })],
  })
  await assert.rejects(github.viewer(), (e) => {
    assert.equal(e.code, 'auth')
    assert.ok(!e.message.includes(TOKEN), 'message leaks token')
    assert.ok(!JSON.stringify(e.details ?? {}).includes(TOKEN))
    return true
  })
  const ctx = gh({ routes: { ViewerLogin: { errors: [{ type: 'X', message: `oops ${TOKEN}` }] } } })
  await assert.rejects(ctx.github.viewer(), (e) => !e.message.includes(TOKEN))
  for (const line of [...logs, ...ctx.logs]) assert.ok(!line.includes(TOKEN))
})

test('createGithub requires a token', () => {
  assert.throws(() => createGithub(makeDeps().deps, { token: '' }), { code: 'no-token' })
})

// --- trust inputs: author type, editor, title renames ------------------------

test('items carry the author type, the last body editor and the last renamer (inputs of the trust whitelist)', async () => {
  const { github, calls } = gh({ routes: { ProjectItem: fixture('gh-item-edited'), IssueComments: fixture('gh-comments-older') } })
  const item = await github.getItem(PROJECT, TEAM, 'PVTI_7')
  assert.equal(item.authorLogin, 'alice')
  assert.equal(item.authorType, 'User')
  assert.equal(item.lastEditedAt, '2026-11-18T11:00:00Z')
  assert.equal(item.editorLogin, 'mallory')
  assert.equal(item.editorType, 'User')
  assert.equal(item.titleEditedAt, '2026-11-18T11:05:00Z')
  assert.equal(item.titleEditorLogin, 'dependabot')
  assert.equal(item.titleEditorType, 'Bot')
  // the query really asks for them
  const q = calls[0].body.query
  assert.match(q, /editor \{ login __typename \}/)
  assert.match(q, /lastEditedAt/)
  assert.match(q, /RENAMED_TITLE_EVENT/)
})

test('an item that was never edited has null editor fields; a missing author stays null', async () => {
  const { github } = gh({ routes: { ProjectItems: [fixture('gh-items-page1'), fixture('gh-items-page2'), fixture('gh-items-page3')] } })
  const { items } = await github.listItems(PROJECT, TEAM)
  for (const i of items) {
    assert.equal(i.lastEditedAt, null)
    assert.equal(i.editorLogin, null)
    assert.equal(i.titleEditedAt, null)
    assert.equal(i.titleEditorLogin, null)
  }
  assert.equal(items[0].authorType, 'User')
})

// --- board exposure: project visibility, repo visibility, teams -------------------

test('resolveProject reads the public flag of the board', async () => {
  let { github } = gh({ routes: { ResolveProjectOrg: fixture('gh-project-org') } })
  let p = await github.resolveProject({ owner: 'acme', number: 3, ownerType: 'organization' })
  assert.equal(p.public, false)
  assert.equal(p.closed, false)
  ;({ github } = gh({ routes: { ResolveProjectOrg: fixture('gh-project-org-public') } }))
  p = await github.resolveProject({ owner: 'acme', number: 3, ownerType: 'organization' })
  assert.equal(p.public, true)
  // old fixture without the flag: unknown, not false
  ;({ github } = gh({ routes: { ResolveProjectUser: fixture('gh-project-user') } }))
  p = await github.resolveProject({ owner: 'alice', number: 1, ownerType: 'user' })
  assert.equal(p.public, null)
})

test('projectAccess lists linked teams and repositories; collaborators are always unknown', async () => {
  const { github, calls } = gh({ routes: { ProjectAccess: fixture('gh-project-access') } })
  const a = await github.projectAccess({ ...PROJECT, public: false })
  assert.equal(a.status, 'ok')
  assert.equal(a.public, false)
  assert.deepEqual(a.teams, [{ slug: 'core', name: 'Core team' }])
  assert.deepEqual(a.repositories.map((r) => [r.repo, r.isPrivate]), [['acme/app', true], ['acme/docs', false]])
  assert.equal(a.collaborators, 'unknown')
  assert.match(a.hint, /Manage access/)
  assert.deepEqual(calls[0].body.variables, { projectId: 'PVT_1' })
})

test('projectAccess degrades to unknown with a hint when the token cannot see it, but auth errors propagate', async () => {
  let { github } = gh({ routes: { ProjectAccess: { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }] } } })
  const a = await github.projectAccess({ ...PROJECT, public: true })
  assert.equal(a.status, 'unknown')
  assert.equal(a.public, true, 'the public flag of resolveProject is kept')
  assert.equal(a.teams, null)
  assert.match(a.hint, /not visible with this token/)
  ;({ github } = gh({ http: [response(401, { message: 'Bad credentials' })] }))
  await assert.rejects(github.projectAccess(PROJECT), { code: 'auth' })
})

test('repoInfo exposes the repository visibility', async () => {
  const { github } = gh({ routes: { RepoInfo: fixture('gh-repo-info-public') } })
  const r = await github.repoInfo('acme/app')
  assert.equal(r.isPrivate, false)
  assert.equal(r.visibility, 'PUBLIC')
})
