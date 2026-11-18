import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDeps } from '../src/deps.js';
import {
  PLEXUS_VERSION, plexusCommand, scopeFor, plexus, listTemplates, createTaskImage, startTaskImage, mcpCall,
  buildBaselineScript, loadBaseline, runVerify, claudeMcpConfig, disposeTaskImage, warmup, probe, PharoError,
} from '../src/pharo.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Fake exec recording argv, answering from a function. */
function execFake(answer) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const r = answer(cmd, args);
    return { code: 0, signal: null, stdout: JSON.stringify(r), stderr: '', timedOut: false, durationMs: 1, ...(r?.__raw ?? {}) };
  };
  return { exec, calls };
}
const cfg = {};
const PREFIX = ['--yes', `@evref-bl/plexus@${PLEXUS_VERSION}`];

test('plexusCommand: pinned npx by default, configurable', () => {
  assert.deepEqual(plexusCommand({}), ['npx', '--yes', `@evref-bl/plexus@${PLEXUS_VERSION}`]);
  assert.deepEqual(plexusCommand({ pharo: { plexusCommand: ['plexus'] } }), ['plexus']);
});

test('scopeFor: no dash, stable, at most 64 chars, valid PLexus scope', () => {
  const s = scopeFor('Evref-BL/My-Project', 42, '20261119T090000Z-ab12');
  assert.equal(s, 'pd_Evref_BL_My_Project_42_ab12');
  assert.match(s, /^[A-Za-z0-9][A-Za-z0-9._]{0,63}$/);
  assert.equal(scopeFor('Evref-BL/My-Project', 42, '20261119T090000Z-ab12'), s);
  assert.ok(scopeFor('a'.repeat(100) + '/' + 'b'.repeat(100), 1, 'x-0000').length <= 64);
});

test('plexus argv: --scope last, one JSON document parsed, npx noise tolerated', async () => {
  const { exec, calls } = execFake(() => ({ ok: true, templates: [{ name: 'Pharo 14.0 - 64bit (stable)' }] }));
  const deps = createDeps({ exec, log: quiet });
  assert.deepEqual(await listTemplates(deps, cfg), [{ name: 'Pharo 14.0 - 64bit (stable)', category: undefined, ambiguous: undefined }]);
  assert.deepEqual(calls[0].args, [...PREFIX, 'image', 'templates', '--scope', 'pd_templates']);
  const noisy = { exec: async () => ({ code: 0, stdout: 'npm warn something\n{"ok":true,"x":1}\n', stderr: '', timedOut: false }), log: quiet };
  assert.deepEqual(await plexus(noisy, cfg, 's', ['image', 'list']), { ok: true, x: 1 });
});

test('plexus errors map to PharoError with the PLexus code', async () => {
  const bad = { exec: async () => ({ code: 1, stdout: '{"ok":false,"code":"template-not-found","error":"no such template"}', stderr: '', timedOut: false }), log: quiet };
  await assert.rejects(plexus(bad, cfg, 's', ['image', 'create', 'task']), (e) => e instanceof PharoError && e.code === 'template-not-found' && /no such template/.test(e.message));
  const crash = { exec: async () => ({ code: 2, stdout: '', stderr: 'boom', timedOut: false }), log: quiet };
  await assert.rejects(plexus(crash, cfg, 's', ['image', 'list']), (e) => e.code === 'plexus-failed');
  const missing = { exec: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, log: quiet };
  await assert.rejects(plexus(missing, cfg, 's', ['image', 'list']), (e) => e.code === 'plexus-unavailable');
  const slow = { exec: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }), log: quiet };
  await assert.rejects(plexus(slow, cfg, 's', ['image', 'list']), (e) => e.code === 'plexus-timeout');
});

test('create / start: argv, endpoint from the start answer or from image list', async () => {
  const seen = [];
  const a = execFake((cmd, args) => {
    seen.push(args.slice(2));
    return args.includes('start') ? { ok: true, image: { name: 'task', pid: 7, endpoint: { url: 'http://127.0.0.1:1/mcp' } } } : { ok: true };
  });
  const deps = createDeps({ exec: a.exec, log: quiet });
  await createTaskImage(deps, cfg, { scope: 'pd_x', template: 'T', category: 'Official' });
  assert.deepEqual(a.calls[0].args.slice(2), ['image', 'create', 'task', '--template', 'T', '--category', 'Official', '--scope', 'pd_x']);
  assert.deepEqual(await startTaskImage(deps, cfg, { scope: 'pd_x', timeoutSeconds: 120 }), { endpointUrl: 'http://127.0.0.1:1/mcp', pid: 7 });
  assert.deepEqual(a.calls[1].args.slice(2), ['image', 'start', 'task', '--timeout', '120', '--scope', 'pd_x']);

  const b = execFake((cmd, args) => (args.includes('start') ? { ok: true } : { ok: true, images: [{ name: 'task', pid: 9, endpoint: { url: 'http://127.0.0.1:2/mcp' } }] }));
  const viaList = await startTaskImage(createDeps({ exec: b.exec, log: quiet }), cfg, { scope: 'pd_y' });
  assert.deepEqual(viaList, { endpointUrl: 'http://127.0.0.1:2/mcp', pid: 9 });
  const none = execFake(() => ({ ok: true, images: [] }));
  await assert.rejects(startTaskImage(createDeps({ exec: none.exec, log: quiet }), cfg, { scope: 'pd_z' }), (e) => e.code === 'no-endpoint');
});

/** A real local HTTP server speaking enough JSON-RPC for mcpCall. */
function mcpServer({ sse = false, toolAnswer } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      log.push({ method: msg.method, session: req.headers['mcp-session-id'], tool: msg.params?.name, args: msg.params?.arguments });
      if (msg.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      let payload;
      if (msg.method === 'initialize') payload = { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {} } };
      else payload = { jsonrpc: '2.0', id: msg.id, result: toolAnswer(msg.params) };
      const headers = { 'content-type': sse ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'S1' };
      res.writeHead(200, headers);
      res.end(sse ? `event: message\ndata: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

for (const sse of [false, true]) {
  test(`mcpCall over real HTTP (${sse ? 'SSE' : 'JSON'}): initialize, notification, tools/call, session id`, async () => {
    const s = await mcpServer({ sse, toolAnswer: (p) => ({ content: [{ type: 'text', text: `ran ${p.arguments.code}` }], isError: p.arguments.code === 'bad' }) });
    try {
      const deps = createDeps({ log: quiet });
      const ok = await mcpCall(deps, s.url, 'image_evaluate', { code: '1+1' });
      assert.deepEqual([ok.isError, ok.text], [false, 'ran 1+1']);
      assert.deepEqual(s.log.map((l) => l.method), ['initialize', 'notifications/initialized', 'tools/call']);
      assert.equal(s.log[2].session, 'S1', 'session id is echoed');
      assert.equal(s.log[2].tool, 'image_evaluate');
      assert.equal((await mcpCall(deps, s.url, 'image_evaluate', { code: 'bad' })).isError, true);
    } finally {
      s.server.close();
    }
  });
}

test('mcpCall: unreachable endpoint is a PharoError', async () => {
  await assert.rejects(mcpCall(createDeps({ log: quiet }), 'http://127.0.0.1:9/mcp', 'image_evaluate', {}), (e) => e instanceof PharoError && e.code === 'mcp-unreachable');
});

test('buildBaselineScript golden (with and without group, quotes, spaces, windows path)', () => {
  assert.equal(
    buildBaselineScript({ baseline: { name: 'MyProject', sourceDirectory: 'src', group: 'default' }, checkout: '/abs/work tree' }),
    "Metacello new\n  baseline: 'MyProject';\n  repository: 'tonel:///abs/work tree/src';\n  onConflictUseLoaded;\n  load: 'default'.",
  );
  assert.equal(
    buildBaselineScript({ baseline: { name: 'MyProject', sourceDirectory: 'src', group: null }, checkout: '/abs/w' }),
    "Metacello new\n  baseline: 'MyProject';\n  repository: 'tonel:///abs/w/src';\n  onConflictUseLoaded;\n  load.",
  );
  assert.match(buildBaselineScript({ baseline: { name: "It's" }, checkout: 'C:\\w\\run' }), /baseline: 'It''s';\n {2}repository: 'tonel:\/\/\/C:\/w\/run\/src'/);
  assert.match(buildBaselineScript({ baseline: { name: 'X', repository: 'github://a/b:main/src' }, checkout: '/w' }), /repository: 'github:\/\/a\/b:main\/src'/);
});

test('loadBaseline and runVerify against a real fake image', async () => {
  const answers = { load: 'Metacello done', check: 'true', verify: "'PASS'" };
  const s = await mcpServer({
    toolAnswer: (p) => {
      const code = p.arguments?.code ?? '';
      const text = code.includes('Metacello') ? answers.load : code.includes('includesKey') ? answers.check : answers.verify;
      return { content: [{ type: 'text', text }], isError: false };
    },
  });
  try {
    const deps = createDeps({ log: quiet });
    const baseline = { name: 'Widgets', sourceDirectory: 'src', group: null };
    assert.deepEqual(await loadBaseline(deps, { endpointUrl: s.url, baseline, checkout: '/w' }), { ok: true, text: 'Metacello done', check: 'true' });
    answers.check = 'false';
    const missing = await loadBaseline(deps, { endpointUrl: s.url, baseline, checkout: '/w' });
    assert.equal(missing.ok, false);
    assert.match(missing.text, /BaselineOfWidgets not found/);

    answers.verify = "'PASS'";
    assert.deepEqual(await runVerify(deps, { endpointUrl: s.url, verify: { expression: "'PASS'" } }), { ran: true, passed: true, text: "'PASS'" });
    answers.verify = "'FAIL'";
    assert.equal((await runVerify(deps, { endpointUrl: s.url, verify: { expression: "'FAIL'" } })).passed, false);
    assert.deepEqual(await runVerify(deps, { endpointUrl: s.url, verify: { mcp: { tool: 'test_run', arguments: { package: 'W' } } } }), { ran: true, passed: true, text: "'FAIL'" });
    assert.deepEqual(await runVerify(deps, { endpointUrl: s.url, verify: { expression: null, mcp: null } }), { ran: false, passed: null, text: '' });
    assert.equal(s.log.filter((l) => l.tool === 'test_run')[0].args.package, 'W');
  } finally {
    s.server.close();
  }
});

test('claudeMcpConfig points the agent at `plexus mcp --scope`', () => {
  assert.deepEqual(claudeMcpConfig({}, 'pd_x_1_ab12'), { mcpServers: { pharo: { command: 'npx', args: ['--yes', `@evref-bl/plexus@${PLEXUS_VERSION}`, 'mcp', '--scope', 'pd_x_1_ab12'], env: {} } } });
  assert.deepEqual(claudeMcpConfig({ pharo: { plexusCommand: ['plexus'] } }, 's').mcpServers.pharo, { command: 'plexus', args: ['mcp', '--scope', 's'], env: {} });
});

test('claudeMcpConfig: explicit allowlist env, no credential, no proxy; pharo.passEnv extends it', () => {
  const env = { PATH: '/bin', HOME: '/h', PLEXUS_HOME: '/p', AWS_SECRET_ACCESS_KEY: 's', NPM_TOKEN: 'n', GH_TOKEN: 'g', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', HTTPS_PROXY: 'http://u:p@proxy', JAVA_HOME: '/j' };
  assert.deepEqual(claudeMcpConfig({}, 's', env).mcpServers.pharo.env, { PATH: '/bin', HOME: '/h', PLEXUS_HOME: '/p' });
  assert.deepEqual(claudeMcpConfig({ pharo: { passEnv: ['JAVA_HOME'] } }, 's', env).mcpServers.pharo.env, { PATH: '/bin', HOME: '/h', PLEXUS_HOME: '/p', JAVA_HOME: '/j' });
});

test('plexus children get an allowlist environment', async () => {
  const seen = [];
  const deps = { env: { PATH: '/bin', HOME: '/h', AWS_SECRET_ACCESS_KEY: 's', NPM_TOKEN: 'n', HTTPS_PROXY: 'px' }, exec: async (cmd, args, opts) => { seen.push(opts.env); return { code: 0, stdout: '{"ok":true}', stderr: '' }; } };
  await plexus(deps, {}, 'pd_x', ['image', 'list']);
  assert.deepEqual(seen[0], { PATH: '/bin', HOME: '/h', HTTPS_PROXY: 'px' });
});

test('disposeTaskImage: stop, delete, confirm through list; never throws', async () => {
  const verbs = [];
  let remaining = [{ name: 'task' }];
  const deps = createDeps({
    log: quiet,
    exec: async (cmd, args) => {
      const verb = args[args.indexOf('image') + 1];
      verbs.push(verb);
      if (verb === 'delete') remaining = [];
      if (verb === 'stop') return { code: 1, stdout: '{"ok":false,"code":"not-running","error":"not running"}', stderr: '', timedOut: false };
      return { code: 0, stdout: JSON.stringify(verb === 'list' ? { ok: true, images: remaining } : { ok: true }), stderr: '', timedOut: false };
    },
  });
  assert.deepEqual(await disposeTaskImage(deps, cfg, 'pd_x'), { stopped: false, deleted: true, leftovers: [] });
  assert.deepEqual(verbs, ['stop', 'delete', 'list']);
  const broken = createDeps({ log: quiet, exec: async () => { throw new Error('npx gone'); } });
  const r = await disposeTaskImage(broken, cfg, 'pd_x');
  assert.equal(r.deleted, false);
  assert.ok(r.leftovers.length > 0, 'an unverifiable cleanup is reported, not hidden');
});

test('warmup and probe', async () => {
  const verbs = [];
  const deps = createDeps({
    log: quiet,
    exec: async (cmd, args) => {
      const verb = args[args.indexOf('image') + 1];
      verbs.push(verb);
      const out = verb === 'start' ? { ok: true, image: { endpoint: { url: 'http://x/mcp' } } } : verb === 'list' ? { ok: true, images: [] } : verb === 'templates' ? { ok: true, templates: ['Pharo 14'] } : { ok: true };
      return { code: 0, stdout: JSON.stringify(out), stderr: '', timedOut: false };
    },
  });
  assert.deepEqual(await warmup(deps, cfg, ['Pharo 14']), [{ template: 'Pharo 14', ok: true }]);
  assert.deepEqual(verbs, ['create', 'start', 'stop', 'delete', 'list']);
  assert.deepEqual(await probe(deps, cfg), { ok: true, templates: [{ name: 'Pharo 14' }] });
  const down = createDeps({ log: quiet, exec: async () => ({ code: 1, stdout: '', stderr: 'offline', timedOut: false }) });
  const p = await probe(down, cfg);
  assert.equal(p.ok, false);
  assert.match(p.detail, /plexus/);
});
