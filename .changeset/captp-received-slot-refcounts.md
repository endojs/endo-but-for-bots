---
'@endo/captp': patch
---

Count only payload reference transfers, rather than received question and target
headers. This releases stale bookkeeping and prevents drops from discarding a
capability whose next reference is still in flight.
