# Iteration 4 — step 2b (production code): PTC nested calls in the spool

## changed:
- `plugin/dsh/src/spool.mjs` (+27 lines, nothing else; `plugin.mjs` needed no change — it already hands every root-session event to `Spool.record`):
  - `record` handles `tool/ptc-dispatch` via new private `#nestedCall(d)`; `tool/ptc-dispatch-start` and everything else stay ignored (return null).
  - Per dispatch: one assistant row (a single `toolCall` block: id = `subCallId`, name = nested tool, arguments via `parseArgs`/`unproxy`; no model, no usage) followed by a `toolResult` row (`isError: Boolean(d.isError)`, text of `d.content` through `clip`/`RESULT_CAP`). The rows are written when the dispatch event arrives, i.e. between the `run_code` assistant row and its `toolResult`; they go through `#add`, so the `parentId` chain stays linear and valid.
  - Dispatch without a string, non-empty `name` (or with no usable `data`) → ignored. Never throws (all guards are type checks).
  - No `subCallId` → id synthesized as `<last tool-call id>:ptc:s<n>` (the `s` keeps it from ever equalling a real `<call>:ptc:<n>`; test 4 requires that a nameless/odd dispatch never produce `<RUN>:ptc:1`). A `subCallId` seen again in the same process is not recorded twice.
  - New fields on `Spool`: `lastCall` (updated in the assistant branch), `nested` (Set of ids). The non-PTC path only gains the `lastCall` assignment; no output change (guard test 5 passes, sha unchanged).
- No test, live script, docs/dod.md edited; no commit. (`docs/iterations/4-implement.md` is this report.)

## gates:
- `node --check plugin/dsh/src/spool.mjs`: OK.
- `cd plugin/dsh && npm test`: tests 161, pass 160, fail 1 — the one failure is test #7 (`spool-ptc.test.mjs:182`), which is WRONG, see open. 7 of the 8 new tests pass (1-6, 8); the 153 earlier tests pass. With line 182 corrected to `[true, true, true]` in a temp copy (deleted) all 8 pass.
- `node plugin/dsh/test/live/live-ptc.mjs` (real model): run 1 19/19, run 2 19/19. Both: session 1 spool calls `run_code, mcp__postgres__…list_connection_profiles, bash`; deny 153 (was 154: the used tool is no longer denied); session 2 dispatched the tool again and its spool check ran; errors.log no ptc lines.
- `live-check.mjs` 25/25; `live-prune-loop.mjs` 15/15; `live-proxy.mjs` 26/26.
- `/tmp/te-venv/bin/python -m pytest -q tests/test_dsh_toolprune.py tests/test_dsh_sidecall.py tests/test_plugin_package.py`: all pass (0 failures).
- `python3 scripts/dsh_diff_budget.py`: 46 (budget 60), unchanged.
- Core Pi reader on a spool produced by the live PTC run: `pi_session_to_claude` → 3 calls `[run_code, mcp__postgres__postgres_mcp_list_connect…, bash]` all success, `pi_prompt_count` 1, `pi_session_usage` requests 2 (the two real model requests of that session; nested rows add none).
- Mutation checks by hand (backup, `sed`, run `spool-ptc.test.mjs`, restore; `cmp` against the backup and `git diff --stat` show only the 27 intended added lines):
  - M1 drop the `tool/ptc-dispatch` branch → tests 1, 2, 3, 4, 6, 7, 8 fail.
  - M2 `isError` forced to false → test 3 fails (and 7 is the already-wrong one).
  - M3 ignore `subCallId` (always synthesize) → tests 4, 6 fail.
  - M4 remove the name guard → test 4 fails.
  - Restored: `spool.mjs` identical to the fixed version; the suite is back to 7/8 (test 7 only).

## open:
- **Test #7 is wrong (not edited, parent decides).** `spool-ptc.test.mjs:182` asserts `view.traj.map(t => t[1])` deepEquals `[false, false, false]`, but `t[1]` is `c[3]` of `claude_calls`, i.e. `success` (`not is_error`), as the helper's own use `[c[0], c[3]]` shows. All three calls succeeded, so the core returns `[true, true, true]`. Existing non-PTC spool gives `[["bash",false],["bash",true],["read",true]]` where false is the failed bash. Fix: line 182 → `[true, true, true]` (or assert the semantics another way, e.g. a failing nested call gives false). D7's "0 failures" can't be met until this one line changes.
- After a process restart (resumed `Spool`), `lastCall`/`nested` start fresh: ids with a `subCallId` are unaffected (test 6); a repeated dispatch after a restart would be recorded again, and a synthesized id might restart at `s1` under a different base call — harmless (base differs per `run_code`) and only on events lacking `subCallId`, which DSH does not produce.
