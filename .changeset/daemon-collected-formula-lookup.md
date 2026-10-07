---
'@endo/daemon': patch
---

Looking up a formula that the daemon has already collected now fails with "unknown or has been collected" instead of reviving it from its persisted record.
A caller that looked up an identifier the daemon no longer holds now sees that rejection, and the error does not reveal the identifier.
