---
'@endo/exo-google-sheets': major
'@endo/google-sheets': minor
---

Add `@endo/exo-google-sheets`, with hardened reader, writer, append-only, and write-only facets built by `makeExoSpreadsheet(client)`.
Facets narrow by sheet or range and by operation; host-retained control can constrain policy and revoke write or all authority.
Add `batchUpdate` and `batchUpdateValues` to `@endo/google-sheets` for updating multiple ranges in one request.
