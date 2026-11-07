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
Niezweryfikowane: tryby interaktywne, subagenci na żywo, skuteczność uwag straży pętli.
Komenda `/te` (CLI rdzenia: `status`, `microskills`, `toolprune`, `config`, `doctor`, …) działa przez executor DSH.

**Przycinanie narzędzi** (tylko `mcp__*`) i **wywołania pomocnicze modelu** (sędzia pętli, propozycje mikro-umiejętności przez `ctx.llm`, domyślnie na modelu sesji, `paid_model` nadpisuje) działają: patrz [ADR 0004](../../docs/dsh/adr/0004-przycinanie-narzedzi-i-wywolania-pomocnicze.md). Plugin zapisuje listę narzędzi DSH (`hosts/dsh/catalog.json`), stosuje `tokeneconomizer.deny` z `.dsh/token-economizer.local.json` przez `restrict` przy tworzeniu agenta i odpowiada rdzeniowi na loopbacku (`src/tools.mjs`, `src/sidecall.mjs`; ścieżka punktu końcowego w `TE_DSH_SIDECALL_FILE`, id sesji hooka w `TE_DSH_SESSION`). Konfiguracja pluginu: `sidecall: false`, `applyDeny: false`.

## Panel w prawym pasku (web/desktop)
Karta „TokenEconomizer” w prawym pasku DSH pokazuje tryby mechanizmów, sumy z księgi (sesje, efektywne tokeny, narzut), ostrzeżenia oraz sekcję **History**: koszt każdej sesji ułożony z zapisanych składowych, cache hit, podsumowanie dzienne i (gdy zadziałała) straż pętli, z przełącznikiem zakresu. Dane pochodzą z `/te panel --json` (status plus seria sesji z księgi), host niczego nie liczy sam, a wykresy pokazują tylko zapisane wartości — nic nie jest szacowane jako „oszczędność”. W terminalu to samo daje `/te panel` (tabela i sparkline'y). Panel czyta stan przy otwarciu, zmianie sesji i po „Refresh”, nigdy cyklicznie, bo każde wykonanie zostawia w czacie wiersz `te · {…}`. Klient to zwykłe moduły CommonJS (`client/src/`), opakowane w kopertę DSH przez `node client/build.mjs` (→ `client.js`, poza gitem; dystrybucję składa `scripts/build_dsh_plugin.py`). Decyzje: [ADR 0003](../../docs/dsh/adr/0003-czesc-wizualna.md). Test w prawdziwej przeglądarce (Chrome + `dsh web` + jedno krótkie wywołanie modelu): `node client/test/browser/browser-check.mjs --env-file <.env z kluczem> --patch <nakładka z modelem>`. W TUI i headless zostaje tekst z `/te`.

## Wymagania i zmienne
Python >= 3.10 w PATH (lub `TE_PYTHON`). `TE_DISABLE=1` wyłącza plugin. Stan: `~/.tokeneconomizer`
(`TOKENECONOMIZER_HOME`). Testy: `npm test` w tym katalogu (Node >= 22). Test na żywym DSH: `node test/live/live-check.mjs [--profile headless]` (kilka krótkich wywołań modelu).
