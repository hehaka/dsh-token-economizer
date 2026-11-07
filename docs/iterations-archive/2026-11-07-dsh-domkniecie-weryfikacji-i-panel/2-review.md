# T3 review (sol, read-only; report saved by the orchestrator because the reviewer was told not to edit files)

| severity | file:line | reason |
|---|---|---|
| Major | plugin/dsh/test/live/stub_core.py:65-70,81-113 | Three real model calls run serially inside ONE PostToolUse hook; the bridge kills a hook after 20 s (`plugin/dsh/src/bridge.mjs:11`). The once-marker is written before the calls, so later hook processes never finish the missing variants. With 7.1 s per call a local fake endpoint reproduced: SIGKILL after 20 s, 2 of 3 rows, second hook adds nothing. |
| Minor | plugin/dsh/test/live/live-sidecall.mjs:90-94 | `row.error` and the non-text fields of the raw reply are printed unredacted; a provider error message can contain a credential (`sidecall.mjs:102` forwards 300 chars). The "credentials are never printed" comment is not guaranteed. |

| case | input | expected | actual | verdict |
|---|---|---|---|---|
| Unknown CLI flag | `--unknown` | exit 2 | exit 2, usage | ok |
| Invalid group | `--only nope` | exit 2 | exit 2 | ok |
| Route placeholder | `--only route` | exit 1, not implemented | exit 1, message | ok |
| Incomplete flags | `--only`, `--paid-a` | exit 2 | exit 2 both | ok |
| Previous raw POST | PostToolUse, TE_LIVE_SIDE, no TE_LIVE_RUNNER, local HTTP | 1 plain POST, old row shape | 1 POST, `endpoint_env,reply`, exit 0 | ok |
| Three real runners | TE_LIVE_RUNNER=1, TE_LIVE_PAID=["","other/changed","bare"], local HTTP | 3 variants with text, priced | 3 rows, text=pong, effective>0 | ok |
| Guard between hook processes | two PostToolUse processes | only first runs variants | second: 0 requests, 0 rows | ok |
| Invalid paid JSON | TE_LIVE_PAID={not json | no hang, no crash | exit 0, one row `setup: JSONDecodeError` | ok |
| SessionStart | TE_LIVE_RUNNER=1 | no side call | exit 0, no side.jsonl | ok |
| HTTPError and spy | local endpoint 502 | raw error kept, urlopen restored | kept; `urlopen is orig` | ok |
| 20 s hook window | endpoint 3 x 7.1 s, 20 s timeout | all 3 results | -9, 2/3 rows, marker kept, next hook adds 0 | finding |
| Offline Node tests | `node --test plugin/dsh/test/sidecall.test.mjs` | 0 failures | 23/23 | ok |

Blocker 0, Major 1, Minor 1, Nit 0
