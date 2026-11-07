# Iteration 4 — implement: T2 `live-prune-loop.mjs` (DoD D1)

changed:
- `plugin/dsh/test/live/live-prune-loop.mjs` (new): live check of the whole pruning loop on `dsh headless` with the real core. One temp git repo + one `TOKENECONOMIZER_HOME` + isolated `CLAUDE_CONFIG_DIR` for all sessions (`os.tmpdir()/te-dsh-live-prune`); env `TE_TOOLPRUNE=auto`, `EVIDENCE=1`, `MIN_SESSIONS=1`, `SESSIONS=2`, `QUIET_MINUTES=0`, `TE_FOLD_SYNC=1`; overlay without bootstrap. `--sessions` (default 2) sessions, then a control session. Flags: `--profile`, `--sessions`, `--used-tool`, `--proxied-tool`; unknown/incomplete flag or invalid value exits 2 with usage. Session ids come from new files in `<home>/dsh-sessions` (newest mtime). Snapshot of catalog + deny is taken right after session 1. The proxy variant is judged from DSH's own log (`tool/call` events: raw name `tool_call` with `arguments.name == <proxied-tool>`), because the spool already unproxies; "tool_call available" = it is in session 1's `request/header` tools.
- `plugin/dsh/test/live/common.mjs`: new exported `redact` (moved verbatim from `live-sidecall.mjs`, same behaviour).
- `plugin/dsh/test/live/live-sidecall.mjs`: imports `redact` from `common.mjs` instead of defining it (nothing else changed).
- No production code (`plugin/dsh/src`, `tokeneconomizer/`), `docs/dod.md`, tests touched; nothing committed.

gates:
- `node --check` on `common.mjs`, `live-sidecall.mjs`, `live-prune-loop.mjs`: ok.
- Usage: `--bogus x` and a trailing `--sessions` with no value both exit 2 with usage.
- `cd plugin/dsh && npm test`: 105 pass, 0 fail.
- `node plugin/dsh/test/live/live-sidecall.mjs --only paid`: 13/13 PASS (identical behaviour after the helper move).
- `node plugin/dsh/test/live/live-prune-loop.mjs` (real model, 3 sessions: 2 + control, exit 0): **15/15 passed**. Counts: catalog 183 (154 `mcp__*`), session 1 request 183 tools, deny 153 (all `mcp__*`, no bash/used tool/`tool_call`/`tool_search`), control request 30 tools (1 `mcp__*`, 0/153 denied names present, `bash` and the used tool present). deny == catalog `mcp__*` minus session 1's used tools (missing 0, extra 0); deny unchanged after session 2; session 2 called the used tool successfully (30 request tools).
- Work dir of that run: `$TMPDIR/te-dsh-live-prune` (`/var/folders/jq/.../T/`).

open:
- The proxy variant was NOT exercised live: in profile `headless` the session's `request/header` has no `tool_call` (183 tools, all MCP tools are listed directly, as in the spike), so the script printed `INFO proxy not exercised` and skipped the two proxy checks (by design, not a failure). The model, told "if a tool named `tool_call` is available", correctly did not use it and did not call the proxied tool at all (session 1 raw calls: `mcp__postgres__postgres_mcp_list_connection_profiles`, `bash`). The proxy path (spool records the carried tool, not `tool_call`) therefore stays covered only by the unit tests in `plugin/dsh/test`.
- With `--sessions 1` the later-session checks are skipped with an INFO line; the 15/15 run used the default 2.
- `docs/iterations/4-spike/*.mjs` left untouched (scratch).
