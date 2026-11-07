# T9 (docs, D11) — wykonane

changed:
- docs/dsh/adr/0004-przycinanie-narzedzi-i-wywolania-pomocnicze.md — status; sekcja „Weryfikacja” rozszerzona (wyniki 25/25, 20/20, 15/15, 34/34, 24/24, błędy znalezione na żywo, limity, odroczone). „Trasa” już opisana (per sesja, NO_ROUTE): bez duplikatu.
- plugin/dsh/README.md — „Stan”: zdanie „Niezweryfikowane…” zastąpione tym, co sprawdzone i czego nie; „Wymagania i zmienne”: cztery skrypty na żywo z poleceniami.
- docs/dsh/spike-phase-b.md — nowa sekcja „### Domknięcie weryfikacji (2026-11-07)” na końcu (po sekcji o przycinaniu): sprawdzone, błędy, liczby, limity, odroczone. Linii „Nie sprawdzone: … wiele sesji otwartych naraz” (panel) nie ruszono.
Bez twierdzeń o efekcie; liczby tylko z dowodów (153/154, 30 vs 183, 46/60, 152, 1287).

gates:
- git diff --stat (docs/dsh + plugin/dsh): 3 pliki (61+, 4−). W drzewie są też zmiany spoza tego zadania (docs/implementation-status.md, docs/iterations/state.json) — nie moje.
- /tmp/te-venv/bin/python -m pytest -q tests/test_plugin_package.py: 26 passed.
- Bez commita.

open:
- Liczby testów (152/1287, 46/60) przepisane z dostarczonych dowodów, nie uruchomione ponownie.
- Odroczone z przeglądu wymienione w dokumentach, bez zmian w kodzie.
