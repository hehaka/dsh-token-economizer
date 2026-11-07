# T8 fixes A: review findings F1-F7 (DSH side-call endpoint)

TDD per finding: failing test first (seen red on an assertion), minimal fix, mutation by hand (break the fix,
the test fails, restore; restored files were diffed against a backup copy). Nothing committed; `docs/dod.md` untouched.

| finding | test (name) | red-before | mutation | status |
|---|---|---|---|---|
| F1 route per session (Blocker) | node `sidecall.test.mjs`: "the endpoint hands the NAMED session to the route lookup"; "with two sessions on different models, a call naming a session runs on that session's route"; "a subagent never sets a route, not even its own"; "the routes kept are bounded: above 64 sessions the oldest is forgotten"; "every hook's environment carries the id of the session it runs for". pytest `test_the_session_of_the_hook_is_sent_so_the_plugin_picks_its_route` | yes: call naming A ran on `last`/B's route (assertion); bound test and env test red; pytest: body lacked `session`. (The subagent test was green before: it pins existing behaviour.) | endpoint ignores `session` -> 3 tests fail; no per-session `set` -> 2 fail; no 64-bound -> 1 fails; no `TE_DSH_SESSION` in hook env -> 1 fails; subagent allowed to set route -> 2 fail; Python omits `session` -> pytest fails | fixed |
| F2 symlink at endpoint path (Blocker) | node: "a symlink planted at the endpoint path is replaced, never followed: its target is left alone (F2)"; "an endpoint directory that is itself a symlink is not written through (F2)" | yes: victim overwritten with the token JSON; linked dir got the file | no `unlink` -> test fails (EEXIST under `wx`, not published); no dir `lstat` check -> dir test fails. `flag: 'wx'` alone is NOT independently covered: with `unlink` in place it only matters in an unlink-to-create race, which I did not inject (defence in depth) | fixed |
| F3 half-sent body holds a slot (Minor) | node: "a half-sent request body does not hold a slot past the deadline (F3)" (timeoutMs 180, two partial bodies, third call at ~260 ms must be 200) | yes: `BUSY` (429) at 260 ms | body read no longer listens to the abort signal -> fails | fixed |
| F4 body limit counted in UTF-16 units (Minor) | node: "the body limit counts bytes, not string length: a chunked 4-byte-emoji body over it is refused (F4)" (1.6 MB chunked, 0 model calls) | yes: status was not 413 (accepted, reached the model) | count by string length -> fails; limit x100 -> fails | fixed |
| F5 provider error text unredacted (Minor) | node: "a provider failure message that echoes the token or the prompt is scrubbed before it leaves (F5)" (MODEL and AUTH; token, whole prompt, 26-char excerpt; 300-char cap; log lines) | yes: token found in reply | scrub not applied / no token removal / no whole-prompt removal / no 20+ run removal / no cap -> each fails | fixed |
| F6 pause only for code AUTH (Minor) | pytest `test_only_the_providers_refusal_pauses_never_a_message_that_says_so` (4 sign-out messages x MODEL 502, TE_AUTH 401, TIMEOUT, NO_LLM, NO_ROUTE: no pause, one log line each with the text intact; AUTH with and without status: pause) | yes: MODEL with "not signed in"/"/login"/"To authenticate"/"not logged in" paused | non-AUTH routed back through `sidecall._no_reply` -> fails; pause for any code -> fails; TE_AUTH also pauses -> fails; AUTH no longer pauses -> existing + new tests fail | fixed |
| F7 unserialisable prompt (Nit) | pytest `test_a_prompt_that_cannot_be_serialised_is_no_answer_with_one_log_line` (object, bytes, dict with a set) | yes: `TypeError` raised | `TypeError` removed from the except -> 3 fail | fixed |

changed:
- `plugin/dsh/src/sidecall.mjs`: `ENV_SESSION`; endpoint reads `session` (string, else 400) and calls `route(sessionId)`; endpoint file: dir must be a plain directory (lstat), existing path removed with `unlink`, written with `wx` + 0600, sweep runs after the dir check; `readBody` (byte count, aborted by the deadline, closes the connection on a stalled body, lingers 2 s to discard an oversize one so the sender can read the 413); `scrub()` (token, prompt, 20+ char runs, 300-char cap; raw message kept to 1000 chars before scrubbing); header comment.
- `plugin/dsh/src/plugin.mjs`: per-session route `Map` (max 64, oldest dropped; set only for root sessions on `agent/created` and `request/context`), `lastRoute` for calls naming no session; `hookEnv(sessionId)` adds `TE_DSH_SESSION`; `run` passes `payload.session_id`.
- `tokeneconomizer/plugin/dsh_sidecall.py` (dsh-only): `ENV_SESSION`, `session` in the request body (omitted when absent/empty); whole request build inside the guarded block (TypeError/ValueError/OSError -> `("", None)` + one line); `_note()` logs without pausing; only code AUTH goes through `sidecall._no_reply` (pause); docstrings. No upstream file touched (`sidecall.py`, `cli.py` untouched).
- Tests: `plugin/dsh/test/sidecall.test.mjs` (+210 lines; the `endpoint()` helper gained `routeFor`, `callEndpoint` an optional session; no test removed or weakened), `tests/test_dsh_sidecall.py` (+40).
- Docs: `docs/dsh/adr/0004-*.md` (Polish: Katalog narzędzi now `tools.schemas(agent)`; endpoint file; limits and scrubbing; Trasa per sesja; Błędy: pause by code only; "Nie sprawdzone na żywo" notes per-session routing is tested with a fake `ctx.llm` only), `plugin/dsh/README.md` (one phrase: `TE_DSH_SESSION`).

gates:
- `node --check` on all `plugin/dsh/src/*.mjs` and `test/*.mjs`: ok.
- `cd plugin/dsh && npm test`: 134 pass, 0 fail.
- `/tmp/te-venv/bin/python -m pytest -q tests/test_dsh_sidecall.py tests/test_dsh_host.py`: all pass.
- `python3 scripts/dsh_diff_budget.py`: 32 (budget 60), unchanged.
- `node plugin/dsh/test/live/live-sidecall.mjs`: 20/20 PASS on the real model (paid group 3 variants + route group; the UserPromptSubmit and PostToolUse hooks succeeded on the session's provider/model, so the `TE_DSH_SESSION` -> `session` -> per-session route path works end to end; the stub core inherits the env, nothing to pass through).
- `node plugin/dsh/test/live/live-check.mjs`: 25/25.

open:
- Per-session routing is verified live only with ONE session (the live profile is headless); two sessions on different models in one process is covered by the plugin tests with a fake `ctx.llm`, not on a real `dsh web`.
- `wx` in the endpoint file write is not independently mutation-covered (see F2).
- An empty-string `session` is treated as absent (same as omitted); a hook whose session is not a root session (subagent) would get NO_ROUTE for its own id, by design (subagents never set a route).
- The Python client does not additionally strip the token/prompt from reply text (the scrub is in the Node endpoint, as specified).
- `docs/implementation-status.md`, `docs/iterations/decisions.md`, `docs/iterations/state.json` were already modified before this work and were not touched by it.
