// H1: arguments reach the server byte-for-byte and are never interpreted by a shell.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { Client, killAll, root, run } from './helpers.js';

after(killAll);

const ARGV_SERVER = join(root, 'test', 'fixtures', 'argv-server.js');
// Each would run a command or redirect output if a shell interpreted it; the canary file must never appear.
const NASTY = [
  'a b',
  'x&echo pwned>canary.txt',
  'x && echo pwned > canary.txt',
  'p|echo pwned>canary.txt',
  'a>canary.txt',
  '$(echo pwned>canary.txt)',
  '`echo pwned>canary.txt`',
  '; echo pwned>canary.txt',
  '%PATH%',
  '%PATH:\\=/%',
  '%X:a=b%',
  '%%',
  '!PATH!',
  'say "hi"',
  '"',
  '\\"&echo pwned>canary.txt&\\"',
  'back\\slash\\',
  'trail\\\\',
  '^caret^',
  '^&',
  '(paren)',
  'semi;colon,comma=eq',
  '*?[]',
  'é€😀',
  '',
];

async function argvThroughProxy(command, cwd, env = {}) {
  const c = new Client(['--', ...command, ...NASTY], env, { cwd });
  await c.init();
  await c.request(1, 'tools/list');
  const r = await c.request(2, 'tools/call', { name: 'argv', arguments: {} });
  await c.close();
  assert.ok(!r.result.isError, JSON.stringify(r));
  return JSON.parse(r.result.content[0].text);
}

test('arguments with spaces, & > | % quotes ^ and more arrive verbatim at a directly spawned server', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ro-argv-')));
  assert.deepEqual(await argvThroughProxy([process.execPath, ARGV_SERVER], dir), NASTY);
  assert.deepEqual(readdirSync(dir), [], 'a shell ran something');
});

test('a server path containing spaces works', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ro argv space ')));
  const copy = join(dir, 'my server.js');
  writeFileSync(copy, readFileSyncText(ARGV_SERVER));
  assert.deepEqual(await argvThroughProxy([process.execPath, copy], dir), NASTY);
});

const winOnly = process.platform !== 'win32' && 'Windows-only: exercises the cmd.exe wrapper for .cmd shims';

test('win32: through a .cmd shim (like npx.cmd) arguments still arrive verbatim and nothing runs', { skip: winOnly }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ro shim & dir ')));
  writeFileSync(join(dir, 'argv-shim.cmd'), `@"${process.execPath}" "${ARGV_SERVER}" %*\r\n`);
  // by full path
  assert.deepEqual(await argvThroughProxy([join(dir, 'argv-shim.cmd')], dir), NASTY);
  // by bare name, resolved through PATH + PATHEXT
  const env = { PATH: dir + delimiter + process.env.PATH };
  assert.deepEqual(await argvThroughProxy(['argv-shim'], dir, env), NASTY);
  assert.deepEqual(readdirSync(dir).sort(), ['argv-shim.cmd'], 'cmd.exe ran something');
});

test('win32: a .cmd shim in a directory containing "=" executes cleanly', { skip: winOnly }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ro=eq-')));
  const shim = join(dir, 'eq-shim.cmd');
  writeFileSync(shim, `@"${process.execPath}" "${ARGV_SERVER}" %*\r\n`);
  assert.deepEqual(await argvThroughProxy([shim], dir), NASTY);
  assert.deepEqual(readdirSync(dir), ['eq-shim.cmd']);
});

test('win32 review M5/N3: a missing .cmd exits 127; a line break for a .cmd target is one clean error line', { skip: winOnly }, async () => {
  const missing = await run(['--', 'C:\\no such dir\\srv.cmd']);
  assert.equal(missing.code, 127, missing.stderr);
  assert.equal(missing.stderr.trim(), 'mcp-readonly: failed to start server "C:\\no such dir\\srv.cmd": ENOENT (command not found)');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ro-n3-')));
  writeFileSync(join(dir, 'srv.cmd'), `@"${process.execPath}" "${ARGV_SERVER}" %*\r\n`);
  const nl = await run(['audit', '--', join(dir, 'srv.cmd'), 'a\nb']);
  assert.equal(nl.code, 2);
  assert.match(nl.stderr, /^mcp-readonly audit: failed to start server ".*srv\.cmd": cannot pass an argument containing a line break or NUL to the batch file .*srv\.cmd\r?\n$/);
  const miss = await run(['audit', '--', 'C:\\no such dir\\srv.cmd']);
  assert.equal(miss.code, 1);
  assert.equal(miss.stderr.trim(), 'mcp-readonly audit: failed to start server "C:\\no such dir\\srv.cmd": ENOENT (command not found)');
});

test('win32: a plain .bat that reads "%~1" gets its arguments without leftover carets', { skip: winOnly }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ro tilde & dir ')));
  const bat = join(dir, 'tilde.bat');
  writeFileSync(bat, `@"${process.execPath}" "${ARGV_SERVER}" "%~1" "%~2" "%~3" "%~4" "%~5"\r\n`);
  const args = ['a&b', '%PATH:\\=/%', '100% ^ !x!', 'C:\\My Docs\\', 'p|q>r'];
  const c = new Client(['--', bat, ...args], {}, { cwd: dir });
  await c.init();
  await c.request(1, 'tools/list');
  const r = await c.request(2, 'tools/call', { name: 'argv', arguments: {} });
  await c.close();
  assert.deepEqual(JSON.parse(r.result.content[0].text), args);
  assert.deepEqual(readdirSync(dir), ['tilde.bat'], 'cmd.exe ran something');
});

import { readFileSync } from 'node:fs';
function readFileSyncText(p) {
  return readFileSync(p, 'utf8');
}
