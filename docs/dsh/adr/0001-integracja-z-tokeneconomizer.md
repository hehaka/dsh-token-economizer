# ADR 0001 — Plugin DSH dla TokenEconomizer: architektura i sposób integracji z upstreamem

Status: **częściowo zastąpiona przez [ADR 0002](0002-fork-jako-model-budowania.md)** (fork zamiast overlayu i `pip`; elementy tu opisane, które 0002 nie uchyla, obowiązują). Wcześniej: **zaakceptowana w części** (decyzje 2026-11-06: rdzeń przez `pip` do venv pluginu; overlay + równoległy PR do upstreamu; dalej bez kodu — zatrzymano po ADR) · Data: 2026-11-06 · Upstream: [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer) @ `a71684c` (Apache-2.0)

## 1. Rekomendacja w skrócie

Trzy warstwy, z których tylko pierwsze dwie są kodem tego repo, a trzecia jest **referencją, nie kopią**:

1. **Natywny plugin DSH** (Node ESM, zero zależności) — cienki tłumacz zdarzeń DSH → protokół hooków TokenEconomizer (TE). Wzorzec: `plugin/hermes/__init__.py` w upstreamie oraz lokalny `dsh-agentmemory-hooks`.
2. **Mały overlay Pythona `te_dsh`** (~kilkaset linii) — rejestruje w uruchomieniu hosta `dsh` i runner wywołań pomocniczych w pakiecie `tokeneconomizer`, **bez modyfikowania jego plików**.
3. **Rdzeń TE (pakiet `tokeneconomizer`) instalowany przez `pip` z gita do venv pluginu**, przypięty po SHA w `upstream.lock.json` i aktualizowany komendą `/te update`. Żaden plik rdzenia nie trafia do tego repo.

Równolegle: zgłosić upstreamowi PR z hostem `dsh` (`hosts.py`, `sidecall.py`, `plugin/dsh/`). Gdy zostanie przyjęty, overlay (warstwa 2) kurczy się do zera.

## 2. Co ustaliłem

**Upstream.** Pakiet `tokeneconomizer` jest *stdlib-only*, Python ≥ 3.10. Trzy mechanizmy: micro-skills (fakty o repo wstrzykiwane na starcie), tool pruning (deny-lista nieużywanych narzędzi) i loop guard (przekierowanie utkniętej tury). Mechanizmy są niezależne od agenta; tylko `trace/` zna format logów, a `plugin/hosts.py` mapuje hooki hosta na wspólny kontrakt (JSON stdin → JSON stdout). Stan siedzi w `~/.tokeneconomizer`, **osobno per agent i repozytorium**. Upstream nazywa nazwy plików stanu (`injection.json`, `untool.json`, `envelope.json`) „powierzchnią kompatybilności”.

**Host bez czytelnego transkryptu ma już precedens**: `Cursor` w `hosts.py` zapisuje potrzebne zdarzenia do prywatnego spoolu i odtwarza z niego ślad w formacie Claude (`prepare`, `record_event`, `mechanism_trace`). Tak samo Pi i Hermes (ślad zapisany jako transkrypt Claude).

**Pi a DSH.** DSH dołącza tylko warstwę modeli Pi (`@earendil-works/pi-ai`, `pi-schema`, `pi-telemetry`, adapter `dsh-llm-pi-ai`), **nie** agenta `pi-coding-agent`. Rozszerzenie Pi z upstreamu (`plugin/pi/tokeneconomizer.ts`, 237 linii) nie uruchomi się więc w DSH bez zmian: zależy od szyny zdarzeń Pi (`pi.on("session_start" …)`) i od plików sesji Pi. Pomaga za to na trzy sposoby (patrz §5): jako gotowy szablon tłumacza, jako **format spoolu** (czytniki Pi w upstreamie dają koszt „za darmo”) oraz przez `ctx.llm` do wywołań pomocniczych.

**DSH.** Zweryfikowane w `@deepseek-ai/dsh@0.2.1-rc.5`:

| Potrzeba TE | Co daje DSH | Źródło |
|---|---|---|
| start sesji | `session/created` | działający `dsh-agentmemory-hooks` |
| wstrzyknięcie faktów | `system-prompt/assemble` → `contexts` (dopisywane na końcu, nie psuje cache prefiksu) | j.w. + README `dsh-system-prompt` |
| prompt użytkownika | `session/event` (`user/message`, `source.kind=user`) | j.w. |
| wynik narzędzia (guard) | `tools/post-execute` (`isError`, treść, możliwość dołączenia kontekstu) | README `dsh-tools` |
| koniec tury / sesji | `agent/turn-stopping`, `session/disposed` | `dsh-agentmemory-hooks` |
| tool pruning | `ctx.tools.restrict(filter)` (maska deny, znika ze schematu) | README `dsh-tools` |
| komendy `/te …` | `ctx.commands.register()` | README `dsh-commands` |
| koszt z cache | `assistant/message.data.usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) | log sesji v4 |
| katalog narzędzi | `request/header.tools` w logu (bez rytuału `refresh-catalog`) | log sesji v4 |

**Most hooków Claude Code w DSH (`dsh-hooks-claude-code`) nie wystarcza.** Brak `SessionEnd`; `transcript_path` jest zawsze pusty (log DSH to `session.v4.jsonl.zstd`, nieczytelny dla skryptów); `SessionStart` działa detached i może nie zdążyć przed pierwszym requestem; nazwy narzędzi i kształt `tool_response` różnią się od Claude. Bez składania zakończonych sesji nic się nie uczy — zostałby sam loop guard.

## 3. Rozważone opcje

| Opcja | Referencja do upstreamu | Pełny zakres | Ocena |
|---|---|---|---|
| A. Sam most hooków Claude + `hooks.json` upstreamu | tak | **nie** (brak fold, SessionEnd, kosztów) | odrzucona jako rozwiązanie; użyteczna tylko jako szybki test |
| B. Kopia / fork kodu TE w tym repo | **nie** | tak | odrzucona — wprost sprzeczna z wymaganiem |
| C. Git submodule | tak | tak | odrzucona: instalacja pluginów w profilu DSH idzie przez `codeload` tarball (patrz `profiles/web/package.json`), a archiwa GitHub **nie zawierają** submodułów |
| D0. Uruchomić rozszerzenie Pi 1:1 przez shim szyny Pi w DSH | tak | tak | odrzucona: sprzęga nas z wnętrzem Pi (szyna zdarzeń + format plików sesji Pi), nie tylko z formatem; szablon i format wykorzystujemy selektywnie w D |
| D. **Natywny plugin + overlay + rdzeń z `pip` w venv** | **tak** | tak | **wybrana** |
| E. rdzeń przez `pip install git+…@SHA` do venv pluginu | tak | tak | **wybrany wariant D** (decyzja użytkownika); zweryfikowane: pakiet instaluje się czysto, `HOSTS` i `trace.cursor_events_to_claude` są dostępne |
| E′. zarządzany klon git + `PYTHONPATH` | tak | tak | alternatywa; zgodna z modelem aktualizacji samego upstreamu (`git pull`), ale bez izolacji zależności |
| F. PR do upstreamu | tak | tak | uzupełnienie D, nie zamiennik (nie mamy kontroli nad terminem) |

## 4. Integracja referencyjna — jak to ma działać

**Rozwiązywanie rdzenia.** Plugin tworzy venv w `~/.dsh/plugin-data/dsh-token-economizer/venv` i instaluje:
`pip install "git+https://github.com/microsoft/TokenEconomizer.git@<commit z locka>"`.
Hooki uruchamiają `<venv>/bin/python -m te_dsh hook`; overlay `te_dsh` jest zainstalowany w tym samym venv (z tego repo, `pip install -e` lub kopia wersjonowana razem z pluginem). Kolejność awaryjna: `TE_CORE_PATH` (checkout deweloperski) → venv pluginu. Brak rdzenia lub zbyt stary Python ⇒ hook odpowiada `{}` i raz zapisuje powód (fail-open, jak upstream).

**Pin i aktualizacje.** Wersja pakietu w upstreamie jest stała (`0.1.0`), więc tożsamością rewizji jest **SHA** (pip zapisuje go w `direct_url.json`, odczyt przez `importlib.metadata`). `upstream.lock.json` w tym repo:
```json
{ "repo": "https://github.com/microsoft/TokenEconomizer.git",
  "ref": "main", "commit": "a71684c…", "verified": "<data>",
  "contract": ["hosts.HOSTS", "sidecall.runner_for", "hook.run", "trace.cursor_events_to_claude"] }
```
- `/te update` = tworzy *nowe* venv z docelowym SHA → test kontraktowy overlayu → dopiero wtedy podmienia aktywne venv; przy porażce zostaje stare (rollback = poprzednie venv).
- `/te status` pokazuje SHA upstreamu i datę weryfikacji.
- Nocny CI: overlay + testy kontraktowe względem `upstream/main`; czerwony wynik = upstream zmienił powierzchnię, na której stoimy.
- Wymaga na maszynie: `python ≥ 3.10`, `pip`, `git` (sprawdza `/te doctor`).

**Zakres sprzężenia z wnętrzem upstreamu (świadomie mały i pilnowany testem):** rejestracja `hosts.HOSTS["dsh"]`, owinięcie `sidecall.runner_for`, wywołanie `hook.run`. Wszystko inne (mechanizmy, stan, CLI `te`, rozliczenia) to kod upstreamu bez zmian.

## 5. Architektura pluginu

```
dsh-token-economizer/
  package.json            # dsh.bundle.patch + engines.dsh
  cordis.patch.yml
  src/index.mjs           # apply(ctx): podpięcie zdarzeń DSH
  src/spool.mjs           # zdarzenia → prywatny spool (wzorzec Cursor)
  src/bridge.mjs          # spawn: python -m te_dsh hook (JSON in/out, timeout, fail-open)
  src/commands.mjs        # /te status|update|config|toolprune|microskills
  python/te_dsh/          # overlay: Host `dsh`, runner side-calli, resolver rdzenia
  upstream.lock.json
  tests/ docs/adr/
```

Odwzorowanie mechanizmów:

- **Micro-skills** — `system-prompt/assemble` dopisuje blok faktów (tylko sesja główna, nie subagenci; rozpoznanie po `header.parentSession` / `origin`).
- **Loop guard** — `tools/post-execute` buduje payload (nazwy narzędzi normalizowane jak `Cursor.tool_call`) i woła dyspozytor; przekierowanie wraca jako dołączony kontekst. Zatrzymanie tury zostaje decyzją człowieka (zasada upstreamu).
- **Tool pruning** — rdzeń liczy dowody i *proponuje*; plugin **stosuje** przez `ctx.tools.restrict` tylko przy starcie sesji (nigdy w trakcie — zachowuje cache), respektując `toolprune restore` i tryby `propose`/`auto`.
- **Uczenie** — `session/disposed` (oraz „cichy” timeout po `turn-stopping`, jak w agentmemory-hooks) → `SessionEnd` → fold ze spoolu. Spool **omija zstd**: Python nie musi czytać logu DSH.
- **Format spoolu = sesja w formacie Pi** (zmiana względem pierwszej wersji, które wskazywała wzorzec Cursor). Plugin Node zapisuje liniowy plik JSONL: nagłówek `{type:"session", id, cwd}` i wpisy `{type:"message", id, parentId, message:{role, content, model, usage:{input, output, cacheRead, cacheWrite}}}`, z `toolCall` (argumenty jako obiekt — w DSH są stringiem JSON, więc parsujemy) i `toolResult` (`isError`). Upstreamowe `trace.pi_session_to_claude`, `pi_prompt_count` i `pi_session_usage` czytają to **bez zmian**, więc nie piszemy czytnika logu, a koszt z cache działa od razu (Cursor tego nie ma: „usage unavailable”). Pola DSH i pi-ai się pokrywają (`inputTokens` bez cache, `cacheReadTokens`, `cacheWriteTokens`; w próbce `total = in + out + cacheRead + cacheWrite`). Host `Dsh` w overlayu to podklasa `hosts.Pi` (zmienia `name` i tryb headless) — kilkadziesiąt linii. Cena: kontrakt na pi-ai `cost.total`, a gdy DSH go nie poda — `pricing.py` (do sprawdzenia w fazie 0).
- **Tłumacz Node** — szablonem jest `plugin/pi/tokeneconomizer.ts`: te same pięć zdarzeń (start sesji, prompt, wynik narzędzia, koniec tury, koniec sesji), konwencje payloadu (`prompt_id` numerowany po stronie pluginu, `tool_response = {content, isError, exit_code}`) i fail-open. Kod piszemy w tym repo; upstream służy jako specyfikacja zachowania i fixtures testów.
- **Koszt** — usage ze spoolu (`cacheRead/cacheWrite`) → księga TE. Ryzyko: modele DSH (`claude-sonnet-5-5`, `gpt-6-*`) mogą nie mieć cen w `pricing.py`.
- **Wywołania pomocnicze modelu** (proponer faktów, sędzia pętli) — preferowane: plugin Node wystawia lokalny kanał (gniazdo unixowe) i obsługuje je przez `ctx.llm.prepareCall()` / `ctx.llm.stream()` (pojedyncza próba, bez historii sesji, jak `session-title-llm`); runner w overlayu `te_dsh` woła ten kanał. Ten sam dostawca i konto, bez startu profilu i bez klucza API. Zapas: `dsh headless` z minimalnym profilem + `TE_SIDECALL=1`. Do potwierdzenia w fazie 0.

## 6. Ryzyka i pytania otwarte

1. **Stabilność wnętrz upstreamu** (rejestr hostów, `runner_for`) — mitygacja: test kontraktowy, nocny CI, PR upstream.
2. **Kompatybilność formatu Pi** — upstream wspiera Pi 1.2.0–1.3.0 i może zmienić format sesji; mitygacja: fixtures z upstreamu w teście kontraktowym oraz nocny CI.
3. **Kształt `tools/post-execute`** — czy można dołączyć kontekst w sposób widoczny dla modelu; do potwierdzenia spike’iem (README mówi „attach ordered contexts”).
4. **Kanał `ctx.llm` dla wywołań pomocniczych** — czy dostępny z pluginu i z jakimi limitami; zapas: `dsh headless`.
5. **Python ≥ 3.10, pip i git na maszynie użytkownika** — wymóg tej opcji; `/te doctor` ma to sprawdzać. Pierwsza instalacja wymaga sieci.
6. **Licencja** — Apache-2.0: samo referowanie nie wymaga niczego; jeśli kiedykolwiek wkleimy kod, trzeba zachować NOTICE/atrybucję.
7. **Pomiar efektu** — liczby z README upstreamu dotyczą Claude Code/Codex/Copilot, nie DSH; własny wynik trzeba zmierzyć, a plugin nie powinien obiecywać oszczędności (tak samo jak upstream).

## 7. Plan faz (z kryteriami zakończenia)

| Faza | Zakres | Kryterium ukończenia (sprawdzalne) |
|---|---|---|
| 0 Spike | Odpowiedzi na pytania 3, 4 i ceny modeli; zapis sesji w formacie Pi i odczyt przez `pi_session_to_claude`; ręczne wywołanie dyspozytora z payloadem DSH | notatka z wynikami + działający `te_dsh hook` na zapisanym zdarzeniu |
| 1 Rdzeń | resolver + `upstream.lock.json`, overlay hosta, spool, `SessionStart`/fakty, `/te status` | `te --host dsh status` w repo pokazuje stan; test kontraktowy zielony |
| 2 Uczenie | fold po sesji, usage, microskills `envfacts` bez modeli | fakt potwierdzony 3 sesjami pojawia się w kontekście 4. sesji (test na nagranych sesjach) |
| 3 Guard | loop guard + side-calle | scenariusz z powtarzającym się błędem daje 1 przekierowanie, brak przy sesji bez pętli |
| 4 Pruning | `ctx.tools.restrict`, `restore` | narzędzie nieużywane przez *p*/*m*/*s* znika od następnej sesji; `restore` je przywraca |
| 5 Upstream | PR z hostem `dsh`; `/te update`; nocny CI | PR otwarty; `/te update` z rollbackiem sprawdzony na zepsutym commicie |

## 8. Poza zakresem

Kopiowanie kodu TE; własna reimplementacja mechanizmów; zmiana modelu lub wag; zatrzymywanie tur przez plugin; eksperymenty z `experiments/` upstreamu.
