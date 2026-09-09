# Google Sheets client

`@endo/google-sheets` is a small capability-oriented client for the Google
Sheets REST API. It is for an application that already has a narrowly
authorized `fetch` function and a spreadsheet identifier.

The package does not obtain OAuth tokens, store credentials, or construct
authorization headers. Supply an authorized `fetch` that has only the network
and credential authority the application intends to grant. The client returns a
hardened interface for reading and changing values or retrieving spreadsheet
metadata.

```js
import { makeSheetsClient } from '@endo/google-sheets';

const sheets = makeSheetsClient(authorizedFetch, {
  spreadsheetId: 'spreadsheet-id',
});
const { values } = await sheets.values.get('Tasks!A1:B10');
```

`authorizedFetch` is application-owned. A host may use a Google API client,
a service-account adapter, or another credential boundary to provide it.
