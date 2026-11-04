/**
 * Starting and stopping the wrapped server without a shell.
 *
 * POSIX: the command is spawned directly (never through /bin/sh) in its own process group, so the
 * whole tree (e.g. npx -> node server) can be signalled at once.
 *
 * Windows: the command is resolved through PATH + PATHEXT ourselves. .exe/.com files are spawned
 * directly, so arguments are quoted by libuv for the MSVC runtime and never seen by cmd.exe.
 * .cmd/.bat files (npx.cmd, npm shims) cannot be spawned without a shell since Node 18.20.2 / 20.12.2
 * (CVE-2024-27980), so they run as `cmd.exe /d /s /v:off /c "<line>"` where every argument is quoted and
 * every cmd metacharacter (including % ^ & | < > " :) is caret-escaped: once for the cmd.exe /c line, and
 * once more for batch files that re-parse their arguments through %* (npx.cmd, npm shims; see forwardsAllArgs,
 * https://qntm.org/cmd and cross-spawn).
 * `shell: true` is never used.
 */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface PlatformOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** File-existence check, injectable for tests. */
  isFile?: (p: string) => boolean;
  /** Read a batch file's text (null if unreadable), injectable for tests. */
  readFile?: (p: string) => string | null;
}

export interface SpawnPlan {
  file: string;
  args: string[];
  /** true when args[4] is a pre-escaped cmd.exe command line. */
  windowsVerbatimArguments: boolean;
  /** true when the target is a .cmd/.bat that is run through cmd.exe. */
  viaCmd: boolean;
  /** viaCmd only: arguments were caret-escaped twice, for a batch file that re-parses them through %*. */
  doubleEscaped: boolean;
  /** POSIX: own process group, so the tree can be killed. */
  detached: boolean;
}

// ':' is included because cmd.exe ends a variable name at ':' in %VAR:a=b% and %VAR:~0,5%,
// so `^%PATH:\=/^%` would still expand PATH; `^%PATH^:\=/^%` names the undefined variable "PATH^".
const META = /([()\][%!^"`<>&|;, *?:])/g;
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const RUNNABLE_EXTS = new Set(['.com', '.exe', '.bat', '.cmd']);

const defaultIsFile = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Read an env var case-insensitively, as Windows does. */
export function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** Quote one argument for the MSVC argv parser, then caret-escape cmd.exe metacharacters (once or twice). */
export function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  let a = String(arg);
  // backslashes before a quote are doubled and the quote is escaped; trailing backslashes are doubled
  a = a.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, '$1$1');
  a = `"${a}"`;
  a = a.replace(META, '^$1');
  if (doubleEscape) a = a.replace(META, '^$1');
  return a;
}

/** Caret-escape the command path itself (it is not quoted, so spaces become ^ ). */
export function escapeCmdCommand(cmd: string): string {
  // a leading drive colon (C:) is left as is; every other ':' is escaped like in arguments
  const drive = /^[a-zA-Z]:/.exec(cmd)?.[0] ?? '';
  return drive + cmd.slice(drive.length).replace(META, '^$1');
}

const defaultReadFile = (p: string): string | null => {
  try {
    return readFileSync(p, 'latin1');
  } catch {
    return null;
  }
};

/** Package-manager shims that forward their arguments with %* (npm, npx, pnpm, yarn, corepack). */
const FORWARDER_NAMES = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'corepack']);

/**
 * Does this batch file hand its arguments to another command line through %* (so they are parsed by cmd.exe a
 * second time and need a second level of caret escaping)? True for package-manager shims, anything in
 * node_modules\.bin, any file whose text contains %*, and, to stay safe, any file we cannot read.
 */
export function forwardsAllArgs(file: string, readFile: (p: string) => string | null = defaultReadFile): boolean {
  const base = path.win32.basename(file).toLowerCase().replace(/\.(cmd|bat)$/, '');
  if (FORWARDER_NAMES.has(base)) return true;
  if (/[\\/]node_modules[\\/]\.bin[\\/]/i.test(file)) return true;
  const text = readFile(file);
  return text === null || text.includes('%*');
}

/** Resolve a command like `npx` to `C:\Program Files\nodejs\npx.cmd` using PATH and PATHEXT. */
export function resolveWindowsCommand(cmd: string, opts: PlatformOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const isFile = opts.isFile ?? defaultIsFile;
  const w = path.win32;
  const exts = (envGet(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim())
    // only things we know how to start; .js/.vbs/.wsf etc. would go to Windows Script Host
    .filter((e) => RUNNABLE_EXTS.has(e.toLowerCase()));
  const hasKnownExt = exts.some((e) => e.toLowerCase() === w.extname(cmd).toLowerCase());
  const candidatesIn = (base: string) => (hasKnownExt ? [base] : exts.map((e) => base + e.toLowerCase()));
  const hasDir = /[\\/]/.test(cmd) || /^[a-zA-Z]:/.test(cmd);
  const dirs = hasDir
    ? [w.resolve(opts.cwd ?? process.cwd(), cmd)]
    : (envGet(env, 'PATH') ?? '')
        .split(';')
        .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean)
        .map((d) => w.join(d, cmd));
  for (const base of dirs) for (const c of candidatesIn(base)) if (isFile(c)) return c;
  return null;
}

/**
 * One-line reason a server could not be started. Built only from the command name and an error code or our own
 * message: never from err.message of child_process errors, which can echo argument values (API keys, tokens).
 */
export function startErrorMessage(command: string[], err: unknown): string {
  const name = command[0] ?? '';
  let detail: string;
  if (err instanceof SpawnError) detail = err.message;
  else {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const hint: Record<string, string> = { ENOENT: 'command not found', EACCES: 'permission denied', EPERM: 'not permitted' };
    detail = typeof code === 'string' ? (hint[code] ? `${code} (${hint[code]})` : code) : (err as Error | undefined)?.name ?? 'error';
  }
  return `failed to start server "${name}": ${detail}`;
}

/** A server command that cannot be started; `code` mirrors the errno spawn would report (ENOENT, EINVAL). */
export class SpawnError extends Error {
  constructor(
    message: string,
    readonly code: 'ENOENT' | 'EINVAL',
  ) {
    super(message);
    this.name = 'SpawnError';
  }
}

/** Work out exactly what to hand to child_process.spawn for a server command. Pure; no I/O except isFile. */
export function planSpawn(command: string[], opts: PlatformOptions = {}): SpawnPlan {
  const [cmd, ...args] = command;
  if (!cmd) throw new SpawnError('no server command given (put it after --)', 'EINVAL');
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { file: cmd, args, windowsVerbatimArguments: false, viaCmd: false, doubleEscaped: false, detached: true };

  const env = opts.env ?? process.env;
  const found = resolveWindowsCommand(cmd, opts);
  const resolved = found ?? cmd;
  const ext = path.win32.extname(resolved).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') {
    // not found: spawn reports ENOENT itself, asynchronously
    return { file: resolved, args, windowsVerbatimArguments: false, viaCmd: false, doubleEscaped: false, detached: false };
  }
  // a missing batch file must not reach cmd.exe (it would print its own message and exit 1)
  if (found === null) throw new SpawnError('ENOENT (command not found)', 'ENOENT');
  const bad = args.find((a) => /[\r\n\0]/.test(a));
  if (bad !== undefined) {
    throw new SpawnError(`cannot pass an argument containing a line break or NUL to the batch file ${resolved}`, 'EINVAL');
  }
  // %* forwarders (npx.cmd, npm shims) re-parse the arguments, so they get two levels of escaping. Other batch
  // files read %1 / "%~1", where a second level would leave carets in the value, so they get one.
  const doubleEscaped = forwardsAllArgs(resolved, opts.readFile);
  if (!doubleEscaped && args.some((a) => a.includes('"'))) {
    // in "%~1" a quote inside the value would end cmd.exe's quoting, and nothing can escape it there
    throw new SpawnError(
      `cannot pass an argument containing a double quote to the batch file ${resolved} (it reads %1-style arguments, not %*)`,
      'EINVAL',
    );
  }
  const line = [escapeCmdCommand(path.win32.normalize(resolved)), ...args.map((a) => escapeCmdArgument(a, doubleEscaped))].join(' ');
  const comspec = envGet(env, 'ComSpec') ?? path.win32.join(envGet(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'cmd.exe');
  return { file: comspec, args: ['/d', '/s', '/v:off', '/c', `"${line}"`], windowsVerbatimArguments: true, viaCmd: true, doubleEscaped, detached: false };
}

function sweepGroup(pid: number): void {
  try {
    process.kill(-pid, 0);
  } catch {
    return; // group is empty: nothing to sweep, and nothing to hit by mistake
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // raced with the last member exiting
  }
}

type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;

export interface ServerProcess {
  child: ChildProcessWithoutNullStreams;
  plan: SpawnPlan;
  /** Resolves when the process has exited and its stdio is closed. */
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Send a signal to the whole tree (POSIX process group; Windows: taskkill /T /F). */
  killTree(signal?: NodeJS.Signals): void;
  /** End stdin, wait graceMs for a clean exit, then kill the tree. Never hangs. */
  stop(graceMs: number): Promise<void>;
}

export function spawnServer(
  command: string[],
  stderr: 'pipe' | 'inherit',
  opts: PlatformOptions & { spawnFn?: SpawnFn } = {},
): ServerProcess {
  const platform = opts.platform ?? process.platform;
  const plan = planSpawn(command, opts);
  const spawnFn: SpawnFn = opts.spawnFn ?? (spawn as unknown as SpawnFn);
  const child = spawnFn(plan.file, plan.args, {
    stdio: ['pipe', 'pipe', stderr],
    env: opts.env ?? process.env,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    windowsHide: true,
    detached: plan.detached,
  });
  let isClosed = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      isClosed = true;
      // POSIX: the server led its own process group. If that group still has members right now
      // (e.g. a grandchild that outlived npx), kill them in the same tick. A pgid cannot be reused
      // while it has members, so the probe and the kill target the same group; we never signal the
      // group later, when the id could belong to someone else.
      if (plan.detached && !opts.spawnFn && child.pid) sweepGroup(child.pid);
      resolve({ code, signal });
    }),
  );
  closed.catch(() => {});
  const killTree = (signal: NodeJS.Signals = 'SIGKILL') => killProcessTree(child, signal, platform, opts.env, spawnFn);
  const wait = (ms: number) =>
    Promise.race([closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
  const stop = async (graceMs: number) => {
    if (!child.stdin.destroyed) child.stdin.end();
    if (!isClosed && !(await wait(graceMs))) {
      if (platform === 'win32') killTree('SIGKILL');
      else {
        killTree('SIGTERM');
        if (!(await wait(1000))) killTree('SIGKILL');
      }
      if (!(await wait(3000))) {
        child.stdout.destroy();
        child.stderr?.destroy();
      }
    }
  };
  return { child, plan, closed, killTree, stop };
}

/** Kill a child and everything it started. */
export function killProcessTree(
  child: { pid?: number | undefined; kill(signal?: NodeJS.Signals): boolean },
  signal: NodeJS.Signals = 'SIGKILL',
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  spawnFn: SpawnFn = spawn as unknown as SpawnFn,
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === 'win32') {
    const taskkill = path.win32.join(envGet(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    try {
      const k = spawnFn(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on('error', () => safeKill(child, signal));
    } catch {
      safeKill(child, signal);
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    safeKill(child, signal);
  }
}

function safeKill(child: { kill(signal?: NodeJS.Signals): boolean }, signal: NodeJS.Signals) {
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

export function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const table: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return signal ? 128 + (table[signal] ?? 1) : 1;
}
