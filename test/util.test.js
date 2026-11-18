import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256Hex, digest, slug, redact, sanitizeForComment, atomicWriteJson, readJsonIfExists, compareStrings, quoteWin, errorCode, DispatchError } from '../src/util.js';
import { tmpDirs } from './support/fakes.js';

const tmp = tmpDirs();

test('canonicalJson sorts keys recursively and is stable', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson([undefined]), '[null]');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

test('digest is sha256 of the canonical JSON', () => {
  assert.equal(digest({ b: 1, a: 2 }), `sha256:${sha256Hex('{"a":2,"b":1}')}`);
  assert.match(digest({}), /^sha256:[0-9a-f]{64}$/);
});

test('slug, compareStrings, errorCode', () => {
  assert.equal(slug('Fix the Parser: crash on "a-b"!!', 40), 'fix-the-parser-crash-on-a-b');
  assert.equal(slug('  --Hello--  ', 4), 'hell');
  assert.equal(slug('\u00e9t\u00e9 chaud', 40), 'ete-chaud');
  assert.equal(slug('???', 10), '');
  assert.deepEqual(['b', 'B', 'a'].sort(compareStrings), ['B', 'a', 'b']);
  assert.equal(errorCode(new DispatchError('no-config', 'x')), 'no-config');
  assert.equal(errorCode(new Error('x')), 'internal');
});

test('redact masks token shapes, Authorization headers and given secrets', () => {
  const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789 and github_pat_11ABCDEFG0123456789_abcdefghij and sk-ant-api03-abcdefgh';
  const out = redact(t);
  assert.ok(!/ghp_|github_pat_|sk-ant-/.test(out), out);
  assert.equal(redact('Authorization: Bearer abc.def-123'), 'Authorization: [redacted]');
  assert.equal(redact('the secret is hunter22 ok', ['hunter22']), 'the secret is [redacted] ok');
  assert.equal(redact('nothing here'), 'nothing here');
});

test('sanitizeForComment strips control characters, defangs mentions, truncates', () => {
  const out = sanitizeForComment('hi @alice\u0007 and a@b.c', 100);
  assert.ok(!out.includes('\u0007'));
  assert.ok(out.includes('@\u200Balice'));
  assert.ok(out.includes('a@b.c'), 'e-mail addresses are left alone');
  const long = sanitizeForComment('x'.repeat(50), 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith('\u2026'));
});

test('atomicWriteJson / readJsonIfExists', async () => {
  const dir = await tmp.make('pd-util-');
  const file = path.join(dir, 'a', 'b.json');
  await atomicWriteJson(fsp, file, { x: 1 });
  assert.deepEqual(await readJsonIfExists(fsp, file), { x: 1 });
  assert.deepEqual((await fsp.readdir(path.dirname(file))), ['b.json'], 'no temp file left');
  assert.equal(await readJsonIfExists(fsp, path.join(dir, 'missing.json')), null);
  await fsp.writeFile(path.join(dir, 'bad.json'), '{nope');
  await assert.rejects(readJsonIfExists(fsp, path.join(dir, 'bad.json')), (e) => e.code === 'bad-json');
  await tmp.cleanup();
});

test('quoteWin', () => {
  assert.equal(quoteWin('plain'), 'plain');
  assert.equal(quoteWin('with space'), '"with space"');
  assert.equal(quoteWin('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWin('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.equal(quoteWin(''), '""');
});
