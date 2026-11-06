# dsh-token-economizer (plugin DSH)

Plugin DeepSeek Harness nad rdzeniem [TokenEconomizer](https://github.com/microsoft/TokenEconomizer).
Rdzeń (Python, tylko biblioteka standardowa) liczy fakty o repozytorium, propozycje przycinania
narzędzi i straż pętli; ten plugin tylko tłumaczy zdarzenia DSH na jego protokół hooków
(`src/plugin.mjs`) i zapisuje spool sesji w formacie Pi (`src/spool.mjs`).

Decyzje: [`docs/dsh/adr/`](../../docs/dsh/adr/). Wyniki spike'u: [`docs/dsh/spike-phase-b.md`](../../docs/dsh/spike-phase-b.md).

## Stan (faza C)
Zaimplementowane i przetestowane bez uruchamiania DSH (atrapa `ctx`, prawdziwy Python):
spool, most do dyspozytora, podpięcie zdarzeń, fold sesji do księgi.
**Niezweryfikowane na żywym DSH:** kształt zdarzeń `session/event`, `additionalContexts` po narzędziu,
wstrzyknięcie faktów przez `system-prompt/assemble`. Brak jeszcze: komend `/te`, wywołań pomocniczych
modelu (`ctx.llm`), przycinania narzędzi.

## Wymagania i zmienne
Python >= 3.10 w PATH (lub `TE_PYTHON`). `TE_DISABLE=1` wyłącza plugin. Stan: `~/.tokeneconomizer`
(`TOKENECONOMIZER_HOME`). Testy: `npm test` w tym katalogu (Node >= 22).
