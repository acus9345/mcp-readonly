import type { Readable, Writable } from 'node:stream';
import { classifyTool, defaultPolicy, type Policy, type ToolInfo, type Verdict } from './classify.js';
import { LineSplitter, stripBom, tryParse } from './framing.js';
import { idKey, isNotification, isObject, isRequest, isResponse, type RpcMessage } from './jsonrpc.js';
import { exitCodeFor, spawnServer, SpawnError, startErrorMessage, type ServerProcess } from './proc.js';

export interface ProxyOptions {
  command: string[];
  policy?: Policy;
  /** Keep blocked tools in tools/list (description prefixed) instead of hiding them. Calls are still refused. */
  showBlocked?: boolean;
  /** Where client messages come from / server messages go. Default: process stdin/stdout. */
  input?: Readable;
  output?: Writable;
  /** Diagnostics sink (never stdout, which carries the protocol). Default: process.stderr. */
  log?: (line: string) => void;
  /** After the client closes stdin, how long the server gets to exit before its process tree is killed. Default 3000. */
  graceMs?: number;
}

export const BLOCK_PREFIX = 'mcp-readonly';

export function blockedText(name: string, v: Verdict): string {
  return (
    `${BLOCK_PREFIX} blocked tool "${name}": ${v.reason}. This MCP server is running in read-only mode, ` +
    `so tools that may change state are not available. If this call is intended, ask the user to allow it ` +
    `(mcp-readonly --allow ${name}).`
  );
}

/**
 * Filter one tools/list result in place-safe fashion; returns the new result (or the same object if unchanged)
 * plus the verdict for every tool.
 */
export function filterToolsResult(
  result: unknown,
  policy: Policy,
  showBlocked: boolean,
): { result: unknown; verdicts: Map<string, Verdict>; changed: boolean } {
  const verdicts = new Map<string, Verdict>();
  if (!isObject(result) || !Array.isArray(result.tools)) return { result, verdicts, changed: false };
  const kept: unknown[] = [];
  let changed = false;
  for (const t of result.tools) {
    if (!isObject(t) || typeof t.name !== 'string') {
      kept.push(t);
      continue;
    }
    const v = classifyTool(t as ToolInfo, policy);
    verdicts.set(t.name, v);
    if (v.allowed) kept.push(t);
    else if (showBlocked) {
      changed = true;
      const desc = typeof t.description === 'string' ? t.description : '';
      kept.push({ ...t, description: `[BLOCKED by mcp-readonly: ${v.reason}] ${desc}`.trim() });
    } else changed = true;
  }
  return { result: changed ? { ...result, tools: kept } : result, verdicts, changed };
}

/**
 * Run the read-only proxy: spawn the server, forward stdio line by line, filter tools/list
 * responses and answer blocked tools/call requests itself (they never reach the server).
 * Resolves with the server's exit code.
 */
export function runProxy(opts: ProxyOptions): Promise<number> {
  const policy = opts.policy ?? defaultPolicy;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const log = opts.log ?? ((l: string) => process.stderr.write(l + '\n'));
  const listIds = new Set<string>();
  const known = new Map<string, Verdict>();
  let lastSummary = '';

  const verdictFor = (name: string): Verdict => known.get(name) ?? classifyTool({ name }, policy);
  const toClient = (line: string) => output.write(line + '\n');

  return new Promise((resolve) => {
    let server: ServerProcess;
    try {
      server = spawnServer(opts.command, 'inherit');
    } catch (err) {
      // never log err.message from child_process: it can contain argument values (API keys)
      log(`${BLOCK_PREFIX}: ${startErrorMessage(opts.command, err)}`);
      resolve(err instanceof SpawnError && err.code === 'ENOENT' ? 127 : 2);
      return;
    }
    const child = server.child;
    const graceMs = opts.graceMs ?? 3000;
    const toServer = (line: string) => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(line + '\n');
    };

    type Decision = { kind: 'forward'; m: unknown; rewrite: boolean } | { kind: 'reply'; reply: unknown } | { kind: 'drop' };

    const fromClient = (m: unknown): Decision => {
      // tools/call is only valid as a request; as a notification (no id) it gets no answer, so drop it
      if (isNotification(m) && m.method === 'tools/call') {
        const n = isObject(m.params) && typeof m.params.name === 'string' ? m.params.name : '';
        log(`${BLOCK_PREFIX}: dropped tools/call "${n}" sent as a notification (no id)`);
        return { kind: 'drop' };
      }
      if (!isRequest(m)) return { kind: 'forward', m, rewrite: false };
      if (m.method === 'tools/list') listIds.add(idKey(m.id));
      if (m.method !== 'tools/call') return { kind: 'forward', m, rewrite: false };
      const name = isObject(m.params) && typeof m.params.name === 'string' ? m.params.name : '';
      const v = verdictFor(name);
      // re-serialize allowed calls, so the server parses exactly what was checked (no duplicate-key tricks)
      if (v.allowed) return { kind: 'forward', m, rewrite: true };
      log(`${BLOCK_PREFIX}: refused tools/call "${name}" (${v.reason})`);
      return {
        kind: 'reply',
        reply: {
          jsonrpc: '2.0',
          id: m.id,
          result: { content: [{ type: 'text', text: blockedText(name, v) }], isError: true },
        },
      };
    };

    const PARSE_ERROR = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });

    const c2s = new LineSplitter((raw) => {
      const line = stripBom(raw);
      const p = tryParse(line);
      if (!p.ok) {
        // never forward what we could not inspect
        log(`${BLOCK_PREFIX}: answered an unparseable client message with a parse error (not forwarded)`);
        return toClient(PARSE_ERROR);
      }
      if (Array.isArray(p.value)) {
        const forward: unknown[] = [];
        let rewrite = false;
        for (const m of p.value) {
          const d = fromClient(m);
          if (d.kind === 'forward') {
            forward.push(d.m);
            rewrite ||= d.rewrite;
          } else {
            rewrite = true;
            if (d.kind === 'reply') toClient(JSON.stringify(d.reply));
          }
        }
        if (p.value.length === 0 || (forward.length === p.value.length && !rewrite)) toServer(line);
        else if (forward.length) toServer(JSON.stringify(forward));
        return;
      }
      const d = fromClient(p.value);
      if (d.kind === 'forward') toServer(d.rewrite ? JSON.stringify(d.m) : line);
      else if (d.kind === 'reply') toClient(JSON.stringify(d.reply));
    });

    const fromServer = (m: unknown): unknown => {
      if (!isResponse(m) || !listIds.has(idKey(m.id))) return m;
      listIds.delete(idKey(m.id));
      if ((m as RpcMessage).error !== undefined) return m;
      const f = filterToolsResult((m as RpcMessage).result, policy, !!opts.showBlocked);
      for (const [n, v] of f.verdicts) known.set(n, v);
      const blocked = [...f.verdicts].filter(([, v]) => !v.allowed);
      const summary =
        `${BLOCK_PREFIX}: exposing ${f.verdicts.size - blocked.length}/${f.verdicts.size} tools` +
        (blocked.length ? `; ${opts.showBlocked ? 'refusing' : 'hiding'} ${blocked.map(([n, v]) => `${n} (${v.reason})`).join(', ')}` : '');
      if (summary !== lastSummary) log(summary);
      lastSummary = summary;
      for (const [n, v] of f.verdicts) for (const w of v.warnings) log(`${BLOCK_PREFIX}: warning: ${n}: ${w}`);
      return f.changed ? { ...m, result: f.result } : m;
    };

    const s2c = new LineSplitter((raw) => {
      const line = stripBom(raw);
      const p = tryParse(line);
      if (!p.ok) return toClient(line);
      if (Array.isArray(p.value)) {
        const out = p.value.map(fromServer);
        return toClient(out.every((x, i) => x === (p.value as unknown[])[i]) ? line : JSON.stringify(out));
      }
      const r = fromServer(p.value);
      toClient(r === p.value ? line : JSON.stringify(r));
    });

    const onData = (c: Buffer) => c2s.push(c);
    const onEnd = () => {
      c2s.end();
      void server.stop(graceMs);
    };
    // The server runs in its own process group (POSIX), so terminal signals must be forwarded to the group.
    const forward = (sig: NodeJS.Signals) => () => {
      server.killTree(sig);
      void server.stop(graceMs);
    };
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');

    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
      if ('pause' in input) input.pause();
      if (output === process.stdout) output.write('', () => resolve(code));
      else resolve(code);
    };
    child.on('error', (err) => {
      log(`${BLOCK_PREFIX}: ${startErrorMessage(opts.command, err)}`);
      finish(127);
    });
    child.stdin.on('error', () => {
      /* server went away; its exit is reported by "close" */
    });
    input.on('data', onData);
    input.on('end', onEnd);
    child.stdout.on('data', (c: Buffer) => s2c.push(c));
    child.stdout.on('end', () => s2c.end());
    process.once('SIGINT', onInt);
    process.once('SIGTERM', onTerm);
    void server.closed.then(({ code, signal }) => {
      s2c.end();
      finish(exitCodeFor(code, signal));
    });
  });
}
