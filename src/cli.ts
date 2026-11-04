#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defaultPolicy, type Policy } from './classify.js';
import { audit, AuditError, formatAudit } from './audit.js';
import { runProxy } from './proxy.js';

const require = createRequire(import.meta.url);
const VERSION: string = (require('../package.json') as { version: string }).version;

const HELP = `mcp-readonly ${VERSION}
Make any MCP server read-only: a stdio proxy that hides and refuses tools that may write.

Usage:
  mcp-readonly [options] -- <server command...>        run the server behind the read-only proxy
  mcp-readonly audit [options] -- <server command...>  list every tool with its verdict and reason, then exit

Example (MCP client config: replace the server command with this):
  npx -y mcp-readonly -- npx -y @modelcontextprotocol/server-filesystem /tmp

How a tool is judged (first match wins):
  --deny pattern > --allow pattern > destructiveHint: true (block) > readOnlyHint: true (allow)
  > readOnlyHint: false (block) > write/exec verb anywhere in the name (block)
  > write verb anywhere in the description (block, checked for every tool that gets here)
  > read verb as the name's first word, after prefixes like git_/browser_ (allow; nouns such as
    status/history/logs never count, nor do names with query/sql/... or "x_and_<unknown>")
  > unclassified (blocked, unless --unknown allow)

Options:
  --allow <glob>            always allow matching tools (repeatable, comma-separated; * and ? wildcards)
  --deny <glob>             always block matching tools (repeatable, comma-separated; wins over --allow)
  --config <file.json>      {"allow":[],"deny":[],"unknown":"block","distrustAnnotations":false,"showBlocked":false}
  --unknown <block|allow>   what to do with tools nothing can classify (default: block)
  --distrust-annotations    let a write verb in the name override readOnlyHint: true
  --show-blocked            keep blocked tools in tools/list (description says why) but still refuse calls
  --quiet                   no diagnostics on stderr
  --json                    (audit) machine-readable output
  --timeout <ms>            (audit) how long to wait for the server (default: 20000)
  --grace <ms>              after stdin closes, how long the server may take to exit before its whole
                            process tree is killed (default: 3000 proxy, 1000 audit)
  -h, --help                show this help
  -v, --version             show the version

Environment: MCP_READONLY_ALLOW and MCP_READONLY_DENY add comma-separated patterns.
Exit code: the server's exit code (proxy); 0 / 1 on audit success / failure; 2 on usage errors.
`;

class UsageError extends Error {}

interface Parsed {
  command: 'proxy' | 'audit' | 'help' | 'version';
  server: string[];
  policy: Policy;
  showBlocked: boolean;
  quiet: boolean;
  json: boolean;
  timeout: number;
  grace: number | undefined;
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Parsed {
  const p: Parsed = {
    command: 'proxy',
    server: [],
    policy: { ...defaultPolicy, allow: list(env.MCP_READONLY_ALLOW), deny: list(env.MCP_READONLY_DENY) },
    showBlocked: false,
    quiet: false,
    json: false,
    timeout: 20_000,
    grace: undefined,
  };
  let i = 0;
  if (argv[0] === 'audit') {
    p.command = 'audit';
    i = 1;
  } else if (argv[0] === 'proxy' || argv[0] === 'run') i = 1;
  const value = (name: string): string => {
    const v = argv[++i];
    if (v === undefined) throw new UsageError(`${name} needs a value`);
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      p.server = argv.slice(i + 1);
      break;
    }
    if (!a.startsWith('-')) {
      // first positional: the rest is the server command (so `mcp-readonly npx -y srv` works)
      p.server = argv.slice(i);
      break;
    }
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const val = (name: string) => inline ?? value(name);
    switch (flag) {
      case '-h':
      case '--help':
        p.command = 'help';
        return p;
      case '-v':
      case '--version':
        p.command = 'version';
        return p;
      case '--allow':
        p.policy.allow.push(...list(val(flag)));
        break;
      case '--deny':
        p.policy.deny.push(...list(val(flag)));
        break;
      case '--unknown': {
        const v = val(flag);
        if (v !== 'block' && v !== 'allow') throw new UsageError('--unknown must be "block" or "allow"');
        p.policy.unknown = v;
        break;
      }
      case '--distrust-annotations':
        p.policy.distrustAnnotations = true;
        break;
      case '--show-blocked':
        p.showBlocked = true;
        break;
      case '--quiet':
        p.quiet = true;
        break;
      case '--json':
        p.json = true;
        break;
      case '--grace': {
        const n = Number(val(flag));
        if (!Number.isFinite(n) || n < 0) throw new UsageError('--grace must be a number of ms (0 or more)');
        p.grace = n;
        break;
      }
      case '--timeout': {
        const n = Number(val(flag));
        if (!Number.isFinite(n) || n <= 0) throw new UsageError('--timeout must be a positive number of ms');
        p.timeout = n;
        break;
      }
      case '--config':
        applyConfig(p, val(flag));
        break;
      default:
        throw new UsageError(`unknown option ${a}`);
    }
  }
  if (p.server.length === 0) throw new UsageError('missing server command; put it after --, e.g. mcp-readonly -- node server.js');
  return p;
}

function applyConfig(p: Parsed, file: string): void {
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new UsageError(`cannot read config ${file}: ${(e as Error).message}`);
  }
  const strings = (k: string): string[] => {
    const v = c[k];
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new UsageError(`config "${k}" must be an array of strings`);
    return v as string[];
  };
  p.policy.allow.push(...strings('allow'));
  p.policy.deny.push(...strings('deny'));
  if (c.unknown !== undefined) {
    if (c.unknown !== 'block' && c.unknown !== 'allow') throw new UsageError('config "unknown" must be "block" or "allow"');
    p.policy.unknown = c.unknown;
  }
  if (c.distrustAnnotations === true) p.policy.distrustAnnotations = true;
  if (c.showBlocked === true) p.showBlocked = true;
}

async function main(): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`mcp-readonly: ${e.message}\nRun "mcp-readonly --help" for usage.\n`);
      return 2;
    }
    throw e;
  }
  if (p.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (p.command === 'version') {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (p.command === 'audit') {
    try {
      const r = await audit(p.server, p.policy, p.timeout, p.grace ?? 1000);
      process.stdout.write((p.json ? JSON.stringify(r, null, 2) : formatAudit(r)) + '\n');
      return 0;
    } catch (e) {
      if (e instanceof AuditError) {
        process.stderr.write(`mcp-readonly audit: ${e.message}\n`);
        return e.exitCode;
      }
      throw e;
    }
  }
  return runProxy({
    command: p.server,
    policy: p.policy,
    showBlocked: p.showBlocked,
    graceMs: p.grace ?? 3000,
    log: p.quiet ? () => {} : (l) => process.stderr.write(l + '\n'),
  });
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`mcp-readonly: ${(err as Error)?.stack ?? String(err)}\n`);
    process.exit(2);
  },
);
