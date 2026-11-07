# Definition of Done

| id | criterion | verification | command |
|---|---|---|---|
| D1 | (pkt 1) Na żywo: N sesji z rdzeniem w trybie `auto` → rdzeń sam zapisuje deny-listę MCP → następna sesja nie ma nieużywanych narzędzi `mcp__*` w `request/header`, a używane narzędzie (także przez proxy `tool_call`) i `bash` zostają | command | `node plugin/dsh/test/live/live-prune-loop.mjs --profile headless` |
| D2 | (pkt 2) Na żywo, przez prawdziwy `Runner` Pythona: `paid_model` jako `provider/model` i jako sam model zmienia model w odpowiedzi; bez niego wychodzi model sesji; zużycie jest wycenione | command | `node plugin/dsh/test/live/live-sidecall.mjs --only paid` |
| D3 | (pkt 4) Wywołanie przed pierwszym requestem: albo działa na modelu sesji (jeśli jest wiarygodne źródło trasy przy `agent/created`), albo kończy się czystym `NO_ROUTE`, bez pauzy hosta i bez księgowania | command | `node plugin/dsh/test/live/live-sidecall.mjs --only route` |
| D4 | (pkt 3) Na żywo: subagent nie jest ograniczany ani foldowany jako sesja główna; dwa równoległe `dsh headless` mają osobne punkty końcowe, oba wywołania działają, a katalog się nie psuje; po SIGTERM zostaje plik, który następny start sprząta | command | `node plugin/dsh/test/live/live-sessions.mjs --profile headless` |
| D5 | (pkt 3) Tryb interaktywny (`dsh web` + Chrome/CDP, jeden prompt): deny-lista zdejmuje narzędzie z requestu, punkt końcowy istnieje w trakcie sesji i odpowiada | command | `node plugin/dsh/client/test/browser/browser-check.mjs --prune` |
| D6 | Nowe testy jednostkowe z mutacjami dla każdej poprawki (np. `NO_ROUTE` nie pauzuje, trasa początkowa, sprzątanie plików, panel); liczba testów Node ≥ 91 i 0 porażek | command | `cd plugin/dsh && test "$(npm test 2>&1 \| awk '/^# tests/{print $3}')" -ge 91 && npm test 2>&1 \| grep -q '^# fail 0'` |
| D7 | (pkt 5) Raport z przeglądu: każde znalezisko ma dyspozycję (`fixed`/`rejected`/`deferred`) i dowód; brak otwartych `critical`/`high` | command | `test -f docs/reviews/2026-11-07-dsh-prune-sidecall.md && ! awk -F'\|' 'tolower($2) ~ /critical\|high/ && tolower($4) ~ /open/ {f=1} END{exit !f}' docs/reviews/2026-11-07-dsh-prune-sidecall.md` |
| D8 | Regresja: dotychczasowy test na żywo dalej przechodzi w całości | command | `node plugin/dsh/test/live/live-check.mjs` |
| D9 | Pełny pytest bez porażek, liczba testów ≥ 575 | command | `/tmp/te-venv/bin/python -m pytest -q tests experiments/tests && test "$(grep -rh 'def test_' tests \| wc -l)" -ge 575` |
| D10 | Zmiany w plikach upstreamu mieszczą się w budżecie 60 | command | `python3 scripts/dsh_diff_budget.py` |
| D11 | ADR 0004, README i `spike-phase-b.md` opisują nowe wyniki, ograniczenia i to, czego nadal nie sprawdzono | descriptive | — |
| D12 | Panel: `te panel --json` niesie stan wywołań pomocniczych (pauza i powód) i listę zastosowanych narzędzi; klient pokazuje wiersz „Model calls” i szczegóły przycinania; test klienta nie używa już „not available on dsh” | command | `/tmp/te-venv/bin/python -m pytest -q tests/test_panel.py && ! grep -q "not available on dsh" plugin/dsh/client/test/model.test.mjs` |
| D13 | Panel w prawdziwej przeglądarce pokazuje nowe wiersze z liczbami z prawdziwej sesji | command | `node plugin/dsh/client/test/browser/browser-check.mjs --prune --only panel` |
