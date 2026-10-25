---
'@endo/git': patch
---

Git clone, fetch, and push operations now settle when aborted, timed out, or output-limited, including when a transport helper ignores the initial termination signal.
