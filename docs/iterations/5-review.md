# Review of the spool PTC change (sol, read-only; saved by the orchestrator from the final message, condensed)
Counts as reported: Blocker 1, Major 0, Minor 3, Nit 0. 18 checked cases: 13 PASS, 2 WARN, 4 FAIL (the FAILs map to the findings below).
Passed: core reads the nested tools as used (run_code 1, nested MCP tool 1, prompts 1, requests 1); parent chain linear with nested result before the outer result; empty/non-string name skipped; `tool_call` proxy inside PTC unproxied; duplicate event in one process -> one call; two run_code calls; interleaved events; result and argument clipping at RESULT_CAP; 250 short dispatches complete; non-PTC spool byte-identical (SHA-256 test); spool mode 0600.

| severity | finding | disposition | evidence |
|---|---|---|---|
| Blocker (reviewer) | PTC inside a SUBAGENT is not in the root spool (plugin.mjs rejects sessions with parentSession) | see docs/reviews | plugin.mjs:30-34,127-145,239-245; child spool absent |
| Minor | Resume does not rebuild the dedup state or the fallback id base (replayed subCallId duplicates rows 5 -> 7; fallback id base changes) | proposed-fix | spool.mjs:86-87,96-110,174-182 |
| Minor | Circular `arguments` throw inside Spool.record before any row is written and poison dedup for that id (the plugin's handler catches it) | proposed-fix | spool.mjs:174-188; DSH events are JSON, so unreachable in practice |
| Minor | RESULT_CAP is per result, not per session (200 results of 20 kB -> 4.07 MB spool) | proposed-fix | spool.mjs:12-13; trace/pi.py:19-20 |
