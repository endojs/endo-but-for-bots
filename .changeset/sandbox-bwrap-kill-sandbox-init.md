---
'@endo/sandbox': patch
---

Keep bwrap sandbox processes in an owned process group and add a parent-death
supervisor, so cancellation or an unexpected daemon exit cannot strand a
sandbox while it is still starting.
