# Faza B — wyniki spike'u (2026-11-06)

Dotyczy [ADR 0001](adr/0001-integracja-z-tokeneconomizer.md) i [ADR 0002](adr/0002-fork-jako-model-budowania.md). Środowisko: `@deepseek-ai/dsh@0.2.1-rc.5`, Python 3.15.2, pnpm 12.8.1, upstream `a71684c`. Bazowy zestaw testów (`pytest tests`) na czystym `main` i na `dsh` przechodzi (exit 0).

| # | Pytanie | Wynik | Pewność |
|---|---|---|---|
| B1 | Czy sesję DSH da się zapisać w formacie Pi i odczytać czytnikami upstreamu? | **Tak** | uruchomione na prawdziwej sesji |
| B2 | Czy rdzeń zna ceny modeli DSH? | **Częściowo, bez blokady** | z kodu |
| B3 | Czy `tools/post-execute` może dołączyć kontekst dla modelu? | **Tak** (`additionalContexts`) | z typów **i potwierdzone na żywo** (patrz „Weryfikacja na żywym DSH”) |
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

## Weryfikacja na żywym DSH (2026-11-06)

Skrypt: `plugin/dsh/test/live/live-check.mjs` (uruchamia `dsh headless` z nakładką `--patch`, więc profil użytkownika nie jest zmieniany; stan rdzenia trafia do katalogu tymczasowego; wymaga `dsh` w PATH i pliku `.env` profilu z kluczem modelu, który wczytuje bez wypisywania). Trzy krótkie przebiegi (`claude-haiku-5-5`), wynik **18/18**.

**Potwierdzone na żywo (headless, DSH 0.2.1-rc.5):**
- Plugin ładuje się jako wpis `--patch`; kształty zdarzeń zgadzają się z założeniami: `SessionStart`, jeden `UserPromptSubmit` (`prompt_id` p1, tekst użytkownika), `PostToolUse` dla `bash` z argumentami jako obiektem i wynikiem w `tool_response`, `Stop`, `SessionEnd`.
- Spool zawiera tylko prompt wpisany przez użytkownika, bez wstrzykniętego kontekstu.
- **Fakty** z `system-prompt/assemble` trafiają do modelu jako wiadomość `runtime-context` (log sesji + odpowiedź modelu).
- **Kontekst po narzędziu**: DSH kolejkuje go (`agent/inbox/spliced`, cel `next-step`), zapisuje jako wiadomość `user` ze `source.kind: token-economizer` po wyniku narzędzia i przed następną odpowiedzią; podsłuch `llm/stream` pokazał, że jest w żądaniu kroku 2.
- Z prawdziwym rdzeniem sesja kończy się rekordem w księdze (`requests 2`, `priced_by: model`).

**Znalezione błędy, naprawione:**
1. `session/disposed` **nie jest emitowane w trybie headless** (proces kończy się przez `beforeExit`) → brak `SessionEnd` i brak foldu. Plugin domyka otwarte sesje na `beforeExit`; po zabitym procesie rdzeń składa sesję przy następnym starcie w tym repozytorium.
2. DSH przekazuje **`null`** jako konfigurację wpisu bez `config:` → `TypeError`, wpis się nie aktywował (DSH tylko ostrzegł, przebieg szedł dalej bez pluginu). `createPlugin` toleruje `null`.
3. Notatka po narzędziu bez opakowania była przez model uznana za nieobecną; opakowanie w `<system-reminder>` (konwencja DSH dla kontekstu) sprawiło, że model ją widział. Nadal **odmówił** podania „kodu” z automatycznej wiadomości — to artefakt projektu testu (prośba o echo kodu wygląda jak wstrzyknięcie), nie błąd pluginu, więc skrypt ocenia dostarczenie z logu DSH, a odpowiedzi modelu tylko raportuje.

**Nie sprawdzone:**
- tryby interaktywne (TUI, web): czy `session/disposed` jest tam emitowane i czy pojedyncza sesja web z wieloma promptami numeruje je poprawnie;
- izolacja subagentów na żywo (jest w testach z atrapą `ctx`);
- czy model faktycznie **stosuje się** do realnej uwagi straży pętli (tu sprawdzono tylko dostarczenie);
- `ctx.llm` (wywołania pomocnicze), komendy `/te`, przycinanie narzędzi;
- import `createUserMessage` z `@deepseek-ai/dsh-llm` z zainstalowanego pakietu (w teście z katalogu tymczasowego zadziałał zapasowy, ręcznie zbudowany obiekt wiadomości i DSH go przyjął);
- współistnienie z `dsh-hooks-claude-code` w tym samym profilu.

### Komenda `/te` (2026-11-06)
- Rejestracja przez `ctx.inject(['commands'], …)`, nie przez `inject` pluginu: tablicowy `inject` oznacza usługę wymaganą, więc profil bez `commands` wstrzymałby cały plugin razem z hookami.
- `dsh headless` **nie wykonuje komend slash** (linia `/te …` poszła do modelu jako zwykły prompt), więc komendę sprawdza plugin diagnostyczny `test/live/command_diag.mjs`, który wywołuje `CommandRegistry.execute(agent, linia, …)`, czyli ścieżkę używaną przez interfejs. Potwierdzone: `te` jest na liście komend agenta, `/te status --json` zwraca status repozytorium z `host: "dsh"`, `/te fold …` jest odrzucone.
- `/te` przekazuje argumenty do CLI rdzenia (`te_bootstrap.py cli --host dsh`) bez powłoki. Dozwolone: `status`, `microskills`/`facts`, `toolprune`/`untool`, `config`, `doctor`, `history`, `repos`, `repomap`. Poza listą: `fold`, `judge` (zadania w tle) i `probe` (wywołania modelu, których wtyczka DSH jeszcze nie ma).
- Wywołanie z prawdziwego okna czatu (przeglądarka, 2026-11-06): `/te status` wpisane w pole wiadomości wykonuje się i zostawia w czacie wiersz `te · { … }` (wynik jako tekst, ucięty do jednej linii). **Nie sprawdzone:** TUI.
- Komenda wpisana w *szkicu* (przed pierwszą wiadomością) nie utworzyła sesji; w sesji działa.

### Panel w prawym pasku (faza G, 2026-11-06)
Decyzje: [ADR 0003](adr/0003-czesc-wizualna.md). Sprawdzone w **prawdziwej przeglądarce** (Chrome headless przez CDP) na prawdziwym `dsh web` z izolowanym `DSH_HOME` i stanem TE oraz modelem `claude-haiku-5-5` (jedno krótkie wywołanie): `node plugin/dsh/client/test/browser/browser-check.mjs --env-file <.env z kluczem> --patch <nakładka z modelem>` → 10/10.
- Host rozpoznaje `dsh.client` z `package.json` i serwuje `client.js` w adresie zbiorczym; w pasku pojawia się karta „TokenEconomizer” z opisem; kliknięcie otwiera zakładkę.
- **Błąd wyłapany tylko w przeglądarce:** pierwsza wersja brała sesję z `ctx.sidebarRight.onScreen`, które w tym widoku jest puste (panel pisał „Open a session first” przy otwartej sesji); testy jednostkowe z atrapą przechodziły. Poprawnie: slot `sidebar.right.pane.tab` ma zakres sesji, więc `register({ …, inject: (sessionId) => ({ sessionId }) }, Panel)` dostarcza sesję jako właściwość komponentu (ten sam wzorzec ma wbudowany panel planu).
- Dane: panel uruchamia `/te status --json` przez `ctx.remote.commands.execute` — tę samą ścieżką co czat. **Skutek uboczny (potwierdzony):** każde otwarcie i „Refresh” zostawia w czacie wiersz `te · { … }`; dlatego panel czyta stan tylko przy otwarciu, przy zmianie sesji i na żądanie, nigdy cyklicznie.
- Liczby: po złożeniu sesji prawdziwym przebiegiem hooków (`seed_session.py`) panel po „Refresh” pokazuje Sessions 1, Effective tokens 53.9k, Plugin overhead 0 — te same wartości co `te status`.
- **Historia i wykresy (G2/G3)** — `te panel --json` zastąpiło `te status --json` jako źródło panelu (jeden wiersz w czacie na odświeżenie). W przeglądarce, na 6 sesjach rozłożonych na 5 dni (zasilonych prawdziwym przepływem hooków ze sterowanym zegarem), `browser-check.mjs` daje **20/20**: po jednym słupku na sesję, każdy ułożony z 4 zapisanych składowych (24 segmenty), **suma słupków = suma efektywnych tokenów z księgi (203 711 vs „203.7k” w kafelku)**, punkt cache hit na sesję, 5 słupków dziennych, brak wykresu straży gdy nie zadziałała, wykres wypełnia szerokość kontenera (641 px), zmiana zakresu nie uruchamia komendy (wiersze w czacie 2 → 2), brak błędów w konsoli.
- Błędy wyłapane przez testy: słupek szerszy niż jego slot przy 120 sesjach (wychodził poza obszar); zbyt gruba skala osi (53,9k → oś do 100k) — zamieniona na gęstsze „okrągłe” kroki; zepsuty wiersz w ledgerze (`overhead` nie-słownik) wywalał `accounting.overhead_total`, więc seria ma własne zabezpieczenie. Testy mutacyjne wykazały lukę (atrapa Reacta ignorowała zależności `useCallback`, więc nie wykryłaby, że zmiana zakresu odpala komendę) — naprawiona.
- **Nie sprawdzone w przeglądarce:** znacznik „wstrzyknięto fakty” i wykres straży pętli z danymi (są tylko w testach jednostkowych: seed nie wywołuje wstrzykiwania ani nudge'y); kilkaset sesji; wąski pasek i motyw jasny (wygląd oceniony na zrzutach tylko dla ciemnego motywu, ~640 px).
- Okna pierwszego uruchomienia (`Preview Notice`, `Get started`) w świeżym `DSH_HOME` trzeba zamknąć; skrypt to robi.
- **Nie sprawdzone:** Firefox/Safari; aplikacja desktopowa; zachowanie przy wielu sesjach otwartych naraz; układ na wąskim ekranie/mobilnie; motyw jasny. Szeregi i wykresy: patrz wyżej.

### Przycinanie narzędzi (wniosek dla fazy F)
Rdzeń zgłasza `tool pruning is not available on dsh`: dostępność to `denylist.supports(host)`, czyli host z plikiem ustawień (Claude Code, Codex, Copilot). Na DSH przycinanie wymaga osobnej ścieżki zastosowania po stronie pluginu (`ctx.tools.restrict`), z propozycją liczoną przez rdzeń. Test `test_tool_pruning_is_not_applied_on_dsh_yet` przypina obecne zachowanie.

