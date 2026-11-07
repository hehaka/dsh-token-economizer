# Review B (mai, read-only): pruning correctness and accounting
Saved by the orchestrator from the reviewer's final message (condensed). Counts: Blocker 0, Major 3, Minor 8, Nit 5. 35 checked cases.

| severity | finding | disposition | evidence |
|---|---|---|---|
| Major | Host-wide catalog: tools from another repo's session enter this repo's deny file | proposed-fix | simulation: catalog with mcp__crm__search/update, repo with 3 bash-only sessions -> deny holds both; adapter.py:127-141, stage.py:181, fold.py:464 |
| Major | Plugin reads deny from session cwd, core writes at git root: sessions from a subdirectory get no pruning | proposed-fix | readDeny(root) -> [mcp__a__b], readDeny(root/pkg/app) -> [] |
| Major | applyDeny sends one batch to restrict; one rejected name (scope-local, run_code) applies nothing | proposed-fix | fake restrict modelled on dsh-tools/lib/index.js:2991-3005 |
| Minor | llm_nudge_writer charges 0 for an empty answer with real usage (judge.py:94-96, pre-existing) | proposed-fix | probe4: judge 250.0, nudge 0 |
| Minor | Wrong-shape hand-edited settings file raises AttributeError/TypeError, not RuntimeError | proposed-fix | denylist.py:248-295 |
| Minor | `deny` as a string: apply says OK, restore writes a list of characters | proposed-fix | probe2 A6/R3 |
| Minor | `te toolprune apply NAME` on dsh does not check protected names | proposed-fix | cli.py:442-447 |
| Minor | Corrupt catalog.json is never repaired | proposed-fix | tools.mjs:47 |
| Minor | PTC (run_code) sessions record only run_code; MCP use by the SDK looks unused (unverified live) | proposed-fix | spool.mjs:67-76 |
| Minor | side.paused true/array shown as active | proposed-fix | model.cjs modelCalls() |
| Minor | ADR 0004 describes the global tool view, code uses schemas(agent) | proposed-fix | tools.mjs:32-39 |
| Nit | Python _usage accepts NaN/Infinity/negative/bool | proposed-fix | probe3 |
| Nit | Tool-pruning panel detail unbounded; proposal object with length counted | proposed-fix | view.cjs:12 |
| Nit | DSH_PROTECTED: empty name, `mcp__`, `mcp__x` prunable (unreachable from DSH catalog) | none | probe1 |
| Nit | usage.reasoningTokens not mapped | none | sidecall.mjs:54-63 |
| Nit | After restore a plugin-created file stays as {} | none | probe2 R7 |

Passed checks: DSH_PROTECTED protects bash, tool_call, case variants, glob metacharacters, unicode lookalikes, 100k-char names; apply on new/person-owned file, invalid JSON, non-object; restore removes only plugin additions; symlinked .dsh/file refused; readDeny shapes; unproxy cases; writeCatalog atomic with 4 concurrent writers; accounting with cache tokens, unknown model, unreachable endpoint (0), HTTP 500/401; panel malformed side, state badge text, no claims-of-effect wording.
