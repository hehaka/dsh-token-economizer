# ADR 0004 — Przycinanie narzędzi i wywołania pomocnicze modelu na DSH

Status: przyjęty i zweryfikowany na żywym `dsh headless` (2026-11-07). Plan i kryteria: [`docs/plans/2026-11-07-dsh-przycinanie-i-wywolania-pomocnicze.md`](../../plans/2026-11-07-dsh-przycinanie-i-wywolania-pomocnicze.md). Domyka dwa braki z [ADR 0001](0001-integracja-z-tokeneconomizer.md) (faza E) i `spike-phase-b.md`.

## Przycinanie narzędzi
**Podział pracy.** Rdzeń decyduje (dowody → propozycja → `auto`/`propose`), plugin tylko wykonuje. Rdzeń zapisuje listę w `.dsh/token-economizer.local.json` pod `tokeneconomizer.deny` — tym samym kodem co pliki ustawień Claude Code/Codex/Copilot (`denylist.apply/restore`, wpis w `.git/info/exclude` tylko dla pliku utworzonego przez plugin, odmowa przy dowiązaniu symbolicznym katalogu `.dsh`). Plugin czyta ten plik przy `agent/created` i wywołuje `agent.ctx.tools.restrict({deny})` **przed pierwszym zapytaniem**, więc lista narzędzi (a z nią cache promptu) nie zmienia się w trakcie sesji.

**Tylko narzędzia serwerów MCP (`mcp__*`).** Rdzeń nie zna znaczenia narzędzi wbudowanych DSH (`bash`, `read`, `tool_call`, `tool_search`, …) i ich usunięcie psuje agenta, więc na DSH chronione jest wszystko poza `mcp__<serwer>__<narzędzie>` (`adapter.DSH_PROTECTED`; własne `protect` użytkownika działa dalej). Zatwierdzone przez użytkownika.

**Katalog narzędzi.** Rdzeń widzi nieużywane narzędzia tylko znając pełną listę. Plugin zapisuje ją przy każdym starcie agenta głównego do `<stan>/hosts/dsh/catalog.json` (format z `te toolprune refresh-catalog`), tylko gdy się zmieniła. Lista pochodzi z globalnego widoku `tools.schemas()`, czyli sprzed `restrict`.

**Proxy `tool_call`.** DSH wywołuje narzędzia odroczone przez `tool_call {name, arguments}`. Spool zapisuje takie wywołanie jako narzędzie, które niesie, inaczej narzędzie używane tylko przez proxy wyglądałoby na nieużywane i trafiłoby na listę odmów.

**Odporność.** `restrict` rzuca dla nieznanej nazwy, więc przekazujemy tylko nazwy znane rejestrowi (narzędzie po odinstalowaniu pluginu nie psuje tworzenia agenta); cały handler jest w `try/catch`. Subagenci nie są ograniczani. `applyDeny: false` w konfiguracji pluginu wyłącza stosowanie, katalog nadal się zapisuje.

## Wywołania pomocnicze (`ctx.llm`)
Sędzia pętli, autor uwag i propozycje mikro-umiejętności działają w Pythonie (w hooku lub w odłączonym procesie), bez dostępu do usługi modeli DSH. Plugin odpowiada więc za rdzeń:

- **Punkt końcowy** `POST /v1/complete` na `127.0.0.1` (port losowy), uwierzytelniany tokenem (porównanie stałoczasowe), z sprawdzeniem nagłówka `Host` (DNS rebinding). Ścieżka pliku z portem i tokenem (`hosts/dsh/sidecall.<pid>.endpoint.json`, 0600) idzie w `TE_DSH_SIDECALL_FILE` do środowiska każdego hooka, więc dziedziczą ją też odłączone zadania. Pliki procesów, których już nie ma, są sprzątane przy starcie; `server.unref()` nie przytrzymuje procesu headless.
- **Jedno wywołanie** przez `ctx.llm.prepareCall(...).stream(...)`: bez historii sesji, bez narzędzi, najniższy dostępny poziom rozumowania, jeden komunikat użytkownika. Limity: prompt ≤ 400 000 znaków, ≤ 2 równoległe, `maxTokens` ≤ 4096, termin 170 s (rdzeń czeka 180 s), przerwanie połączenia anuluje wywołanie modelu. Prompt i odpowiedź nigdy nie trafiają do logów.
- **Trasa.** Domyślnie bieżący model sesji (z `agent.options`, potem z ostatniego `request/context`; zweryfikowane na żywo); `paid_model` nadpisuje: `provider/model` albo sam model u dostawcy sesji. Zatwierdzone przez użytkownika.
- **Koszt.** Odpowiedź niesie zużycie (`input` bez cache, jak w księdze), rdzeń wycenia je jak sesję (`accounting.effective`) i księguje jak przy innych hostach. Wywołanie, które nie dotarło do modelu, nie jest szacowane (`Runner.estimate_effective`).
- **Błędy.** Brak odpowiedzi to `("", None)` plus jedna linia w `errors.log`, nigdy wyjątek. Odmowa konta przez dostawcę (HTTP 401/403 → kod `AUTH`) wstrzymuje wywołania hosta jak „nie zalogowano” u innych agentów (`te config set microskills|loopguard` zdejmuje pauzę). Własny błąd uwierzytelnienia punktu końcowego (`TE_AUTH`) nie wstrzymuje niczego.
- **Usługi.** `ctx.llm` i `ctx.tools` to usługi: odczyt bez `ctx.inject` rzuca (wyłapane na żywo, atrapy testowe tego nie wykazały). Plugin pobiera je przez `ctx.inject([...])`, więc profil bez nich nadal dostaje hooki.

## Poza zakresem
Narzędzia wbudowane DSH w propozycjach; nazwane potoki Windows (loopback TCP działa wszędzie); wyświetlanie propozycji w `systemMessage` przy starcie; pomiar skutku (`CLAUDE.md`: brak twierdzeń o efekcie).

## Weryfikacja
Python: `tests/test_dsh_toolprune.py`, `tests/test_dsh_sidecall.py` (w tym sędzia pętli na punkcie końcowym i księgowanie). Node: `test/tools.test.mjs`, `test/sidecall.test.mjs`, `test/sidecall.e2e.test.mjs` (prawdziwy serwer + prawdziwy Python, atrapa `ctx.llm`). Testy mutacyjne ręczne (usunięcie kontroli → test pada) dla obu części. **Na żywo** (`test/live/live-check.mjs`, 25/25): wywołanie przez punkt końcowy zwróciło tekst i wycenialne zużycie na modelu sesji; narzędzie z listy odmów zniknęło z `request/header` (183 → 182), a nieznana nazwa nie zepsuła uruchomienia. **Nie sprawdzone na żywo:** `paid_model` (tylko testy), tryby interaktywne, wiele sesji naraz, skuteczność samego przycinania (pomiar poza zakresem).
