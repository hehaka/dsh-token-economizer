# Iteration 3 — implement: T4 (route before the first request; DoD D3, D6, D9)

Production code unchanged (`plugin/dsh/src/plugin.mjs` is byte-identical to HEAD; the spike's finding that
`observeRoute(agent.options)` reads real data held). Nothing committed; `docs/dod.md` untouched.

changed:
- `tests/test_dsh_sidecall.py`: a `409 NO_ROUTE` case added to the parametrized error replies (no answer, `sidecall dsh: no reply`, no pause);
  new `test_no_route_yet_is_no_answer_that_pauses_nothing_and_charges_nothing`: the runner gives `("", None)`, exactly one errors.log line,
  `sidecall.paused("dsh", state) is None`, `Runner.estimate_effective("p", "") == 0.0` and `pricing.runner_effective_or_approx(runner, "p", "", None) == 0.0`.
- `plugin/dsh/test/sidecall.test.mjs` (+3 tests, import of `subSession`):
  (a) before any `agent/created` / `request/context` the real endpoint answers HTTP 409 `NO_ROUTE` and `prepareCall` is never invoked; an agent with no/partial options (`{}`, `{provider}` only) changes nothing;
  (b) after a ROOT `agent/created` with `{provider, model}` and before any `request/context`, a call runs on exactly that provider/model (one `prepareCall`);
  (c) a subagent's `agent/created` (header `parentSession` + `origin: 'subagent'`) with another route neither creates a route (409 when it comes first) nor replaces the root's.
  (d) the `request/context` replacement stays covered by the existing test "the route a call runs on follows the session"; not duplicated.
  Mutation check by hand on `plugin.mjs`, restored (`git diff --quiet plugin/dsh/src/plugin.mjs` clean):
  drop the `isRoot` guard before `observeRoute(agent.options)` -> test (c) fails; drop `observeRoute(agent.options)` -> existing route test + (b) + (c) + the services test fail;
  extra: a default route `let route = {provider:'dflt',model:'dm'}` -> (a) and the others fail.
- `plugin/dsh/test/live/stub_core.py`: opt-in `TE_LIVE_ROUTE=1`. On SessionStart / UserPromptSubmit / PostToolUse, ONCE per hook name per run (O_EXCL marker
  `<TE_LIVE_SIDE>.route.<hook name>`), the real `sidecall.runner_for("dsh", cfg)` with `paid_model ""` and the prompt "Reply with the single word: pong";
  appends `{phase, text, effective, charge, reply, error?}`, `charge = pricing.runner_effective_or_approx(runner, prompt, text, effective)`
  (0 when the call yielded nothing). Never raises; one call per hook. The per-call capture (spy on `urlopen`, error body of an HTTPError kept) was factored out
  of `runner_calls` into `_run_one` and is shared by both modes; `runner_calls` rows are byte-for-byte the same shape (existing 7 stub tests pass unchanged).
  If both `TE_LIVE_ROUTE` and `TE_LIVE_RUNNER` are set, route wins (the live script blanks `TE_LIVE_RUNNER`).
- `plugin/dsh/test/stub_core.test.mjs` (+4 tests, existing ones untouched; helpers got optional, default-off `answer` / `route` options):
  one row per hook name and a second payload of a name adds none (3 requests, `paid_model` null, row keys, charge == effective); other hooks (Stop, SessionEnd) call nothing and the notes are still answered;
  a NO_ROUTE 409 body -> `reply.error.code === 'NO_ROUTE'`, text `''`, `effective` null, `charge` 0, no `error` field, no `sidecall.json` pause file, `sidecall dsh: no reply` in errors.log, next hook name still calls;
  a vanished plugin -> row with `error`, charge 0, exit 0.
- `plugin/dsh/test/live/live-sidecall.mjs`: group `route` implemented (the "not implemented" stub and its forced exit 1 removed). One headless session (bash `echo te-live-route`),
  `TE_LIVE_ROUTE=1`, isolated `TOKENECONOMIZER_HOME`; the route is read from the session log's `request/context`. Checks: all three rows exist (count printed);
  SessionStart is a clean NO_ROUTE (empty text, charge 0) OR a success on the session's route (INFO line says which); UserPromptSubmit succeeds on the session's provider/model with text and effective > 0;
  PostToolUse succeeds on the route; no `hosts/dsh/sidecall.json`. Everything printed from replies/errors goes through the existing `redact()`. `--only route` and the full run both execute it.

gates:
- `node --check` on `sidecall.test.mjs`, `stub_core.test.mjs`, `live-sidecall.mjs`: ok; `python3 -m py_compile stub_core.py`: ok.
- `cd plugin/dsh && npm test`: 105 tests, 105 pass, 0 fail (98 + 3 + 4).
- `/tmp/te-venv/bin/python -m pytest -q tests/test_dsh_sidecall.py`: 35 passed.
- `node plugin/dsh/test/live/live-check.mjs`: 25/25.
- `node plugin/dsh/test/live/live-sidecall.mjs --only route` (real model): 7/7, exit 0. Full `node plugin/dsh/test/live/live-sidecall.mjs`: 20/20 (13 paid + 7 route), exit 0.

open:
- INFO observed for SessionStart (2 live runs, both): SUCCESS on anthropic/claude-haiku-5-5 (text "pong", effective 36, charge 36), not NO_ROUTE. The SessionStart hook is a
  spawned python process, so by the time its call reaches the endpoint `agent/created` (+55 ms after `session/created`) has already set the route: the call raced and won.
  The clean NO_ROUTE path is therefore pinned only by the Node unit tests, the Python test and the stub_core fake-endpoint test, not observed live; a faster hook launcher could flip this
  (the live check accepts both).
- Subagent branch of the route is verified in unit tests only (spike Q4 was code reading; no live subagent run).
- `redact()` also masks 24+ char JSON keys in the printed reply (e.g. `cache_creation_input_tokens` shows as `<redacted>`); cosmetic, left as is.
- The `request/context` route in `plugin.mjs` is applied for root sessions only (via `stateFor`), same as `agent/created`; a subagent's request never moves the route.
