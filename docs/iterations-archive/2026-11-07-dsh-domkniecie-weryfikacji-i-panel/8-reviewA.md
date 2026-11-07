# Review A (sol, read-only): endpoint security and robustness
Saved by the orchestrator from the reviewer's final message (condensed; the reviewer could not write files).
Counts: Blocker 2, Major 0, Minor 4, Nit 1. 33 checked cases, 6 FAIL, 4 HARDENING, rest PASS.

| severity | finding | disposition | evidence |
|---|---|---|---|
| Blocker | Route shared by all sessions in a process; a call for session A ran on session B's model without paid_model | proposed-fix | plugin.mjs:79-82,106,197,231; two-session probe: call for A answered by pB/model-B |
| Blocker | Endpoint file write follows a pre-planted symlink; target overwritten with token JSON, mode stays 0644 | proposed-fix | sidecall.mjs:175-181; probe with symlink to a 0644 victim file |
| Minor | Deadline timer does not abort reading an unfinished body; two half-sent POSTs hold both slots | proposed-fix | sidecall.mjs:132-161; timeoutMs 180, third POST after 260 ms got 429 BUSY |
| Minor | MAX_BODY_BYTES compared with string length, not UTF-8 bytes (chunked) | proposed-fix | 1,600,026-byte body accepted with limit 1,000,000 |
| Minor | Provider error text (may hold prompt/token) returned in HTTP reply and errors.log | proposed-fix | sidecall.mjs:99-103,156; dsh_sidecall.py:85-92 |
| Minor | MODEL error whose message contains 'not signed in' pauses side calls (pause must be provider 401/403 only) | proposed-fix | dsh_sidecall.py:85-92, sidecall.py:67,85 |
| Nit | json.dumps outside the guarded block: non-serializable prompt raises | proposed-fix | call({1}) -> TypeError |

Passed checks (no finding): wrong/empty/prefix token -> 401 TE_AUTH; foreign Host and `localhost` -> 403; correct Host -> 200; prompt at the limit 200, over -> 413; maxTokens 0/4097 -> 400, 4096 -> 200; chunked ASCII over limit -> 413; Content-Length huge without body -> 413 with no model call; CL+TE conflict -> 400; endpoint file 0600; three parallel calls -> third 429; client hang-up aborts the model call; provider 401 pauses, TE_AUTH does not; no endpoint -> ("", None). Odd `model` strings (a//b, ../x, space, 12,000 chars) passed through to the fake llm (hardening only).
