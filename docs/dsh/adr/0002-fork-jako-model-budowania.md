# ADR 0002 — Fork `microsoft/TokenEconomizer` jako model budowania pluginu DSH

Status: **zaakceptowana** (decyzja użytkownika 2026-11-06) · Zastępuje w [ADR 0001](0001-integracja-z-tokeneconomizer.md): §1 warstwa 2–3, §3 (wybór opcji), §4 (cały), układ repo w §5. Reszta 0001 (mapowanie zdarzeń DSH, spool w formacie Pi, `ctx.llm`, ryzyka) obowiązuje dalej.

## Decyzja

Budujemy plugin DSH **wewnątrz forka** [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer), nazwanego `dsh-token-economizer`. Zamiast overlayu Pythona i instalacji rdzenia przez `pip` host `dsh` dopisujemy bezpośrednio do pakietu `tokeneconomizer` w forku, a rdzeń leży obok pluginu w tym samym checkoucie.

## Dlaczego zmiana względem ADR 0001

- Rdzeń rozgałęzia się po nazwie hosta w wielu miejscach: `controller.py`, `denylist.py` (m.in. `unit(host)`), `fold.py`, `toolcheck.py`, `adapter.py`, `cli.py` (listy agentów, `doctor`), `sidecall.py` (`runner_for`). Overlay z zewnątrz sięgnąłby tylko `HOSTS` i `runner_for`; resztę musielibyśmy łatać monkey-patchem albo i tak forkować.
- Fork jest naturalnym nośnikiem PR-a z hostem `dsh` do upstreamu (zewnętrzne PR-y są tam przyjmowane, np. #140 zmergowany 2026-11-05).
- Jedno repo: wspólne testy (`tests/test_plugin_package.py` pilnuje granic pakietu) i bundle budowany tym samym wzorcem co `scripts/build_plugin.py` upstreamu.
- „Referencja zamiast kopii” jest spełniona: aktualizacja upstreamu to `git merge upstream/main`, a nie ręczne przenoszenie kodu.

## Zasady (obowiązują w forku)

1. **Reguła addytywności.** Kod DSH trafia do nowych plików: `plugin/dsh/**` (plugin Node, `package.json`, `cordis.patch.yml`), `tests/test_dsh_*.py`, `scripts/build_dsh_plugin.py`, `docs/dsh/**`. W plikach upstreamu wolno dopisać wyłącznie to, co konieczne do zarejestrowania hosta `dsh` (klasa hosta, wpisy w `HOSTS`, `runner_for`, `denylist`, listy w `cli`). **Budżet:** CI liczy `git diff upstream/main --stat` dla ścieżek upstreamu i czerwienieje powyżej ustalonego progu (start: 60 linii; zmiana progu wymaga uzasadnienia w PR).
2. **Gałęzie.**
   - `main` — lustro `microsoft/TokenEconomizer:main`, tylko fast-forward, bez własnych commitów.
   - `dsh` — gałąź domyślna i dystrybucyjna: `main` + dodatki DSH; do niej wchodzi merge z `main` (bez rebase i force-push, żeby nie psuć użytkownikom).
   - `upstream/dsh-host*` — krótkie gałęzie wycinane z `main` pod PR-y do upstreamu (cherry-pick z `dsh`).
3. **Synchronizacja.** Workflow cotygodniowy (i na żądanie): `git fetch upstream`, aktualizacja `main`, merge do `dsh`, testy upstreamu + `tests/test_dsh_*.py`. Przy konflikcie lub czerwonych testach otwiera PR do ręcznego rozwiązania, nie merguje na ślepo.
4. **Kontakt z upstreamem przed dużym kodem.** Najpierw issue z propozycją hosta DSH (nowe hosty wchodzą tam jako „experimental” z tabelą wspieranych wersji; zweryfikowana wersja DSH: `0.2.1-rc.5`). Gdy upstream przyjmie host, `dsh` w forku kurczy się do `plugin/dsh/**` i kod można czerpać wprost z upstreamu.
5. **Licencja.** Apache-2.0: zachowujemy `LICENSE`, dodajemy `NOTICE` (kto i co zmienił), oznaczamy zmienione pliki upstreamu. Nazwa `dsh-token-economizer` nie sugeruje autorstwa Microsoftu.
6. **Konwencje upstreamu zostają** (`CLAUDE.md`): rdzeń tylko stdlib, hook startuje szybko i działa fail-open, nazwy plików stanu (`injection.json`, `untool.json`, `envelope.json`) to powierzchnia kompatybilności, a tekst pluginu nie obiecuje oszczędności.

## Skutki dla ADR 0001

| Element 0001 | Teraz |
|---|---|
| Overlay `te_dsh` | **Znika.** Host `Dsh(Pi)` jest w `tokeneconomizer/plugin/hosts.py` forka (kilkadziesiąt linii) |
| `pip install git+…@SHA` do venv, `upstream.lock.json`, `/te update` z rollbackiem | **Znikają.** Pinem jest historia gita; plugin używa rdzenia z `lib/` bundla lub z checkoutu (`te_bootstrap.py`: `lib` → katalog nadrzędny) |
| `pip` i `git` na maszynie użytkownika | **Niepotrzebne.** Zostaje Python ≥ 3.10 |
| `/te update` | Zastąpione aktualizacją pakietu pluginu (nowy tag/gałąź `dsh` po merge'u z upstreamu) |
| Test kontraktowy względem upstreamu | Zastąpiony pełnym zestawem testów forka na każdym merge'u z `upstream/main` |
| Spool w formacie Pi, `ctx.llm`, mapowanie zdarzeń | **Bez zmian** |

Nowy koszt: użytkownik dostaje zmiany upstreamu z opóźnieniem równym tempu naszych merge'y (stąd automatyzacja z zasady 3). Upstream jest świeży i aktywny, więc konflikty w `hosts.py`/`sidecall.py` są prawdopodobne; ogranicza je reguła addytywności.

## Otwarte (do spike'u)

- Instalacja w DSH: w katalogu głównym upstreamu jest `package.json` pakietu Pi, więc manifest DSH trafia do `plugin/dsh/`. Czy `dsh plugin add` (pnpm) obsługuje podkatalog repo, czy potrzebna jest gałąź `dist` budowana przez CI — niezweryfikowane.
- Czy nieznane hosty bezpiecznie przechodzą przez rozgałęzienia po nazwie hosta — w forku to zbędne, ale warto to opisać w issue do upstreamu.
- Nadal otwarte z 0001: kontekst z `tools/post-execute`, kanał `ctx.llm`, ceny modeli DSH.

## Operacje na GitHubie (do wykonania po zatwierdzeniu — niczego nie wykonano)

1. Obecne `hehaka/dsh-token-economizer` ma jeden pusty commit startowy (`AGENTS.md`, `.gitignore`, `README.md`). Fork pod tą samą nazwą jest niemożliwy, dopóki ono istnieje: zmienić nazwę (np. `dsh-token-economizer-old`) albo usunąć.
2. Utworzyć fork `microsoft/TokenEconomizer` pod nazwą `dsh-token-economizer` (zachowuje sieć forków i „Sync fork”).
3. Lokalnie w tym katalogu: skierować `origin` na fork, dodać `upstream`, utworzyć gałąź `dsh` jako domyślną, przenieść `docs/adr/` do `docs/dsh/adr/`, `AGENTS.md` zachować.
4. Dodać workflow synchronizacji i sprawdzian budżetu zmian.
5. Otworzyć issue w upstreamie z propozycją hosta DSH.

## Plan faz (zastępuje §7 z 0001)

| Faza | Zakres | Kryterium ukończenia |
|---|---|---|
| A Repo | Operacje GitHub 1–5, `main` = lustro, `dsh` domyślna, workflow sync | `git diff upstream/main --stat` = tylko nowe pliki; sync-workflow przechodzi na pustym diffie |
| B Spike | Odpowiedzi na otwarte (kontekst z `post-execute`, `ctx.llm`, ceny, instalacja podkatalogu); zapis sesji w formacie Pi i odczyt przez `pi_session_to_claude` | notatka z wynikami + działający test odczytu zapisanej sesji |
| C Host i fakty | `Dsh(Pi)`, spool, `SessionStart`/micro-skills, `/te status` | `te --host dsh status` w repo pokazuje stan; testy forka zielone |
| D Uczenie | fold po sesji, usage, `envfacts` bez modeli | fakt potwierdzony 3 sesjami pojawia się w kontekście 4. sesji |
| E Guard | loop guard + wywołania pomocnicze przez `ctx.llm` | powtarzający się błąd daje 1 przekierowanie; brak przy sesji bez pętli |
| F Pruning | `ctx.tools.restrict`, `restore` | nieużywane narzędzie znika od następnej sesji; `restore` je przywraca |
| G Upstream | PR z hostem `dsh` | PR otwarty, uwagi upstreamu obsłużone |

## Aktualizacja po fazie B (2026-11-06)

Wyniki: [spike-phase-b.md](../spike-phase-b.md).

- **Dystrybucja przez gałąź `dist`, nie przez podkatalog.** `pnpm add …#path:/plugin/dsh` działa, ale instaluje tylko ten podkatalog, więc rdzeń Pythona z korzenia repo nie trafiłby do instalacji. Korekta zdania „rdzeń obok pluginu w tym samym checkoucie” powyżej: obok pluginu jest on w repo, a w instalacji — dopiero po zbudowaniu. `scripts/build_dsh_plugin.py` (nowy plik) kopiuje `plugin/dsh/` i `tokeneconomizer/` do bundla (wzorzec `scripts/build_plugin.py` upstreamu), a CI publikuje wynik na gałąź `dist`, z której instaluje się plugin DSH. Reguła addytywności i budżet bez zmian: nie edytujemy głównego `package.json` upstreamu.
- **Format Pi potwierdzony** na prawdziwej sesji; z ADR 0001 §5 obowiązuje bez zmian (z zastrzeżeniem o pomijaniu wstrzykniętego kontekstu).
- **Do `adapter.py` dochodzi zbiór narzędzi chronionych dla `dsh`** (patrz notatka ze spike'u); mieści się w budżecie.

## Aktualizacja: komenda `/te` i część wizualna (2026-11-06)

- **`/te`** jest cienką nakładką na CLI rdzenia (`status --json` itd.), więc zakres i teksty komend należą do upstreamu. Wynik live: zob. [spike-phase-b.md](../spike-phase-b.md).
- **Część wizualna (faza G, decyzja: później).** DSH pozwala pluginowi mieć połówkę kliencką: `dsh.client` w `package.json` (`platform: "web"`, lista wstrzykiwanych usług klienta) i eksport `./client` z paczką przeglądarkową; wzorcem jest `dsh-context` (host `lib/index.js` + klient React `lib/client.js`, panel w prawym pasku, strona w lewym, `/context`, karta ustawień). Warunki: krok budowania (React/TS; plugin jest dziś czystym ESM), wszystko w nowym katalogu `plugin/dsh/client/` i w CI budującym gałąź `dist` (bez edycji plików upstreamu), zgodność z konkretnymi wydaniami rc DSH, UI tylko w web/desktop (w TUI i headless zostaje tekst z `/te`). Kontraktem danych dla UI będzie `te status --json`. Do sprawdzenia w spike'u: kanał host→klient (prawdopodobnie `dsh-api-remotes`; nie czytany) oraz sam krok budowania.

