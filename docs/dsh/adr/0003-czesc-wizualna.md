# ADR 0003 — Część wizualna pluginu DSH (panel w prawym pasku)

Status: przyjęty i zweryfikowany w przeglądarce (2026-11-06), zakres G0–G3: panel z sumami oraz sekcją „History” (szeregi z księgi, wykresy SVG). Rozwija sekcję „część wizualna” z [ADR 0002](0002-fork-jako-model-budowania.md).

## Cel
Panel „TokenEconomizer” w prawym pasku DSH (web/desktop): stan mechanizmów (fakty, przycinanie narzędzi, straż pętli), sumy z księgi (efektywne tokeny, narzut, nudge'e), konfiguracja i ostrzeżenia. Wzorzec: `dsh-context`.

## Ustalenia z rozpoznania (DSH 0.2.1-rc.5)
- **Dwie połówki w jednym pakiecie.** Host: `main` (nasz `index.mjs`). Klient: `exports["./client"]` + deklaracja `dsh.client` w `package.json` (`platform: "web"`, `inject`: pakiety klienckie, których usług używamy). Serwer web serwuje bundle pod `/plugins/<id>/client.js` (`dsh-client-modules`).
- **Format bundla** to `window.__ModuleLoader__.load({id, factory: (require) => …})`; moduł zwraca `{name, inject, apply}`. Zależności środowiska (`react`, `react/jsx-runtime`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-primitives`, …) pobiera `require` z tabeli statycznej, więc **nie są pakowane**.
- **Rejestracja panelu** jest dwuetapowa: `ctx.sidebarRightTabs.register({id, kind, title, guide})` oraz slot `sidebar.right.pane.tab` (ciało, klucz = `id`). Otwarcie: karta w pasku (`guide`) lub `ctx.sidebarRight.openTab(kind)`. **Sesję** panel dostaje z `inject: (sessionId) => ({ sessionId })` przy rejestracji slotu (zakres sesji); `sidebarRight.onScreen` okazało się puste i nie nadaje się (wyłapane w przeglądarce).
- **Kanał host→klient.** Własne metody zdalne wymagają wewnętrznego generatora RPC (`typert`) lub „SRC markers” bramy — krucha ścieżka dla pluginu zewnętrznego. Publicznym, sprawdzonym kanałem jest `ctx.remote.commands.execute(sessionId, "/te …", [])` (używa go wbudowany panel planu). Koszt (potwierdzony w przeglądarce): każde wykonanie zostawia w czacie wiersz `te · {…}` i wpis w logu sesji, więc panel odświeża się **tylko przy otwarciu, zmianie sesji i na żądanie** (bez odpytywania).

## Decyzje
1. **Dane z `/te`.** Kontraktem jest wyjście CLI rdzenia (`te status --json`); host nie liczy niczego sam. Szeregi czasowe sesji (G2) dostaną osobne, małe polecenie rdzenia w nowym pliku (`dsh_panel.py`), podpięte kilkoma liniami w `cli.py` (w budżecie addytywności).
2. **Bez bundlera i bez JSX.** Klient to zwykłe moduły CJS (`plugin/dsh/client/src/*.cjs`) używające `React.createElement`; `client/build.mjs` tylko opakowuje je w otoczkę `__ModuleLoader__` (kilkadziesiąt linii, zero zależności). Plugin pozostaje czystym JS; nie ma kroku Reacta/TS/Tailwinda.
3. **Logika testowalna bez przeglądarki.** Model widoku (status → struktura) jest czysty i testowany `node:test`; widok jest funkcją (props → drzewo elementów); cienka warstwa ze stanem (hooki) jest weryfikowana w prawdziwej przeglądarce.
4. **Artefakt `client.js` nie jest w gicie** (`plugin/dsh/.gitignore`); `build_dsh_plugin.py` buduje go i kładzie w korzeniu paczki `dist` (bez edycji plików upstreamu).
5. **UI tylko w web/desktop.** W TUI i headless zostaje tekst z `/te`.

## Historia i wykresy (G2/G3)
- **Jedno polecenie rdzenia dla panelu: `te panel [--json]`** (`tokeneconomizer/plugin/panel.py`, w `cli.py` tylko import i podkomenda: 4 linie). JSON to `{schema, status, series}`: `status` jest dosłownie wyjściem `te status --json` (komenda wołana wewnątrz, więc dwa widoki nie mogą się rozjechać), `series` — ostatnie ≤120 sesji z księgi, od najstarszej. Jedno polecenie = jeden wiersz w czacie na odświeżenie. Bez `--json` ta sama seria jako krótka tabela i sparkline'y (działa też w TUI i headless).
- **Seria zawiera tylko to, co zapisano:** efektywne tokeny rozbite na składowe **na tych samych wagach co cena** (`pricing.weights_for`; suma składowych = `effective_tokens`), narzut pluginu, cache hit, przekierowania straży, znacznik wstrzykniętych faktów. Sesje zaimportowane z historii agenta są liczone, nie rysowane. Model, którego tabela cen nie zna, daje jedną składową „not split” zamiast błędu.
- **Żadnej „oszczędności”.** Księga nie ma przebiegu bez pluginu do porównania, a `CLAUDE.md` zabrania pluginowi twierdzeń o efekcie, więc wykresy pokazują koszt, skład, cache i zdarzenia; napis pod wykresami mówi to wprost, a test pilnuje, że payload i widok nie zawierają słów „saving/saved/baseline/estimate”.
- **Wykresy bez biblioteki:** geometria to czyste funkcje (`series.cjs`: dane → współrzędne, osie na „okrągłych” krokach), renderer to ~100 linii SVG (`charts.cjs`). Szerokość bierze się z prawdziwej szerokości kontenera (`ResizeObserver`), więc czcionki mają stały rozmiar w wąskim i szerokim pasku. Dni liczone w strefie czasowej widza. Zakres (10/30/wszystko) to ustawienie widoku — przerysowuje dane już wczytane, nie uruchamia komendy.
- **Wykresy** pokazują się tylko gdy mają sens: słupki per sesja (≥1 sesja), linia cache hit (≥2 punkty), per dzień (≥2 dni), straż pętli (tylko gdy kiedykolwiek zadziałała).

## Ryzyka
- API klienta (`sidebarRight*`, sloty) zmienia się między wydaniami rc; `dsh-context` deklaruje zgodność tylko z wybranymi. Klient ładuje się w `try/catch`, a błąd rejestracji nie może zepsuć hosta.
- `command/run` w logu sesji przy każdym odświeżeniu (patrz wyżej).
- Wygląd: tylko zmienne CSS i style wbudowane; brak własnego arkusza.

## Weryfikacja
Testy modelu/widoku i budowania w CI; **w przeglądarce** — skrypt `client/test/browser-check.mjs` (Chrome headless przez CDP, drugi serwer `dsh web`), wyniki w `spike-phase-b.md`. To, czego nie sprawdzono w przeglądarce, jest tam wprost wymienione.
