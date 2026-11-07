# Iteration 2: implement T2 (live-multisession.mjs; DoD D1, D2)

No production code (`plugin/dsh/src`, `tokeneconomizer/`) was changed: no live run showed a defect. Nothing committed; `docs/dod.md` untouched.

changed:
- `plugin/dsh/test/live/live-multisession.mjs` (new): `node plugin/dsh/test/live/live-multisession.mjs [--profile headless] [--only models|resume] [--model-b provider/model]`; unknown flag / `--only` value / `--model-b` equal to haiku or without a `/` -> usage, exit 2; default runs both groups.
  - `models` (D1): pure HTTP RPC of `dsh web` for BOTH sessions, no Chrome (the spike's Q1c recipe worked: launch token -> cookie -> `workspace/initializeDefault`, `session/create`, `session/selectModel`, `session/prompt`). Isolated DSH_HOME + TOKENECONOMIZER_HOME, real core, `TE_TOOLPRUNE=off`, temp git repo as the workspace (`documentsDirectory`). A = anthropic/claude-haiku-5-5, B = `--model-b` (default anthropic/claude-sonnet-5-5). Checks: session routes from `request/context`, spool ids = session ids, (a) A/B replies equal their log routes and differ, (b) A again = A, (c) unknown session 409 NO_ROUTE and no text/provider/model/usage, (d) no `session` -> 200 with text, (e) non-zero usage for each 200 reply, (g) endpoint file gone after SIGTERM; plus one-endpoint-file-per-process. INFO (f), (d) route, (g) when not gone.
  - `resume` (D2): headless run 1 on the profile default (haiku), run 2 = `dsh --profile P --patch <stub> --patch <agent-default-model overlay = --model-b> --session-id <id>` in the same cwd, stub core in `TE_LIVE_ROUTE=1` mode. Checks: run 1 was not on model B (non-vacuous), (a) last `request/context` = model B, (b) UserPromptSubmit row succeeded on model B (a reply on the old default prints `FINDING:` and fails) and its request named the resumed session, (c) PostToolUse row succeeded on model B and named the session (absent row -> INFO, UserPromptSubmit alone decides; in the real run the stub DID get a PostToolUse row in the resumed session). `--model-b` also sets the resume target.
- `plugin/dsh/test/live/common.mjs`: added `alive`, `profileModelPatch(work, profile)` (moved verbatim from browser-check, one optional parameter added), `startWeb(prep, extraEnv, profile)` (isolated `dsh web`), `webClient(url)` (cookie + `rpc(method,args)`), `endpointPost(home, body)` (POST /v1/complete with Bearer token and Host header; no credential is returned for printing). Existing exports and the other live scripts are untouched.
- `plugin/dsh/client/test/browser/browser-check.mjs`: its local `profileModelPatch` and `alive` removed, it now calls `live.profileModelPatch` / `live.alive` from common.mjs; two unused imports dropped; behaviour unchanged.
- `plugin/dsh/test/live/stub_core.py`: the route row also carries `session` (the `TE_DSH_SESSION` the hook was given, None without), so the resume check can prove the endpoint request named the session. Additive.
- `plugin/dsh/test/stub_core.test.mjs`: `hook()` got an optional `session` option; the pinned key list of the route row gained `session` (and asserts null when unset); one new test: rows carry the session and the real runner sends it as `session` (mutation checked: dropping the field from the stub fails 2 tests, restored). No test deleted or weakened.

gates:
- `node --check` on every changed/new .mjs and all live/browser scripts: ok.
- `cd plugin/dsh && npm test`: 153 tests, 153 pass, 0 fail (was 152; +1 new).
- `node plugin/dsh/test/live/live-multisession.mjs --only models`: 24/24, exit 0 (run twice, real haiku+sonnet).
- `node plugin/dsh/test/live/live-multisession.mjs --only resume`: 9/9, exit 0.
- `node plugin/dsh/test/live/live-multisession.mjs` (both): 33/33, exit 0.
- `node plugin/dsh/client/test/browser/browser-check.mjs`: 4/4; `... --prune`: 24/24 (real model).
- `node plugin/dsh/test/live/live-check.mjs`: 25/25; `node plugin/dsh/test/live/live-sidecall.mjs --only route`: 7/7 (after the stub change).
- `/tmp/te-venv/bin/python -m pytest tests -q -k "stub or live or dsh"`: passed (no failures).
- `python3 scripts/dsh_diff_budget.py`: 46 (budget 60), unchanged.
- Model calls: about 8 per full multisession run (A, B prompts + 5 endpoint calls + the early (f) call; resume: 2 prompts + 3 stub side calls), all tiny on haiku/sonnet.

open:
- KNOWN LIMIT (f), observed every run (not failed): after `session/selectModel` to sonnet and BEFORE B's first model request, a call naming B is answered 200 by anthropic/claude-haiku-5-5 (the server default = `agent.options`), not sonnet. The plugin only learns a route from `agent.options` at `agent/created` and from `request/context`. Consequence: it ran on the default model, never on another session's. Matches spike Q1g and decisions.md (T2 watch item); not fixed, no DSH event carrying the selection was used (the log's `model/selection` event was not wired in).
- INFO (d): a call naming no session ran on anthropic/claude-sonnet-5-5 = B, the last route observed (A's first, B's later).
- INFO (g): in all runs the endpoint file was gone after SIGTERM of the server (checked via the file's owner pid).
- INFO: the SessionStart side call of the RESUMED headless run succeeded on sonnet (it raced `agent/created`; the spike's probe inside the listener got NO_ROUTE). UserPromptSubmit and PostToolUse both ran on sonnet and named the resumed session; no defect found for D2.
- Spike resume recipe used as-is (`--session-id`, overlay of `agent-default-model`); the web-UI (Chrome) was not needed. Resume in `dsh web` and two simultaneous prompts remain untested (as in the spike).
- The headless resume group, like the other live scripts, writes its sessions to the real `~/.dsh/sessions` (headless profile); the models group uses an isolated DSH_HOME.
- `live-sessions.mjs` was not re-run (the only shared change is an extra field in the stub's route rows; live-sidecall route and live-check pass).
