# Przegląd: przycinanie narzędzi i wywołania pomocnicze na DSH (zakres 5f7bc3f..HEAD)

Dwa niezależne przeglądy (tylko odczyt, każdy z >=20 własnymi sondami bez płatnych wywołań):
A - bezpieczeństwo i odporność punktu końcowego (model sol), B - poprawność przycinania i wyceny (model mai).
Pełne tabele sprawdzonych przypadków: `docs/iterations/8-reviewA.md`, `docs/iterations/8-reviewB.md`.
Mapowanie ważności: Blocker = critical, Major = high. Dyspozycje: fixed | rejected | deferred.

| severity | finding | disposition | evidence |
|---|---|---|---|
| critical | A1 Trasa modelu wspólna dla sesji w procesie: wywołanie sesji A mogło iść na modelu sesji B bez `paid_model` | fixed | Hook niesie `TE_DSH_SESSION`, żądanie nazywa sesję, wtyczka trzyma trasę per sesja; nieznana sesja -> 409 NO_ROUTE. Testy w `sidecall.test.mjs` i `test_dsh_sidecall.py`, czerwone przed poprawką, mutacja sprawdzona (`8-fixA.md` F1) |
| critical | A2 Zapis pliku punktu końcowego podąża za symlinkiem (nadpisanie celu, wyciek tokenu) | fixed | lstat+unlink, potem `wx` 0600; test z symlinkiem do pliku 0644 (`8-fixA.md` F2) |
| high | B1 `restrict` w jednej partii: jedna odrzucona nazwa wyłącza całe przycinanie | fixed | partia, potem per nazwa; `run_code`/`tool_call`/`tool_search` nigdy nie wysyłane (`8-fixB.md` G1) |
| high | B2 Plik deny czytany z cwd sesji, rdzeń pisze w korzeniu repo: sesja z podkatalogu bez przycinania | fixed | `repoRoot(cwd)` jak `find_repo_root`; testy podkatalog/brak .git/zagnieżdżone (G2) |
| high | B3 Katalog narzędzi globalny dla hosta: narzędzia z innego repo trafiały do deny tego repo | fixed | katalog per repo `hosts/dsh/catalogs/<sha1[:16]>.json`, adapter czyta go w pierwszej kolejności; test pytest dwóch repo (G3); budżet upstream 46 z 60 |
| medium | A3 Termin nie przerywa odczytu niedokończonego body (dwa wolne POST-y zajmują sloty) | fixed | test: po timeoucie trzeci POST nie dostaje BUSY (F3) |
| medium | A4 Limit body liczony w znakach JS, nie w bajtach UTF-8 | fixed | chunked 1,6 MB emoji -> 413 bez wywołania modelu (F4) |
| medium | A5 Tekst błędu dostawcy (prompt, token) w odpowiedzi HTTP i errors.log | fixed | token i prompt usuwane, limit 300 znaków; test (F5) |
| medium | A6 Błąd MODEL z tekstem "not signed in" wstrzymywał wywołania | fixed | pauza tylko dla kodu AUTH; test MODEL/AUTH/TE_AUTH (F6) |
| low | A7 `json.dumps` poza try: nie-serializowalny prompt rzuca TypeError | fixed | test, wynik ("", None) (F7) |
| medium | B4 Uszkodzony `catalog.json` nigdy nie jest naprawiany | fixed | zapis atomowy przy nieczytelnym poprzednim pliku (G4) |
| medium | B5 Ręcznie zmieniony plik ustawień o złym kształcie: AttributeError/TypeError, a `deny` jako string psuje restore | fixed | walidacja kształtu, RuntimeError, plik bajt w bajt bez zmian (G5) |
| medium | B6 Panel: `side.paused` = true/tablica pokazywało `active` | fixed | każda wartość poza null/false = `paused`; powód tylko jako string do 120 znaków (G6) |
| low | B7 Szczegół Tool pruning bez limitu, `proposal` jako obiekt z `length` liczony jak tablica | fixed | limit 300, zawijanie, `Array.isArray` (G7) |
| low | B8 `te toolprune apply NAZWA` na dsh nie sprawdza nazw chronionych | rejected | `cli.py` to plik upstreamu (budżet różnicy), nazwę wybiera sama osoba jawnym poleceniem; wtyczka i tak stosuje plik |
| medium | B9 Sesje PTC (`run_code`) nie dają bloków tool-call: narzędzia MCP z SDK wyglądają na nieużywane | deferred | niezweryfikowane na żywo; do sprawdzenia przy realnym użyciu PTC, wpis w `docs/implementation-status.md` |
| low | B10 `llm_nudge_writer` księguje 0 dla pustej odpowiedzi z usage | rejected | mechanizm sprzed tej pracy (`loopguard/judge.py`, upstream), poza zakresem; sędzia i proposer księgują poprawnie |
| low | B11 `_usage` w Pythonie przyjmuje NaN/Infinity/ujemne/bool | deferred | utwardzenie; strona JS (`ledgerUsage`) je czyści, więc do księgi nie dociera |
| low | A8 Nietypowa nazwa `model` (`a//b`, `../x`, 12 000 znaków) trafia do adaptera DSH | rejected | adapter odrzuca nieznany model; nie ma dostępu do plików ani SSRF (sprawdzone), brak kosztu poza trasą sesji |
| low | B12 `usage.reasoningTokens` niemapowane; po `restore` zostaje `{}` i wpis w exclude; puste `DSH_PROTECTED` | rejected | nieosiągalne lub bez skutku kosztowego; opisane w raportach A/B |
| low | T7 Uszkodzony `sidecall.json` przechodzi do panelu bez walidacji (typy, długość) | deferred | tylko rdzeń pisze ten plik; UI skraca powód do 120 znaków; panel liczy dziś każdą wartość jako pauzę |

Ocena końcowa: 2 critical i 3 high naprawione z testami czerwonymi przed poprawką i sprawdzoną mutacją; brak otwartych critical/high.
Gwarancja kosztowa po poprawce A1: wywołanie nigdy nie działa na modelu innej sesji (nieznana sesja = brak odpowiedzi, zero kosztu).
Ograniczenie: dwie sesje na różnych modelach w jednym procesie sprawdzone testami z atrapą `ctx.llm`, nie na żywo.
