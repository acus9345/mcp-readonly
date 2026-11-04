#!/usr/bin/env node
// A server that, before answering initialize, sends the client three requests (ping, roots/list,
// sampling/createMessage) and reports the replies it got back in serverInfo.version (as JSON).
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const asks = ['ping', 'roots/list', 'sampling/createMessage'];
const replies = {};
let initId = null;

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    initId = m.id;
    asks.forEach((method, i) => send({ jsonrpc: '2.0', id: `ask-${i}`, method, params: {} }));
  } else if (typeof m.id === 'string' && m.id.startsWith('ask-')) {
    replies[asks[Number(m.id.slice(4))]] = m.error ? { error: m.error.code } : { result: m.result };
    if (Object.keys(replies).length === asks.length) {
      send({
        jsonrpc: '2.0',
        id: initId,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'asking', version: JSON.stringify(replies) } },
      });
    }
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
  }
});
