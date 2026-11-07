# T8 fix batch B: review findings G1-G7

Not committed. TDD per finding: regression test first (seen red on an assertion), minimal fix, hand
mutation (break, test fails, restore, `cmp` against a saved copy).

| finding | test (name) | red-before | mutation | status |
|---|---|---|---|---|
| G1 restrict batch (Major) | `plugin/dsh/test/tools.test.mjs`: `G1: a name restrict refuses does not stop the others from being hidden`; `G1: run_code, tool_call and tool_search are never sent to restrict`; `G1: a restrict that refuses everything leaves applied empty and does not throw`; `G1: the batch is tried first ..., each name alone only after a throw`; `G1: at agent creation one refused name still lets the rest be hidden, and the refusal is logged once` | 5/5 red (AssertionError; `doesNotThrow` wraps the old throw) | drop retry loop -> 4 fail; drop the never-send filter -> 2 fail; drop the log line -> 2 fail; restored | fixed |
| G2 repo root for deny file (Major) | `G2: a session started in a subdirectory reads the deny file at the repository root`; `G2: without a repository the file next to the session is read, and no parent's`; `G2: in a nested repository the nearest .git wins; a .git file (worktree) counts`; `G2: at agent creation a subdirectory session gets the root's deny list` | 3/4 red (the no-.git test passes on old code by design, it pins the fallback) | `repoRoot` always cwd -> 3 fail; farthest `.git` wins -> 1 fail; no `.git`-file support -> 1 fail; restored | fixed |
| G3 host-wide catalog of any repo (Major) | pytest `tests/test_dsh_toolprune.py`: `test_a_repos_own_catalog_is_not_polluted_by_another_repos_tools`, `test_the_host_wide_catalog_is_still_the_fallback_without_an_own_file`, `test_load_catalog_prefers_the_repos_file_and_keeps_its_old_signature`; node: `G3: the catalog is also written per repository, named by the sha1 of its root`, `G3: two repositories give two catalog files; the host-wide one is the last session's` | pytest 1 assertion red (A's `mcp__crm__*` in B's `catalog_tools`) + 1 TypeError (new arg); the fallback test is green before and after by design; node 2 red on assertion | fold call without root -> 1 fail; `load_catalog` ignores own file -> 2 fail; key `[:15]` -> 2 fail (py) and 1 fail (node); plugin keys by cwd instead of root -> 1 fail; no own file written -> 2 fail; restored | fixed (fits the budget) |
| G4 corrupt catalog never repaired (Minor) | `G4: an unreadable previous catalog is treated as changed and rewritten atomically` (5 junk contents, mode 0600, no `.tmp` left, then unchanged again) | red (returned false) | unreadable -> throw again -> fails; restored | fixed |
| G5 misshapen settings file (Minor) | pytest: `test_apply_refuses_a_misshapen_deny_list_and_leaves_the_file_alone[...]` and `test_restore_refuses_..._[...]` for te-str, te-list, te-null, deny-str, deny-dict, deny-null, deny-number (byte-identical file, no record written / record kept), `test_a_misshapen_file_stops_the_pending_write_without_a_crash` (fold survives) | red: AttributeError / TypeError / DID NOT RAISE in all 15 | remove check in apply -> 8 fail; in restore -> 7 fail; no key check -> 9 fail; no outer check -> 6 fail; restored | fixed |
| G6 damaged pause (Minor) | `plugin/dsh/client/test/model.test.mjs`: `G6: any pause value that is not null or false is a pause, whatever its shape`; `G6: only a missing side is unknown, also through the view state`; `G6: the reason is shown only when it is a string` | 3/3 red | `isObject` only -> 3 fail; reason of any type -> 1 fail; restored | fixed |
| G7 detail cap, wrap, `Array.isArray` (Nit) | model: `G7: the tool-pruning detail is capped at 300 characters`, `G7: a proposal that is not an array is not counted`; view: `G7: the mechanism and model-call details wrap long words` | 3/3 red | no cap -> 1 fail; no `Array.isArray` -> 1 fail; no wrap style -> 1 fail; model-calls row without the style -> 1 fail; restored | fixed |

No existing assertion contradicted any fix. One existing-test text was briefly altered by a careless
`str.replace` in my own edit of `tests/test_dsh_toolprune.py` and put back at once; `git diff` of that
file contains additions only.

## Rejected (no code)
| item | status | reason |
|---|---|---|
| `te toolprune apply NAME` accepts protected names on dsh | rejected | `cli.py` is an upstream file (budget), and the person names the tool explicitly |
| PTC (`run_code`) sessions hiding tool use | deferred | unverified; not reproduced; needs a live PTC session to see what the spool records |
| `llm_nudge_writer` charges 0 for an empty answer | rejected | pre-existing upstream mechanism (`loopguard/judge.py`), outside the fork's files |

## Design notes
- G1: `applyDeny(agent, deny, known, log)` never sends `run_code`, `tool_call`, `tool_search` or a name outside `known`; one batch call, on a throw each name alone; returns only what was hidden; one `warn` line names the refused tools. `plugin.mjs` passes the logger. A live batch of 153 names still goes in one call.
- G2: `repoRoot(cwd)` in `tools.mjs` mirrors the core's `paths.find_repo_root`/`is_git_entry` (a directory with `HEAD`, or a `.git` file whose `gitdir:` exists; the home directory is a ceiling, as in the core); fallback is `cwd`. The deliberate difference from the task text ("a `.git` dir or file") is the stricter check, so both sides agree on the root; an empty `.git` directory is no repository for either.
- G3: the plugin also writes `hosts/dsh/catalogs/<sha1(root)[:16]>.json` (the host-wide file stays, other tools and live scripts read it). The core reads the repo's own file in preference: `adapter.load_catalog(state_root, host, repo_root=None)`, new module `dsh_catalog.py` (`repo_catalog_path`, `own_catalog_path`), one call site (`fold.py`, passes `ctx.repo.root`). Checked: JS and Python produce the same file name for the same real repository (`f07ac64f5b72ceb7` for a `git init` temp repo started from a subdirectory), and the pinned constant `124e753dd7ff7c84` for `/r/a` is asserted on both sides. A damaged own file gives `{}` (nothing proposed from the catalog), never another repository's tools; the plugin repairs it at the next agent start (G4). Live: the real run wrote `catalogs/923745f007f1775a.json` (183 tools).
- G5: new `json_shape.check_list_shape`, called in `_apply_json_list` and `_restore_json_list` right after `_read_settings` (so it also covers Claude's `permissions.deny` and Copilot's list: they used to crash the same way). Null for `tokeneconomizer` or `deny` is refused in both paths (the old apply crashed on it, the old restore silently treated it as empty).
- G6: `side.paused` of null/false is active; undefined/no `side` is unknown; any other value is paused. A reason shows only for an object pause with a string reason. A `side` that is not an object (string, array) is dropped by `parsePanel` and reads as unknown (the "missing side").
- G7: detail capped at 300 characters (299 + `…`); `S.detail` style (`overflowWrap: 'anywhere'`, `wordBreak: 'break-word'`) used by the mechanism and model-calls cards.

changed:
- `plugin/dsh/src/tools.mjs` (applyDeny, repoRoot, readDeny, repoCatalogPath, writeCatalog + `writeListIfChanged`), `plugin/dsh/src/plugin.mjs` (repoRoot, logger into applyDeny)
- `plugin/dsh/client/src/model.cjs`, `plugin/dsh/client/src/view.cjs`
- tests: `plugin/dsh/test/tools.test.mjs` (+18 node tests with the client ones), `plugin/dsh/client/test/model.test.mjs`, `plugin/dsh/client/test/view.test.mjs`, `tests/test_dsh_toolprune.py`
- new core files (free): `tokeneconomizer/plugin/dsh_catalog.py`, `tokeneconomizer/plugin/json_shape.py`
- upstream files: `adapter.py` (`load_catalog` takes `repo_root`, one import), `fold.py` (one call), `denylist.py` (one import, two check calls)

gates:
- `node --check` on all changed `.mjs`/`.cjs`: ok
- `cd plugin/dsh && npm test`: 152 tests, 152 pass, 0 fail (was 134)
- `pytest -q tests/test_dsh_toolprune.py tests/test_dsh_sidecall.py tests/test_dsh_host.py tests/test_panel.py`: exit 0, no failures
- `python3 scripts/dsh_diff_budget.py`: 32 on `HEAD` (it compares commits, so it cannot see uncommitted work); on a snapshot of the working tree (`git stash create`, `--head <sha>`, nothing stored in the stash list): **46 of 60** (adapter `+12 -4`, denylist `+10 -3`, cli `+4 -1`, sidecall `+4 -1`, controller `+2 -2`, fold `+1 -1`, hosts `+1 -0`)
- `node plugin/dsh/test/live/live-prune-loop.mjs`: 15/15 PASS (real model; 153 names denied in one batch, control request has none of them)
- `node plugin/dsh/test/live/live-check.mjs`: 25/25 PASS
- `pytest -q tests experiments/tests`: exit code 0, 1287 test results, no `F` (this repo's pytest config is quiet: the last line is the progress line `...............................................................          [100%]`, no `N passed` summary is printed)

open:
- ADR 0004 (Polish) still describes the single host-wide catalog and the all-or-nothing `restrict` handling; update it with G1/G2/G3 when the iteration is documented (not touched here, and `docs/dod.md` untouched)
- the host-wide `catalog.json` is still written and still the fallback for a repository without its own file (older plugin, first run before any agent started)
- the DSH client's `bundle`/panel was not re-checked in a browser for the wrapping style (unit-level only: style object asserted)
- PTC (`run_code`) sessions: deferred (see above)
