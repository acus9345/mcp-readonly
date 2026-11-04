// Against real published servers. Needs network/npm cache, so it only runs with MCP_READONLY_E2E=1.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, run, killAll } from './helpers.js';

after(killAll);

const skip = process.env.MCP_READONLY_E2E !== '1' && 'set MCP_READONLY_E2E=1 to run';

test('server-filesystem: write tools hidden and refused, reads work', { skip, timeout: 180_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ro-fs-')));
  writeFileSync(join(dir, 'a.txt'), 'hello');
  const c = new Client(['--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', dir]);
  await c.request(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, 120_000);
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await c.request(1, 'tools/list', {}, 120_000);
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['write_file', 'edit_file', 'move_file', 'create_directory']) assert.ok(!names.includes(n), n);
  assert.ok(names.includes('read_text_file'));
  const read = await c.request(2, 'tools/call', { name: 'read_text_file', arguments: { path: join(dir, 'a.txt') } });
  assert.equal(read.result.content[0].text, 'hello');
  const w = await c.request(3, 'tools/call', { name: 'write_file', arguments: { path: join(dir, 'b.txt'), content: 'x' } });
  assert.equal(w.result.isError, true);
  assert.equal(existsSync(join(dir, 'b.txt')), false);
  await c.close();
});

test('server-everything audit', { skip, timeout: 180_000 }, async () => {
  const r = await run(['audit', '--timeout', '150000', '--', 'npx', '-y', '@modelcontextprotocol/server-everything']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /BLOCK {2}toggle-simulated-logging/);
  assert.match(r.stdout, /allow {2}echo/);
});
