# DoD check report

- source: docs/dod.md
- sha256: 29ef905b325fe55bb641acaec6703f78a0e97bc23751ee39e75130de9a1d5f2c
- run: 2026-11-07 19:43:41
- head: 3ac4c43

| id | verification | result | evidence |
|---|---|---|---|
| D1 | command | PASS | exit 0: 24/24 passed. Work directory: /var/folders/jq/7dpgx9ln3pb1zv_xg8m6dshr0000gn/T/te-dsh-live-multi-models |
| D2 | command | PASS | exit 0: 9/9 passed. Work directory: /var/folders/jq/7dpgx9ln3pb1zv_xg8m6dshr0000gn/T/te-dsh-live-multi-resume |
| D3 | command | PASS | exit 0: 26/26 passed. Work directory: /var/folders/jq/7dpgx9ln3pb1zv_xg8m6dshr0000gn/T/te-dsh-live-proxy |
| D4 | command | PASS | exit 0: 19/19 passed. Work directory: /var/folders/jq/7dpgx9ln3pb1zv_xg8m6dshr0000gn/T/te-dsh-live-ptc |
| D5 | command | FAIL | exit 1: Node.js v22.23.2 |
| D6 | command | PASS | exit 0: 20/20 passed. Work directory: /var/folders/jq/7dpgx9ln3pb1zv_xg8m6dshr0000gn/T/te-dsh-live-route |
| D7 | command | PASS | exit 0: no output |
| D8 | command | PASS | exit 0: ...............................................................          [100%] |
| D9 | command | PASS | exit 0: changed lines in upstream files: 46 (budget 60) |
| D10 | command | PASS | exit 0: no output |
| D11 | descriptive | NOT CHECKED | excluded from exit; human review |

RESULT: FAIL (1 of 10 command criteria failed)
