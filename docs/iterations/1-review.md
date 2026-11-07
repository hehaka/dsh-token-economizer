# T1 — przegląd wydzielenia helperów testu na żywo

Zakres: niezatwierdzona różnica `plugin/dsh/test/live/live-check.mjs` oraz nowy `plugin/dsh/test/live/common.mjs`; porównanie ze skryptem w HEAD i planem T1. Nie zmieniano plików implementacji ani nie ponawiano płatnego przebiegu modelu. Testy pomocnicze tworzyły wyłącznie osobne katalogi w katalogu systemowym `tmpdir()`.

## Findings

| severity | file:line | reason |
|---|---|---|

**Blocker 0, Major 0, Minor 0, Nit 0**

## Checked cases

| case | input | expected | actual | verdict |
|---|---|---|---|---|
| Import bez skutków ubocznych | `import('./plugin/dsh/test/live/common.mjs')`, pomiar mtime lub braku domyślnego katalogu pracy przed i po | Nie usuwa katalogu, nie wywołuje `process.exit`, nie wypisuje niczego | Mtime/nieistnienie bez zmian; import zakończony; brak wypisu z modułu | ok |
| Rozwiązanie ścieżek | `REPO`, `HERE` z importowanego modułu | Skrypt budujący w `REPO/scripts/`, stub w `HERE/` | Oba pliki istnieją we wskazanych lokalizacjach | ok |
| Format i licznik kontroli | `makeChecker(); check('sample', false, 'detail'); info('sample', true); summary('/tmp/test-work')` | `FAIL  sample  (detail)`, `INFO  sample: yes`, pusta linia i `0/1 passed. Work directory: /tmp/test-work`; liczba błędów 1 | Wynik i wszystkie linie dokładnie takie same | ok |
| Flagi CLI | `process.argv` zawiera `--profile private --dump-only`; brak `--missing` | Profil `private`, `dump-only` true, brakujący argument przywraca wartość domyślną | `private`, true, `fallback` | ok |
| Nieznana sesja | `requestTools('session-not-known-012345')` | `undefined` | `undefined` | ok |
| Katalog sesji `DSH_HOME` | `DSH_HOME` ustawiony na nieistniejący katalog; nieznany identyfikator | `sessionLogFile` zwraca `undefined`, `readSessionEvents` zwraca `[]` | `undefined`, `[]` | ok |
| Izolacja katalogu roboczego | `prepareWork('te-review-T1-<unikalny>')`, stan `tmpdir()/te-dsh-live` przed i po | Tworzy pakiet pod inną nazwą, bez dotykania domyślnego katalogu | `pkg/index.mjs` istnieje, `entry` jest URL `file:`, domyślny katalog bez zmiany mtime/nieistnienia | ok |
| Błąd budowy | `prepareWork('te-review-T1-fail-<unikalny>')` przy `PATH=/nonexistent` | Nie zwraca pozornie udanego pakietu: rzuca `build failed:` | Rzucił `Error` zaczynający się od `build failed:` | ok |
| Fałszywe repozytorium git | `fakeGitRepo(<odrębny work>/repo)` | `repo/.git/config` podaje remote `https://github.com/acme/widget.git` | Remote zgodny | ok |
| Nakładka patch | `overlay(work, entry, 'test', {bootstrap:'/tmp/safe-stub.py'})` | Zawiera wskazany entry i JSON-quoted bootstrap | Obie wartości w wygenerowanym patchu | ok |
| Zachowanie uruchamiania DSH | Porównanie kodu starego wywołania `spawnSync('dsh', …)` z `common.mjs:85-86` i wrapperem w `live-check.mjs:30` | Domyślny `cwd` pozostaje `<work>/repo`, timeout, kodowanie i scalanie env bez zmian | Parametry wywołania odpowiadają staremu wywołaniu; dodatkowy jawny parametr `cwd` służy następnym skryptom | ok |
| Wyjścia w `live-check` | Porównanie całej różnicy, w tym `--dump-only`/nieudany dump i końcowy `summary(work)` | Takie same teksty PASS/FAIL/INFO, ta sama liczba kontrolowanych warunków i kody wyjścia 0/1 | Funkcje wypisują identyczne linie; wczesne `process.exit` niezmienione; końcowe `process.exit(summary(work) ? 1 : 0)` równoważne wcześniejszemu | ok |
| Ładowanie profilu i sekrety | Porównanie starego fragmentu i `common.mjs:49-53` | `.env` z `DSH_HOME` lub `~/.dsh` i profilu, bez wypisywania wartości | Identyczna ścieżka, `process.loadEnvFile` i komunikat o braku pliku; wartości `.env` nie są drukowane | ok |
| Dostęp do logu sesji | Porównanie wcześniejszego `sessionsRoot`/`sessionTools` i `common.mjs:89-109` | Ten sam korzeń `DSH_HOME`/`~/.dsh`, pierwszy `request/header` i nazwy narzędzi | Ścieżka, wybór logu, dekodowanie i mapowanie narzędzi zgodne | ok |

Nie znaleziono regresji. Rozpoznanie statyczne potwierdza pozostałe powierzchnie, których testy izolowane nie uruchamiają: żadne operacje usuwania ani `process.exit` nie zachodzą podczas importu; `loadProfileEnv` i `prepareWork` wykonują je dopiero po jawnym wywołaniu. Test pełny z modelem i `npm test` były już raportowane jako zaliczone; nie powtarzano ich w tym przeglądzie.
