---
'@endo/lal': minor
---

Add `glob` and `grep` tools to Lal for search-capable filesystem capabilities.
The tools delegate directly to the confined `EndoMount` search surface, with
optional fused glob-restricted grep and result caps.
