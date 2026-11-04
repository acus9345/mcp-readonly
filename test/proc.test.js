// Unit tests for the Windows spawn path (run on every OS with platform: 'win32' mocked) and the escaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { escapeCmdArgument, escapeCmdCommand, planSpawn, resolveWindowsCommand, spawnServer, killProcessTree, SpawnError, forwardsAllArgs, startErrorMessage } from '../dist/proc.js';

const require = createRequire(import.meta.url);

// Arguments that broke the old `shell: true` implementation, plus the classic cmd.exe traps.
const NASTY = [
  'plain', 'a b', '', ' ', 'x&echo pwned>canary.txt', 'a&&b', 'p|q', 'a>b', 'a<b', 'a>>b', '%PATH%', '%%', '%', '%~dp0',
  '%=C:%', 'say "hi"', '"', '""', '\\', 'back\\slash\\', 'trail\\\\', '\\"', 'C:\\Program Files\\x', '^', '^^', '^&', 'a^b',
  '!bang!', 'semi;colon', 'com,ma', 'paren(1)', '(', ')', 'star*', 'q?', '`tick`', '[br]', 'tab\tx', '=eq', '-y',
  '@scope/pkg@1.2.3', '"&calc&"', '\\"&calc&\\"', 'a\\" & echo pwned & rem', '%COMSPEC% /c calc', '^"&calc', 'é€😀',
  '{"path":"C:\\\\a b\\\\c.txt"}',
  // %VAR:str=repl% / %VAR:~n,m%: the variable name ends at ':', so a caret before the closing % is not enough
  '%PATH:\\=/%', '%X:a=b%', '%PATH:~0,5%', '%COMSPEC:C="&echo pwned>canary9.txt&rem "%', 'a:b', 'C:\\x', '%:%',
];

/** cmd.exe phase 2 for a line with no unescaped quotes: one level of ^ escapes is consumed. */
const decaret = (s) => s.replace(/\^(.)/gs, '$1');

/** True if cmd.exe would see no unescaped metacharacter (operators, quotes, %) in s. */
function cmdSafe(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '^') {
      i++;
      continue;
    }
    if ('&|<>()"%!'.includes(s[i])) return false;
  }
  return true;
}

/**
 * No %...% pair that cmd.exe could expand. Conservative model of phase 1: every two consecutive % signs
 * (overlapping, since an undefined name leaves its % in place) delimit a candidate; the variable name is the
 * part before the first ':' (%NAME:a=b%, %NAME:~0,5%). It is only harmless if that name contains a caret,
 * which no real variable does, or is empty.
 */
function noPercentExpansion(s) {
  const at = [...s].flatMap((c, i) => (c === '%' ? [i] : []));
  for (let k = 0; k + 1 < at.length; k++) {
    const name = s.slice(at[k] + 1, at[k + 1]).split(':')[0];
    if (name !== '' && !name.includes('^')) return false;
  }
  return true;
}

/** CommandLineToArgvW / MSVC runtime argv parsing (what node.exe does with the line the batch file builds). */
function parseMsvc(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i >= s.length) break;
    let arg = '';
    let inQ = false;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        let n = 0;
        while (s[i] === '\\') {
          n++;
          i++;
        }
        if (s[i] === '"') {
          arg += '\\'.repeat(Math.floor(n / 2));
          if (n % 2) arg += '"';
          else inQ = !inQ;
        } else {
          arg += '\\'.repeat(n);
          i--;
        }
        continue;
      }
      if (c === '"') {
        if (inQ && s[i + 1] === '"') {
          arg += '"';
          i++;
        } else inQ = !inQ;
        continue;
      }
      if (!inQ && (c === ' ' || c === '\t')) break;
      arg += c;
    }
    out.push(arg);
  }
  return out;
}

test('escapeCmdArgument matches known cmd.exe escaping cases', () => {
  const r = String.raw;
  assert.equal(escapeCmdArgument('a&b', false), r`^"a^&b^"`);
  assert.equal(escapeCmdArgument('a&b', true), r`^^^"a^^^&b^^^"`);
  assert.equal(escapeCmdArgument('x y', false), r`^"x^ y^"`);
  assert.equal(escapeCmdArgument('%PATH%', false), r`^"^%PATH^%^"`);
  assert.equal(escapeCmdArgument('%PATH%', true), r`^^^"^^^%PATH^^^%^^^"`);
  assert.equal(escapeCmdArgument('say "hi"', false), r`^"say^ \^"hi\^"^"`);
  assert.equal(escapeCmdArgument('back\\', false), r`^"back\\^"`);
  assert.equal(escapeCmdArgument('^', false), r`^"^^^"`);
  assert.equal(escapeCmdArgument('a|b>c', true), r`^^^"a^^^|b^^^>c^^^"`);
  assert.equal(escapeCmdArgument('', false), r`^"^"`);
  assert.equal(escapeCmdArgument('!x!', false), r`^"^!x^!^"`);
  assert.equal(escapeCmdCommand('C:\\Program Files\\nodejs\\npx.cmd'), r`C:\Program^ Files\nodejs\npx.cmd`);
});

test('escapeCmdArgument agrees with cross-spawn on every nasty argument', () => {
  const oracle = require('cross-spawn/lib/util/escape.js');
  // cross-spawn 7.0.6's backtracking-safe regex doubles only one backslash of a run before a quote / the end,
  // which breaks e.g. `trail\\` (the closing quote ends up escaped). We double the whole run (qntm.org/cmd).
  // It also does not escape ':', so %VAR:a=b% still expands through it. The round-trip test below proves
  // those cases. Compare everything else.
  for (const a of NASTY.filter((x) => !/\\\\/.test(x) && !x.includes(':'))) {
    assert.equal(escapeCmdArgument(a, false), oracle.argument(a, false), a);
    assert.equal(escapeCmdArgument(a, true), oracle.argument(a, true), a);
  }
  assert.equal(escapeCmdArgument('trail\\\\', false), String.raw`^"trail\\\\^"`, 'two trailing backslashes become four');
  assert.equal(escapeCmdCommand('C:\\a (x86)\\b&c\\npx.cmd'), oracle.command('C:\\a (x86)\\b&c\\npx.cmd'));
});

test('simulated cmd.exe -> batch %* -> argv round trip delivers every argument verbatim and runs nothing', () => {
  for (const a of NASTY) {
    const stage1 = escapeCmdArgument(a, true); // what cmd.exe /c parses
    assert.ok(cmdSafe(stage1) && noPercentExpansion(stage1), `cmd /c stage unsafe for ${JSON.stringify(a)}: ${stage1}`);
    const stage2 = decaret(stage1); // what the batch file's %* re-parses
    assert.ok(cmdSafe(stage2) && noPercentExpansion(stage2), `batch stage unsafe for ${JSON.stringify(a)}: ${stage2}`);
    const stage3 = decaret(stage2); // the command line node.exe receives
    assert.deepEqual(parseMsvc(stage3), [a], `argv mismatch for ${JSON.stringify(a)}: ${stage3}`);
  }
});

// A fake Windows machine.
const WIN_ENV = {
  Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs;C:\\tools',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  SystemRoot: 'C:\\Windows',
};
const WIN_FILES = new Set(
  ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files\\nodejs\\npx.cmd', 'C:\\tools\\both.exe', 'C:\\tools\\both.cmd', 'C:\\tools\\run.BAT', 'C:\\work\\local.cmd'].map((f) => f.toLowerCase()),
);
// readFile -> null: unknown batch contents, so the safe default (double escaping) applies unless a test says otherwise
const win = { platform: 'win32', env: WIN_ENV, cwd: 'C:\\work', isFile: (p) => WIN_FILES.has(p.toLowerCase()), readFile: () => null };

test('win32: PATH + PATHEXT resolution', () => {
  assert.equal(resolveWindowsCommand('npx', win), 'C:\\Program Files\\nodejs\\npx.cmd');
  assert.equal(resolveWindowsCommand('node', win), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(resolveWindowsCommand('both', win), 'C:\\tools\\both.exe', '.EXE comes before .CMD in PATHEXT');
  assert.equal(resolveWindowsCommand('npx.cmd', win), 'C:\\Program Files\\nodejs\\npx.cmd');
  assert.equal(resolveWindowsCommand('.\\local', win), 'C:\\work\\local.cmd');
  assert.equal(resolveWindowsCommand('local', win), null, 'the current directory is not searched for bare names');
  assert.equal(resolveWindowsCommand('nosuch', win), null);
});

test('win32: npx with an & argument becomes a fully escaped cmd.exe /d /s /v:off /c line', () => {
  const plan = planSpawn(['npx', '-y', '@modelcontextprotocol/server-filesystem', 'C:\\My Docs', 'a&b'], win);
  assert.deepEqual(plan, {
    file: 'C:\\Windows\\system32\\cmd.exe',
    args: [
      '/d',
      '/s',
      '/v:off',
      '/c',
      String.raw`"C:\Program^ Files\nodejs\npx.cmd ^^^"-y^^^" ^^^"@modelcontextprotocol/server-filesystem^^^" ^^^"C^^^:\My^^^ Docs^^^" ^^^"a^^^&b^^^""`,
    ],
    windowsVerbatimArguments: true,
    viaCmd: true,
    doubleEscaped: true,
    detached: false,
  });
  // and the simulated round trip gives npx exactly the original argv
  const line = plan.args[4].slice(1, -1); // /s strips the outer quotes
  const cmdToken = escapeCmdCommand('C:\\Program Files\\nodejs\\npx.cmd');
  assert.ok(line.startsWith(cmdToken + ' '));
  const batchArgs = decaret(line.slice(cmdToken.length + 1)); // %* inside npx.cmd
  const nodeLine = decaret(batchArgs); // re-parsed by the batch file's own line
  assert.deepEqual(parseMsvc(nodeLine), ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\My Docs', 'a&b']);
});

test('win32: .exe targets are spawned directly, with unmodified args', () => {
  const plan = planSpawn(['node', 'C:\\my dir\\server.js', 'a&b', '%PATH%'], win);
  assert.deepEqual(plan, {
    file: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\my dir\\server.js', 'a&b', '%PATH%'],
    windowsVerbatimArguments: false,
    viaCmd: false,
    doubleEscaped: false,
    detached: false,
  });
  assert.equal(planSpawn(['nosuch', 'x'], win).file, 'nosuch', 'unresolvable commands are spawned as-is (ENOENT -> 127)');
});

test('win32: %VAR:a=b% and %VAR:~n,m% are not expanded for .cmd/.bat targets', () => {
  const plan = planSpawn(['npx', '%PATH:\\=/%', '%X:a=b%'], win);
  assert.equal(plan.args[4], String.raw`"C:\Program^ Files\nodejs\npx.cmd ^^^"^^^%PATH^^^:\=/^^^%^^^" ^^^"^^^%X^^^:a=b^^^%^^^""`);
  const line = plan.args[4].slice(1, -1);
  assert.ok(noPercentExpansion(line) && noPercentExpansion(decaret(line)));
  assert.deepEqual(parseMsvc(decaret(decaret(line))).slice(2), ['%PATH:\\=/%', '%X:a=b%'], '"C:\\Program Files\\..." is argv 0-1 unquoted');
  const sub = planSpawn(['npx', '%PATH:~0,5%'], win).args[4].slice(1, -1);
  assert.ok(noPercentExpansion(sub) && noPercentExpansion(decaret(sub)), sub);
  // the drive colon of the command itself stays unescaped
  assert.equal(escapeCmdCommand('C:\\a:b\\x.cmd'), 'C:\\a^:b\\x.cmd');
});

test('win32: a .cmd/.bat path that does not exist fails with ENOENT before cmd.exe is involved', () => {
  assert.throws(
    () => planSpawn(['C:\\no such dir\\srv.cmd', 'x'], win),
    (e) => e instanceof SpawnError && e.code === 'ENOENT' && e.message === 'ENOENT (command not found)',
  );
  assert.throws(() => planSpawn(['missing.bat'], win), (e) => e.code === 'ENOENT');
});

/** cmd.exe batch parameter splitting (%1, %2, ...): delimiters outside quotes; quotes are kept. */
function batchParams(s) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (const c of s) {
    if (c === '"') inQ = !inQ;
    if (!inQ && ' \t,;='.includes(c)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

test('win32: only %* forwarders are double-escaped; other batch files get one level', () => {
  const withText = (text) => ({ ...win, readFile: () => text });
  const plain = '@"C:\\node\\node.exe" "C:\\srv\\server.js" "%~1" "%~2"\r\n';
  assert.equal(planSpawn(['run.bat', 'x'], withText(plain)).doubleEscaped, false, 'reads %~1');
  assert.equal(planSpawn(['run.bat', 'x'], withText('@node srv.js %*\r\n')).doubleEscaped, true, 'forwards %*');
  assert.equal(planSpawn(['run.bat', 'x'], withText(null)).doubleEscaped, true, 'unreadable: safe default');
  for (const shim of ['npx', 'npm', 'pnpm', 'yarn']) assert.equal(forwardsAllArgs(`C:\\x\\${shim}.CMD`, () => plain), true, shim);
  assert.equal(forwardsAllArgs('C:\\p\\node_modules\\.bin\\srv.cmd', () => plain), true);
  assert.equal(forwardsAllArgs('C:\\p/node_modules/.bin/srv.cmd', () => plain), true);
  assert.equal(forwardsAllArgs('C:\\tools\\npx-helper.cmd', () => plain), false);
  // a quote cannot be passed to a "%~1" reader safely
  assert.throws(() => planSpawn(['run.bat', 'say "hi"'], withText(plain)), (e) => e instanceof SpawnError && e.code === 'EINVAL' && /double quote/.test(e.message));

  // simulated round trip: cmd /c line -> %1..%n -> the batch's own "%~n" -> argv of node.exe
  const args = NASTY.filter((a) => !a.includes('"') && !/[\r\n]/.test(a));
  for (const a of args) {
    const line = planSpawn(['run.bat', a], withText(plain)).args[4].slice(1, -1);
    const rest = line.replace(/^\S+ /, '');
    assert.ok(cmdSafe(rest) && noPercentExpansion(rest), `cmd /c stage unsafe for ${JSON.stringify(a)}: ${rest}`);
    const params = batchParams(decaret(rest));
    assert.equal(params.length, 1, `split into several parameters: ${JSON.stringify(a)} -> ${JSON.stringify(params)}`);
    const tilde = params[0].replace(/^"(.*)"$/s, '$1'); // %~1
    assert.ok(!tilde.includes('"'), tilde); // so "%~1" stays one quoted token, where cmd.exe interprets nothing
    assert.deepEqual(parseMsvc(`"${tilde}"`), [a], `argv mismatch for ${JSON.stringify(a)}`);
    assert.ok(!tilde.includes('^') || a.includes('^'), `carets left in ${JSON.stringify(a)}: ${tilde}`);
  }
});

test('win32: PATHEXT entries other than .com/.exe/.bat/.cmd are ignored', () => {
  const env = { ...WIN_ENV, PATHEXT: '.COM;.EXE;.BAT;.CMD;.JS;.VBS' };
  const isFile = (p) => p.toLowerCase() === 'c:\\tools\\server.js';
  assert.equal(resolveWindowsCommand('server', { ...win, env, isFile }), null);
});

test('win32: on a case-insensitive file system the resolver returns the as-given / lowercase spelling', () => {
  // NTFS: statSync("npx.CMD") succeeds for npx.cmd, so the spelling we try first is what we return
  const files = new Set([...WIN_FILES].map((f) => f.toLowerCase()));
  const ntfs = { ...win, isFile: (p) => files.has(p.toLowerCase()) };
  assert.equal(resolveWindowsCommand('npx', ntfs), 'C:\\Program Files\\nodejs\\npx.cmd');
  assert.equal(resolveWindowsCommand('NPX.CMD', ntfs), 'C:\\Program Files\\nodejs\\NPX.CMD', 'as given');
  assert.equal(planSpawn(['NPX.CMD'], ntfs).viaCmd, true);
});

test('win32: batch files reject arguments with line breaks instead of mangling them', () => {
  assert.throws(() => planSpawn(['npx', 'a\nb'], win), (e) => e instanceof SpawnError && e.code === 'EINVAL' && /line break/.test(e.message));
  assert.doesNotThrow(() => planSpawn(['node', 'a\nb'], win));
});

test('regression: a .cmd/.bat target never reaches spawn without the cmd.exe wrapper, and shell is never used', () => {
  const calls = [];
  const fakeSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    const c = new EventEmitter();
    c.stdin = { end() {}, destroyed: false };
    c.stdout = new EventEmitter();
    c.stdout.destroy = () => {};
    c.pid = 4242;
    return c;
  };
  const commands = [
    ['npx', '-y', 'srv', 'a&b'],
    ['npx.cmd', 'x'],
    ['NPX.CMD', 'x'],
    ['C:\\Program Files\\nodejs\\npx.cmd', 'x'],
    ['C:/Program Files/nodejs/npx.cmd', 'x'],
    ['run', 'x'],
    ['run.bat', 'x'],
    ['C:\\tools\\run.BAT', 'x>y'],
    ['both', 'x'],
    ['.\\local', 'x'],
    ['node', 'x'],
  ];
  for (const cmd of commands) spawnServer(cmd, 'pipe', { ...win, spawnFn: fakeSpawn });
  for (const { file, args, options } of calls) {
    assert.doesNotMatch(file, /\.(cmd|bat)$/i, `spawned a batch file directly: ${file}`);
    assert.equal(options.shell, undefined, 'shell option must never be set');
    if (file.toLowerCase().endsWith('cmd.exe')) {
      assert.deepEqual(args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
      assert.equal(options.windowsVerbatimArguments, true);
      const rest = args[4].slice(1, -1).replace(/^\S+/, '');
      assert.ok(cmdSafe(rest) && noPercentExpansion(rest), args[4]);
    } else {
      assert.equal(options.windowsVerbatimArguments, false);
    }
  }
  assert.equal(calls.filter((c) => c.file.endsWith('cmd.exe')).length, 9);
});

test('posix: spawned directly in its own process group, never via a shell', () => {
  const plan = planSpawn(['npx', '-y', 'srv', 'a&b;rm -rf x'], { platform: 'linux' });
  assert.deepEqual(plan, { file: 'npx', args: ['-y', 'srv', 'a&b;rm -rf x'], windowsVerbatimArguments: false, viaCmd: false, doubleEscaped: false, detached: true });
});

test('killProcessTree: taskkill /T /F on win32, process group on posix', () => {
  const calls = [];
  const fakeSpawn = (file, args) => {
    calls.push([file, args]);
    return new EventEmitter();
  };
  killProcessTree({ pid: 77, kill: () => true }, 'SIGKILL', 'win32', WIN_ENV, fakeSpawn);
  assert.deepEqual(calls, [['C:\\Windows\\System32\\taskkill.exe', ['/pid', '77', '/T', '/F']]]);
  let killed = null;
  // a pid that cannot exist: the group kill fails, so it falls back to child.kill
  killProcessTree({ pid: 2 ** 30, kill: (s) => ((killed = s), true) }, 'SIGTERM', 'linux');
  assert.equal(killed, 'SIGTERM');
});

test('review: start errors never echo argument values (API keys), only the command name', () => {
  const secret = 'sk-SECRET-123';
  // Node's own messages can include argument values, e.g. ERR_INVALID_ARG_VALUE for a NUL byte
  let nodeErr;
  try {
    spawnServer([process.execPath, `--key=${secret}\0`], 'pipe');
  } catch (e) {
    nodeErr = e;
  }
  assert.ok(nodeErr && String(nodeErr.message).includes(secret), 'precondition: node echoes the argument');
  const msg = startErrorMessage([process.execPath, `--key=${secret}\0`], nodeErr);
  assert.equal(msg, `failed to start server "${process.execPath}": ERR_INVALID_ARG_VALUE`);
  const enoent = Object.assign(new Error(`spawn nope ENOENT ${secret}`), { code: 'ENOENT' });
  assert.equal(startErrorMessage(['nope', secret], enoent), 'failed to start server "nope": ENOENT (command not found)');
  assert.doesNotMatch(startErrorMessage(['run.bat', secret], new SpawnError('x', 'EINVAL')), /SECRET/);
});
