# @endo/exo-google-sheets

`makeExoSpreadsheet(client)` wraps an `@endo/google-sheets` client in hardened, passable spreadsheet facets.

The default `spreadsheet` facet reads only.
The separately minted `writer` facet can delegate read-only, append-only, and write-only facets. Readers and overwrite-only writers can narrow to one tab or A1 range; appenders narrow only to a tab because Google chooses their destination row.
The host retains `control` to constrain scopes, adjust limits and polling, sever write authority (`revokeWrites()`), or revoke every facet (`revoke()`).
Read and mutation payload limits are independently adjustable with
`setMaxCellsPerRead()` and `setMaxCellsPerWrite()`.

Interface guards: `SpreadsheetInterface`, `SpreadsheetWriterInterface`,
`SpreadsheetAppenderInterface`, `SpreadsheetWriteOnlyInterface`, and
`SpreadsheetControlInterface`.

`follow(range)` returns an `@endo/exo-stream` passable reader that can cross CapTP; import `iterateReader` from `@endo/exo-stream/iterate-reader.js` on the consumer side.
It polls on a timer the host granted rather than an ambient one — pass `{ setTimeout }` to supply it, or `{ setTimeout: null }` to hand out facets that can read but cannot poll.
Push/webhook delivery, `SheetsService`, and `SpreadsheetStructure` are deliberately deferred.

## Example

```js
import { makeSheetsClient } from '@endo/google-sheets';
import { makeExoSpreadsheet } from '@endo/exo-google-sheets';

const client = makeSheetsClient(fetch, { spreadsheetId });
const { spreadsheet, writer, control } = makeExoSpreadsheet(client);

const tasks = spreadsheet.part('Tasks').part('A1:C10');
const rows = await tasks.read('A1:C10');

const taskWriter = writer.part('Tasks!A1:C10');
await taskWriter.write('A2:C2', [['review', 'open', false]]);
const appendOnly = writer.part('Tasks').appendOnly();

control.setMaxRequestsPerMinute(30);
control.revokeWrites();
```

All reads use bounded A1 rectangles so `maxCellsPerRead` can reject oversized
requests before they reach Google. `range()` establishes such a rectangle
within an existing sheet scope; use `sheet()` to grant authority over one tab,
then name a bounded rectangle for each read. Close the local iterator returned
by `iterateReader(followReader)` with `return()` when its consumer is done.
Setting a host range allowlist disables append, since the Sheets API selects the
destination row and cannot guarantee that the resulting write stays inside a
rectangle.

See [`designs/exo-google-sheets.md`](../../designs/exo-google-sheets.md) and the
source module headers for the attenuation rationale and implementation layers.
