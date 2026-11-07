# 6 — implement (T7 docs, DoD D11)
changed:
- `docs/dsh/adr/0004-przycinanie-narzedzi-i-wywolania-pomocnicze.md`: status i link do planu drugiego przebiegu; „Proxy tool_call” (+ nieznana nazwa → `{ok:false}`); nowa sekcja „Sesje PTC” (`tool/ptc-dispatch` → toolCall+toolResult); „Trasa” (+ limity obserwowane na żywo); „Weryfikacja”: liczby testów (npm 161, pytest 591 `def test_`), cztery nowe wyniki na żywo (multisession models 24/24, resume 9/9, proxy 26/26, ptc 19/19), błąd 3 (PTC), listy „Limity obserwowane na żywo” i „Nie sprawdzone” przycięte (usunięte: dwie sesje na różnych modelach, proxy, PTC, wznowienie/zmiana modelu; „jeden prompt na przebieg” zastąpione „długie sesje interaktywne”).
- `plugin/dsh/README.md`: akapit „Stan” (drugi przebieg), „Niezweryfikowane (limity)” przycięte i uzupełnione o limity obserwowane, brak TUI w tej instalacji; „Dalsze skrypty na żywo” + `live-multisession.mjs`, `live-proxy.mjs`, `live-ptc.mjs` (składnia zgodna z `USAGE` każdego skryptu, w tym `--profile headless`).
- `docs/dsh/spike-phase-b.md` („Domknięcie weryfikacji”): akapit „Drugi przebieg” z 4 skryptami, błąd 3, „Liczby” (46 z 60; npm 161; pytest 591 `def test_`, wcześniejsze 1287 oznaczone jako inna miara; D1–D13 PASS przypisane do pierwszego przebiegu), listy limitów jak w ADR.
gates:
- `git diff --stat -- docs/dsh plugin/dsh`: 3 pliki (51 +, 26 −). Cały `git diff --stat` pokazuje też `docs/implementation-status.md`, `docs/iterations/log.md`, `docs/iterations/state.json` — zmienione wcześniej poza tym zadaniem.
- `/tmp/te-venv/bin/python -m pytest -q tests/test_plugin_package.py`: przeszło (26 kropek, bez błędów).
- Składnia 3 nowych skryptów porównana z ich stałymi `USAGE` (grep).
open:
- Bez commita. Nie ponowiono liczb (npm test, pytest, diff 46/60) — wzięte z dostarczonych dowodów.
- `docs/dod.md` i `docs/implementation-status.md` nie były w zakresie; D1–D13 PASS w spike dotyczy pierwszego przebiegu.
- Decyzja użytkownika: czy kryterium TUI odpada, czy instalować pakiet TUI ze społeczności (T5).
