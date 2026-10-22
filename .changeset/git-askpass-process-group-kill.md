---
'@endo/git': patch
---

Aborting, timing out, or overflowing a credentialed git operation (clone, fetch, push) now signals git's whole process group on POSIX.
Before, only `git` itself was signalled, and its `git-remote-https` transport helper kept the output pipes and the connection open, so an aborted https operation never settled.
