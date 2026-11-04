// H2: a server that ignores stdin EOF (and SIGTERM), directly or as a grandchild behind a launcher like npx,
// must not hang `audit` or the proxy, and nothing it started may survive. With the 0.1.0 implementation
// (child.kill on the direct child only) these tests hang until their timeout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, run, killAll, root } from './helpers.js';

after(killAll);

const STUBBORN = join(root, 'test', 'fixtures', 'stubborn-server.js');

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === 'EPERM';
  }
  // a zombie is dead for our purposes
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2)[0] === 'Z') return false;
  } catch {
    /* no /proc (macOS, Windows) */
  }
  return true;
}

async function assertAllGone(pidFile, expected) {
  assert.ok(existsSync(pidFile), 'fixture did not start');
  const pids = readFileSync(pidFile, 'utf8').split(/\r?\n/).filter(Boolean).map(Number);
  assert.equal(pids.length, expected, `expected ${expected} server processes, saw ${pids.join(',')}`);
  const deadline = Date.now() + 3000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const left = pids.filter(alive);
  for (const pid of left) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
  assert.deepEqual(left, [], 'server processes survived');
}

const pidFile = () => join(mkdtempSync(join(tmpdir(), 'ro-stubborn-')), 'pids');

for (const [label, extra, count] of [
  ['server', [], 1],
  ['grandchild behind a launcher', ['--spawn-child'], 2],
]) {
  test(`audit exits within the grace period when the ${label} ignores EOF and SIGTERM`, { timeout: 15_000 }, async () => {
    const f = pidFile();
    const t0 = Date.now();
    const r = await run(['audit', '--grace', '300', '--', process.execPath, STUBBORN, ...extra], {
      env: { ...process.env, STUBBORN_PID_FILE: f },
    });
    const ms = Date.now() - t0;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /stubborn@1: 1 tools/);
    assert.ok(ms < 8000, `audit took ${ms} ms`);
    await assertAllGone(f, count);
  });

  test(`proxy exits after the client closes stdin when the ${label} ignores EOF`, { timeout: 15_000 }, async () => {
    const f = pidFile();
    const c = new Client(['--grace', '300', '--', process.execPath, STUBBORN, ...extra], { STUBBORN_PID_FILE: f });
    await c.init();
    const list = await c.request(1, 'tools/list');
    assert.deepEqual(list.result.tools.map((t) => t.name), ['get_time']);
    const t0 = Date.now();
    await c.close();
    const ms = Date.now() - t0;
    assert.ok(ms < 8000, `proxy took ${ms} ms to exit`);
    await assertAllGone(f, count);
  });
}

test('audit timing out on a server that never answers still kills it', { timeout: 15_000 }, async () => {
  const f = pidFile();
  const r = await run(['audit', '--timeout', '300', '--grace', '200', '--', process.execPath, '-e', 'require("fs").appendFileSync(process.env.STUBBORN_PID_FILE, process.pid + "\\n"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
    env: { ...process.env, STUBBORN_PID_FILE: f },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /timed out after 300 ms/);
  await assertAllGone(f, 1);
});
