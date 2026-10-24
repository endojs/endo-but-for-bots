---
'@endo/sandbox': patch
---

Fix bwrap sandbox processes surviving a cancellation that lands while the
sandbox is still starting, and let teardown of a bwrap launcher that never
finishes starting complete within its normal grace.
