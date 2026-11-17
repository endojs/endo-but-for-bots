---
"@endo/lal": patch
---

Use provider-reported token occupancy to trigger automatic context compaction.
Do not treat serialized UTF-8 bytes, JSON escaping, or opaque reasoning data as
model tokens. Scale summary and retained-history byte budgets from the observed
token occupancy while preserving complete tool groups and recovery evidence.
