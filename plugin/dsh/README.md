# dsh-token-economizer (plugin DSH)

Plugin DeepSeek Harness nad rdzeniem [TokenEconomizer](https://github.com/microsoft/TokenEconomizer).
Rdzeń (Python, tylko biblioteka standardowa) liczy fakty o repozytorium, propozycje przycinania
narzędzi i straż pętli; ten plugin tylko tłumaczy zdarzenia DSH na jego protokół hooków
(`src/plugin.mjs`) i zapisuje spool sesji w formacie Pi (`src/spool.mjs`).

Decyzje: [`docs/dsh/adr/`](../../docs/dsh/adr/). Wyniki spike'u: [`docs/dsh/spike-phase-b.md`](../../docs/dsh/spike-phase-b.md).

## Stan (faza C)
Zaimplementowane: spool, most do dyspozytora, podpięcie zdarzeń, fold sesji do księgi. Testy bez DSH
(atrapa `ctx`, prawdziwy Python) oraz **sprawdzenie na żywym DSH w trybie headless**
(`test/live/live-check.mjs`, wyniki w [`spike-phase-b.md`](../../docs/dsh/spike-phase-b.md)).
Na żywym DSH (2026-11-07, `dsh headless` i `dsh web` w prawdziwym Chrome) potwierdzone: wywołania pomocnicze na trasie sesji i na `paid_model` (trzy warianty, odpowiedź z wycenianym zużyciem); przycinanie z prawdziwym rdzeniem (po pierwszej zakończonej sesji rdzeń zapisał 153 nazwy `mcp__*` (katalog 154 minus 1 użyta), `bash` i użyte narzędzie nie były na liście; zapytanie sesji kontrolnej miało 30 narzędzi wobec 183 w pierwszej, a żadna z 153 zablokowanych nazw w nim nie wystąpiła; szczegóły w [`spike-phase-b.md`](../../docs/dsh/spike-phase-b.md), to obserwacja liczby narzędzi w zapytaniu, nie pomiar skutku); subagent nie dostaje listy odmów, nie jest spoolowany ani składany jak sesja główna i nie otwiera drugiego punktu końcowego; dwa równoległe procesy mają osobne pliki punktu końcowego (po pid) i oba odpowiadają; SIGTERM kończy DSH czysto i usuwa plik; zwisający plik punktu końcowego rdzeń omija (`("", None)`, ~0,03 s); wiersze panelu „Model calls” i szczegół przycinania zgadzają się z `te status --json`.
**Niezweryfikowane (limity):** dwie sesje na różnych modelach w jednym procesie (tylko testy z atrapą `ctx.llm`); proxy `tool_call` (tylko testy jednostkowe, profil headless nie ma tego narzędzia); sesje PTC (`run_code`) mogą ukrywać użycie narzędzi MCP przed spoolem; trasa po wznowieniu lub zmianie modelu w sesji (trasa z `agent/created` i `request/context`, może różnić się od modelu domyślnego profilu); rozliczenie tokenów rozumowania (nie wiadomo, czy `outputTokens` je obejmuje); brak trasy przy wywołaniu rdzenia (`409 NO_ROUTE`, rdzeń traktuje to jak brak odpowiedzi — przypięte testami, na żywo nieobserwowane, wyścig); aplikacja desktopowa, Firefox/Safari, interaktywne TUI; `dsh web` sterowany jednym promptem na przebieg, nie długimi sesjami; skuteczność uwag straży pętli. Odroczone: uszkodzony `sidecall.json` trafia do panelu bez walidacji; `te toolprune apply NAZWA` na dsh nie odmawia nazw chronionych.
Komenda `/te` (CLI rdzenia: `status`, `microskills`, `toolprune`, `config`, `doctor`, …) działa przez executor DSH.

**Przycinanie narzędzi** (tylko `mcp__*`) i **wywołania pomocnicze modelu** (sędzia pętli, propozycje mikro-umiejętności przez `ctx.llm`, domyślnie na modelu sesji, `paid_model` nadpisuje) działają: patrz [ADR 0004](../../docs/dsh/adr/0004-przycinanie-narzedzi-i-wywolania-pomocnicze.md). Plugin zapisuje listę narzędzi DSH (`hosts/dsh/catalog.json`), stosuje `tokeneconomizer.deny` z `.dsh/token-economizer.local.json` przez `restrict` przy tworzeniu agenta i odpowiada rdzeniowi na loopbacku (`src/tools.mjs`, `src/sidecall.mjs`; ścieżka punktu końcowego w `TE_DSH_SIDECALL_FILE`, id sesji hooka w `TE_DSH_SESSION`). Konfiguracja pluginu: `sidecall: false`, `applyDeny: false`.

## Panel w prawym pasku (web/desktop)
Karta „TokenEconomizer” w prawym pasku DSH pokazuje tryby mechanizmów, sumy z księgi (sesje, efektywne tokeny, narzut), ostrzeżenia oraz sekcję **History**: koszt każdej sesji ułożony z zapisanych składowych, cache hit, podsumowanie dzienne i (gdy zadziałała) straż pętli, z przełącznikiem zakresu. Dane pochodzą z `/te panel --json` (status plus seria sesji z księgi), host niczego nie liczy sam, a wykresy pokazują tylko zapisane wartości — nic nie jest szacowane jako „oszczędność”. W terminalu to samo daje `/te panel` (tabela i sparkline'y). Panel czyta stan przy otwarciu, zmianie sesji i po „Refresh”, nigdy cyklicznie, bo każde wykonanie zostawia w czacie wiersz `te · {…}`. Klient to zwykłe moduły CommonJS (`client/src/`), opakowane w kopertę DSH przez `node client/build.mjs` (→ `client.js`, poza gitem; dystrybucję składa `scripts/build_dsh_plugin.py`). Decyzje: [ADR 0003](../../docs/dsh/adr/0003-czesc-wizualna.md). Test w prawdziwej przeglądarce (Chrome + `dsh web` + jedno krótkie wywołanie modelu): `node client/test/browser/browser-check.mjs --env-file <.env z kluczem> --patch <nakładka z modelem>`. W TUI i headless zostaje tekst z `/te`.

## Wymagania i zmienne
Python >= 3.10 w PATH (lub `TE_PYTHON`). `TE_DISABLE=1` wyłącza plugin. Stan: `~/.tokeneconomizer`
(`TOKENECONOMIZER_HOME`). Testy: `npm test` w tym katalogu (Node >= 22). Test na żywym DSH: `node test/live/live-check.mjs [--profile headless]` (kilka krótkich wywołań modelu; regresja, 25/25).
Dalsze skrypty na żywo (wywołują prawdziwy model):
- `node test/live/live-sidecall.mjs [--profile headless] [--only paid|route] [--paid-a provider/model] [--paid-b model]` — `paid_model` (trasa sesji, jawny `provider/model`, sam model u dostawcy sesji); 20/20.
- `node test/live/live-prune-loop.mjs [--profile headless] [--sessions 2] [--used-tool NAZWA] [--proxied-tool NAZWA]` — pętla przycinania z prawdziwym rdzeniem (tryb `auto`); 15/15.
- `node test/live/live-sessions.mjs [--profile headless] [--only subagent|concurrent|sigterm]` — subagent, dwa równoległe procesy, SIGTERM i nieaktualny plik punktu końcowego; 34/34.
- `node client/test/browser/browser-check.mjs --prune [--only prune|panel] [--env-file F] [--patch P]` — prawdziwy Chrome przeciw `dsh web` z prawdziwym modelem: lista odmów, jeden plik punktu końcowego, wywołanie przez niego, wiersze panelu; 24/24.
