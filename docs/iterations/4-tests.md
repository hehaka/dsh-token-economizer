# Iteration 4 — step 2a (tests only): PTC nested calls in the spool (plan T4, DoD D4, D6-D8)

## design:
**Sentence:** the spool must record each completed nested call of a `run_code` as a `toolCall` block (name = the nested tool, arguments, id = its `subCallId`) with a `toolResult` row (isError, content) next to the `run_code` block, so the core counts the tool as used; the `run_code` block and result stay, nested rows carry no usage, and every other session's spool stays byte-identical.

**Chosen event:** the `tool/ptc-dispatch` session event (`data`: `rootCallId, parentCallId, subCallId '<call>:ptc:N', name, arguments (object), isError, content [{type:text,text}], meta.cwd`), consumed in `Spool.record` (`plugin/dsh/src/spool.mjs`). Why this one:
- `plugin.mjs` already hands EVERY root-session event to `spool.record` (`ctx.on('session/event')`, line ~239; it already reads `request/context` from the same stream), and `record` today keeps only `user/message`, `assistant/message`, `tool/result`. So the dispatch events reach the plugin and are simply dropped; no new wiring is needed. (Test 8 pins that path through `createPlugin`.)
- It carries name, arguments, result and error flag in one event, and `subCallId` is a stable unique id. `tool/ptc-dispatch-start` has no result and must be ignored (else duplicates).
- The alternative, `tools/post-execute` for the nested call (the spike saw `PostToolUse` `bash` before `run_code`), has no `subCallId` link and writes to the core's hook channel, not the spool the core folds. It stays untouched.
- Order in the log is assistant(`run_code`) → dispatch(es) → `tool/result`(`run_code`), so the nested rows sit between the outer call and its result. A nested assistant row (one `toolCall` block, no usage, no model) followed by its `toolResult` keeps `pi_session_to_claude` pairing by id, and `pi_session_usage`/`pi_prompt_count` unchanged (test 7 pins both).
- Live confirmation (below): the spool of session 1 has `run_code` only, while DSH's log has `tool/ptc-dispatch` for the MCP tool and bash.

## changed:
- NEW `plugin/dsh/test/spool-ptc.test.mjs` (8 tests; node:test; uses `helpers.mjs` fakes and its own PTC event builders in the spike's shape):
  1. nested calls recorded as `toolCall` blocks named after the nested tool (MCP tool + bash; args; result text; start events not counted)
  2. `run_code` block and its result stay; nested calls sit between them (order)
  3. failed nested call recorded with `isError`
  4. dispatch without name / empty / non-string name / non-object / null / array / no data is ignored without throwing, a valid one in the same session is recorded, ids stay unique
  5. non-PTC spool byte-identical (sha256 `3cf62621…a5e1` of the spool `dshEvents()` produces with the unchanged `spool.mjs`, 8 rows, no `run_code`) — regression guard, PASSES now
  6. nested ids unique, equal to the `subCallId`s (also `:ptc:1` again under a second `run_code`), identical between an uninterrupted spool and one resumed by a new `Spool` on the same file
  7. core reader (`coreView`): 3 calls (run_code, MCP, bash), 1 prompt, 1 request, no extra usage
  8. through `createPlugin` (stub `run`): a `tool/ptc-dispatch` session event reaches the spool; not a prompt
- NEW `plugin/dsh/test/live/live-ptc.mjs` (flags `--profile`, `--used-tool`; unknown/incomplete flag → exit 2, checked). Temp git repo, isolated `TOKENECONOMIZER_HOME`, real core + live-prune-loop env, ONE overlay file inserting the plugin and `- id: tools / name: '@deepseek-ai/dsh-tools' / config: {mode: ptc}`; sessions 1, 2 (one `run_code` calling `<used-tool>` and bash from code) and a control. Checks: exit 0 of every run; (a) request tools exactly `[run_code]` (INFO count if more); also the model really dispatched both (DSH log `tool/ptc-dispatch`); (b) spool: `run_code` kept, nested `<used-tool>` and nested `bash` blocks, unique ids with result rows; (c) deny file only `mcp__*` and without `<used-tool>`/bash/`run_code`; (d) deny has none of the dispatched tools; core proposal/applied (`te status --json`) lists none of them; session 2 spool check only when the model dispatched the tool again; (e) errors.log has no line mentioning ptc (INFO line count).
- No production code, no docs/dod.md, no commit. `common.mjs` untouched.

## gates:
- `node --check` on both new files: OK.
- `cd plugin/dsh && npm test`: tests 161, pass 154, fail 7 (baseline 153/153; +8 tests: 7 fail, the guard passes). All 7 are assertion failures (`ERR_ASSERTION`, no syntax/other errors):
  - #111 each nested call … recorded as a toolCall block: `actual [] / expected [mcp__postgres__postgres_mcp_list_connection_profiles, bash]` (deepEqual on nested names)
  - #112 the run_code block and its result stay …: `actual ['run_code'] / expected ['run_code', mcp__…list_connection_profiles, 'bash']` (message "run_code first, then what it dispatched")
  - #113 a nested call that failed is recorded with isError: `actual [] / expected [mcp__…, bash]` ("a failed call is still a call of that tool")
  - #114 a dispatch without a name … ignored without throwing: `the one valid dispatch (ptc:3) is recorded` (expected true, actual false)
  - #116 ids of nested blocks are unique, derived from the call …: `actual [] / expected [toolu_01RunCodeA:ptc:1, toolu_01RunCodeA:ptc:2, toolu_01RunCodeB:ptc:1]`
  - #117 the core's own reader counts the nested tools as used …: `expected 3, actual 1` ("run_code, the MCP tool and bash")
  - #118 through the plugin, a tool/ptc-dispatch session event reaches the spool: `actual ['run_code'] / expected ['run_code', mcp__…, 'bash']`
  - #115 (byte-identical non-PTC guard) PASSES; the 153 earlier tests still pass.
- `node plugin/dsh/test/live/live-ptc.mjs` run once (real model, headless profile; exit 1, 10/18 passed, ~25 s of model time). EXPECTED FAILURES, which is the finding:
  ```
  PASS  (a) session 1's first request has exactly the tools [run_code]  (1 tools: run_code)
  session 1 dispatched (DSH log tool/ptc-dispatch): mcp__postgres__postgres_mcp_list_connection_profiles, bash
  session 1 spool calls: run_code
  FAIL  (b) the spool … holds a toolCall block for the nested mcp__postgres__postgres_mcp_list_connection_profiles  (calls: run_code)
  FAIL  (b) … for the nested bash  (calls: run_code)
  FAIL  (b) the nested blocks have unique ids and a result row each  (0 nested block(s))
  catalog 184 tools (154 mcp__*); deny 154
  FAIL  (c) deny contains none of <used-tool>, bash, run_code  (mcp__postgres__postgres_mcp_list_connection_profiles)
  FAIL  (d) deny contains none of the tools DSH's log shows session 1 dispatched  (mcp__postgres__postgres_mcp_list_connection_profiles)
  FAIL  after session 1: the core's proposal/applied do not list …  (applied 154, listed: <used-tool>)
  session 2 dispatched: none; spool calls: run_code        (INFO: the denied tool was no longer there)
  FAIL  (c) after all sessions deny still has none of …    FAIL  after the control session: proposal/applied …
  PASS  (e) errors.log has no line mentioning ptc  (0 of 0 lines)
  ```
  All three runs exited 0; (a) and the "dispatched from code" check pass, so PTC took effect and the model did what the prompt asked. Failing now: (b) ×3, (c) ×2, (d), proposal ×2 — all consequences of the single missing spool rows. Work dir `/var/folders/jq/7dpgx9ln3pb1zv_xg8m6dshr0000gn/T/te-dsh-live-ptc`.

## open:
- The live run shows the real consequence of the bug: the core denied the used MCP tool (154 `mcp__*` names), and in session 2 the model could not use it any more (`dispatched: none`). After the fix this check path (session 2 spool) only runs if the model dispatches again; that is intentional (INFO otherwise).
- Production choices left to step 2b that the tests leave open: whether a dispatch without `subCallId` (but with a name) is recorded with a synthesized id or dropped (test 4 allows both, only requires unique ids); the nested assistant row's shape (one row per dispatch, or all nested blocks in one row) — tests read blocks/results across rows, not row structure, except that the nested result must precede the `run_code` result.
- The nested `toolResult` text should be capped by `RESULT_CAP` like other results (not pinned by a test; add in 2b with the mutation test if wanted).
- Mutation check (plan T4 "with a mutation test") is for step 2b/3: e.g. dropping the `tool/ptc-dispatch` branch must turn tests 1-3, 6-8 red.
- D7 (≥ 152 tests, 0 failures) and D8 are not evaluated in this step (7 intended red tests now); Python suite not run (no Python changes).
- The guard hash pins `spool.mjs` output for `dshEvents()`; if a later change legitimately alters non-PTC rows (e.g. new metadata), update the hash deliberately.
