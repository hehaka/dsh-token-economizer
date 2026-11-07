changed: plugin/dsh/test/live/common.mjs (new), plugin/dsh/test/live/live-check.mjs (185 -> 141 lines)
gates: pass. `node --check` on both files OK; `live-check.mjs --dump-only` printed "PASS  the plugin entry composes into the profile tree", exit 0; `cd plugin/dsh && npm test` 91 tests, 0 fail. live-check.mjs was not run with a model (orchestrator does that).
open:
- common.mjs also exports HERE, REPO and tail (beyond the requested list); live-check keeps its stub/diag file usage via HERE.
- makeChecker().summary(workDir) prints the closing line and returns the failed count; live-check calls process.exit(summary(work) ? 1 : 0).
- dsh(work, args, env, timeout, cwd = <work>/repo); live-check wraps overlay/dsh locally so its call sites are unchanged.
- Section 2 now uses sessionLogFile/readSessionEvents; section 5 uses requestTools (replaces sessionTools). Checks and their text are unchanged.
- Nothing committed; docs/dod.md, stub_core.py untouched.
