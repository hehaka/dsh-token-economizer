# DSH: przycinanie narzędzi i wywołania pomocnicze modelu

## Cel
Dołożyć dwa brakujące mechanizmy do wtyczki DSH: (1) przycinanie narzędzi (rdzeń odpowiadał „not available on dsh”),
(2) wywołania pomocnicze modelu przez `ctx.llm` (sędzia pętli, opcjonalnie proponer faktów; na DSH działał stub).

## Zakres
W zakresie: host `dsh` w `denylist` (plik ustawień per repozytorium, który czyta wtyczka), ochrona narzędzi, katalog
narzędzi, rozpakowanie proxy `tool_call`, `restrict` przy `agent/created`; serwer wywołań pomocniczych we wtyczce
Node, runner po stronie Pythona, test na żywo.
Poza zakresem: narzędzia inne niż `mcp__*` w propozycji (decyzja użytkownika 2026-11-07), Windows (named pipes), wyświetlanie
`systemMessage` z SessionStart w DSH, pomiar efektu.

Decyzje użytkownika (2026-11-07): (a) proponowane są tylko narzędzia MCP; (b) wywołania pomocnicze idą domyślnie na
modelu bieżącej sesji, `paid_model` (`provider/model` lub sam model) go nadpisuje.

## Definition of Done

| id | criterion | verification | command |
|---|---|---|---|
| D1 | Runner Pythona: sukces, zużycie → `effective`, błędy fail-open, pauza przy „signed out” | command | `/tmp/te-venv/bin/python -m pytest -q tests/test_dsh_sidecall.py` |
| D2 | Przycinanie: plik ustawień dsh (apply/restore/kept), ochrona poza `mcp__*`, dowody z katalogu i proxy | command | `/tmp/te-venv/bin/python -m pytest -q tests/test_dsh_toolprune.py` |
| D3 | Serwer sidecall i `restrict` mają testy Node; liczba testów nie spada poniżej 54 | command | `cd plugin/dsh && test "$(npm test 2>&1 \| awk '/^# tests/{print $3}')" -ge 54 && npm test 2>&1 \| grep -q '^# fail 0'` |
| D4 | Pełna ścieżka na drutach: serwer Node + runner Python + sędzia pętli, fałszywe `ctx.llm` | command | `cd plugin/dsh && node --test test/sidecall.e2e.test.mjs` |
| D5 | Test na żywo: prawdziwy `dsh headless` i model; wywołanie pomocnicze zwraca tekst z zużyciem, `deny` zdejmuje narzędzie z `request/header` | command | `node plugin/dsh/test/live/live-side-check.mjs --profile headless` |
| D6 | Pełny pytest bez porażek, liczba testów ≥ 543 | command | `/tmp/te-venv/bin/python -m pytest -q tests \| tail -n 3 && test "$(grep -rh 'def test_' tests \| wc -l)" -ge 543` |
| D7 | Zmiany w plikach upstreamu mieszczą się w budżecie 60 | command | `python3 scripts/dsh_diff_budget.py` |
| D8 | ADR 0004, README wtyczki i `spike-phase-b.md` opisują projekt, ograniczenia i wyniki (także niesprawdzone) | descriptive | — |

DoD approved: 2026-11-07

## Taski
- **T1** rdzeń: `denylist` (host `dsh`), `adapter` (ochrona), testy. Kind: behaviour. Serves: D2, D6, D7.
- **T2** Node: katalog narzędzi, rozpakowanie proxy `tool_call`, `restrict` przy `agent/created`. Kind: behaviour. Serves: D3. Unknowns: czy `tools/post-execute` widzi proxy i narzędzie właściwe oba.
- **T3** rdzeń: `dsh_sidecall.py`, `runner_for("dsh")`. Kind: behaviour. Serves: D1, D6, D7.
- **T4** Node: serwer sidecall, środowisko w bridge, e2e. Kind: behaviour. Serves: D3, D4.
- **T5** test na żywo. Kind: behaviour. Serves: D5.
- **T6** dokumentacja, ADR 0004, budżet, commit. Kind: other. Serves: D6, D7, D8.

## Poza DoD
Brak.

## Checklista
- [x] Każde kryterium ma sposób weryfikacji.
- [x] Każdy task ma co najmniej jedno kryterium.
- [x] Każde kryterium ma co najmniej jeden task.
- [x] DoD zatwierdzone przez użytkownika.
- [x] `descriptive` tylko D8; są kryteria `command` i kryterium liczby testów.
