import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_ALLOWED_TOOLS, PHARO_AGENT_TOOLS, allowlistEnv, buildClaudeArgs, buildClaudeEnv, parseStream, classifyOutcome, parseResetTime, extractResultBlock, verifyInit, runClaude } from '../src/claudeRun.js';

const INIT = { type: 'system', subtype: 'init', tools: ['Read', 'mcp__pharo__test_run'], mcp_servers: [{ name: 'pharo', status: 'connected' }] };
const lines = (...events) => events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
const block = (o) => `Done.\n\`\`\`json inactivity-result\n${JSON.stringify(o)}\n\`\`\``;
const success = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.2, result: block({ status: 'done', summary: 's' }) };
const classify = (text, exec = { code: 0 }, now = new Date('2026-11-19T10:00:00')) => classifyOutcome({ parsed: parseStream(text), exec, now });

test('buildClaudeArgs: golden shape, lists comma-joined, never --bare nor skip-permissions', () => {
  const args = buildClaudeArgs({
    model: 'sonnet', effort: 'medium', mcpConfigPath: '/r/mcp.json', systemPromptFile: '/r/system.md', maxTurns: 80, maxBudgetUsd: 3,
    extraAllowedTools: ['Bash(ls *)'], extraDisallowedTools: ['Bash(rm *)'], denyPharoTools: ['image_evaluate'],
  });
  assert.deepEqual(args.slice(0, 5), ['-p', '--model', 'sonnet', '--effort', 'medium']);
  const pair = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(pair('--output-format'), 'stream-json');
  assert.ok(args.includes('--verbose'));
  assert.equal(pair('--permission-mode'), 'dontAsk');
  assert.equal(pair('--permission-prompts'), 'none');
  const allowed = pair('--allowedTools').split(',');
  assert.deepEqual(allowed.slice(0, 5), ['Read(./**)', 'Glob(./**)', 'Grep(./**)', 'Edit(./**)', 'Write(./**)']);
  assert.ok(allowed.includes('mcp__pharo__test_run') && allowed.includes('Bash(ls *)'));
  const denied = pair('--disallowedTools').split(',');
  for (const t of ['WebFetch', 'WebSearch', 'mcp__pharo__image_delete', 'Edit(.github/**)', 'Write(.inactivity.json)', 'mcp__pharo__image_evaluate', 'Bash(rm *)']) assert.ok(denied.includes(t), t);
  assert.equal(pair('--mcp-config'), '/r/mcp.json');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(pair('--setting-sources'), '', 'machine settings are not loaded');
  assert.deepEqual(JSON.parse(pair('--settings')), { disableAllHooks: true, includeCoAuthoredBy: false });
  assert.equal(pair('--append-system-prompt-file'), '/r/system.md');
  assert.equal(pair('--max-turns'), '80');
  assert.equal(pair('--max-budget-usd'), '3');
  assert.ok(args.includes('--no-session-persistence'));
  for (const bad of ['--bare', '--dangerously-skip-permissions', '--plugin-dir', '--fallback-model']) assert.ok(!args.includes(bad), bad);
  assert.ok(!buildClaudeArgs({ model: 'haiku', mcpConfigPath: 'm', systemPromptFile: 's', maxTurns: 1, maxBudgetUsd: null }).includes('--max-budget-usd'));
  assert.ok(!buildClaudeArgs({ model: 'haiku', mcpConfigPath: 'm', systemPromptFile: 's', maxTurns: 1 }).includes('--effort'));
});

test('buildClaudeEnv: allowlist only, no API key, no GitHub token, limits on; config dir for multi-account', () => {
  const env = buildClaudeEnv({
    PATH: '/bin', ANTHROPIC_API_KEY: 'k', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', GITHUB_PAT_X: 'c', HOME: '/h', EMPTY: undefined,
    AWS_SECRET_ACCESS_KEY: 's', NPM_TOKEN: 'n', OPENAI_API_KEY: 'o', SSH_AUTH_SOCK: '/sock', DATABASE_URL: 'pg://x', GITLAB_TOKEN: 'g',
    HTTPS_PROXY: 'http://proxy:3128', CLAUDE_CODE_OAUTH_TOKEN: 't', LANG: 'C',
  }, { claude: { configDir: '/acct2' } });
  assert.deepEqual(env, {
    PATH: '/bin', HOME: '/h', HTTPS_PROXY: 'http://proxy:3128', CLAUDE_CODE_OAUTH_TOKEN: 't', LANG: 'C',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_MAX_RETRIES: '3', CLAUDE_CONFIG_DIR: '/acct2',
  });
  assert.equal(buildClaudeEnv({ ANTHROPIC_API_KEY: 'k' }, { claude: { allowApiKey: true } }).ANTHROPIC_API_KEY, 'k');
  const passed = buildClaudeEnv({ MY_GATEWAY: 'g', GH_TOKEN: 'a', OTHER: 'x' }, { claude: { passEnv: ['MY_GATEWAY', 'GH_TOKEN'] } });
  assert.equal(passed.MY_GATEWAY, 'g', 'claude.passEnv lets a named variable through');
  assert.ok(!('GH_TOKEN' in passed) && !('OTHER' in passed), 'a GitHub token is never passed, nor is anything unnamed');
});

test('allowlistEnv: network and auth variables are opt-in, case-insensitive match', () => {
  const env = { Path: '/b', HTTP_PROXY: 'p', CLAUDE_CODE_OAUTH_TOKEN: 't', PLEXUS_HOME: '/x', LC_ALL: 'C', AWS_PROFILE: 'a' };
  assert.deepEqual(allowlistEnv(env), { Path: '/b', PLEXUS_HOME: '/x', LC_ALL: 'C' });
  assert.deepEqual(allowlistEnv(env, { network: true, auth: true }), { Path: '/b', HTTP_PROXY: 'p', CLAUDE_CODE_OAUTH_TOKEN: 't', PLEXUS_HOME: '/x', LC_ALL: 'C' });
});

test('tool allowlist: no whole-server wildcard, image_evaluate and shell denied, file tools scoped, opt-ins explicit', () => {
  assert.ok(!BASE_ALLOWED_TOOLS.includes('mcp__pharo'), 'no blanket mcp__pharo entry');
  assert.ok(BASE_ALLOWED_TOOLS.every((t) => !/^mcp__pharo(__\*)?$/.test(t) && !t.includes('*') || t.endsWith('(./**)')), 'no wildcard server entry');
  assert.ok(!PHARO_AGENT_TOOLS.some((t) => /evaluate|shell|file|exec|run_command/.test(t.replace('test_run', ''))), 'no code-running tool in the list');
  assert.ok(BASE_ALLOWED_TOOLS.every((t) => !/^(Read|Glob|Grep|Edit|Write)$/.test(t)), 'no bare file tool: all scoped to the worktree');
  assert.ok(!BASE_ALLOWED_TOOLS.some((t) => t.startsWith('Bash')), 'no Bash at all');
  const base = { model: 'm', mcpConfigPath: 'm', systemPromptFile: 's', maxTurns: 1 };
  const pairOf = (args, flag) => args[args.indexOf(flag) + 1].split(',');
  const plain = buildClaudeArgs(base);
  assert.ok(pairOf(plain, '--disallowedTools').includes('mcp__pharo__image_evaluate'));
  assert.ok(pairOf(plain, '--disallowedTools').includes('Bash'), 'generic Bash denied: it overrides any user-level allow rule');
  assert.ok(!pairOf(plain, '--allowedTools').includes('mcp__pharo__image_evaluate'));
  for (const t of ['Read(~/.ssh/**)', 'Read(~/.config/gh/**)', 'Read(**/.env.*)', 'Read(//etc/**)']) assert.ok(pairOf(plain, '--disallowedTools').includes(t), t);
  const opted = buildClaudeArgs({ ...base, allowImageEvaluate: true, allowPharoTools: ['class_list', 'bad name'], claudeConfigDir: '/acct2/.claude' });
  assert.ok(pairOf(opted, '--allowedTools').includes('mcp__pharo__image_evaluate'));
  assert.ok(!pairOf(opted, '--disallowedTools').includes('mcp__pharo__image_evaluate'));
  assert.ok(pairOf(opted, '--allowedTools').includes('mcp__pharo__class_list'));
  assert.ok(!pairOf(opted, '--allowedTools').some((t) => t.includes('bad name')), 'tool names are validated');
  assert.ok(pairOf(opted, '--disallowedTools').includes('Read(//acct2/.claude/**)'), 'a second Claude config dir is unreadable too');
  const withBash = buildClaudeArgs({ ...base, extraAllowedTools: ['Bash(ls *)'] });
  assert.ok(!pairOf(withBash, '--disallowedTools').includes('Bash'), 'an explicit Bash opt-in is honoured');
  const user = buildClaudeArgs({ ...base, loadUserSettings: true });
  assert.equal(user[user.indexOf('--setting-sources') + 1], 'user');
  assert.ok(!user.includes('--settings'));
});

test('parseStream tolerates junk, keeps init, last result, errors and rate limit events', () => {
  const p = parseStream(lines('not json', '{broken', INIT, { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }, { type: 'assistant', error: 'rate_limit', message: { content: [] } }, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, '', success));
  assert.equal(p.init.subtype, 'init');
  assert.equal(p.result.num_turns, 3);
  assert.deepEqual(p.assistantErrors.map((e) => e.error), ['rate_limit']);
  assert.equal(p.rateLimitEvents.length, 1);
  assert.ok(p.texts.includes('hello'));
  assert.deepEqual(parseStream('').init, null);
});

test('classifyOutcome: success, limit (429, text, assistant error, event), overloaded, auth, turns, budget, timeout, error', () => {
  assert.equal(classify(lines(INIT, success)).kind, 'success');
  const limit429 = classify(lines(INIT, { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'Request rejected (429)' }));
  assert.equal(limit429.kind, 'limit');
  const text = classify(lines(INIT, { type: 'result', subtype: 'success', is_error: true, result: "You've hit your weekly limit · resets 3pm" }));
  assert.equal(text.kind, 'limit');
  assert.equal(new Date(text.resetsAt).getHours(), 15, 'reset time parsed in local time');
  assert.equal(classify(lines({ type: 'assistant', error: 'billing_error', message: { content: [] } })).kind, 'limit');
  assert.equal(classify(lines(INIT, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1795000000 } }, success)).kind, 'limit');
  assert.equal(classify(lines(INIT, { type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'x' })).kind, 'overloaded');
  assert.equal(classify(lines({ type: 'assistant', error: 'authentication_failed', message: { content: [] } })).kind, 'auth');
  assert.equal(classify(lines(INIT, { type: 'result', subtype: 'error_max_turns', is_error: true })).kind, 'max_turns');
  assert.equal(classify(lines(INIT, { type: 'result', subtype: 'error_max_budget_usd', is_error: true })).kind, 'budget');
  assert.equal(classify(lines(INIT), { code: null, timedOut: true }).kind, 'timeout');
  assert.equal(classify(lines(INIT, { type: 'result', subtype: 'error_during_execution', is_error: true })).kind, 'error');
  assert.equal(classify('', { code: 1 }).kind, 'error');
});

test('a long successful answer that merely mentions "usage limit" is still a success', () => {
  const chatty = { ...success, result: `${'We discussed the usage limit handling in the docs. '.repeat(10)}${block({ status: 'done', summary: 's' })}` };
  assert.equal(classify(lines(INIT, chatty)).kind, 'success');
});

test('parseResetTime', () => {
  const now = new Date(2026, 10, 19, 10, 0, 0);
  const at = (t) => new Date(parseResetTime(t, now));
  assert.equal(at('resets 3pm').getHours(), 15);
  assert.equal(at('resets 10:30am').getDate(), 19, 'later today');
  assert.equal(at('resets 10:30am').getMinutes(), 30);
  assert.equal(at('resets 9:30am').getDate(), 20, 'already past today: tomorrow');
  assert.equal(at('resets 12am').getHours(), 0);
  assert.equal(at('resets Mon').getDay(), 1);
  assert.equal(parseResetTime('no hint here', now), null);
});

test('extractResultBlock: last block wins, invalid JSON gives null', () => {
  assert.deepEqual(extractResultBlock(`${block({ status: 'blocked', summary: 'first' })}\nmore\n${block({ status: 'done', summary: 'last' })}`), { status: 'done', summary: 'last' });
  assert.equal(extractResultBlock('```json inactivity-result\n{oops\n```'), null);
  assert.equal(extractResultBlock('```json\n{"status":"done"}\n```'), null);
  assert.equal(extractResultBlock(''), null);
});

test('verifyInit: connected pharo server with mcp__pharo__ tools, no plugin errors', () => {
  assert.deepEqual(verifyInit({ init: INIT }), { ok: true, problems: [] });
  assert.equal(verifyInit({ init: null }).ok, false);
  assert.match(verifyInit({ init: { ...INIT, mcp_servers: [{ name: 'pharo', status: 'failed' }] } }).problems.join(), /status: failed/);
  assert.match(verifyInit({ init: { ...INIT, tools: ['Read'] } }).problems.join(), /no mcp__pharo__/);
  assert.match(verifyInit({ init: { ...INIT, mcp_servers: [] } }).problems.join(), /not declared/);
  assert.match(verifyInit({ init: { ...INIT, plugin_errors: ['x'] } }).problems.join(), /plugin errors/);
});

test('runClaude: prompt on stdin, tee path, outcome and parsed stream', async () => {
  const seen = [];
  const written = [];
  const deps = {
    now: () => new Date('2026-11-19T10:00:00Z'),
    fs: { writeFile: async (p, c) => written.push([p, c]) },
    exec: async (cmd, args, opts) => { seen.push({ cmd, args, opts }); return { code: 0, signal: null, stdout: lines(INIT, success), stderr: '', timedOut: false, durationMs: 1 }; },
  };
  const r = await runClaude(deps, { cwd: '/w', prompt: 'THE PROMPT', args: ['-p'], env: { A: '1' }, timeoutMs: 1000, claudePath: '/bin/claude', teePath: '/r/stream.jsonl' });
  assert.equal(seen[0].cmd, '/bin/claude');
  assert.equal(seen[0].opts.stdin, 'THE PROMPT');
  assert.equal(seen[0].opts.cwd, '/w');
  assert.deepEqual(seen[0].opts.tee, { stdout: '/r/stream.jsonl' });
  assert.equal(r.outcome.kind, 'success');
  assert.equal(r.parsed.result.num_turns, 3);
  assert.equal(written[0][0], '/r/stream.jsonl', 'a fake exec that does not tee still gets its stream saved');
});
