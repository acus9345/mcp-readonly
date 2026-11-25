import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, root, SERVER } from './helpers.js';

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('--version and --help', async () => {
  const v = await run(['--version']);
  assert.equal(v.code, 0);
  assert.equal(v.stdout.trim(), pkg.version);
  const h = await run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Usage:/);
  assert.match(h.stdout, /mcp-readonly audit/);
});

test('usage errors exit 2', async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run(['--bogus', '--', 'node'])).code, 2);
  assert.equal((await run(['--unknown', 'maybe', '--', 'node'])).code, 2);
  assert.match((await run(['--config', '/nope.json', '--', 'node'])).stderr, /cannot read config/);

  const emptyGrace = await run(['--grace=', '--', 'node']);
  assert.equal(emptyGrace.code, 2);
  assert.match(emptyGrace.stderr, /--grace must be a number/);

  const boolVal = await run(['--quiet=false', '--', 'node']);
  assert.equal(boolVal.code, 2);
  assert.match(boolVal.stderr, /--quiet does not take a value/);

  const dir = mkdtempSync(join(tmpdir(), 'ro-cfg-'));
  try {
    const nullCfg = join(dir, 'null.json');
    writeFileSync(nullCfg, 'null');
    const rNull = await run(['--config', nullCfg, '--', 'node']);
    assert.equal(rNull.code, 2);
    assert.match(rNull.stderr, /must be a JSON object/);
    assert.doesNotMatch(rNull.stderr, /TypeError/);

    const badBoolCfg = join(dir, 'bad-bool.json');
    writeFileSync(badBoolCfg, JSON.stringify({ showBlocked: 'yes' }));
    const rBadBool = await run(['--config', badBoolCfg, '--', 'node']);
    assert.equal(rBadBool.code, 2);
    assert.match(rBadBool.stderr, /"showBlocked" must be a boolean/);

    const bomCfg = join(dir, 'bom.json');
    writeFileSync(bomCfg, '\uFEFF' + JSON.stringify({ allow: ['frobnicate'] }));
    const rBom = await run(['audit', '--json', '--config', bomCfg, '--', process.execPath, SERVER]);
    assert.equal(rBom.code, 0, rBom.stderr);
    const parsed = JSON.parse(rBom.stdout);
    assert.equal(parsed.tools.find((t) => t.name === 'frobnicate').allowed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit prints every tool with its verdict and reason', async () => {
  const r = await run(['audit', '--', process.execPath, SERVER]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /notes-server@1\.0\.0: 12 tools, 6 allowed, 6 blocked/);
  assert.match(r.stdout, /BLOCK {2}delete_note +annotated destructiveHint: true/);
  assert.match(r.stdout, /allow {2}get_note +no readOnlyHint; name starts with read verb "get"/);
  assert.match(r.stdout, /BLOCK {2}reindex +no readOnlyHint; description contains write verb "writes"/);
  assert.match(r.stdout, /warning: annotated readOnlyHint: true but the name contains write verb "clear"/);
});

test('review L7: audit answers ping, and server->client requests it does not support with -32601', async () => {
  const r = await run(['audit', '--json', '--', process.execPath, join(root, 'test', 'fixtures', 'asking-server.js')]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(JSON.parse(r.stdout).server.version), {
    ping: { result: {} },
    'roots/list': { error: -32601 },
    'sampling/createMessage': { error: -32601 },
  });
});

test('audit --json follows pagination', async () => {
  const r = await run(['audit', '--json', '--', process.execPath, SERVER, '--page-size', '4']);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.tools.length, 12);
  assert.equal(j.server.name, 'notes-server');
  assert.deepEqual(j.tools.find((t) => t.name === 'frobnicate'), {
    name: 'frobnicate',
    allowed: false,
    source: 'default',
    reason: 'unclassified ("frobnicate" is not a known read verb); blocked by default',
    warnings: [],
  });
});

test('audit fails cleanly on a server that dies or hangs', async () => {
  const dead = await run(['audit', '--', process.execPath, '-e', 'process.exit(4)']);
  assert.equal(dead.code, 1);
  assert.match(dead.stderr, /server exited \(code 4\)/);
  const t0 = Date.now();
  const hang = await run(['audit', '--timeout', '300', '--', process.execPath, '-e', 'setInterval(()=>{},1000)']);
  assert.equal(hang.code, 1);
  assert.match(hang.stderr, /timed out after 300 ms waiting for initialize/);
  assert.ok(Date.now() - t0 < 5000);
});
