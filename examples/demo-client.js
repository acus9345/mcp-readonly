#!/usr/bin/env node
// Minimal MCP client for the quick start: spawns the command after "--", runs the handshake,
// lists tools, then calls each tool named with --call (JSON args with --args), printing results.
//   node demo-client.js --call list_notes --call delete_note --args '{"id":"1"}' -- <server command...>
import { spawnServer } from '../dist/proc.js';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) {
  console.error('usage: demo-client.js [--call <tool> [--args <json>]]... -- <server command...>');
  process.exit(2);
}
const calls = [];
for (let i = 0; i < sep; i++) {
  if (argv[i] === '--call') calls.push({ name: argv[++i], arguments: {} });
  else if (argv[i] === '--args' && calls.length) calls[calls.length - 1].arguments = JSON.parse(argv[++i]);
}
const [cmd, ...args] = argv.slice(sep + 1);
// spawnServer never uses a shell: .exe files are spawned directly and .cmd shims (npx.cmd) go through a
// fully escaped cmd.exe line on Windows, so arguments arrive verbatim.
const server = spawnServer([cmd, ...args], 'inherit');
const child = server.child;
const pending = new Map();
let id = 0;
createInterface({ input: child.stdout }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const request = (method, params) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });

await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo-client', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const list = await request('tools/list', {});
console.log('tools:', list.result.tools.map((t) => t.name).join(', '));
for (const c of calls) {
  const r = await request('tools/call', c);
  const body = r.error ? `error ${JSON.stringify(r.error)}` : `${r.result.isError ? '[isError] ' : ''}${r.result.content.map((x) => x.text).join(' ')}`;
  console.log(`${c.name}: ${body}`);
}
await server.stop(3000);
