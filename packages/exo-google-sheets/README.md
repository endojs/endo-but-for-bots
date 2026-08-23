# @endo/exo-google-sheets

`makeExoSpreadsheet(client)` wraps an `@endo/google-sheets` client in hardened, passable spreadsheet facets.

The default `spreadsheet` facet reads only.
The separately minted `writer` facet can delegate read-only, append-only, and write-only facets, each of which can narrow to one tab or A1 range.
The host retains `control` to constrain scopes, adjust limits and polling, sever write authority (`revokeWrites()`), or revoke every facet (`revoke()`).

`follow(range)` is a polling async iterator, and it polls on a timer the host granted rather than an ambient one — pass `{ setTimeout }` to supply it, or `{ setTimeout: null }` to hand out facets that can read but cannot poll.
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
const appendOnly = taskWriter.appendOnly();

control.setMaxRequestsPerMinute(30);
control.revokeWrites();
```

`range()` establishes a bounded rectangle and therefore rejects named,
whole-row, and whole-column ranges; use `sheet()` to grant a whole tab. A
`follow()` iterator is local to the process and should be closed with
`return()` when its consumer is done.

See [`designs/exo-google-sheets.md`](../../designs/exo-google-sheets.md) and the
source module headers for the attenuation rationale and implementation layers.
