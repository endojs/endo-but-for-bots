---
'@endo/exo-dynamodb': minor
---

Add recursively attenuated DynamoDB object capabilities. A host control derives
named or unnamed grants over one table; each capability can derive narrower
children whose key space, per-index key ranges, item shape and guard,
operations, and limits only shrink. Requests check every ancestor before one
AWS call, index results are rechecked against the base key space, and every
method resolves a tagged result. Named grants persist recipes and withdrawal
tombstones through a grant store so a restarted broker rebinds only live grants.
