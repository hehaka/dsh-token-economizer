# Przegląd: kontrole na żywo, drugi przebieg (zakres 0bce3df..HEAD)

Jedna zmiana produkcyjna tego przebiegu: `plugin/dsh/src/spool.mjs` (spool zapisuje narzędzia wywołane z `run_code` w trybie PTC).
Przegląd niezależny (model sol, tylko odczyt, 18 przypadków): `docs/iterations/5-review.md`.
Pozostałe zmiany to skrypty i testy na żywo (`plugin/dsh/test/live/`, `spool-ptc.test.mjs`), bez zmian w kodzie produkcyjnym.
Mapowanie ważności: Blocker = critical, Major = high. Dyspozycje: fixed | rejected | deferred.

| severity | finding | disposition | evidence |
|---|---|---|---|
| high | Defekt znaleziony na żywo (`live-ptc.mjs`): w sesjach PTC spool miał tylko `run_code`, rdzeń zapisał deny-listę z używanym narzędziem MCP i druga sesja nie mogła go wywołać | fixed | `spool.mjs` zapisuje `tool/ptc-dispatch` jako toolCall + toolResult; 8 testów w `spool-ptc.test.mjs` (7 czerwonych przed poprawką, mutacje sprawdzone), `live-ptc.mjs` 19/19 (przed poprawką 10/18) |
| medium | R1 Reviewer: PTC w subagencie nie trafia do spoola sesji głównej, więc narzędzie użyte tylko tam wygląda na nieużyte | rejected | Decyzja projektowa ADR 0004: spool i fold dotyczą tylko sesji głównej, a subagent NIE jest ograniczany deny-listą (live-sessions: 183 narzędzia subagenta wobec 182 głównej). Przycięcie dotyczy wyłącznie sesji głównej, więc subagent dalej wywoła swoje narzędzie. To samo dotyczy zwykłych wywołań subagenta, nie tylko PTC; reviewer nazwał to Blockerem, ale nie łamie to opisu zmiany (root-PTC). Zapisane w ograniczeniach dokumentacji |
| low | R2 Wznowienie nie odtwarza stanu deduplikacji ani bazy zastępczych id dla dispatchu bez `subCallId` | deferred | Powtórka tego samego subCallId po restarcie procesu dopisuje duplikat; DSH nadaje subCallId zawsze (`<call>:ptc:N`), więc dotyczy tylko ponownego dostarczenia zdarzenia. Duplikat nie psuje liczenia użycia |
| low | R3 Cykliczne `arguments` rzucają z `Spool.record` i zatruwają dedup id | rejected | Zdarzenia DSH są serializowane do JSON, więc cykl nie jest osiągalny; handler pluginu łapie wyjątek (fail-open) |
| low | R4 Limit wyniku jest per wynik, nie per sesja (200 wyników po 20 kB = 4 MB) | deferred | Rozmiar spoola to koszt dyskowy, nie poprawność; pętle PTC z setkami dużych wyników są rzadkie; do rozważenia przy realnym użyciu |
| low | Test 7 w `spool-ptc.test.mjs` miał błędne oczekiwanie (`[false,false,false]`) | fixed | `claude_calls` zwraca `success` (nie `is_error`): poprawione na `[true,true,true]`, decyzja zapisana w `docs/iterations/decisions.md` |

Ocena końcowa: 1 high znaleziony na żywo i naprawiony z testami czerwonymi przed poprawką; brak otwartych critical/high.
