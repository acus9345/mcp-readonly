# mcp-readonly: make any MCP server read-only with one command, no config file

Unlike [mcp-proxy](https://github.com/joshrotenberg/mcp-proxy) (`read_only_only`, which needs a TOML config and trusts annotations only), [tool-filter-mcp](https://github.com/respawn-llc/tool-filter-mcp), [mcp-filter](https://github.com/pro-vi/mcp-filter) and [mcp-tool-allowlist](https://www.npmjs.com/package/mcp-tool-allowlist) (hand-written allow/deny lists), `npx mcp-readonly -- <server cmd>` works with zero config: it also judges servers **without annotations** by the verbs in tool names and descriptions, fails closed on tools it can't classify, and **tells you why** each tool was blocked.
It is a zero-dependency stdio proxy (Node 18+) that hides write tools from `tools/list` and refuses any `tools/call` to them, so the call never reaches the server.

```
$ npx -y mcp-readonly audit -- npx -y @modelcontextprotocol/server-memory@0.6.2   # an old server with no annotations
memory-server@1.0.0: 9 tools, 2 allowed, 7 blocked
  BLOCK  create_entities      no readOnlyHint; name contains write verb "create"
  BLOCK  add_observations     no readOnlyHint; name contains write verb "add"
  BLOCK  delete_entities      no readOnlyHint; name contains write verb "delete"
  allow  read_graph           no readOnlyHint; name starts with read verb "read"
  allow  search_nodes         no readOnlyHint; name starts with read verb "search"
  BLOCK  open_nodes           unclassified ("open" is not a known read verb); blocked by default
```
# open_nodes is really a read: add --allow open_nodes

## Install

```sh
npm install -g mcp-readonly     # or run it with npx and no install: npx -y mcp-readonly ...
```

Node.js 18 or newer. There are no runtime dependencies.

## Quick start

The package includes a small example MCP server (`examples/notes-server.js`, 12 tools with a mix of good, missing and lying annotations) and a tiny client (`examples/demo-client.js`), so you can try everything locally.

macOS / Linux (bash, zsh):

```sh
mkdir try-mcp-readonly && cd try-mcp-readonly && npm init -y >/dev/null && npm install mcp-readonly
EX=node_modules/mcp-readonly/examples

# 1. See what would be exposed and why
npx mcp-readonly audit -- node $EX/notes-server.js

# 2. Call a read tool and a destructive tool through the proxy: the read works, the delete is refused
node $EX/demo-client.js --call list_notes --call delete_note --args '{"id":1}' -- npx mcp-readonly -- node $EX/notes-server.js

# 3. A server with no annotations at all: heuristics only, plus explicit overrides
npx mcp-readonly audit --allow delete_note --unknown allow -- node $EX/notes-server.js --no-annotations

# 4. Machine-readable audit
npx mcp-readonly audit --json -- node $EX/notes-server.js
```

Windows PowerShell. Use `npx.cmd`: PowerShell runs `npx` as the `npx.ps1` script and drops the first `--` it passes to a script.

```powershell
mkdir try-mcp-readonly; cd try-mcp-readonly; npm init -y > $null; npm install mcp-readonly
$EX = "node_modules\mcp-readonly\examples"

npx.cmd mcp-readonly audit -- node $EX\notes-server.js
node $EX\demo-client.js --call list_notes --call delete_note -- npx.cmd mcp-readonly -- node $EX\notes-server.js
npx.cmd mcp-readonly audit --allow delete_note --unknown allow -- node $EX\notes-server.js --no-annotations
npx.cmd mcp-readonly audit --json -- node $EX\notes-server.js
```

Windows Command Prompt (cmd.exe):

```bat
mkdir try-mcp-readonly && cd try-mcp-readonly && npm init -y >nul && npm install mcp-readonly
set EX=node_modules\mcp-readonly\examples

npx mcp-readonly audit -- node %EX%\notes-server.js
node %EX%\demo-client.js --call list_notes --call delete_note -- npx mcp-readonly -- node %EX%\notes-server.js
npx mcp-readonly audit --allow delete_note --unknown allow -- node %EX%\notes-server.js --no-annotations
npx mcp-readonly audit --json -- node %EX%\notes-server.js
```

The Windows variants leave out step 2's `--args '{"id":1}'`, because quoting JSON differs between shells. The delete is refused before any arguments matter.

Output of step 2:

```
mcp-readonly: exposing 6/12 tools; hiding create_note (no readOnlyHint; name contains write verb "create"), update_note (annotated readOnlyHint: false), delete_note (annotated destructiveHint: true), ...
mcp-readonly: warning: clear_cache: annotated readOnlyHint: true but the name contains write verb "clear"
tools: list_notes, get_note, search_notes, count_words, clear_cache, show_tally
list_notes: 1: buy milk
2: call mom
mcp-readonly: refused tools/call "delete_note" (annotated destructiveHint: true)
delete_note: [isError] mcp-readonly blocked tool "delete_note": annotated destructiveHint: true. This MCP server is running in read-only mode, ...
```

### Using it with an MCP client (Claude Desktop, Cursor, etc.)

Put `npx -y mcp-readonly --` in front of the server command you already have:

```json
{
  "mcpServers": {
    "filesystem-readonly": {
      "command": "npx",
      "args": ["-y", "mcp-readonly", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  }
}
```

With `@modelcontextprotocol/server-filesystem` 2.1.0 this exposes 10 of 14 tools and blocks `write_file`, `edit_file`, `move_file` and `create_directory`. Diagnostics go to stderr, which most clients show in their MCP logs.

## How a tool is judged

First match wins:

1. `--deny` glob → **block**
2. `--allow` glob → allow
3. `destructiveHint: true` → **block**
4. `readOnlyHint: true` → allow. If the name or the description contains a write verb, it is still allowed but a warning is logged; with `--distrust-annotations` it is blocked.
5. `readOnlyHint: false` → **block**
6. Name heuristic: the name is split on `_ - . /` and camelCase.
   - Any write or exec verb anywhere **blocks**, even after a read verb. Examples: create, delete, update, write, send, move, drop, truncate, exec, execute, eval, evaluate, run, call, invoke, export, import, webhook, trigger, deploy. So `get_or_create`, `get_and_drop`, `browser_evaluate`, `export_database` and `test_webhook` are blocked.
   - A few words are usually nouns in tool names (post, order, email, comment, message, …). They count as writes when they come first, follow `and`/`then`/`or`, or no read verb comes first. So `get_post` and `list_orders` stay readable, while `post_message` and `get_and_post` are blocked.
   - Words that can mean either reading or writing (query, sql, graphql, request, http, command, shell, script, …) are never allowed by name alone.
   - After `and`/`then`/`or`/`plus`, the second action must itself be a known read verb (`list_and_count` is fine). Otherwise the name is unclassified, so `scan_and_fix`, `audit_and_remediate` and `show_and_tell` fail closed.
   - Otherwise the name is a read candidate only if its **verb** is a read verb (get, list, read, search, show, describe, …). The verb is the first word, after known namespace prefixes such as `git_`, `browser_`, `k8s_`, `aws_`, `slack_`. Nouns that sound like reading (status, history, logs, schema, tree, snapshot, metadata, stats, diff, check, …) never count, wherever they appear. So `get_status`, `show_history` and `git_show` are read candidates, while `git_status`, `tree_prune` and `regenerate_metadata` are unclassified (and `prune_history`, `clean_logs`, `log_event` are blocked by their write verb). Verb-last names such as `word_count` are unclassified too; allow them with `--allow`. Words that often produce output, such as convert, translate, render, compute and calculate, are deliberately not read verbs.
7. Description check, for **every** tool that reaches this step, including read candidates. A write verb **anywhere** in the description blocks, in any form (`wipes`, `deleted`, `creating`, `resets`, …), so `show` described as "Shows and then deletes the item" is blocked. A few noun-like words (set, new, store, post, commit, merge, archive, …) count only as the first word. The description can only block. It never allows a tool, so "Reads the number of notes." does not clear a name like `tally`. The phrase "read-only" counts for nothing, so a disclaimer like "Deletes all records. Not available in read-only mode." or "This tool is NOT read-only" can't make a tool look safe. A read candidate with a clean description is allowed.
8. Otherwise the tool is **unclassified and blocked** (fail closed). Use `--unknown allow` or `--allow name` to change that.

Every verdict carries its reason. `audit` prints them, the proxy logs them on stderr, and a refused call returns them to the model as an `isError` tool result.

## CLI reference

```
mcp-readonly [options] -- <server command...>        run the server behind the read-only proxy
mcp-readonly audit [options] -- <server command...>  list every tool with its verdict and reason, then exit

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
-h, --help / -v, --version
```

The `--` is optional; the first argument that isn't an option starts the server command. `MCP_READONLY_ALLOW` and `MCP_READONLY_DENY` add comma-separated patterns. Exit codes: the proxy returns the server's exit code, or 127 if the server can't be started (including a `.cmd`/`.bat` path that doesn't exist). `audit` returns 0 on success and 1 if the server fails. Start errors print only the command name and an error code (for example `failed to start server "npx": ENOENT (command not found)`), never the server's arguments, which may hold API keys. Usage errors return 2, as does a server command that can't be passed safely, such as a line break in an argument to a `.cmd`/`.bat` target.

### How the server is started and stopped

- The server command is never run through a shell (no `shell: true`). On macOS and Linux it is spawned directly, in its own process group. On Windows the command is resolved through `PATH` + `PATHEXT`, and `.exe` files are spawned directly. `.cmd`/`.bat` files (like `npx.cmd`) can't be spawned without a shell since Node 18.20.2 / 20.12.2 (CVE-2024-27980), so they run as `cmd.exe /d /s /v:off /c "…"`. Every argument is quoted, and its cmd metacharacters (`& | < > ^ % ! " ( ) :` …) are caret-escaped. Batch files that forward their arguments with `%*` re-parse them, so they get a second level of escaping. That covers the npm/npx/pnpm/yarn shims, anything in `node_modules\.bin`, any `.cmd`/`.bat` whose text contains `%*`, and, to be safe, a file that can't be read. Other batch files, which typically read `"%~1"`, get one level, so no carets are left in their values. For those batch files, an argument containing `"` is rejected: inside `"%~1"` it would end cmd.exe's quoting, and nothing can escape it there. `:` is escaped because `%VAR:a=b%` and `%VAR:~0,5%` end the variable name at the colon. `/v:off` disables `!VAR!` expansion even if the registry turns delayed expansion on. Arguments with spaces, quotes, `&`, `>`, `%VAR%`, `%PATH:\=/%` and so on reach the server verbatim. A line break in an argument to a `.cmd`/`.bat` target can't be passed safely, so it is rejected with an error. A `.cmd`/`.bat` that doesn't exist fails with ENOENT before cmd.exe runs. Only `.com`, `.exe`, `.bat` and `.cmd` from `PATHEXT` are considered.
- When the client closes stdin, the server gets `--grace` ms to exit. After that its whole process tree is killed: the process group on POSIX (SIGTERM, then SIGKILL 1 s later), or `taskkill /T /F` on Windows. So a server that ignores EOF, or a grandchild behind `npx`, can't keep `audit` or the proxy alive. SIGINT/SIGTERM sent to the proxy are forwarded to the server's process group.

A programmatic API (`classifyTool`, `runProxy`, `audit`, `filterToolsResult`) is exported from the package root.

## Limitations

- **The heuristics are guesses, not a sandbox.** A tool called `fetch_url` or `run_query` can still change state, and a well-named tool can lie. Use `audit` to review the verdicts, and `--deny` anything you don't trust. Real isolation (credentials with read-only scopes, OS sandboxing) is still the strong guarantee.
- Annotations are trusted by default: a server that marks a writing tool `readOnlyHint: true` gets it allowed. A write verb in the name triggers a warning; `--distrust-annotations` blocks those.
- Only **tools** are filtered. Resources, prompts, sampling and other methods pass through untouched.
- Client lines that aren't valid JSON are answered with a JSON-RPC parse error (`-32700`) and never forwarded. A leading UTF-8 BOM is stripped first. A `tools/call` sent as a notification (no `id`) is dropped. Allowed `tools/call` requests are re-serialized from the parsed message, so the server sees exactly what was checked.
- stdio transport only (no Streamable HTTP or SSE).
- In a JSON-RPC batch, refused calls are answered as separate messages instead of inside one batch response.
- A `tools/call` made before any `tools/list` (or for a tool not in the list) is judged by its name alone.
- The verb lists are English-only. Opaque words like `query` make many legitimate read tools unclassified, so expect to `--allow` a few.
- Windows: if the server's direct child exits on its own but leaves grandchildren running, those can't be swept afterwards (`taskkill /T` needs the parent to still be alive).
- Windows: whether a `.cmd`/`.bat` forwards `%*` is decided from its name, its location and whether its text contains `%*`. A batch file that does both can still see wrong values. Never point mcp-readonly at a batch file that uses `%~1` unquoted: it can run injected commands. Point it at the real `.exe` instead (for example `node server.js`).
- POSIX: when the server exits, its process group is swept with SIGKILL only if the group still has members at that moment. A process group id can't be reused while it has members, so the probe and the kill hit the same group. The group is never signalled later.
- POSIX: because the server runs in its own process group, a terminal Ctrl-C reaches it only through the proxy's forwarding. If the proxy itself is SIGKILLed, the server only sees stdin EOF.

## Development

```sh
npm install
npm run typecheck && npm run lint && npm test        # unit + integration tests (example servers, shutdown, argv escaping)
MCP_READONLY_E2E=1 npm test                          # also runs against the real @modelcontextprotocol servers (needs network/npx cache)
```

CI runs typecheck, lint, build and the tests on Ubuntu, Windows and macOS with Node 18, 20 and 22. The end-to-end tests against the real servers run as a separate CI step (`MCP_READONLY_E2E=1`); they need the npm registry. The Windows-only tests (arguments, including `%PATH:\=/%`, through a real `.cmd` shim; a missing `.cmd` exits 127; a line break for a `.cmd` target is one clean error with exit 2) run on the Windows runners. The cmd.exe escaping is also unit-tested on every OS with a simulated cmd.exe → batch → argv round trip.

## License

MIT
