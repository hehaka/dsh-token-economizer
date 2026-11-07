# Iteration log

- it1 T1: done, commit 8debe41, fix rounds 0; T1 implemented by sonnet; orchestrator re-ran npm test 91/0 and live-check 25/25 with real model
- it2 T3: done, commit 07c6c65, fix rounds 1; T3 implemented by sonnet; orchestrator re-ran live-sidecall --only paid 12/12, npm test 91/0, mutation (drop provider from reply) -> 3 Node tests fail; T3 fix round 1: 5a test plugin/dsh/test/stub_core.test.mjs written (6 of 7 fail on assertions); 5b next
- it3 T4: done, commit 5fbb1b0, fix rounds 0; T4 implemented by sonnet (tests + live route group, production code unchanged); orchestrator re-ran npm test 105/0 and live-sidecall --only route 7/7
- it4 T2: done, commit d2263dd, fix rounds 0; T2: live-prune-loop 15/15 re-run by orchestrator; mutation (applyDeny always off) -> 2 FAIL; review deferred to T8
- it5 T5: done, commit 22afdb9, fix rounds 0; T5: live-sessions 34/34 re-run by orchestrator; no production defect
