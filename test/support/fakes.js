// Test doubles shared by the integration tests (docs/design.md 11.1).
// Nothing here touches the network, `gh`, a real `claude` or a Pharo image.
// Git is the one real thing: tests run it against local temp repositories.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { realExec } from '../../src/deps.js';

/** Memory clock shared by every simulated machine and by the fake GitHub server. */
export function memClock(startIso) {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    set(iso) { ms = Date.parse(iso); },
    advance(delta) { ms += delta; },
    iso: () => new Date(ms).toISOString(),
  };
}

/** Real temp directories removed by `cleanup()`. */
export function tmpDirs() {
  const dirs = [];
  return {
    async make(prefix = 'pd-') {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    async cleanup() {
      for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
    },
  };
}

function response(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return { status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, text: async () => text, json: async () => JSON.parse(text) };
}

const STATUS_OPTIONS = ['Todo', 'Claimed', 'In progress', 'In review', 'Blocked', 'Done'];

/**
 * A stateful in-memory GitHub: one org project board, issues with comments, a policy repo,
 * pull requests. Routes by GraphQL `operationName`; the viewer is chosen by bearer token.
 * @param {{clock:{now:()=>Date}, tokens:Record<string,string>, owner?:string, number?:number}} opts
 */
export function fakeGithub({ clock, tokens, owner = 'acme', number = 7 }) {
  const project = { id: 'PVT_1', title: 'Backlog', owner, number };
  const fields = {
    Status: { id: 'F_STATUS', dataType: 'SINGLE_SELECT', options: Object.fromEntries(STATUS_OPTIONS.map((n, i) => [n, `OS${i}`])) },
    Priority: { id: 'F_PRIO', dataType: 'SINGLE_SELECT', options: { P0: 'OP0', P1: 'OP1', P2: 'OP2', P3: 'OP3' } },
    Difficulty: { id: 'F_DIFF', dataType: 'SINGLE_SELECT', options: { easy: 'OD0', medium: 'OD1', hard: 'OD2' } },
    Agent: { id: 'F_AGENT', dataType: 'TEXT' },
  };
  const items = [];
  const repos = new Map();
  const policyHistory = [];
  const gh = {
    project, fields, items, repos, policyHistory,
    nextId: 5000,
    calls: [],            // every request: {op, login}
    mutations: [],        // every mutation: {op, variables, login}
    pullRequests: [],
    failNext: [],         // queue of {status, headers, body} returned instead of routing
    comments: (id) => items.find((i) => i.id === id)?.comments ?? [],
  };

  /** Add a repo (id, default branch). */
  gh.addRepo = (nameWithOwner, defaultBranch = 'main') => {
    repos.set(nameWithOwner, { id: `R_${nameWithOwner}`, defaultBranch, url: `https://github.com/${nameWithOwner}` });
  };

  /** Add an issue to the board. */
  gh.addIssue = ({ repo, num, title, body = 'Please fix.', status = 'Todo', priority = 'P2', difficulty = 'medium', author = 'owner', association = 'MEMBER', labels = [] }) => {
    const id = `${repo}#${num}`;
    items.push({
      id, itemId: `PVTI_${num}`, issueNodeId: `I_${num}`, repo, number: num, title, body, state: 'OPEN', author, association, labels,
      fields: { Status: status, Priority: priority, Difficulty: difficulty, Agent: null }, comments: [],
    });
    return id;
  };

  /** Someone edits an issue (body and/or title): the board then reports the editor, as GitHub does. */
  gh.edit = (id, { editor, body, title, renamedBy }) => {
    const it = items.find((i) => i.id === id);
    if (body !== undefined) { it.body = body; it.lastEditedAt = clock.now().toISOString(); it.editor = editor; }
    if (title !== undefined) { it.title = title; it.titleEditor = renamedBy ?? editor; it.titleEditedAt = clock.now().toISOString(); }
  };

  gh.setPolicy = (text, committedDate) => {
    policyHistory.push({ oid: `c${policyHistory.length + 1}`.padEnd(8, '0'), committedDate, text });
  };

  const login = (init) => {
    const m = /^Bearer (.+)$/.exec(init.headers?.Authorization ?? '');
    return m ? tokens[m[1]] ?? null : null;
  };

  const commentNode = (c) => ({
    id: c.id, databaseId: c.databaseId, author: c.author ? { login: c.author, __typename: 'User' } : null,
    createdAt: c.createdAt, lastEditedAt: c.lastEditedAt ?? null, isMinimized: Boolean(c.isMinimized), body: c.body,
  });

  const itemNode = (it) => ({
    id: it.itemId, type: 'ISSUE', isArchived: false,
    fieldValues: {
      nodes: Object.entries(it.fields).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([name, value]) => (
        fields[name].dataType === 'TEXT'
          ? { __typename: 'ProjectV2ItemFieldTextValue', text: value, field: { name } }
          : { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: value, optionId: fields[name].options[value], field: { name } })),
    },
    content: {
      __typename: 'Issue', id: it.issueNodeId, number: it.number, title: it.title, body: it.body, url: `https://github.com/${it.repo}/issues/${it.number}`,
      state: it.state, updatedAt: clock.now().toISOString(), authorAssociation: it.association,
      lastEditedAt: it.lastEditedAt ?? null, editor: it.editor ? { login: it.editor, __typename: it.editorType ?? 'User' } : null,
      titleEvents: { nodes: it.titleEditor ? [{ __typename: 'RenamedTitleEvent', createdAt: it.titleEditedAt ?? clock.now().toISOString(), actor: { login: it.titleEditor, __typename: 'User' } }] : [] },
      author: { login: it.author, __typename: it.authorType ?? 'User' }, repository: { nameWithOwner: it.repo },
      labels: { nodes: it.labels.map((name) => ({ name })) },
      comments: { totalCount: it.comments.length, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: it.comments.map(commentNode) },
    },
  });

  const route = {
    ViewerLogin: (v, who) => ({ viewer: { login: who, databaseId: 1 } }),
    ResolveProjectOrg: () => ({
      organization: {
        projectV2: {
          id: project.id, title: project.title,
          fields: { nodes: Object.entries(fields).map(([name, f]) => ({ id: f.id, name, dataType: f.dataType, ...(f.options ? { options: Object.entries(f.options).map(([n, id]) => ({ id, name: n })) } : {}) })) },
        },
      },
    }),
    ResolveProjectUser: () => ({ user: { projectV2: null } }),
    ProjectItems: () => ({ node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: items.map(itemNode) } } }),
    ProjectItem: (v) => ({ node: itemNode(items.find((i) => i.itemId === v.itemId)) }),
    IssueComments: () => ({ node: { comments: { totalCount: 0, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] } } }),
    PolicyCommit: (v) => {
      const eligible = policyHistory.filter((p) => Date.parse(p.committedDate) <= Date.parse(v.until));
      const last = eligible.at(-1);
      return { repository: { defaultBranchRef: { target: { history: { nodes: last ? [{ oid: last.oid, committedDate: last.committedDate }] : [] } } } } };
    },
    PolicyBlob: (v) => {
      const oid = v.expression.split(':')[0];
      const p = policyHistory.find((x) => x.oid === oid);
      return { repository: { object: p ? { text: p.text, isTruncated: false, isBinary: false } : null } };
    },
    RepoInfo: (v) => {
      const r = repos.get(`${v.owner}/${v.name}`);
      return { repository: r ? { id: r.id, url: r.url, defaultBranchRef: { name: r.defaultBranch } } : null };
    },
    AddComment: (v, who) => {
      const it = items.find((i) => i.issueNodeId === v.subjectId);
      const c = { id: `IC_${gh.nextId}`, databaseId: gh.nextId, author: who, createdAt: clock.now().toISOString(), lastEditedAt: null, isMinimized: false, body: v.body };
      gh.nextId += 1;
      it.comments.push(c);
      return { addComment: { commentEdge: { node: commentNode(c) } } };
    },
    UpdateItemSelect: (v) => {
      const it = items.find((i) => i.itemId === v.itemId);
      const [name, f] = Object.entries(fields).find(([, x]) => x.id === v.fieldId);
      const option = Object.entries(f.options).find(([, id]) => id === v.optionId)[0];
      it.fields[name] = option;
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: it.itemId } } };
    },
    UpdateItemText: (v) => {
      const it = items.find((i) => i.itemId === v.itemId);
      const [name] = Object.entries(fields).find(([, x]) => x.id === v.fieldId);
      it.fields[name] = v.text;
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: it.itemId } } };
    },
    CreatePullRequest: (v, who) => {
      const repo = [...repos.entries()].find(([, r]) => r.id === v.repositoryId)[0];
      const n = gh.pullRequests.length + 100;
      const pr = { id: `PR_${n}`, number: n, url: `https://github.com/${repo}/pull/${n}`, repo, base: v.base, head: v.head, title: v.title, body: v.body, draft: v.draft, author: who, labels: [] };
      gh.pullRequests.push(pr);
      return { createPullRequest: { pullRequest: { id: pr.id, number: pr.number, url: pr.url } } };
    },
    RepoLabels: () => ({ repository: { labels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'L1', name: 'inactivity' }, { id: 'L2', name: 'inactivity:needs-human' }] } } }),
    AddLabels: (v) => {
      const pr = gh.pullRequests.find((p) => p.id === v.labelableId);
      if (pr) pr.labels.push(...v.labelIds);
      return { addLabelsToLabelable: { labelable: { __typename: 'PullRequest' } } };
    },
  };
  const MUTATIONS = new Set(['AddComment', 'UpdateItemSelect', 'UpdateItemText', 'CreatePullRequest', 'AddLabels']);

  /** `deps.fetch` for api.github.com. */
  gh.fetch = async (url, init) => {
    const who = login(init);
    if (!who) return response(401, { message: 'Bad credentials' });
    const body = init.body ? JSON.parse(init.body) : null;
    if (gh.failNext.length) {
      const f = gh.failNext.shift();
      return response(f.status, f.body ?? { message: 'injected' }, f.headers);
    }
    if (!body) return response(200, {}, { 'x-oauth-scopes': 'repo, project' });
    gh.calls.push({ op: body.operationName, login: who });
    const handler = route[body.operationName];
    if (!handler) return response(200, { errors: [{ message: `fake github: unrouted operation ${body.operationName}` }] });
    if (MUTATIONS.has(body.operationName)) gh.mutations.push({ op: body.operationName, variables: body.variables, login: who });
    return response(200, { data: handler(body.variables, who) });
  };

  /** Parsed protocol comments on an issue: [{kind, member, round, ...payload}]. */
  gh.protocol = (id) => gh.comments(id).map((c) => {
    const m = /<!-- inactivity:v1 (\{.*\}) -->/.exec(c.body);
    return m ? { ...JSON.parse(m[1]), _author: c.author, _id: c.databaseId } : null;
  }).filter(Boolean);

  return gh;
}

/**
 * The machine-side doubles: `claude`, `npx` (PLexus) and the image MCP endpoint, plus real git.
 * @param {{name:string, claudeScript?:(call:object)=>object|Promise<object>}} opts
 */
export function fakeMachine({ name, claudeScript }) {
  const m = {
    name,
    claudeCalls: [],
    plexusCalls: [],
    images: new Map(),      // scope -> {endpoint}
    imageMax: 0,
    mcpCalls: [],
    execCalls: [],
  };
  const IMAGE_URL = 'http://127.0.0.1:7777/mcp';
  m.imageUrl = IMAGE_URL;

  const stream = (events) => events.map((e) => JSON.stringify(e)).join('\n');

  /** Default fake agent: writes one Tonel file in the worktree and reports success. */
  const defaultClaude = async (call) => {
    const issue = /Issue number: (\d+)/.exec(call.stdin)?.[1] ?? '0';
    await fsp.mkdir(path.join(call.cwd, 'src', 'Widgets'), { recursive: true });
    await fsp.writeFile(path.join(call.cwd, 'src', 'Widgets', `Fix${issue}.class.st`), `Class { #name : #Fix${issue} }\n`);
    return {
      stdout: stream([
        { type: 'system', subtype: 'init', tools: ['Read', 'mcp__pharo__test_run'], mcp_servers: [{ name: 'pharo', status: 'connected' }] },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }] } },
        {
          type: 'result', subtype: 'success', is_error: false, num_turns: 5, total_cost_usd: 0.31,
          result: `Done.\n\`\`\`json inactivity-result\n${JSON.stringify({ status: 'done', summary: `Fixed issue ${issue}.`, tests: { ran: true, passed: true, detail: 'ok' } })}\n\`\`\``,
        },
      ]),
      code: 0,
    };
  };

  const plexusAnswer = (args, scope) => {
    const i = args.indexOf('image');
    const verb = args[i + 1];
    if (verb === 'templates') return { ok: true, templates: [{ name: 'Pharo 14.0 - 64bit (stable)' }] };
    if (verb === 'create') { m.images.set(scope, { endpoint: null }); return { ok: true, image: { name: 'task' } }; }
    if (verb === 'start') {
      if (!m.images.has(scope)) return { ok: false, code: 'image-not-found', error: 'no such image' };
      m.images.get(scope).endpoint = IMAGE_URL;
      m.imageMax = Math.max(m.imageMax, m.images.size);
      return { ok: true, image: { name: 'task', pid: 4242, endpoint: { url: IMAGE_URL } } };
    }
    if (verb === 'stop') return { ok: true };
    if (verb === 'delete') { m.images.delete(scope); return { ok: true }; }
    if (verb === 'list') return { ok: true, images: m.images.has(scope) ? [{ name: 'task', endpoint: { url: IMAGE_URL } }] : [] };
    return { ok: false, code: 'unknown-verb', error: verb };
  };

  /** `deps.exec`: claude and npx are faked, git is real, anything else is a test failure. */
  m.exec = async (cmd, args, opts = {}) => {
    m.execCalls.push({ cmd, args });
    if (cmd === 'git') return realExec(cmd, args, opts);
    if (cmd === 'claude') {
      const call = { args, cwd: opts.cwd, env: opts.env, stdin: opts.stdin, timeoutMs: opts.timeoutMs };
      m.claudeCalls.push(call);
      const out = await (claudeScript ?? defaultClaude)(call, defaultClaude);
      return { code: 0, signal: null, stderr: '', timedOut: false, durationMs: 5, ...out };
    }
    if (cmd === 'npx') {
      const scope = args[args.indexOf('--scope') + 1];
      const call = { args, scope };
      m.plexusCalls.push(call);
      return { code: 0, signal: null, stdout: JSON.stringify(plexusAnswer(args, scope)), stderr: '', timedOut: false, durationMs: 2 };
    }
    if (cmd === 'gh') throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    throw new Error(`unexpected process: ${cmd} ${args.join(' ')}`);
  };

  /** `deps.fetch` for the image endpoint (JSON-RPC over HTTP). */
  m.imageFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return response(200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {} } });
    if (body.method === 'notifications/initialized') return response(202, '');
    if (body.method === 'tools/call') {
      m.mcpCalls.push({ tool: body.params.name, args: body.params.arguments });
      const code = String(body.params.arguments?.code ?? '');
      let text = "'PASS'";
      if (code.includes('Metacello')) text = 'loaded';
      else if (code.includes('includesKey')) text = 'true';
      return response(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }], isError: false } });
    }
    return response(200, { jsonrpc: '2.0', id: body.id, error: { message: `unknown method ${body.method}` } });
  };

  return m;
}

/** Bare remote with one commit on `main` that holds a minimal Pharo project. @returns {Promise<string>} remote path */
export async function makeRemoteRepo(dir) {
  const work = path.join(dir, 'seed');
  const remote = path.join(dir, 'remote.git');
  await fsp.mkdir(path.join(work, 'src', 'BaselineOfWidgets'), { recursive: true });
  await fsp.mkdir(path.join(work, 'src', 'Widgets'), { recursive: true });
  await fsp.writeFile(path.join(work, 'src', 'BaselineOfWidgets', 'BaselineOfWidgets.class.st'), 'Class { #name : #BaselineOfWidgets }\n');
  await fsp.writeFile(path.join(work, 'src', 'Widgets', 'Widget.class.st'), 'Class { #name : #Widget }\n');
  await fsp.writeFile(path.join(work, '.inactivity.json'), JSON.stringify({
    version: 1,
    pharo: { template: 'Pharo 14.0 - 64bit (stable)' },
    baseline: { name: 'Widgets', sourceDirectory: 'src' },
    verify: { expression: "(WidgetsTests suite run) hasPassed ifTrue: ['PASS'] ifFalse: ['FAIL']" },
    extraInstructions: 'Run Widgets-Tests before finishing.',
  }, null, 2));
  const git = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git(['init', '-q', '-b', 'main'], work);
  git(['add', '-A'], work);
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'initial'], work);
  git(['clone', '-q', '--bare', work, remote], dir);
  return remote;
}

/** `deps.fetch` that routes by URL to the fake GitHub or to a machine's image endpoint. */
export function routeFetch(gh, machine, counter = { count: 0 }) {
  const fetch = async (url, init) => {
    counter.count += 1;
    if (String(url).startsWith('https://api.github.com')) return gh.fetch(url, init);
    if (String(url).startsWith('http://127.0.0.1')) return machine.imageFetch(url, init);
    throw new Error(`unexpected network access: ${url}`);
  };
  fetch.counter = counter;
  return fetch;
}
