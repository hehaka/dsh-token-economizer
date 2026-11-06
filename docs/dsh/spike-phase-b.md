# Faza B — wyniki spike'u (2026-11-06)

Dotyczy [ADR 0001](adr/0001-integracja-z-tokeneconomizer.md) i [ADR 0002](adr/0002-fork-jako-model-budowania.md). Środowisko: `@deepseek-ai/dsh@0.2.1-rc.5`, Python 3.15.2, pnpm 12.8.1, upstream `a71684c`. Bazowy zestaw testów (`pytest tests`) na czystym `main` i na `dsh` przechodzi (exit 0).

| # | Pytanie | Wynik | Pewność |
|---|---|---|---|
| B1 | Czy sesję DSH da się zapisać w formacie Pi i odczytać czytnikami upstreamu? | **Tak** | uruchomione na prawdziwej sesji |
| B2 | Czy rdzeń zna ceny modeli DSH? | **Częściowo, bez blokady** | z kodu |
| B3 | Czy `tools/post-execute` może dołączyć kontekst dla modelu? | **Tak** (`additionalContexts`) | z typów, bez uruchomienia |
| B4 | Czy `ctx.llm` nadaje się do wywołań pomocniczych? | **Tak, jednorazowe `stream()`** | z typów, bez uruchomienia |
| B5 | Czy `dsh plugin add` zainstaluje plugin z podkatalogu repo? | **Tak, ale tylko ten podkatalog** | uruchomione na lokalnym repo testowym |

## B1 — mapowanie log DSH → sesja w formacie Pi

Prototyp (Python, poza repo) przepuścił sesję z 12 turami przez `trace.pi_session_to_claude`, `pi_prompt_count`, `pi_session_usage` i `load_trajectory`:

| Zdarzenie DSH | Wpis spoolu (Pi) |
|---|---|
| nagłówek `session` (`id`, `cwd`) | `{type:"session", id, cwd}` |
| `user/message` **tylko z `source.kind == "user"`** | `message` / `role:"user"` |
| `assistant/message`, blok `tool-call` (`arguments` to **string JSON**) | `message` / `role:"assistant"`, blok `toolCall` z `arguments` jako obiekt |
| `assistant/message.data.usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) | `usage` (`input`, `output`, `cacheRead`, `cacheWrite`) |
| `assistant/message.message.source.model` | `model` |
| `tool/result` (`toolCallId`, `isError`, `content`) | `message` / `role:"toolResult"` |

Wynik: 13/13 wywołań narzędzi i 12/12 promptów; sumy tokenów zgodne co do jednego (`input 74`, `cacheRead 877372`, `cacheWrite 50000`, `output 6278`); `load_trajectory` zwraca 13 wywołań z poprawnymi flagami sukcesu (jedno nieudane `bash`).

Wnioski wiążące dla implementacji:
- **Wstrzyknięty kontekst też jest `user/message`**, tylko z innym `source.kind` (`agent-instructions`, `runtime-context`, `skill-catalog`). Spool musi je pomijać, a blok faktów TE dostanie własny `source.kind`, także pomijany. Inaczej TE policzy go jako prompt.
- `inputTokens` w DSH nie zawiera cache (`total = in + out + cacheRead + cacheWrite`), tak jak w pi-ai.
- Nazwy narzędzi są po DSH (`bash`, `read`, `edit`, `write`, `grep`, `glob`, `tool_search`). Loop guard kanonizuje je sam (`canon_tool` w `loopguard/state.py`), więc działa bez mapowania.
- **Nie sprawdzono:** sesji po kompaktowaniu, subagentów (`header.parentSession` / `origin`, do pominięcia), obrazów, zapisu przyrostowego na żywo (prototyp przetwarzał gotowy log).
- Surowej sesji nie wersjonujemy (zawiera treść rozmowy i konfigurację); fixture w fazie C będzie syntetyczny.

## B2 — ceny
`pricing.py` liczy względne wagi (jednostki „effective tokens”), nie dolary. Każde `claude-*` (m.in. `claude-sonnet-5-5`, `claude-haiku-5-5`) trafia na krzywą Claude. Nieznane id (np. `gpt-6-sol`, `gpt-6-luna`) dostaje w pluginie krzywą zapasową z adnotacją `priced_by: "fallback"` (`plugin/accounting.py`) — bez błędu. Dopisanie wag dla `gpt-6-*` to opcjonalne ~2 linie w `pricing.py` (budżet addytywności).

## B3 — kontekst po narzędziu
`PostToolDecision` (`dsh-tools`): `{kind:'accept', additionalContexts?: UserMessage[]}` lub `{kind:'block', feedback, additionalContexts?}` — „attach context for the next request”. Przekierowanie loop guarda idzie jako `additionalContexts`. Do potwierdzenia uruchomieniem w fazie C/E: że model faktycznie widzi tekst.

## B4 — wywołania pomocnicze
`LlmRuntime.stream(options)` i `prepareCall(config)` (`dsh-llm`): jednorazowe wywołanie, adapter wybierany przez `options.provider`, jedna próba, poza historią sesji. Plugin musi zadeklarować zależność od usługi `llm`. Do potwierdzenia w fazie E: jak plugin zna bieżący provider/model (zdarzenie `model/selection` w logu) oraz limity.

## B5 — instalacja
`pnpm add "git+file://…#path:/plugin/dsh"` instaluje pakiet z podkatalogu (`dsh.bundle` w jego `package.json`), ale **wyłącznie zawartość tego podkatalogu**. Rdzeń Pythona z korzenia repo nie trafia do `node_modules`. Skutek: potrzebny krok budowania, który kopiuje `tokeneconomizer/` do bundla (wzorzec `scripts/build_plugin.py` upstreamu), a dystrybucja idzie przez gałąź `dist` budowaną przez CI. Szczegóły w ADR 0002, sekcja „Aktualizacja po fazie B”.

## Dodatkowe ustalenia
- **Zbiór narzędzi chronionych przed pruningiem** (`plugin/adapter.py`: `PROTECTED_TOOLS | INTERACTIVE_PROTECTED`) ma nazwy w stylu Claude (`Bash`, `Edit`…). Host `dsh` potrzebuje własnego zbioru (`bash`, `read`, `edit`, `write`, `glob`, `grep`, `tool_search`, `tool_describe`, `tool_call`, `skill`, `subagent*`, `ask_user_question`, `todo_write`…), inaczej pruning mógłby zaproponować usunięcie narzędzi podstawowych lub wyszukiwarki narzędzi. To kilkanaście linii w `adapter.py` (z budżetu).
- **Pruning a `dsh-tool-search`:** w tej instalacji większość narzędzi jest już odroczona (kosztuje tylko wpis w katalogu), więc zysk z pruningu będzie mniejszy niż w upstreamie. Do oceny przed fazą F, na realnych sesjach.
- **Nie zmierzono** kosztu `dsh headless` (próba uruchomienia z sandboxa zakończyła się `EPERM`); przy podejściu z `ctx.llm` nie jest już potrzebne.
