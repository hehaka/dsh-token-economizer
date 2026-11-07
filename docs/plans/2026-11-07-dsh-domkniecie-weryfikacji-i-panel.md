# DSH: domknięcie weryfikacji przycinania i wywołań pomocniczych, przegląd, panel

## Cel
Zamknąć luki zostawione po [ADR 0004](../dsh/adr/0004-przycinanie-narzedzi-i-wywolania-pomocnicze.md): (1) pełna pętla
przycinania na żywo, (2) `paid_model` na żywo, (3) tryb interaktywny, wiele sesji i subagenci, (4) trasa modelu przed
pierwszym requestem, (5) niezależny przegląd kodu; plus panel pokazujący stan przycinania i wywołań pomocniczych
oraz sprzątnięcie przestarzałego tekstu w teście klienta.

## Zakres
W zakresie: nowe skrypty testowe na żywo (`plugin/dsh/test/live/`), wspólne helpery tych skryptów, poprawki tego, co
wyjdzie w testach (nie przesądzamy które), przegląd i jego dyspozycje, panel (`panel.py` + klient), dokumentacja.
Poza zakresem: narzędzia wbudowane DSH w propozycjach; Windows (potoki); `systemMessage` przy starcie; pomiar skutku
przycinania (`CLAUDE.md`: brak twierdzeń o efekcie); PR do upstreamu.

Decyzje użytkownika (2026-11-07): zakres punktów 1–5 plus panel i poprawka tekstu w `model.test.mjs`.
Koszt: testy na żywo to kilkanaście bardzo małych wywołań modelu (głównie haiku) i start serwerów MCP profilu.

## Definition of Done

| id | criterion | verification | command |
|---|---|---|---|
| D1 | (pkt 1) Na żywo: N sesji z rdzeniem w trybie `auto` → rdzeń sam zapisuje deny-listę MCP → następna sesja nie ma nieużywanych narzędzi `mcp__*` w `request/header`, a używane narzędzie (także przez proxy `tool_call`) i `bash` zostają | command | `node plugin/dsh/test/live/live-prune-loop.mjs --profile headless` |
| D2 | (pkt 2) Na żywo, przez prawdziwy `Runner` Pythona: `paid_model` jako `provider/model` i jako sam model zmienia model w odpowiedzi; bez niego wychodzi model sesji; zużycie jest wycenione | command | `node plugin/dsh/test/live/live-sidecall.mjs --only paid` |
| D3 | (pkt 4) Wywołanie przed pierwszym requestem: albo działa na modelu sesji (jeśli jest wiarygodne źródło trasy przy `agent/created`), albo kończy się czystym `NO_ROUTE`, bez pauzy hosta i bez księgowania | command | `node plugin/dsh/test/live/live-sidecall.mjs --only route` |
| D4 | (pkt 3) Na żywo: subagent nie jest ograniczany ani foldowany jako sesja główna; dwa równoległe `dsh headless` mają osobne punkty końcowe, oba wywołania działają, a katalog się nie psuje; po SIGTERM zostaje plik, który następny start sprząta | command | `node plugin/dsh/test/live/live-sessions.mjs --profile headless` |
| D5 | (pkt 3) Tryb interaktywny (`dsh web` + Chrome/CDP, jeden prompt): deny-lista zdejmuje narzędzie z requestu, punkt końcowy istnieje w trakcie sesji i odpowiada | command | `node plugin/dsh/client/test/browser/browser-check.mjs --prune` |
| D6 | Nowe testy jednostkowe z mutacjami dla każdej poprawki (np. `NO_ROUTE` nie pauzuje, trasa początkowa, sprzątanie plików, panel); liczba testów Node ≥ 91 i 0 porażek | command | `cd plugin/dsh && test "$(npm test 2>&1 \| awk '/^# tests/{print $3}')" -ge 91 && npm test 2>&1 \| grep -q '^# fail 0'` |
| D7 | (pkt 5) Raport z przeglądu: każde znalezisko ma dyspozycję (`fixed`/`rejected`/`deferred`) i dowód; brak otwartych `critical`/`high` | command | `test -f docs/reviews/2026-11-07-dsh-prune-sidecall.md && ! grep -Eiq '\\\| *(critical\|high) *\\\|.*\\\| *open *\\\|' docs/reviews/2026-11-07-dsh-prune-sidecall.md` |
| D8 | Regresja: dotychczasowy test na żywo dalej przechodzi w całości | command | `node plugin/dsh/test/live/live-check.mjs` |
| D9 | Pełny pytest bez porażek, liczba testów ≥ 575 | command | `/tmp/te-venv/bin/python -m pytest -q tests experiments/tests && test "$(grep -rh 'def test_' tests \| wc -l)" -ge 575` |
| D10 | Zmiany w plikach upstreamu mieszczą się w budżecie 60 | command | `python3 scripts/dsh_diff_budget.py` |
| D11 | ADR 0004, README i `spike-phase-b.md` opisują nowe wyniki, ograniczenia i to, czego nadal nie sprawdzono | descriptive | — |
| D12 | Panel: `te panel --json` niesie stan wywołań pomocniczych (pauza i powód) i listę zastosowanych narzędzi; klient pokazuje wiersz „Model calls” i szczegóły przycinania; test klienta nie używa już „not available on dsh” | command | `/tmp/te-venv/bin/python -m pytest -q tests/test_panel.py && ! grep -q "not available on dsh" plugin/dsh/client/test/model.test.mjs` |
| D13 | Panel w prawdziwej przeglądarce pokazuje nowe wiersze z liczbami z prawdziwej sesji | command | `node plugin/dsh/client/test/browser/browser-check.mjs --prune --only panel` |

DoD approved: 2026-11-07

## Taski
- **T1** Wspólne helpery skryptów na żywo (`plugin/dsh/test/live/common.mjs`: katalog roboczy, budowa paczki, nakładka, uruchomienie `dsh`, odczyt logu sesji, `check`); `live-check.mjs` korzysta z nich. Kind: other. Serves: D8.
- **T2** `live-prune-loop.mjs`: repo tymczasowe, rdzeń prawdziwy (`TE_TOOLPRUNE=auto`, niskie progi: `EVIDENCE=1`, `MIN_SESSIONS=1`, `SESSIONS=2`, `QUIET_MINUTES=0`, `TE_FOLD_SYNC=1`), N krótkich sesji używających `bash` i jednego tylko-do-odczytu narzędzia MCP (`--used-tool`, domyślnie `mcp__postgres__postgres_mcp_list_connection_profiles`), potem sesja kontrolna: `request/header` bez nieużywanych `mcp__*`, z używanym i `bash`. Kind: behaviour. Serves: D1, D9. Unknowns: czy w profilu `headless` model woła narzędzie MCP wprost, czy przez `tool_call {name, arguments}` (kształt proxy niezweryfikowany na żywo); czy fold kończy się przed zamknięciem procesu; jak liczą się progi dowodów dla sesji headless.
- **T3** `live-sidecall.mjs --only paid`: rdzeń stub (`stub_core.py`) importuje pakiet i woła prawdziwy `sidecall.runner_for("dsh", cfg)`; trzy przebiegi: bez `paid_model`, z `provider/model` innego modelu, z samym modelem; sprawdza model w odpowiedzi i wycenę zużycia. Kind: behaviour. Serves: D2. Unknowns: który drugi model (inny niż sesji) jest wołalny w profilu `headless` (`--paid-model` z domyślną autodetekcją z konfiguracji profilu).
- **T4** Trasa przed pierwszym requestem: sonda (wtyczka diagnostyczna zrzuca klucze `agent`, `agent.options`, `agent.ctx`, usługi modelu domyślnego) → jeśli jest źródło, ustawić trasę początkową w `observeRoute` przy `agent/created`; w obu przypadkach `live-sidecall.mjs --only route` (wywołanie na `SessionStart`) i testy: `NO_ROUTE` nie pauzuje hosta ani nie księguje (Python), źródło trasy (Node). Kind: behaviour. Serves: D3, D6, D9. Unknowns: co udostępnia obiekt `agent` przy `agent/created`.
- **T5** `live-sessions.mjs`: (a) prompt każący użyć narzędzia subagenta: subagent nie ma `restrict`, jego sesja nie trafia do foldu jako główna, nie otwiera drugiego punktu końcowego; (b) dwa równoległe `dsh headless` na wspólnym `TOKENECONOMIZER_HOME`: dwa pliki `sidecall.<pid>.endpoint.json`, oba wywołania pomocnicze działają, `catalog.json` jest poprawnym JSON-em, w księdze obie sesje; (c) `SIGTERM` procesu zostawia plik, następny start go sprząta (`sweep`), a rdzeń na starym pliku dostaje „brak odpowiedzi” szybko; poprawki + testy Node z mutacjami tego, co wyjdzie. Kind: behaviour. Serves: D4, D6, D9. Unknowns: czy podczas `SIGTERM` DSH wykonuje `exit`/`beforeExit`; czy subagent dostaje `agent/created` z własną sesją (`origin: subagent`) tak jak zakłada `isRoot`.
- **T6** `browser-check.mjs --prune [--only panel]`: dodać do istniejącego skryptu (Chrome/CDP, `dsh web`) przebieg z deny-listą w repozytorium sesji: jeden prompt, odczyt `request/header` z logu sesji, istnienie i odpowiedź punktu końcowego w trakcie, zrzut wierszy panelu. Kind: behaviour. Serves: D5, D13. Unknowns: jak skrypt wskazuje katalog roboczy sesji web (repo z `.dsh/token-economizer.local.json`).
- **T7** Panel: `panel.py` dodaje do `payload` klucz `side` (`paused: {at, reason}|null`, bez zmian w `cli.py`, żeby nie rosła różnica z upstreamem) i listę zastosowanych narzędzi (z `status`); `model.cjs`/`view.cjs`: wiersz „Model calls” (aktywne / wstrzymane + powód) i szczegóły przycinania (zastosowane, źródło katalogu); zastąpić „not available on dsh” w `model.test.mjs` tekstem neutralnym; testy modelu, widoku i `test_panel.py` z mutacjami. Kind: behaviour. Serves: D6, D12, D13, D9.
- **T8** Przegląd (pkt 5): `requesting-code-review` lub `agent-review-panel` dla zakresu `5f7bc3f` i zmian z tego planu (perspektywy: bezpieczeństwo punktu końcowego, odporność hooków fail-open, współbieżność, poprawność wyceny); raport `docs/reviews/2026-11-07-dsh-prune-sidecall.md` z tabelą `severity | finding | disposition | evidence`; poprawki zaakceptowanych znalezisk z testami (`receiving-code-review`). Kind: other. Serves: D7, D6, D9, D10.
- **T9** Dokumentacja i zamknięcie: ADR 0004 (sekcje „Weryfikacja”, „Trasa”), README wtyczki, `spike-phase-b.md` (co sprawdzone na żywo, co nie); budżet upstreamu; pełne testy; commit i push. Kind: other. Serves: D8, D9, D10, D11.

Kolejność: T1 → (T2, T3) → T4 → T5 → T7 → T6 → T8 → T9. T2 i T3 są niezależne po T1; T6 wymaga T7 (wiersze panelu).

## Poza DoD
Nic: każdy task ma kryterium. Świadomie poza planem: narzędzia wbudowane, Windows, `systemMessage`, pomiar skutku, PR do upstreamu.

## Checklista
- [x] Każde kryterium ma sposób weryfikacji (D11 `descriptive`: dokumentacji nie da się sprawdzić komendą).
- [x] Każdy task ma co najmniej jedno kryterium.
- [x] Każde kryterium ma co najmniej jeden task (D1: T2; D2: T3; D3: T4; D4: T5; D5: T6; D6: T4, T5, T7, T8; D7: T8; D8: T1, T9; D9: T2, T4, T5, T7, T8, T9; D10: T8, T9; D11: T9; D12: T7; D13: T6, T7).
- [x] DoD zatwierdzone przez użytkownika (2026-11-07).
- [x] `descriptive` tylko tam, gdzie komendy nie da się napisać; są kryteria `command` i kryterium liczby testów (D6, D9).
- [x] Pod tabelą DoD jest linia `DoD approved`, a każdy task ma `Kind:`.
