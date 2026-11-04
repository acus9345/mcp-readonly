#!/usr/bin/env node
// Tiny MCP server with one read-only tool, `argv`, that returns the command-line arguments it received.
// Used to prove arguments reach the server verbatim (no shell splitting, no cmd.exe interpretation).
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
    let result = {};
    if (m.method === 'initialize')
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'argv', version: '1' } };
    else if (m.method === 'tools/list')
      result = { tools: [{ name: 'argv', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }] };
    else if (m.method === 'tools/call')
      result = { content: [{ type: 'text', text: JSON.stringify(process.argv.slice(2)) }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
