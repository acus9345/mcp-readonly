#!/usr/bin/env node
// A tiny, dependency-free MCP server over stdio (newline-delimited JSON-RPC) used by the
// mcp-readonly tests and quick start. It keeps notes in memory and has a mix of read and
// write tools, some annotated, some not.
//
// Flags:
//   --no-annotations        strip every tool annotation (exercises the name heuristics)
//   --page-size <n>         paginate tools/list with nextCursor
//   --exit-after-init <n>   exit with code <n> right after answering initialize
// Env:
//   NOTES_CALL_LOG=<file>   append the name of every tools/call that reaches the server

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const notes = new Map([
  ['1', 'buy milk'],
  ['2', 'call mom'],
]);
let nextId = 3;

const TOOLS = [
  { name: 'list_notes', description: 'List all notes.', annotations: { readOnlyHint: true } },
  { name: 'get_note', description: 'Get one note by id.', props: { id: 'string' } },
  { name: 'search_notes', description: 'Search notes by text.', props: { q: 'string' }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'count_words', description: 'Count words across all notes.' },
  { name: 'create_note', description: 'Create a note.', props: { text: 'string' } },
  { name: 'update_note', description: 'Change the text of a note.', props: { id: 'string', text: 'string' }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'delete_note', description: 'Delete a note.', props: { id: 'string' }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'clear_cache', description: 'Drop the server cache (annotated read-only on purpose, to show a contradiction).', annotations: { readOnlyHint: true } },
  { name: 'sync', description: 'Synchronises notes with the cloud.' },
  { name: 'reindex', description: 'Writes a fresh search index to disk.' },
  { name: 'show_tally', description: 'Reads the number of notes.' },
  { name: 'frobnicate', description: 'Frobnicates the notes.' },
];

function toolList() {
  return TOOLS.map((t) => {
    const out = {
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(t.props ?? {}).map(([k, type]) => [k, { type }])) },
    };
    if (t.annotations && !flag('--no-annotations')) out.annotations = t.annotations;
    return out;
  });
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

function callTool(name, args = {}) {
  if (process.env.NOTES_CALL_LOG) appendFileSync(process.env.NOTES_CALL_LOG, name + '\n');
  switch (name) {
    case 'list_notes':
      return text([...notes].map(([id, t]) => `${id}: ${t}`).join('\n'));
    case 'get_note':
      return notes.has(args.id) ? text(notes.get(args.id)) : { ...text(`no note ${args.id}`), isError: true };
    case 'search_notes':
      return text([...notes.values()].filter((t) => t.includes(args.q ?? '')).join('\n'));
    case 'count_words':
      return text(String([...notes.values()].join(' ').split(/\s+/).filter(Boolean).length));
    case 'create_note': {
      const id = String(nextId++);
      notes.set(id, String(args.text ?? ''));
      return text(`created ${id}`);
    }
    case 'update_note':
      notes.set(args.id, String(args.text ?? ''));
      return text(`updated ${args.id}`);
    case 'delete_note':
      notes.delete(args.id);
      return text(`deleted ${args.id}`);
    case 'clear_cache':
      return text('cache cleared');
    case 'sync':
      return text('synced');
    case 'reindex':
      return text('reindexed');
    case 'show_tally':
      return text(String(notes.size));
    case 'frobnicate':
      return text('frobnicated');
    default:
      return null;
  }
}

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

function handle(m) {
  if (m.method === undefined) return; // a response from the client; ignore
  const reply = (result) => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, result });
  const fail = (code, message) => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  switch (m.method) {
    case 'initialize':
      reply({
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false }, logging: {} },
        serverInfo: { name: 'notes-server', version: '1.0.0' },
      });
      if (opt('--exit-after-init') !== undefined) process.exit(Number(opt('--exit-after-init')));
      return;
    case 'notifications/initialized':
      send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'notes-server ready' } });
      return;
    case 'ping':
      return reply({});
    case 'tools/list': {
      const all = toolList();
      const size = Number(opt('--page-size') ?? all.length);
      const start = Number(m.params?.cursor ?? 0);
      const page = all.slice(start, start + size);
      const result = { tools: page };
      if (start + size < all.length) result.nextCursor = String(start + size);
      return reply(result);
    }
    case 'tools/call': {
      const r = callTool(m.params?.name, m.params?.arguments);
      return r ? reply(r) : fail(-32602, `unknown tool ${m.params?.name}`);
    }
    default:
      return fail(-32601, `method not found: ${m.method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  if (Array.isArray(m)) m.forEach(handle);
  else handle(m);
});
