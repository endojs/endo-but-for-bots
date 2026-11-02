---
'@endo/git': patch
---

- Fixed: an aborted, timed-out, or output-limited git clone, fetch, or push no longer hangs when a transport helper ignores `SIGTERM`; the operation now ends with an error.
- Behavior change: on POSIX, termination now signals the whole process group, so helpers that git started end with it.
