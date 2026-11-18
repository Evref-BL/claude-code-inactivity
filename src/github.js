// GitHub access for inactivity: GraphQL over deps.fetch, token from env or `gh auth token`.
// All network goes through deps.fetch, all processes through deps.exec, all waiting through deps.sleep.
// Many GraphQL shapes here are UNVERIFIED against the live API (see docs/design.md 9.9 and 12.1).

import { DispatchError, redact } from './util.js'

/** @typedef {import('./types.js').BoardItem} BoardItem */
/** @typedef {import('./types.js').ProjectInfo} ProjectInfo */
/** @typedef {import('./types.js').Comment} Comment */

export class GithubError extends DispatchError {
  /**
   * @param {string} code auth|scope|not-found|rate-limit|graphql|network (plus unknown-option, unknown-field, item-skipped)
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details) {
    super(code, message, details)
    this.name = 'GithubError'
  }
}

const DEFAULT_API_URL = 'https://api.github.com'
const MAX_RATE_RETRIES = 3
const MAX_SERVER_RETRIES = 2
const MAX_WAIT_MS = 120_000
const COMMENT_PAGE = 100
const COMMENT_PAGES_MAX = 50

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a GitHub token: GH_TOKEN, then GITHUB_TOKEN, then `gh auth token`. `gh` is optional.
 * @param {{env:Record<string,string|undefined>, exec:Function}} deps
 * @returns {Promise<{token:string, source:'GH_TOKEN'|'GITHUB_TOKEN'|'gh'}>}
 */
export async function resolveToken(deps) {
  for (const name of /** @type {const} */ (['GH_TOKEN', 'GITHUB_TOKEN'])) {
    const value = deps.env?.[name]?.trim()
    if (value) return { token: value, source: name }
  }
  try {
    const res = await deps.exec('gh', ['auth', 'token'], { timeoutMs: 15_000 })
    const token = (res.stdout ?? '').trim()
    if (res.code === 0 && token) return { token, source: 'gh' }
  } catch {
    // gh not installed: fall through
  }
  throw new GithubError(
    'no-token',
    'No GitHub token found. Set GH_TOKEN or GITHUB_TOKEN, or run `gh auth login` (gh is optional).'
  )
}

// ---------------------------------------------------------------------------
// GraphQL documents (all named)
// ---------------------------------------------------------------------------

const AUTHOR = 'author { login __typename }'
const COMMENT_FIELDS = `id databaseId ${AUTHOR} createdAt lastEditedAt isMinimized body`
const FIELD_VALUES = `fieldValues(first: 20) { nodes { __typename
  ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { name } } }
  ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
} }`
// editor + lastEditedAt: who last rewrote the body; titleEvents: who last renamed the issue (the trust
// whitelist applies to them too, see trust.js). Shapes are UNVERIFIED against the live API (docs 9.9).
const EDITOR = 'editor { login __typename }'
const TITLE_EVENTS = `titleEvents: timelineItems(last: 1, itemTypes: [RENAMED_TITLE_EVENT]) { nodes { __typename
    ... on RenamedTitleEvent { createdAt actor { login __typename } } } }`
const CONTENT_FIELDS = `id number title body url state updatedAt authorAssociation lastEditedAt
  ${AUTHOR}
  ${EDITOR}
  ${TITLE_EVENTS}
  repository { nameWithOwner }
  labels(first: 30) { nodes { name } }
  comments(last: ${COMMENT_PAGE}) { totalCount pageInfo { hasPreviousPage startCursor } nodes { ${COMMENT_FIELDS} } }`
const ITEM_FIELDS = `fragment ItemFields on ProjectV2Item {
  id type isArchived
  ${FIELD_VALUES}
  content { __typename
    ... on Issue { ${CONTENT_FIELDS} }
    ... on PullRequest { ${CONTENT_FIELDS} }
  }
}`
const PROJECT_FIELDS = `id title public closed
  fields(first: 50) { nodes {
    ... on ProjectV2Field { id name dataType }
    ... on ProjectV2IterationField { id name dataType }
    ... on ProjectV2SingleSelectField { id name dataType options { id name } }
  } }`

export const QUERIES = {
  ViewerLogin: 'query ViewerLogin { viewer { login databaseId } }',
  ResolveProjectOrg: `query ResolveProjectOrg($owner: String!, $number: Int!) {
  organization(login: $owner) { projectV2(number: $number) { ${PROJECT_FIELDS} } } }`,
  ResolveProjectUser: `query ResolveProjectUser($owner: String!, $number: Int!) {
  user(login: $owner) { projectV2(number: $number) { ${PROJECT_FIELDS} } } }`,
  ProjectItems: `query ProjectItems($projectId: ID!, $cursor: String) {
  node(id: $projectId) { ... on ProjectV2 {
    items(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ...ItemFields } } } } }
${ITEM_FIELDS}`,
  ProjectItem: `query ProjectItem($itemId: ID!) { node(id: $itemId) { ... on ProjectV2Item { ...ItemFields } } }
${ITEM_FIELDS}`,
  IssueComments: `query IssueComments($id: ID!, $before: String) {
  node(id: $id) {
    ... on Issue { comments(last: ${COMMENT_PAGE}, before: $before) { totalCount pageInfo { hasPreviousPage startCursor } nodes { ${COMMENT_FIELDS} } } }
    ... on PullRequest { comments(last: ${COMMENT_PAGE}, before: $before) { totalCount pageInfo { hasPreviousPage startCursor } nodes { ${COMMENT_FIELDS} } } }
  } }`,
  PolicyCommit: `query PolicyCommit($owner: String!, $name: String!, $path: String!, $until: GitTimestamp!) {
  repository(owner: $owner, name: $name) { defaultBranchRef { target { ... on Commit {
    history(first: 1, until: $until, path: $path) { nodes { oid committedDate } } } } } } }`,
  PolicyBlob: `query PolicyBlob($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) { object(expression: $expression) { ... on Blob { text isTruncated isBinary } } } }`,
  RepoInfo: `query RepoInfo($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id url isPrivate visibility defaultBranchRef { name } } }`,
  ProjectAccess: `query ProjectAccess($projectId: ID!) {
  node(id: $projectId) { ... on ProjectV2 { public closed
    owner { __typename ... on Organization { login } ... on User { login } }
    teams(first: 50) { nodes { slug name } }
    repositories(first: 50) { nodes { nameWithOwner isPrivate visibility } } } } }`,
  AddComment: `mutation AddComment($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) { commentEdge { node { ${COMMENT_FIELDS} } } } }`,
  UpdateItemSelect: `mutation UpdateItemSelect($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) { projectV2Item { id } } }`,
  UpdateItemText: `mutation UpdateItemText($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { text: $text } }) { projectV2Item { id } } }`,
  CreatePullRequest: `mutation CreatePullRequest($repositoryId: ID!, $base: String!, $head: String!, $title: String!, $body: String!, $draft: Boolean!) {
  createPullRequest(input: { repositoryId: $repositoryId, baseRefName: $base, headRefName: $head, title: $title, body: $body, draft: $draft }) { pullRequest { id number url } } }`,
  RepoLabels: `query RepoLabels($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) { labels(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id name } } } }`,
  AddLabels: `mutation AddLabels($labelableId: ID!, $labelIds: [ID!]!) {
  addLabelsToLabelable(input: { labelableId: $labelableId, labelIds: $labelIds }) { labelable { __typename } } }`,
}

// ---------------------------------------------------------------------------
// Pure extraction helpers
// ---------------------------------------------------------------------------

/** @param {string} repo @returns {{owner:string, name:string}} */
function splitRepo(repo) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(repo ?? '')
  if (!m) throw new GithubError('graphql', `Invalid repository "${repo}" (expected owner/repo)`)
  return { owner: m[1], name: m[2] }
}

/** @param {any} node @returns {Comment} */
export function normalizeComment(node) {
  const a = node.author
  return {
    id: node.id,
    databaseId: node.databaseId,
    author: a ? { login: a.login, type: a.__typename ?? 'User' } : null,
    createdAt: node.createdAt,
    lastEditedAt: node.lastEditedAt ?? null,
    isMinimized: Boolean(node.isMinimized),
    body: node.body ?? '',
  }
}

/**
 * Extract Priority/Difficulty/Status/Agent field values from `fieldValues.nodes`.
 * Field names come from team.fields (case-insensitive match).
 * @param {any[]} nodes
 * @param {any} [team]
 */
export function extractFields(nodes, team) {
  const names = {
    priority: team?.fields?.priority ?? 'Priority',
    difficulty: team?.fields?.difficulty ?? 'Difficulty',
    status: team?.fields?.status ?? 'Status',
    agent: team?.fields?.agent ?? 'Agent',
  }
  const byName = new Map()
  for (const n of nodes ?? []) {
    if (!n || !n.field?.name) continue
    let value = null
    if (n.__typename === 'ProjectV2ItemFieldSingleSelectValue') value = n.name ?? null
    else if (n.__typename === 'ProjectV2ItemFieldTextValue') value = n.text ?? null
    else continue
    byName.set(String(n.field.name).toLowerCase(), value)
  }
  const get = (name) => byName.get(String(name).toLowerCase()) ?? null
  return {
    priority: get(names.priority),
    difficulty: get(names.difficulty),
    status: get(names.status),
    agent: get(names.agent),
  }
}

/**
 * Convert a ProjectV2Item node to a BoardItem or a skip reason.
 * @param {any} node
 * @param {any} [team]
 * @returns {{item:BoardItem}|{skipped:{itemId:string, reason:string}}}
 */
export function toBoardItem(node, team) {
  const itemId = node?.id
  const content = node?.content
  if (node?.type === 'REDACTED' || !content) {
    return { skipped: { itemId, reason: node?.type === 'DRAFT_ISSUE' ? 'draft-issue' : 'redacted' } }
  }
  if (node.isArchived) return { skipped: { itemId, reason: 'archived' } }
  if (node.type === 'DRAFT_ISSUE' || content.__typename === 'DraftIssue') {
    return { skipped: { itemId, reason: 'draft-issue' } }
  }
  const isPr = content.__typename === 'PullRequest'
  if (!isPr && content.__typename !== 'Issue') return { skipped: { itemId, reason: 'redacted' } }
  if (isPr && !team?.includePullRequests) return { skipped: { itemId, reason: 'pull-request' } }
  const repo = content.repository?.nameWithOwner
  if (!repo) return { skipped: { itemId, reason: 'redacted' } }
  const comments = (content.comments?.nodes ?? []).filter(Boolean).map(normalizeComment)
  const total = content.comments?.totalCount ?? comments.length
  const titleEvent = (content.titleEvents?.nodes ?? []).filter(Boolean).at(-1) ?? null
  return {
    item: {
      itemId,
      issueNodeId: content.id,
      id: `${repo}#${content.number}`,
      repo,
      number: content.number,
      title: content.title ?? '',
      body: content.body ?? '',
      url: content.url ?? '',
      contentType: isPr ? 'PullRequest' : 'Issue',
      state: content.state,
      authorLogin: content.author?.login ?? null,
      authorType: content.author ? (content.author.__typename ?? 'User') : null,
      authorAssociation: content.authorAssociation ?? 'NONE',
      lastEditedAt: content.lastEditedAt ?? null,
      editorLogin: content.editor?.login ?? null,
      editorType: content.editor ? (content.editor.__typename ?? 'User') : null,
      titleEditedAt: titleEvent?.createdAt ?? null,
      titleEditorLogin: titleEvent ? (titleEvent.actor?.login ?? null) : null,
      titleEditorType: titleEvent?.actor ? (titleEvent.actor.__typename ?? 'User') : null,
      labels: (content.labels?.nodes ?? []).filter(Boolean).map((l) => l.name),
      fields: extractFields(node.fieldValues?.nodes, team),
      comments,
      commentsComplete: total <= comments.length,
      updatedAt: content.updatedAt ?? '',
    },
  }
}

/** Case-insensitive lookup in a record, exact key first. */
function lookup(record, name) {
  if (!record || name == null) return undefined
  if (Object.hasOwn(record, name)) return record[name]
  const lower = String(name).toLowerCase()
  for (const k of Object.keys(record)) if (k.toLowerCase() === lower) return record[k]
  return undefined
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * @param {import('./types.js').Deps|any} deps
 * @param {{token:string, apiUrl?:string}} options
 */
export function createGithub(deps, { token, apiUrl }) {
  if (!token) throw new GithubError('no-token', 'createGithub requires a token')
  const base = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  // GHES: https://host/api/v3 -> GraphQL at https://host/api/graphql
  const graphqlUrl = /\/api\/v3$/.test(base) ? base.replace(/\/v3$/, '/graphql') : `${base}/graphql`
  const secrets = [token]
  const clean = (text) => redact(String(text ?? ''), secrets)

  const headers = () => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'inactivity',
  })

  /** Seconds to wait from rate limit headers, or null. */
  function waitMs(res) {
    const retryAfter = res.headers?.get?.('retry-after')
    if (retryAfter != null && retryAfter !== '' && Number.isFinite(Number(retryAfter))) {
      return Math.max(0, Number(retryAfter)) * 1000
    }
    const reset = res.headers?.get?.('x-ratelimit-reset')
    if (reset != null && Number.isFinite(Number(reset))) {
      return Math.max(1000, Number(reset) * 1000 - deps.now().getTime() + 1000)
    }
    return 60_000
  }

  async function readJson(res) {
    let text = ''
    try {
      text = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json())
    } catch {
      return null
    }
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return { __raw: text }
    }
  }

  /**
   * One HTTP exchange with retry policy. Returns {res, json}.
   * @param {string} url
   * @param {object} init
   * @param {string} label for messages
   */
  async function send(url, init, label) {
    let rateRetries = 0
    let serverRetries = 0
    for (;;) {
      let res
      try {
        res = await deps.fetch(url, init)
      } catch (error) {
        if (serverRetries < MAX_SERVER_RETRIES) {
          serverRetries++
          await deps.sleep(500 * serverRetries)
          continue
        }
        throw new GithubError('network', `${label}: network error: ${clean(error?.message ?? error)}`)
      }
      const status = res.status
      if (status >= 200 && status < 300) return { res, json: await readJson(res) }
      const json = await readJson(res)
      const msg = clean(json?.message ?? json?.__raw ?? `HTTP ${status}`).slice(0, 300)
      if (status === 401) throw new GithubError('auth', `${label}: GitHub rejected the token (401): ${msg}`, { status })
      const remaining = res.headers?.get?.('x-ratelimit-remaining')
      const limited =
        status === 429 ||
        (status === 403 &&
          (res.headers?.get?.('retry-after') != null || remaining === '0' || /rate limit/i.test(json?.message ?? '')))
      if (limited) {
        const ms = waitMs(res)
        if (rateRetries >= MAX_RATE_RETRIES || ms > MAX_WAIT_MS) {
          throw new GithubError('rate-limit', `${label}: GitHub rate limit reached (HTTP ${status})`, {
            status,
            retryAfterMs: ms,
          })
        }
        rateRetries++
        deps.log?.warn?.(`github: rate limited on ${label}, waiting ${Math.round(ms / 1000)}s`)
        await deps.sleep(ms)
        continue
      }
      if (status === 403) throw new GithubError('scope', `${label}: forbidden (403): ${msg}`, { status })
      if (status === 404) throw new GithubError('not-found', `${label}: not found (404): ${msg}`, { status })
      if (status >= 500) {
        if (serverRetries < MAX_SERVER_RETRIES) {
          serverRetries++
          await deps.sleep(500 * serverRetries)
          continue
        }
        throw new GithubError('network', `${label}: GitHub server error (HTTP ${status})`, { status })
      }
      throw new GithubError('graphql', `${label}: HTTP ${status}: ${msg}`, { status })
    }
  }

  /** @param {any[]} errors */
  function mapGraphqlErrors(errors, label) {
    const first = errors[0] ?? {}
    const message = clean(errors.map((e) => e.message).join('; ')).slice(0, 500)
    const types = errors.map((e) => String(e.type ?? '').toUpperCase())
    let code = 'graphql'
    if (types.includes('RATE_LIMITED') || types.includes('RATE_LIMIT')) code = 'rate-limit'
    else if (types.includes('INSUFFICIENT_SCOPES') || types.includes('FORBIDDEN') || /scope|resource not accessible/i.test(message)) code = 'scope'
    else if (types.includes('NOT_FOUND') || /could not resolve to/i.test(message)) code = 'not-found'
    return new GithubError(code, `${label}: ${message}`, { type: first.type ?? null, path: first.path ?? null })
  }

  /**
   * Run a named GraphQL document. Throws GithubError on any failure; `data` otherwise.
   * @param {keyof typeof QUERIES} operationName
   * @param {Record<string, unknown>} [variables]
   */
  async function gql(operationName, variables = {}) {
    deps.log?.debug?.(`github: ${operationName}`)
    const { json } = await send(
      graphqlUrl,
      { method: 'POST', headers: headers(), body: JSON.stringify({ operationName, query: QUERIES[operationName], variables }) },
      operationName
    )
    if (Array.isArray(json?.errors) && json.errors.length) throw mapGraphqlErrors(json.errors, operationName)
    if (!json || typeof json.data !== 'object' || json.data === null) {
      throw new GithubError('graphql', `${operationName}: response without data`)
    }
    return json.data
  }

  /** Fetch earlier comment pages (newest first) and prepend them. */
  async function allComments(issueNodeId, firstComments, pageInfo) {
    let comments = firstComments
    let cursor = pageInfo?.hasPreviousPage ? pageInfo.startCursor : null
    for (let i = 0; cursor && i < COMMENT_PAGES_MAX; i++) {
      const data = await gql('IssueComments', { id: issueNodeId, before: cursor })
      const conn = data.node?.comments
      if (!conn) break
      comments = [...(conn.nodes ?? []).filter(Boolean).map(normalizeComment), ...comments]
      cursor = conn.pageInfo?.hasPreviousPage ? conn.pageInfo.startCursor : null
    }
    return comments
  }

  return {
    /** @returns {Promise<{login:string, databaseId:number}>} */
    async viewer() {
      const data = await gql('ViewerLogin')
      if (!data.viewer?.login) throw new GithubError('auth', 'ViewerLogin: no viewer returned')
      return { login: data.viewer.login, databaseId: data.viewer.databaseId }
    },

    /** Classic PAT scopes from x-oauth-scopes; null when the header is absent (fine-grained token). */
    async scopes() {
      const { res } = await send(`${base}/user`, { method: 'GET', headers: headers() }, 'GET /user')
      const header = res.headers?.get?.('x-oauth-scopes')
      if (header == null) return null
      return header.split(',').map((s) => s.trim()).filter(Boolean)
    },

    /**
     * @param {{owner:string, number:number, ownerType?:'organization'|'user'|null}} spec
     * @returns {Promise<ProjectInfo>}
     */
    async resolveProject({ owner, number, ownerType = null }) {
      const order = ownerType === 'organization' ? ['organization'] : ownerType === 'user' ? ['user'] : ['organization', 'user']
      let lastError = null
      for (const type of order) {
        try {
          const data = await gql(type === 'organization' ? 'ResolveProjectOrg' : 'ResolveProjectUser', { owner, number })
          const project = data[type]?.projectV2
          if (!project) {
            lastError = new GithubError('not-found', `Project ${owner}#${number} not found as ${type}`)
            continue
          }
          /** @type {ProjectInfo['fields']} */
          const fields = {}
          for (const f of project.fields?.nodes ?? []) {
            if (!f || !f.name) continue
            fields[f.name] = { id: f.id, dataType: f.dataType }
            if (f.options) fields[f.name].options = Object.fromEntries(f.options.map((o) => [o.name, o.id]))
          }
          return { id: project.id, title: project.title, ownerType: type, public: typeof project.public === 'boolean' ? project.public : null, closed: typeof project.closed === 'boolean' ? project.closed : null, fields }
        } catch (error) {
          if (error instanceof GithubError && error.code === 'not-found') {
            lastError = error
            continue
          }
          throw error
        }
      }
      throw new GithubError(
        'not-found',
        `GitHub project ${owner}#${number} not found (tried ${order.join(', ')}); check owner, number and token access${lastError ? ` (${lastError.message})` : ''}`
      )
    },

    /**
     * @param {ProjectInfo} project
     * @param {any} team
     * @returns {Promise<{items:BoardItem[], skipped:{itemId:string, reason:string}[]}>}
     */
    async listItems(project, team) {
      const items = []
      const skipped = []
      let cursor = null
      for (let page = 0; page < 200; page++) {
        const data = await gql('ProjectItems', { projectId: project.id, cursor })
        const conn = data.node?.items
        if (!conn) throw new GithubError('not-found', `Project ${project.id} has no items connection`)
        for (const node of conn.nodes ?? []) {
          if (!node) continue
          const r = toBoardItem(node, team)
          if ('item' in r) items.push(r.item)
          else skipped.push(r.skipped)
        }
        if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break
        cursor = conn.pageInfo.endCursor
      }
      return { items, skipped }
    },

    /**
     * Fresh item with all comment pages.
     * @param {ProjectInfo} _project
     * @param {any} team
     * @param {string} itemId
     * @returns {Promise<BoardItem>}
     */
    async getItem(_project, team, itemId) {
      const data = await gql('ProjectItem', { itemId })
      const node = data.node
      if (!node) throw new GithubError('not-found', `Project item ${itemId} not found`)
      const r = toBoardItem(node, team)
      if (!('item' in r)) throw new GithubError('item-skipped', `Project item ${itemId} is not executable (${r.skipped.reason})`)
      const item = r.item
      if (!item.commentsComplete) {
        const pageInfo = node.content?.comments?.pageInfo
        item.comments = await allComments(item.issueNodeId, item.comments, pageInfo)
        item.commentsComplete = true
      }
      return item
    },

    /**
     * Policy file content at the last default-branch commit touching `path` with committedDate <= until.
     * Returns the commit oid (not the blob oid).
     * @param {{repo:string, path:string, until:string|Date}} spec
     * @returns {Promise<{text:string, oid:string, committedDate:string}|null>}
     */
    async readPolicyFile({ repo, path, until }) {
      const { owner, name } = splitRepo(repo)
      const ts = until instanceof Date ? until.toISOString() : String(until)
      const data = await gql('PolicyCommit', { owner, name, path, until: ts })
      if (!data.repository) throw new GithubError('not-found', `Repository ${repo} not found`)
      const commit = data.repository.defaultBranchRef?.target?.history?.nodes?.[0]
      if (!commit) return null
      const blob = await gql('PolicyBlob', { owner, name, expression: `${commit.oid}:${path}` })
      const obj = blob.repository?.object
      if (!obj || typeof obj.text !== 'string' || obj.isBinary) return null
      if (obj.isTruncated) throw new GithubError('graphql', `Policy file ${repo}:${path} is truncated by the API`)
      return { text: obj.text, oid: commit.oid, committedDate: commit.committedDate }
    },

    /** @returns {Promise<{id:string, defaultBranch:string, cloneUrl:string}>} */
    async repoInfo(repo) {
      const { owner, name } = splitRepo(repo)
      const data = await gql('RepoInfo', { owner, name })
      const r = data.repository
      if (!r) throw new GithubError('not-found', `Repository ${repo} not found`)
      return {
        id: r.id,
        defaultBranch: r.defaultBranchRef?.name ?? null,
        cloneUrl: `${String(r.url).replace(/\/+$/, '')}.git`,
        isPrivate: typeof r.isPrivate === 'boolean' ? r.isPrivate : null,
        visibility: r.visibility ?? null,
      }
    },

    /**
     * Who can see the board, best effort (docs/design.md 4.7). `public` comes from the project itself; the
     * linked teams and repositories come from a separate query that is allowed to fail: the GraphQL API
     * does not expose the project's direct collaborators at all (only a mutation), so that list is always
     * 'unknown' and the human has to read Project > Settings > Manage access (docs/board-lockdown.md).
     * @param {ProjectInfo} project
     * @returns {Promise<{public:boolean|null, teams:{slug:string,name:string}[]|null, repositories:{repo:string,isPrivate:boolean|null,visibility:string|null}[]|null, collaborators:'unknown', status:'ok'|'unknown', hint:string|null}>}
     */
    async projectAccess(project) {
      const out = { public: typeof project.public === 'boolean' ? project.public : null, teams: null, repositories: null, collaborators: 'unknown', status: 'unknown', hint: null }
      try {
        const data = await gql('ProjectAccess', { projectId: project.id })
        const node = data.node
        if (!node) throw new GithubError('not-found', 'ProjectAccess: project not returned')
        if (typeof node.public === 'boolean') out.public = node.public
        out.teams = (node.teams?.nodes ?? []).filter(Boolean).map((t) => ({ slug: t.slug, name: t.name }))
        out.repositories = (node.repositories?.nodes ?? []).filter(Boolean).map((r) => ({ repo: r.nameWithOwner, isPrivate: typeof r.isPrivate === 'boolean' ? r.isPrivate : null, visibility: r.visibility ?? null }))
        out.status = 'ok'
        out.hint = 'Direct collaborators of the board are not readable through the API: review Project > Settings > Manage access by hand.'
      } catch (error) {
        if (error instanceof GithubError && error.code === 'auth') throw error
        out.hint = `Teams and linked repositories are not visible with this token (${clean(error?.message).slice(0, 160)}). Review Project > Settings > Manage access by hand.`
      }
      return out
    },

    /** @returns {Promise<Comment>} */
    async postComment(issueNodeId, body) {
      const data = await gql('AddComment', { subjectId: issueNodeId, body })
      const node = data.addComment?.commentEdge?.node
      if (!node) throw new GithubError('graphql', 'AddComment: response without comment node')
      return normalizeComment(node)
    },

    /**
     * Set Status and/or Agent. Resolves field/option ids from the ProjectInfo before any mutation.
     * Agent is skipped when the project has no such field.
     * @param {ProjectInfo} project
     * @param {any} team
     * @param {string} itemId
     * @param {{status?:string, agent?:string|null}} change
     * @returns {Promise<void>}
     */
    async setStatus(project, team, itemId, { status, agent } = {}) {
      const names = { status: team?.fields?.status ?? 'Status', agent: team?.fields?.agent ?? 'Agent' }
      const ops = []
      if (status !== undefined) {
        const field = lookup(project.fields, names.status)
        if (!field) throw new GithubError('unknown-field', `Project has no field "${names.status}"`)
        const optionId = lookup(field.options, status)
        if (!optionId) {
          throw new GithubError(
            'unknown-option',
            `Field "${names.status}" has no option "${status}" (available: ${Object.keys(field.options ?? {}).join(', ') || 'none'})`
          )
        }
        ops.push(['UpdateItemSelect', { projectId: project.id, itemId, fieldId: field.id, optionId }])
      }
      if (agent !== undefined) {
        const field = lookup(project.fields, names.agent)
        if (field) ops.push(['UpdateItemText', { projectId: project.id, itemId, fieldId: field.id, text: agent ?? '' }])
        else deps.log?.debug?.(`github: no "${names.agent}" field, agent update skipped`)
      }
      for (const [op, vars] of ops) await gql(op, vars)
    },

    /** @returns {Promise<{url:string, number:number, nodeId:string}>} */
    async createPullRequest({ repo, base, head, title, body, draft = true }) {
      const info = await this.repoInfo(repo)
      const data = await gql('CreatePullRequest', { repositoryId: info.id, base, head, title, body, draft })
      const pr = data.createPullRequest?.pullRequest
      if (!pr) throw new GithubError('graphql', 'CreatePullRequest: response without pull request')
      return { url: pr.url, number: pr.number, nodeId: pr.id }
    },

    /**
     * Best effort: unknown labels are ignored; only auth errors propagate.
     * @returns {Promise<string[]>} names applied
     */
    async addLabels(repo, nodeId, names) {
      try {
        const { owner, name } = splitRepo(repo)
        const known = new Map()
        let cursor = null
        for (let i = 0; i < 10; i++) {
          const data = await gql('RepoLabels', { owner, name, cursor })
          const conn = data.repository?.labels
          for (const l of conn?.nodes ?? []) if (l) known.set(l.name.toLowerCase(), l)
          if (!conn?.pageInfo?.hasNextPage) break
          cursor = conn.pageInfo.endCursor
        }
        const wanted = names.map((n) => known.get(String(n).toLowerCase())).filter(Boolean)
        const unique = [...new Map(wanted.map((l) => [l.id, l])).values()]
        if (!unique.length) return []
        await gql('AddLabels', { labelableId: nodeId, labelIds: unique.map((l) => l.id) })
        return unique.map((l) => l.name)
      } catch (error) {
        if (error instanceof GithubError && error.code === 'auth') throw error
        deps.log?.warn?.(`github: addLabels ignored: ${clean(error?.message)}`)
        return []
      }
    },
  }
}
