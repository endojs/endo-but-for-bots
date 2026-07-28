# @endo/exo-google-sheets

`makeExoSpreadsheet(client)` wraps an `@endo/google-sheets` client in hardened, passable spreadsheet facets.

The default `spreadsheet` facet reads only.
The separately minted `writer` facet can delegate read-only, append-only, and write-only facets, each of which can narrow to one tab or A1 range.
The host retains `control` to constrain scopes, adjust limits and polling, or revoke all facets.

`follow(range)` is a polling async iterator.
Push/webhook delivery, `SheetsService`, and `SpreadsheetStructure` are deliberately deferred.
