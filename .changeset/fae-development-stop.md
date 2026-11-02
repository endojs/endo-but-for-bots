---
"@endo/floot": patch
---

Enable the existing stop/resume control for Fae development sessions, including
work started from the inbox. Fence new work, abort inference, and await the exact
environment admin before publishing stopped. Failed native cleanup keeps the
session fenced for retry; stopped sessions remain stopped after reconstruction.
