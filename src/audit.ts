import { classifyTool, defaultPolicy, type Policy, type ToolInfo, type Verdict } from './classify.js';
import { LineSplitter, stripBom, tryParse } from './framing.js';
import { isObject, isResponse, type RpcMessage } from './jsonrpc.js';
import { spawnServer, SpawnError, startErrorMessage, type ServerProcess } from './proc.js';

export interface AuditEntry {
  name: string;
  allowed: boolean;
  source: Verdict['source'];
  reason: string;
  warnings: string[];
  annotations?: unknown;
}

export interface AuditResult {
  server?: { name?: string; version?: string };
  protocolVersion?: string;
  tools: AuditEntry[];
}

export class AuditError extends Error {
  /** Process exit code for the CLI: 1 = the server failed, 2 = the command line cannot be run as given. */
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
    this.name = 'AuditError';
  }
}

/** Start the server, run the MCP handshake, page through tools/list and classify every tool. */
export async function audit(
  command: string[],
  policy: Policy = defaultPolicy,
  timeoutMs = 20_000,
  graceMs = 1000,
): Promise<AuditResult> {
  let server: ServerProcess;
  try {
    server = spawnServer(command, 'pipe');
  } catch (e) {
    // one clean line, never err.message from child_process (it can echo argument values)
    throw new AuditError(startErrorMessage(command, e), e instanceof SpawnError && e.code === 'ENOENT' ? 1 : 2);
  }
  const child = server.child;
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-4000);
  });
  child.stdin.on('error', () => {});
  const pending = new Map<number, (m: RpcMessage) => void>();
  let failed: ((e: Error) => void)[] = [];
  const fail = (e: Error) => {
    for (const f of failed) f(e);
    failed = [];
  };
  child.on('error', (e) => fail(new AuditError(startErrorMessage(command, e))));
  const onClose = (code: number | null) =>
    fail(new AuditError(`server exited (code ${code}) before answering${stderr.trim() ? `; stderr:\n${stderr.trim()}` : ''}`));
  child.on('close', onClose);
  const splitter = new LineSplitter((line) => {
    const p = tryParse(stripBom(line));
    if (!p.ok) return;
    const list = Array.isArray(p.value) ? p.value : [p.value];
    for (const m of list) {
      if (isResponse(m) && typeof m.id === 'number') {
        pending.get(m.id)?.(m);
        pending.delete(m.id);
      } else if (isObject(m) && typeof m.method === 'string' && 'id' in m) {
        // server→client request: answer ping; we declare no client capabilities, so anything else
        // (roots/list, sampling/createMessage, elicitation/create) is "method not found", not a fake success
        const reply =
          m.method === 'ping'
            ? { jsonrpc: '2.0', id: m.id, result: {} }
            : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
        child.stdin.write(JSON.stringify(reply) + '\n');
      }
    }
  });
  child.stdout.on('data', (c: Buffer) => splitter.push(c));

  let nextId = 1;
  const request = (method: string, params: unknown): Promise<RpcMessage> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new AuditError(`timed out after ${timeoutMs} ms waiting for ${method}`)), timeoutMs);
      failed.push((e) => {
        clearTimeout(timer);
        reject(e);
      });
      pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new AuditError(`${method} failed: ${JSON.stringify(m.error)}`));
        else resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  try {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-readonly-audit', version: '1' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const r = isObject(init.result) ? init.result : {};
    const out: AuditResult = { tools: [] };
    if (isObject(r.serverInfo)) out.server = r.serverInfo as AuditResult['server'] & object;
    if (typeof r.protocolVersion === 'string') out.protocolVersion = r.protocolVersion;
    let cursor: unknown;
    for (let page = 0; page < 100; page++) {
      const res = await request('tools/list', cursor === undefined ? {} : { cursor });
      const body = isObject(res.result) ? res.result : {};
      for (const t of Array.isArray(body.tools) ? body.tools : []) {
        if (!isObject(t) || typeof t.name !== 'string') continue;
        const v = classifyTool(t as ToolInfo, policy);
        const e: AuditEntry = { name: t.name, allowed: v.allowed, source: v.source, reason: v.reason, warnings: v.warnings };
        if (t.annotations !== undefined) e.annotations = t.annotations;
        out.tools.push(e);
      }
      cursor = body.nextCursor;
      if (typeof cursor !== 'string' || cursor === '') break;
    }
    return out;
  } finally {
    child.removeListener('close', onClose);
    await server.stop(graceMs);
  }
}

export function formatAudit(r: AuditResult): string {
  const lines: string[] = [];
  const who = r.server ? `${r.server.name ?? '?'}${r.server.version ? '@' + r.server.version : ''}` : 'server';
  const blocked = r.tools.filter((t) => !t.allowed).length;
  lines.push(`${who}: ${r.tools.length} tools, ${r.tools.length - blocked} allowed, ${blocked} blocked`);
  const w = Math.max(4, ...r.tools.map((t) => t.name.length));
  for (const t of r.tools) {
    lines.push(`  ${t.allowed ? 'allow' : 'BLOCK'}  ${t.name.padEnd(w)}  ${t.reason}`);
    for (const warn of t.warnings) lines.push(`         ${''.padEnd(w)}  warning: ${warn}`);
  }
  return lines.join('\n');
}
