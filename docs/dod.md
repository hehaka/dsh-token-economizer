| id | criterion | verification | command |
|---|---|---|---|
| D1 | (pkt 1) Na żywo: dwie sesje na różnych modelach w jednym procesie DSH (`dsh web`): wywołanie rdzenia nazwane sesją A wraca z modelem A, nazwane sesją B z modelem B; nieznana sesja kończy się `NO_ROUTE` | command | `node plugin/dsh/test/live/live-multisession.mjs --only models` |
| D2 | (pkt 5) Na żywo: sesja wznowiona (`--resume`) lub z przełączonym modelem: trasa wywołania pomocniczego to bieżący model sesji, nie domyślny model profilu | command | `node plugin/dsh/test/live/live-multisession.mjs --only resume` |
| D3 | (pkt 2) Na żywo: w profilu z proxy `tool_call` narzędzie MCP wywołane przez proxy jest w spoolu pod własną nazwą i nie trafia do deny-listy rdzenia | command | `node plugin/dsh/test/live/live-proxy.mjs` |
| D4 | (pkt 3) Na żywo: sesja w trybie PTC (`run_code`) nie psuje foldu ani przycinania: wynik jest opisany liczbami (czy spool widzi zagnieżdżone wywołania), a narzędzie użyte przez SDK nie ląduje w deny-liście | command | `node plugin/dsh/test/live/live-ptc.mjs` |
| D5 | (pkt 4) Na żywo: TUI (`dsh` w pseudoterminalu, jeden prompt): wtyczka startuje, deny-lista zdejmuje narzędzie z requestu, punkt końcowy odpowiada, sesja kończy się czysto | command | `node plugin/dsh/test/live/live-tui.mjs` |
| D6 | Regresja na żywo: dotychczasowe skrypty dalej przechodzą w całości | command | `node plugin/dsh/test/live/live-check.mjs && node plugin/dsh/test/live/live-prune-loop.mjs && node plugin/dsh/test/live/live-sidecall.mjs` |
| D7 | Testy Node: 0 porażek, liczba testów ≥ 152 | command | `cd plugin/dsh && test "$(npm test 2>&1 \| awk '/^# tests/{print $3}')" -ge 152 && npm test 2>&1 \| grep -q '^# fail 0'` |
| D8 | Pełny pytest bez porażek, liczba testów ≥ 591 | command | `/tmp/te-venv/bin/python -m pytest -q tests experiments/tests && test "$(grep -rh 'def test_' tests \| wc -l)" -ge 591` |
| D9 | Zmiany w plikach upstreamu mieszczą się w budżecie 60 | command | `python3 scripts/dsh_diff_budget.py` |
| D10 | Raport z przeglądu poprawek tego przebiegu: każde znalezisko ma dyspozycję, brak otwartych `critical`/`high` | command | `test -f docs/reviews/2026-11-07-dsh-live-gaps.md && ! awk -F'\|' 'tolower($2) ~ /critical\|high/ && tolower($4) ~ /open/ {f=1} END{exit !f}' docs/reviews/2026-11-07-dsh-live-gaps.md` |
| D11 | ADR 0004, README wtyczki i `spike-phase-b.md` opisują nowe wyniki i to, czego nadal nie sprawdzono | descriptive | — |
