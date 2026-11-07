# DSH: brakujące kontrole na żywo (drugi przebieg po ADR 0004)

## Cel
Sprawdzić na żywym DSH to, co pierwszy przebieg ([plan](2026-11-07-dsh-domkniecie-weryfikacji-i-panel.md)) zostawił jako
niezweryfikowane i opisał w [ADR 0004](../dsh/adr/0004-przycinanie-narzedzi-i-wywolania-pomocnicze.md) oraz
`docs/dsh/spike-phase-b.md`: (1) dwie sesje na RÓŻNYCH modelach w jednym procesie, (2) proxy `tool_call`
(rozpakowanie w spoolu i ochrona przed przycięciem), (3) sesje PTC (`run_code`), (4) TUI, (5) sesja wznowiona lub
z przełączonym modelem. Poprawić to, co wyjdzie.

## Zakres
W zakresie: skrypty na żywo w `plugin/dsh/test/live/`, wspólne helpery, poprawki tego, co wyjdzie (z testem
jednostkowym i mutacją), dokumentacja. Poza zakresem: aplikacja desktopowa, Firefox/Safari, Windows, żywy wyścig
`NO_ROUTE` przy `SessionStart` (zostaje przypięty testami jednostkowymi), pomiar skutku przycinania (`CLAUDE.md`).
Zasada: jeśli kontrola okaże się niewykonalna w tym środowisku (np. profil nie ma potrzebnego narzędzia), task
zapisuje dowód (komenda, wynik) i kończy się jako `blocked` z pytaniem; nie osłabia się DoD po cichu.
Koszt: kilkanaście bardzo małych wywołań modelu (haiku, jeden drugi model z profilu).

## Definition of Done

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

DoD approved: 2026-11-07

## Taski
- **T1** Spike wykonalności (bez implementacji): jak w tym środowisku (a) uruchomić dwie sesje `dsh web` na różnych modelach (UI/CDP albo API serwera), (b) znaleźć lub złożyć profil z proxy `tool_call` (`dsh-tool-search`) i tryb PTC (`run_code`), (c) uruchomić TUI w pseudoterminalu (`python3 pty`), (d) wznowić sesję i przełączyć model. Wynik: `docs/iterations/N-spike.md` z komendami i obserwacjami dla każdego punktu. Kind: other. Serves: D1, D2, D3, D4, D5. Unknowns: wszystkie cztery punkty.
- **T2** `live-multisession.mjs --only models|resume` (+ helpery w `common.mjs`): dwie sesje na różnych modelach, wywołania punktu końcowego z `session` jako w `dsh_sidecall.py`, kontrola modelu w odpowiedzi; sesja wznowiona/przełączona. Kind: behaviour. Serves: D1, D2, D6, D7.
- **T3** `live-proxy.mjs`: profil z `tool_call`, prompt każący wywołać narzędzie MCP przez proxy, kontrola spoolu (nazwa własna, nie `tool_call`), rdzeń prawdziwy: narzędzie poza deny-listą po foldzie. Kind: behaviour. Serves: D3, D6, D7.
- **T4** `live-ptc.mjs`: profil/tryb PTC, kontrola spoolu i foldu, opisanie czy zagnieżdżone wywołania są widoczne; jeśli nie, minimalna poprawka (nie proponować przycinania narzędzi użytych w sesji PTC, albo odczyt zagnieżdżonych wywołań) z testem jednostkowym i mutacją. Kind: behaviour. Serves: D4, D6, D7, D8.
- **T5** `live-tui.mjs`: `dsh` w pseudoterminalu (prompt przez pty), kontrola `request/header`, punktu końcowego i czystego zakończenia. Kind: behaviour. Serves: D5, D6, D7.
- **T6** Przegląd poprawek produkcyjnych tego przebiegu (jeśli jakieś powstały; inaczej raport z adnotacją "brak zmian produkcyjnych"), dyspozycje znalezisk. Kind: other. Serves: D10, D9.
- **T7** Dokumentacja i zamknięcie: ADR 0004, README, `spike-phase-b.md`, pełne testy, budżet, commit, push. Kind: other. Serves: D6, D7, D8, D9, D11.

Kolejność: T1 → (T2, T3, T4, T5) → T6 → T7.

## Poza DoD
Brak (każdy task obsługuje kryterium).

## Checklista
- [x] Każde kryterium ma sposób weryfikacji.
- [x] Każdy task ma co najmniej jedno kryterium.
- [x] Każde kryterium ma co najmniej jeden task (D1: T2; D2: T2; D3: T3; D4: T4; D5: T5; D6: T2-T5, T7; D7: T2-T5, T7; D8: T4, T7; D9: T6, T7; D10: T6; D11: T7).
- [x] DoD zatwierdzone przez użytkownika.
- [x] `descriptive` tylko D11; są kryteria `command` i liczby testów (D7, D8).
- [x] Pod tabelą DoD jest linia `DoD approved: <data>`.
