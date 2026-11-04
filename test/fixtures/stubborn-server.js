#!/usr/bin/env node
// A badly behaved MCP server for shutdown tests: it ignores stdin EOF, SIGTERM and SIGINT, and keeps running.
// With --spawn-child it starts a grandchild (the process that actually serves MCP) that shares its stdio,
// like `npx` -> `node server.js`. Every process appends its pid to $STUBBORN_PID_FILE.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.env.STUBBORN_PID_FILE) appendFileSync(process.env.STUBBORN_PID_FILE, `${process.pid}\n`);
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.on('SIGHUP', () => {});
setInterval(() => {}, 1000);

if (process.argv.includes('--spawn-child')) {
  spawn(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit' });
} else {
  let buf = '';
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.id === undefined) continue;
      const result =
        m.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stubborn', version: '1' } }
          : m.method === 'tools/list'
            ? { tools: [{ name: 'get_time', inputSchema: { type: 'object' } }] }
            : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
    }
  });
  process.stdin.on('end', () => {
    /* deliberately ignored */
  });
}
