import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, SERVER, killAll, run } from './helpers.js';

after(killAll);

const tmp = () => mkdtempSync(join(tmpdir(), 'mcp-readonly-'));
const names = (r) => r.result.tools.map((t) => t.name);
const READ_TOOLS = ['list_notes', 'get_note', 'search_notes', 'count_words', 'clear_cache', 'show_tally'];

test('tools/list hides write tools and keeps read tools untouched', async () => {
  const c = new Client(['--', 'node', SERVER]);
  const init = await c.init();
  assert.equal(init.result.serverInfo.name, 'notes-server');
  const r = await c.request(1, 'tools/list');
  assert.deepEqual(names(r), READ_TOOLS);
  assert.deepEqual(r.result.tools[0].annotations, { readOnlyHint: true });
  assert.equal(await c.close(), 0);
  assert.match(c.stderr, /exposing 6\/12 tools/);
  assert.match(c.stderr, /delete_note \(annotated destructiveHint: true\)/);
  assert.match(c.stderr, /frobnicate \(unclassified/);
});

test('a blocked tools/call is answered by the proxy and never reaches the server', async () => {
  const dir = tmp();
  const logFile = join(dir, 'calls.log');
  const c = new Client(['--', process.execPath, SERVER], { NOTES_CALL_LOG: logFile });
  await c.init();
  await c.request(1, 'tools/list');
  const del = await c.request('del-1', 'tools/call', { name: 'delete_note', arguments: { id: '1' } });
  assert.equal(del.id, 'del-1', 'string id preserved');
  assert.equal(del.result.isError, true);
  assert.match(del.result.content[0].text, /blocked tool "delete_note": annotated destructiveHint: true/);
  const list = await c.request(2, 'tools/call', { name: 'list_notes', arguments: {} });
  assert.match(list.result.content[0].text, /1: buy milk/, 'note 1 still exists');
  await c.close();
  assert.deepEqual(readFileSync(logFile, 'utf8').trim().split(/\r?\n/), ['list_notes']);
  assert.match(c.stderr, /refused tools\/call "delete_note"/);
});

test('calls made before any tools/list are judged by name alone', async () => {
  const dir = tmp();
  const logFile = join(dir, 'calls.log');
  const c = new Client(['--', process.execPath, SERVER], { NOTES_CALL_LOG: logFile });
  await c.init();
  const cr = await c.request(5, 'tools/call', { name: 'create_note', arguments: { text: 'x' } });
  assert.equal(cr.result.isError, true);
  assert.match(cr.result.content[0].text, /write verb "create"/);
  const g = await c.request(6, 'tools/call', { name: 'get_note', arguments: { id: '2' } });
  assert.equal(g.result.content[0].text, 'call mom');
  await c.close();
  assert.deepEqual(readFileSync(logFile, 'utf8').trim().split(/\r?\n/), ['get_note']);
});

test('notifications, pings and other methods pass through unchanged', async () => {
  const c = new Client(['--', process.execPath, SERVER]);
  await c.init();
  const note = await c.waitFor((m) => m.method === 'notifications/message');
  assert.equal(note.params.data, 'notes-server ready');
  assert.deepEqual((await c.request(9, 'ping')).result, {});
  const nf = await c.request(10, 'resources/list');
  assert.equal(nf.error.code, -32601);
  await c.close();
});

test('review M3: unparseable client lines are answered locally with -32700 and never forwarded', async () => {
  const dir = tmp();
  const logFile = join(dir, 'calls.log');
  const c = new Client(['--', process.execPath, SERVER], { NOTES_CALL_LOG: logFile });
  await c.init();
  // invalid JSON that a lenient server parser might still act on
  c.send('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"delete_note","arguments":{"id":"1"}},}');
  const pe = await c.waitFor((m) => m.error?.code === -32700);
  assert.deepEqual(pe, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  // a BOM-prefixed line is parsed (not rejected, not forwarded raw) and the blocked call is refused
  c.send('\uFEFF' + JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'delete_note', arguments: { id: '1' } } }));
  const bom = await c.waitFor((m) => m.id === 8);
  assert.equal(bom.result.isError, true);
  assert.match(bom.result.content[0].text, /blocked tool "delete_note"/);
  // L8: a tools/call notification (no id) is dropped, allowed or not
  c.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'delete_note', arguments: { id: '2' } } });
  c.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_note', arguments: { id: '2' } } });
  // a batch mixing an allowed request and a blocked notification forwards only the request
  c.send([
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'create_note', arguments: { text: 'x' } } },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_note', arguments: { id: '2' } } },
  ]);
  const g = await c.waitFor((m) => m.id === 9);
  assert.equal(g.result.content[0].text, 'call mom');
  await c.close();
  // stderr is a separate pipe: check it only after the proxy has exited
  assert.match(c.stderr, /unparseable client message/);
  assert.match(c.stderr, /dropped tools\/call "delete_note" sent as a notification/);
  assert.deepEqual(readFileSync(logFile, 'utf8').trim().split(/\r?\n/), ['get_note'], 'only the allowed request reached the server');
});

test('--allow, --deny and MCP_READONLY_DENY change the exposed set', async () => {
  const c = new Client(['--allow', 'delete_note,create_*', '--deny', 'count_words', '--', process.execPath, SERVER], { MCP_READONLY_DENY: 'show_tally' });
  await c.init();
  const r = await c.request(1, 'tools/list');
  assert.deepEqual(names(r), ['list_notes', 'get_note', 'search_notes', 'create_note', 'delete_note', 'clear_cache']);
  const d = await c.request(2, 'tools/call', { name: 'delete_note', arguments: { id: '1' } });
  assert.equal(d.result.content[0].text, 'deleted 1');
  const w = await c.request(3, 'tools/call', { name: 'count_words', arguments: {} });
  assert.match(w.result.content[0].text, /matches --deny "count_words"/);
  await c.close();
});

test('--config file works and --show-blocked keeps tools listed but refuses them', async () => {
  const dir = tmp();
  const cfg = join(dir, 'ro.json');
  writeFileSync(cfg, JSON.stringify({ allow: ['frobnicate'], showBlocked: true, distrustAnnotations: true }));
  const c = new Client(['--config', cfg, '--', process.execPath, SERVER]);
  await c.init();
  const r = await c.request(1, 'tools/list');
  assert.equal(r.result.tools.length, 12);
  const del = r.result.tools.find((t) => t.name === 'delete_note');
  assert.match(del.description, /^\[BLOCKED by mcp-readonly: annotated destructiveHint: true\] Delete a note\./);
  const cc = r.result.tools.find((t) => t.name === 'clear_cache');
  assert.match(cc.description, /BLOCKED.*readOnlyHint: true ignored by --distrust-annotations/);
  assert.ok(!r.result.tools.find((t) => t.name === 'frobnicate').description.includes('BLOCKED'));
  const call = await c.request(2, 'tools/call', { name: 'clear_cache', arguments: {} });
  assert.equal(call.result.isError, true);
  await c.close();
});

test('heuristics alone protect a server with no annotations', async () => {
  const c = new Client(['--', process.execPath, SERVER, '--no-annotations']);
  await c.init();
  const r = await c.request(1, 'tools/list');
  // clear_cache loses its (misleading) readOnlyHint and is now blocked by name
  assert.deepEqual(names(r), ['list_notes', 'get_note', 'search_notes', 'count_words', 'show_tally']);
  await c.close();
  assert.match(c.stderr, /delete_note \(no readOnlyHint; name contains write verb "delete"\)/);
});

test('paginated tools/list is filtered page by page and nextCursor is kept', async () => {
  const c = new Client(['--', process.execPath, SERVER, '--page-size', '5']);
  await c.init();
  const p1 = await c.request(1, 'tools/list');
  assert.deepEqual(names(p1), ['list_notes', 'get_note', 'search_notes', 'count_words']);
  assert.equal(p1.result.nextCursor, '5');
  const p2 = await c.request(2, 'tools/list', { cursor: '5' });
  assert.deepEqual(names(p2), ['clear_cache']);
  assert.equal(p2.result.nextCursor, '10');
  const p3 = await c.request(3, 'tools/list', { cursor: '10' });
  assert.deepEqual(names(p3), ['show_tally']);
  assert.equal(p3.result.nextCursor, undefined);
  await c.close();
});

test('JSON-RPC batches: blocked calls are answered locally, the rest is forwarded', async () => {
  const dir = tmp();
  const logFile = join(dir, 'calls.log');
  const c = new Client(['--', process.execPath, SERVER], { NOTES_CALL_LOG: logFile });
  await c.init();
  c.send([
    { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'delete_note', arguments: { id: '1' } } },
    { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'count_words', arguments: {} } },
  ]);
  const a = await c.waitFor((m) => m.id === 'a');
  const b = await c.waitFor((m) => m.id === 'b');
  assert.equal(a.result.isError, true);
  assert.equal(b.result.content[0].text, '4');
  await c.close();
  assert.deepEqual(readFileSync(logFile, 'utf8').trim().split(/\r?\n/), ['count_words']);
});

test('server exit code is propagated when the server dies', async () => {
  const c = new Client(['--', process.execPath, SERVER, '--exit-after-init', '3']);
  const init = await c.request(0, 'initialize', {});
  assert.equal(init.result.serverInfo.name, 'notes-server');
  assert.equal(await c.exited, 3);
});

test('a missing server command exits 127 with a clear message', async () => {
  const c = new Client(['--', 'definitely-not-a-real-binary-xyz']);
  assert.equal(await c.exited, 127);
  assert.match(c.stderr, /failed to start server "definitely-not-a-real-binary-xyz"/);
  assert.equal(existsSync('definitely-not-a-real-binary-xyz'), false);
});

test('review: "failed to start server" shows the command name, never its arguments (API keys)', async () => {
  const secret = 'sk-live-SECRET-0123456789';
  const p = await run(['--', 'definitely-not-a-real-binary-xyz', '--api-key', secret, `--token=${secret}`]);
  assert.equal(p.code, 127);
  assert.equal(p.stderr.trim(), 'mcp-readonly: failed to start server "definitely-not-a-real-binary-xyz": ENOENT (command not found)');
  const a = await run(['audit', '--', 'definitely-not-a-real-binary-xyz', '--api-key', secret]);
  assert.equal(a.code, 1);
  assert.equal(a.stderr.trim(), 'mcp-readonly audit: failed to start server "definitely-not-a-real-binary-xyz": ENOENT (command not found)');
  assert.doesNotMatch(p.stderr + a.stderr + p.stdout + a.stdout, /SECRET/);
});

