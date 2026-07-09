---
'@endo/http-confine': patch
---

Return an inert snapshot of the confined HTTP response instead of the live
platform `Response`. `makeHttpConfinement`'s `request()` previously handed back
the live `fetch` `Response` (and its `Headers`) inside the hardened
`ConfinedResponse`. On Node 22, `harden()` freezes the live undici `Headers`
before its lazy `Symbol(headers map sorted)` slot is materialised, so the next
read throws `Cannot assign to read only property 'Symbol(headers map sorted)'` —
which surfaced downstream as a CapTP error-decode failure in the consuming
client (endojs/endo-but-for-bots#286). The response is now snapshotted to a
plain `{ status, statusText, ok, url, headers }` record, with headers copied via
`defineProperty` so prototype-adjacent names (`__proto__`, `constructor`) remain
own data properties. Node 24 undici did not trip the frozen-slot assignment, so
this also brings Node 22 to parity with Node 24.
