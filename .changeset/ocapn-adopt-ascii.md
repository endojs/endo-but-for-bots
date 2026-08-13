---
'@endo/ocapn': patch
---

Reject non-ASCII string-form swissnums instead of encoding them as UTF-8, while
preserving the existing byte identity of ASCII swissnums.
