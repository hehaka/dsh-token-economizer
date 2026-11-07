# ADR 0004 — Przycinanie narzędzi i wywołania pomocnicze modelu na DSH

Status: przyjęty i zweryfikowany na żywym `dsh headless` i `dsh web` (2026-11-07), z limitami w „Weryfikacja”. Plan i kryteria: [`docs/plans/2026-11-07-dsh-przycinanie-i-wywolania-pomocnicze.md`](../../plans/2026-11-07-dsh-przycinanie-i-wywolania-pomocnicze.md). Domyka dwa braki z [ADR 0001](0001-integracja-z-tokeneconomizer.md) (faza E) i `spike-phase-b.md`.

## Przycinanie narzędzi
**Podział pracy.** Rdzeń decyduje (dowody → propozycja → `auto`/`propose`), plugin tylko wykonuje. Rdzeń zapisuje listę w `.dsh/token-economizer.local.json` pod `tokeneconomizer.deny` — tym samym kodem co pliki ustawień Claude Code/Codex/Copilot (`denylist.apply/restore`, wpis w `.git/info/exclude` tylko dla pliku utworzonego przez plugin, odmowa przy dowiązaniu symbolicznym katalogu `.dsh`). Plugin czyta ten plik przy `agent/created` i wywołuje `agent.ctx.tools.restrict({deny})` **przed pierwszym zapytaniem**, więc lista narzędzi (a z nią cache promptu) nie zmienia się w trakcie sesji.

**Tylko narzędzia serwerów MCP (`mcp__*`).** Rdzeń nie zna znaczenia narzędzi wbudowanych DSH (`bash`, `read`, `tool_call`, `tool_search`, …) i ich usunięcie psuje agenta, więc na DSH chronione jest wszystko poza `mcp__<serwer>__<narzędzie>` (`adapter.DSH_PROTECTED`; własne `protect` użytkownika działa dalej). Zatwierdzone przez użytkownika.

**Katalog narzędzi.** Rdzeń widzi nieużywane narzędzia tylko znając pełną listę. Plugin zapisuje ją przy każdym starcie agenta głównego do `<stan>/hosts/dsh/catalog.json` (format z `te toolprune refresh-catalog`), tylko gdy się zmieniła. Lista pochodzi z widoku agenta, `tools.schemas(agent)` (widok globalny na profilu webowym DSH nie zawiera prawie nic, bo narzędzia modelu są rejestrowane w płaszczyźnie agenta), czyli sprzed `restrict`.

**Proxy `tool_call`.** DSH wywołuje narzędzia odroczone przez `tool_call {name, arguments}`. Spool zapisuje takie wywołanie jako narzędzie, które niesie, inaczej narzędzie używane tylko przez proxy wyglądałoby na nieużywane i trafiłoby na listę odmów.

**Odporność.** `restrict` rzuca dla nieznanej nazwy, więc przekazujemy tylko nazwy znane rejestrowi (narzędzie po odinstalowaniu pluginu nie psuje tworzenia agenta); cały handler jest w `try/catch`. Subagenci nie są ograniczani. `applyDeny: false` w konfiguracji pluginu wyłącza stosowanie, katalog nadal się zapisuje.

## Wywołania pomocnicze (`ctx.llm`)
Sędzia pętli, autor uwag i propozycje mikro-umiejętności działają w Pythonie (w hooku lub w odłączonym procesie), bez dostępu do usługi modeli DSH. Plugin odpowiada więc za rdzeń:

- **Punkt końcowy** `POST /v1/complete` na `127.0.0.1` (port losowy), uwierzytelniany tokenem (porównanie stałoczasowe), z sprawdzeniem nagłówka `Host` (DNS rebinding). Ścieżka pliku z portem i tokenem (`hosts/dsh/sidecall.<pid>.endpoint.json`, 0600) idzie w `TE_DSH_SIDECALL_FILE` do środowiska każdego hooka, więc dziedziczą ją też odłączone zadania. Plik powstaje bez podążania za dowiązaniami: istniejąca ścieżka jest usuwana (`lstat` + `unlink`), zapis idzie z flagą `wx` i trybem 0600, a katalog `hosts/dsh`, który sam jest dowiązaniem, powoduje odmowę publikacji. Pliki procesów, których już nie ma, są sprzątane przy starcie; `server.unref()` nie przytrzymuje procesu headless.
- **Jedno wywołanie** przez `ctx.llm.prepareCall(...).stream(...)`: bez historii sesji, bez narzędzi, najniższy dostępny poziom rozumowania, jeden komunikat użytkownika. Limity: prompt ≤ 400 000 znaków, ≤ 2 równoległe, `maxTokens` ≤ 4096, termin 170 s (rdzeń czeka 180 s), przerwanie połączenia anuluje wywołanie modelu. Limit ciała (1 000 000) liczy bajty UTF-8, a termin przerywa też czytanie niedokończonego ciała (połączenie jest zamykane, miejsce zwolnione). Tekst błędu dostawcy jest przed odesłaniem oczyszczany z tokenu i z promptu (całego i każdego ciągu ≥ 20 znaków z niego) i obcinany do 300 znaków. Prompt i odpowiedź nigdy nie trafiają do logów.
- **Trasa.** Domyślnie bieżący model sesji (z `agent.options`, potem z ostatniego `request/context`; zweryfikowane na żywo); `paid_model` nadpisuje: `provider/model` albo sam model u dostawcy sesji. Zatwierdzone przez użytkownika. Jeden proces DSH może gościć kilka sesji na różnych modelach (`dsh web`), więc trasa jest **per sesja**: plugin trzyma mapę `id sesji → trasa` (ustawianą tylko dla sesji głównych, przy `agent/created` i `request/context`; ograniczoną do 64 wpisów, najstarszy odpada), środowisko hooka niesie `TE_DSH_SESSION`, klient (`dsh_sidecall.call`) wysyła je jako pole `session`, a punkt końcowy używa trasy sesji **wskazanej**. Wywołanie bez `session` (starszy klient) dostaje ostatnio zaobserwowaną trasę; sesja bez znanej trasy daje `409 NO_ROUTE`, nigdy model innej sesji.
- **Koszt.** Odpowiedź niesie zużycie (`input` bez cache, jak w księdze), rdzeń wycenia je jak sesję (`accounting.effective`) i księguje jak przy innych hostach. Wywołanie, które nie dotarło do modelu, nie jest szacowane (`Runner.estimate_effective`).
- **Błędy.** Brak odpowiedzi to `("", None)` plus jedna linia w `errors.log`, nigdy wyjątek. Odmowa konta przez dostawcę (HTTP 401/403 → kod `AUTH`) wstrzymuje wywołania hosta jak „nie zalogowano” u innych agentów (`te config set microskills|loopguard` zdejmuje pauzę). Własny błąd uwierzytelnienia punktu końcowego (`TE_AUTH`) nie wstrzymuje niczego, a `MODEL` (i każdy inny kod) nie wstrzymuje nigdy, choćby jego tekst mówił „not signed in”: o pauzie decyduje kod, nie treść komunikatu.
- **Usługi.** `ctx.llm` i `ctx.tools` to usługi: odczyt bez `ctx.inject` rzuca (wyłapane na żywo, atrapy testowe tego nie wykazały). Plugin pobiera je przez `ctx.inject([...])`, więc profil bez nich nadal dostaje hooki.

## Poza zakresem
Narzędzia wbudowane DSH w propozycjach; nazwane potoki Windows (loopback TCP działa wszędzie); wyświetlanie propozycji w `systemMessage` przy starcie; pomiar skutku (`CLAUDE.md`: brak twierdzeń o efekcie).

## Weryfikacja
Python: `tests/test_dsh_toolprune.py`, `tests/test_dsh_sidecall.py` (w tym sędzia pętli na punkcie końcowym i księgowanie). Node: `test/tools.test.mjs`, `test/sidecall.test.mjs`, `test/sidecall.e2e.test.mjs` (prawdziwy serwer + prawdziwy Python, atrapa `ctx.llm`). Testy mutacyjne ręczne (usunięcie kontroli → test pada) dla obu części. **Na żywo** (2026-11-07, prawdziwy model, szczegóły i błędy w [`spike-phase-b.md`](../spike-phase-b.md), sekcja „Domknięcie weryfikacji”):
- `live-check.mjs` 25/25: wywołanie przez punkt końcowy zwróciło tekst i wycenialne zużycie na modelu sesji; narzędzie z listy odmów zniknęło z `request/header` (183 → 182), nieznana nazwa nie zepsuła uruchomienia.
- `live-sidecall.mjs` 20/20: `paid_model` w trzech wariantach (trasa sesji `anthropic/claude-haiku-5-5`, jawny `azure-openai-responses/gpt-6-luna`, sam model u dostawcy sesji) — wszystkie z wycenianym zużyciem.
- `live-prune-loop.mjs` 15/15: prawdziwy rdzeń, tryb `auto`; po pierwszej zakończonej sesji plik odmów z 153 nazwami `mcp__*` (katalog 154 minus 1 użyta), `bash` i użyte narzędzie poza listą, kolejne sesje zachowują listę; zapytanie sesji kontrolnej: 30 narzędzi wobec 183 w pierwszej.
- `live-sessions.mjs` 34/34: subagent nie podlega liście odmów, nie jest spoolowany ani składany jak sesja główna i nie otwiera drugiego punktu końcowego (potwierdza „subagenci nie są ograniczani”); dwa procesy w jednym katalogu stanu mają osobne pliki (po pid) i oba odpowiadają; SIGTERM kończy DSH czysto i usuwa plik; nieaktualny plik punktu końcowego daje `("", None)` w ~0,03 s i jest sprzątany przez następny proces.
- `client/test/browser/browser-check.mjs --prune` 24/24: prawdziwy Chrome przeciw `dsh web`; lista odmów zastosowana, jeden plik punktu końcowego, wywołanie przez niego na modelu sesji, wiersze panelu („Model calls”, szczegół przycinania) zgodne z `te status --json`. `te panel --json` niesie `side` = `{paused, host}`.
- Trasa przed pierwszym zapytaniem: wywołanie rdzenia przy `SessionStart` udało się na trasie sesji w każdym przebiegu na żywo (hook to osobny proces, `agent/created` ustawił trasę wcześniej).

**Błędy znalezione na żywo:** (1) na `dsh web` lista odmów nigdy nie była stosowana, bo `tools.schemas()` bez zakresu zwracało tylko `working_directory` → `schemas(agent)`; (2) trzy kolejne prawdziwe wywołania modelu w jednym hooku przekraczają 20 s limit mostu → atrapa rdzenia robi jeden wariant na hook. Poprawki z przeglądu (`docs/reviews/2026-11-07-dsh-prune-sidecall.md`) opisują sekcje wyżej.

**Nie sprawdzone / limity:**
- dwie sesje na różnych modelach w jednym procesie: testy z atrapą `ctx.llm`, nie na żywo;
- brak trasy (`409 NO_ROUTE`, rdzeń: „brak odpowiedzi”, bez pauzy i księgowania): przypięte testami (Node, Python, atrapa), na żywo nieobserwowane (wyścig);
- proxy `tool_call` (`unproxy`): tylko testy jednostkowe (profil headless nie ma tego narzędzia);
- sesje PTC (`run_code`) mogą ukrywać użycie narzędzi MCP przed spoolem (niezweryfikowane);
- aplikacja desktopowa, Firefox/Safari, interaktywne TUI; `dsh web` tylko przez headless Chrome, jeden prompt na przebieg;
- sesja wznowiona lub ze zmienionym modelem: trasa z `agent/created` i `request/context`, bieżący model może różnić się od domyślnego profilu;
- rozliczenie tokenów rozumowania (czy `outputTokens` je obejmuje);
- skuteczność samego przycinania (pomiar poza zakresem; obserwowane są tylko liczby narzędzi w zapytaniu).

**Odroczone z przeglądu:** uszkodzony `sidecall.json` trafia do panelu bez walidacji; Python `_usage` przyjmuje NaN i wartości ujemne (JS czyści je przed księgą); `llm_nudge_writer` z upstreamu księguje 0 dla pustej odpowiedzi; `te toolprune apply NAZWA` na dsh nie odmawia nazw chronionych (upstreamowy `cli.py`).
