import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTool, tokenize, globMatch, defaultPolicy, LineSplitter } from '../dist/index.js';

const p = (o = {}) => ({ ...defaultPolicy, allow: [], deny: [], ...o });
const v = (tool, pol) => classifyTool(typeof tool === 'string' ? { name: tool } : tool, pol ?? p());

test('tokenize splits snake, kebab, camel, dots and slashes', () => {
  assert.deepEqual(tokenize('createPullRequest'), ['create', 'pull', 'request']);
  assert.deepEqual(tokenize('repo.list-issues/v2'), ['repo', 'list', 'issues', 'v2']);
  assert.deepEqual(tokenize('HTTPGetURL_value'), ['http', 'get', 'url', 'value']);
});

test('annotations: destructiveHint blocks, readOnlyHint allows, readOnlyHint:false blocks', () => {
  assert.equal(v({ name: 'x', annotations: { destructiveHint: true } }).allowed, false);
  assert.equal(v({ name: 'x', annotations: { readOnlyHint: true } }).allowed, true);
  const nd = v({ name: 'x', annotations: { readOnlyHint: false, destructiveHint: false } });
  assert.equal(nd.allowed, false);
  assert.match(nd.reason, /readOnlyHint: false/);
});

test('contradictory annotations block and warn', () => {
  const r = v({ name: 'x', annotations: { readOnlyHint: true, destructiveHint: true } });
  assert.equal(r.allowed, false);
  assert.equal(r.warnings.length, 1);
});

test('annotations beat the name, with a warning; --distrust-annotations flips it', () => {
  const t = { name: 'delete_cache', annotations: { readOnlyHint: true } };
  const trusted = v(t);
  assert.equal(trusted.allowed, true);
  assert.match(trusted.warnings[0], /write verb "delete"/);
  const distrust = v(t, p({ distrustAnnotations: true }));
  assert.equal(distrust.allowed, false);
  assert.equal(distrust.source, 'name');
});

test('name heuristics: write verbs anywhere block, read verbs allow', () => {
  for (const n of ['create_issue', 'deleteFile', 'fs.write', 'git-push', 'get_or_create_user', 'browser_click', 'run_query', 'execute_sql', 'send_email'])
    assert.equal(v(n).allowed, false, n);
  for (const n of ['get_issue', 'listRepos', 'search-code', 'read_file', 'describe_table', 'get_file_info'])
    assert.equal(v(n).allowed, true, n);
  assert.match(v('create_issue').reason, /write verb "create"/);
  assert.match(v('get_issue').reason, /read verb "get"/);
});

test('review M1: exec/export/webhook verbs block anywhere, opaque names are unclassified', () => {
  const cases = [
    ['browser_evaluate', false, 'name', 'no readOnlyHint; name contains write verb "evaluate"'],
    ['export_database', false, 'name', 'no readOnlyHint; name contains write verb "export"'],
    ['test_webhook', false, 'name', 'no readOnlyHint; name contains write verb "webhook"'],
    ['get_and_drop', false, 'name', 'no readOnlyHint; name contains write verb "drop"'],
    ['list_then_delete', false, 'name', 'no readOnlyHint; name contains write verb "delete"'],
    ['get_and_post', false, 'name', 'no readOnlyHint; name contains write verb "post"'],
    ['js_eval', false, 'name', 'no readOnlyHint; name contains write verb "eval"'],
    ['run_script', false, 'name', 'no readOnlyHint; name contains write verb "run"'],
    ['execute_query', false, 'name', 'no readOnlyHint; name contains write verb "execute"'],
    ['executeSql', false, 'name', 'no readOnlyHint; name contains write verb "execute"'],
    ['exec', false, 'name', 'no readOnlyHint; name contains write verb "exec"'],
    ['call_api', false, 'name', 'no readOnlyHint; name contains write verb "call"'],
    ['query', false, 'default', 'unclassified (name contains "query", which can read or write); blocked by default'],
    ['sql', false, 'default', 'unclassified (name contains "sql", which can read or write); blocked by default'],
    ['get_query', false, 'default', 'unclassified (name contains "query", which can read or write); blocked by default'],
    ['http_request', false, 'default', 'unclassified (name contains "http", which can read or write); blocked by default'],
  ];
  for (const [name, allowed, source, reason] of cases) {
    const r = v(name);
    assert.deepEqual({ name, allowed: r.allowed, source: r.source, reason: r.reason }, { name, allowed, source, reason });
  }
  // an opaque name can be blocked by its description, but a reassuring description does not clear it
  assert.equal(v({ name: 'query', description: 'Deletes rows matching a query.' }).source, 'description');
  assert.equal(v({ name: 'query', description: 'Run a read-only query.' }).allowed, false);
  assert.equal(v({ name: 'query', description: 'Reads rows.' }).source, 'default');
  // annotations still decide first, and --allow / --unknown allow still work
  assert.equal(v({ name: 'query', annotations: { readOnlyHint: true } }).allowed, true);
  assert.equal(v('query', p({ allow: ['query'] })).allowed, true);
  assert.equal(v('sql', p({ unknown: 'allow' })).reason, 'unclassified (name contains "sql", which can read or write); allowed by --unknown allow');
  // words that are no longer treated as reads
  assert.equal(v({ name: 'tool', description: 'Exports the database to a file.' }).allowed, false);
  assert.equal(v({ name: 'tool', description: 'Evaluates JavaScript in the page.' }).allowed, false);
});

test('ambiguous noun/verb words only count as writes in verb position', () => {
  assert.equal(v('get_post').allowed, true);
  assert.equal(v('list_orders').allowed, true);
  assert.equal(v('get_email').allowed, true);
  assert.equal(v('post_message').allowed, false);
  assert.equal(v('browser_type').allowed, false);
  assert.equal(v('issue_comment').allowed, false);
  assert.equal(v('get_and_post').allowed, false, 'after a conjunction it is a second action');
});

test('the description can only block, and it is checked even when the name reads', () => {
  assert.equal(v({ name: 'reindex', description: 'Writes a fresh index.' }).allowed, false);
  assert.equal(v({ name: 'tally', description: 'Reads the count.' }).source, 'default', 'a read description never allows');
  assert.equal(v({ name: 'foo', description: 'A read-only view of things.' }).allowed, false, 'no read-only phrase rule');
  assert.equal(v({ name: 'get_x', description: 'Deletes everything.' }).reason, 'no readOnlyHint; name starts with read verb "get" but description contains write verb "deletes"');
});

test('review M2: negated or disclaimed "read-only" never clears a description that writes', () => {
  const cases = [
    ['This tool is NOT read-only: it wipes the table.', 'wipes'],
    ['Deletes all records. Not available in read-only mode.', 'deletes'],
    ['Wipes the table. Do not use in read-only sessions.', 'wipes'],
    ['Non read-only: truncates the table', 'truncates'],
    ['Read-only safe. Also updated the cache.', 'updated'],
    ['Lists rows, then copies them to the archive bucket.', 'copies'],
  ];
  for (const [description, word] of cases) {
    const r = v({ name: 'tbl', description });
    assert.deepEqual(
      { allowed: r.allowed, source: r.source, reason: r.reason },
      { allowed: false, source: 'description', reason: `no readOnlyHint; description contains write verb "${word}"` },
      description,
    );
  }
  // a read description alone never allows; a read-only phrase alone does not either
  assert.equal(v({ name: 'tbl', description: 'Reads the table schema.' }).reason, 'unclassified ("tbl" is not a known read verb); blocked by default');
  assert.equal(v({ name: 'tbl', description: 'Read-only.' }).source, 'default');
  // prose nouns are not mistaken for verbs, except as the first word
  assert.equal(v({ name: 'get_tbl', description: 'Shows the set of new posts in the store.' }).allowed, true);
  assert.equal(v({ name: 'get_tbl', description: 'Lists commits, merges and archives of the branch.' }).allowed, true);
  assert.equal(v({ name: 'tbl', description: 'Sets the value.' }).source, 'description');
  assert.equal(v({ name: 'get_tbl', description: 'Sets the value.' }).allowed, false);
});

test('review M1: convert/translate/render/compute/calculate are not reads (fail closed)', () => {
  for (const n of ['convert_file', 'convert_to_pdf', 'translate_document', 'render_template', 'calculate_invoice', 'compute_totals']) {
    const r = v(n);
    assert.deepEqual({ n, allowed: r.allowed, source: r.source }, { n, allowed: false, source: 'default' });
    assert.equal(r.reason, `unclassified ("${n.split('_')[0]}" is not a known read verb); blocked by default`);
  }
});

test('review-3 M-1: read nouns never allow; only a read verb in verb position does', () => {
  const B = (reason) => ({ allowed: false, reason: `no readOnlyHint; ${reason}` });
  const U = (word) => ({ allowed: false, reason: `unclassified ("${word}" is not a known read verb); blocked by default` });
  const cases = [
    // the seven cases from the review
    [{ name: 'prune_history', description: 'Permanently deletes old history entries.' }, B('name contains write verb "prune"')],
    ['rewrite_history', B('name contains write verb "rewrite"')],
    ['overwrite_schema', B('name contains write verb "overwrite"')],
    ['clean_logs', B('name contains write verb "clean"')],
    ['tree_prune', B('name contains write verb "prune"')],
    ['log_event', B('name contains write verb "log"')],
    [{ name: 'show', description: 'Shows and then deletes the item.' }, B('name starts with read verb "show" but description contains write verb "deletes"')],
    // more names from the review
    ['rotate_logs', B('name contains write verb "rotate"')],
    ['vacuum_logs', B('name contains write verb "vacuum"')],
    ['flush_cache_stats', B('name contains write verb "flush"')],
    ['discard_diff', B('name contains write verb "discard"')],
    ['squash_history', B('name contains write verb "squash"')],
    ['nuke_snapshot', B('name contains write verb "nuke"')],
    ['regenerate_metadata', U('regenerate')],
    ['reindex_status', U('reindex')],
    ['check_in_file', U('check')],
    ['git_status', U('status')],
    ['history', U('history')],
    ['word_count', U('word')],
    [{ name: 'get_item', description: 'Returns the item and resets its counter.' }, B('name starts with read verb "get" but description contains write verb "resets"')],
    // real reads still pass
    ...['list_files', 'get_status', 'read_logs', 'show_history', 'get_schema', 'list_snapshots'].map((n) => [n, { allowed: true, reason: `no readOnlyHint; name starts with read verb "${n.split('_')[0]}"` }]),
    ['git_show', { allowed: true, reason: 'no readOnlyHint; name starts with read verb "show"' }],
    ['browser_get_text', { allowed: true, reason: 'no readOnlyHint; name starts with read verb "get"' }],
    ['aws_s3_list_buckets', { allowed: true, reason: 'no readOnlyHint; name starts with read verb "list"' }],
  ];
  for (const [tool, want] of cases) {
    const r = v(tool);
    assert.deepEqual({ tool, allowed: r.allowed, reason: r.reason }, { tool, ...want });
  }
});

test('review-3 M-1: readOnlyHint: true with a writing description warns, and blocks under --distrust-annotations', () => {
  const t = { name: 'get_item', description: 'Returns the item and resets its counter.', annotations: { readOnlyHint: true } };
  const r = v(t);
  assert.equal(r.allowed, true);
  assert.deepEqual(r.warnings, ['annotated readOnlyHint: true but the description contains write verb "resets"']);
  const d = v(t, p({ distrustAnnotations: true }));
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'description contains write verb "resets" (readOnlyHint: true ignored by --distrust-annotations)');
});

test('review N1: an unknown second action after and/then/or/plus fails closed', () => {
  for (const [n, word] of [
    ['scan_and_fix', 'fix'],
    ['audit_and_remediate', 'remediate'],
    ['show_and_tell', 'tell'],
    ['get_or_none', 'none'],
    ['listPlusSummon', 'summon'],
  ]) {
    const r = v(n);
    assert.deepEqual(
      { n, allowed: r.allowed, reason: r.reason },
      { n, allowed: false, reason: `unclassified (name chains a second action "${word}" that is not a known read); blocked by default` },
    );
    assert.equal(v({ name: n, description: 'Reads things.' }).allowed, false, 'a description cannot clear it');
  }
  assert.equal(v('list_and_count').allowed, true, 'two reads are fine');
  assert.equal(v('get_or_create').reason, 'no readOnlyHint; name contains write verb "create"');
});

test('unclassified tools fail closed unless --unknown allow', () => {
  assert.equal(v('frobnicate').allowed, false);
  assert.equal(v('frobnicate').source, 'default');
  assert.equal(v('frobnicate', p({ unknown: 'allow' })).allowed, true);
});

test('allow/deny globs: deny wins over allow, allow wins over annotations', () => {
  assert.equal(globMatch('delete_*', 'DELETE_note'), true);
  assert.equal(globMatch('get_?', 'get_ab'), false);
  assert.equal(v({ name: 'delete_note', annotations: { destructiveHint: true } }, p({ allow: ['delete_*'] })).allowed, true);
  assert.equal(v('get_note', p({ deny: ['get_*'] })).allowed, false);
  assert.equal(v('get_note', p({ deny: ['get_*'], allow: ['get_note'] })).source, 'deny');
});

test('LineSplitter handles partial chunks, CRLF, blank lines and split UTF-8', () => {
  const lines = [];
  const s = new LineSplitter((l) => lines.push(l));
  const euro = Buffer.from('{"a":"€"}\r\n\n{"b":', 'utf8');
  s.push(euro.subarray(0, 8));
  s.push(euro.subarray(8));
  s.push('2}\n{"c":3}');
  s.end();
  assert.deepEqual(lines, ['{"a":"€"}', '{"b":2}', '{"c":3}']);
});
