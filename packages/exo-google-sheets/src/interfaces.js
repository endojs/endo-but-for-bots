// @ts-check

/**
 * Interface guards for the spreadsheet facets.
 *
 * Each guard describes one *authority class*, and the vocabulary is the whole
 * statement of what a holder may do: a `Spreadsheet` has no `write` method
 * because a reader holds no write authority to name, not because a reader is
 * asked politely not to call it.
 *
 * Every facet carries `part(designation)`, the mereological verb: a part of a
 * whole is a narrower whole of the same authority class.  It is the primary
 * narrowing method, and it composes — `part('Tasks').part('A1:C10')`.  The
 * `sheet` / `range` pair remains as the explicit spelling for the one case
 * `part` cannot read on its own: a tab whose title is itself A1-shaped.
 *
 * The two axes are orthogonal by construction.  Narrowing the part never
 * widens the verbs, because a narrowed facet is minted by the same maker;
 * attenuating the verbs never widens the part, because `readOnly()` and its
 * siblings pass along the powers they already hold.
 */

import { M } from '@endo/patterns';

const CellValueShape = M.or(M.string(), M.number(), M.boolean(), M.null());
const CellValuesShape = M.arrayOf(M.arrayOf(CellValueShape));
const UpdateShape = M.splitRecord(
  { range: M.string(), values: CellValuesShape },
  {},
);
const SheetInfoShape = M.splitRecord(
  {
    sheetId: M.number(),
    title: M.string(),
    index: M.number(),
    rowCount: M.number(),
    columnCount: M.number(),
  },
  {},
);
const UpdatedCellsShape = M.splitRecord(
  { updatedRange: M.string(), updatedCells: M.number() },
  {},
);
const AppendedRowsShape = M.splitRecord(
  { updatedRange: M.string(), appendedRows: M.number() },
  {},
);

/** The read-only surface: no method here can change a cell. */
export const SpreadsheetInterface = M.interface('Spreadsheet', {
  title: M.callWhen().returns(M.string()),
  sheets: M.callWhen().returns(M.arrayOf(SheetInfoShape)),
  part: M.call(M.string()).returns(M.remotable('Spreadsheet')),
  sheet: M.call(M.string()).returns(M.remotable('Spreadsheet')),
  range: M.call(M.string()).returns(M.remotable('Spreadsheet')),
  read: M.callWhen(M.string()).returns(CellValuesShape),
  readBatch: M.callWhen(M.arrayOf(M.string())).returns(
    M.arrayOf(CellValuesShape),
  ),
  readRecords: M.callWhen(M.string()).returns(
    M.arrayOf(M.recordOf(M.string(), CellValueShape)),
  ),
  follow: M.call(M.string()).returns(M.remotable('PassableReader')),
  help: M.call().returns(M.string()),
});

/**
 * The read-write surface.  Its `readOnly` / `appendOnly` / `writeOnly` methods
 * are *authority selection*: each mints a fresh facet built over strictly
 * fewer powers, rather than the same object carrying a narrower mood.
 */
export const SpreadsheetWriterInterface = M.interface('SpreadsheetWriter', {
  title: M.callWhen().returns(M.string()),
  sheets: M.callWhen().returns(M.arrayOf(SheetInfoShape)),
  part: M.call(M.string()).returns(M.remotable('SpreadsheetWriter')),
  sheet: M.call(M.string()).returns(M.remotable('SpreadsheetWriter')),
  range: M.call(M.string()).returns(M.remotable('SpreadsheetWriter')),
  read: M.callWhen(M.string()).returns(CellValuesShape),
  readBatch: M.callWhen(M.arrayOf(M.string())).returns(
    M.arrayOf(CellValuesShape),
  ),
  readRecords: M.callWhen(M.string()).returns(
    M.arrayOf(M.recordOf(M.string(), CellValueShape)),
  ),
  follow: M.call(M.string()).returns(M.remotable('PassableReader')),
  help: M.call().returns(M.string()),
  write: M.callWhen(M.string(), CellValuesShape).returns(UpdatedCellsShape),
  writeBatch: M.callWhen(M.arrayOf(UpdateShape)).returns(
    M.arrayOf(UpdatedCellsShape),
  ),
  append: M.callWhen(M.string(), CellValuesShape).returns(AppendedRowsShape),
  clear: M.callWhen(M.string()).returns(),
  readOnly: M.call().returns(M.remotable('Spreadsheet')),
  appendOnly: M.call().returns(M.remotable('SpreadsheetAppender')),
  writeOnly: M.call().returns(M.remotable('SpreadsheetWriteOnly')),
});

/**
 * The host's retained surface.  It adjusts the policy the powers enforce and
 * revokes authority classes; it deliberately has no way to *restore* revoked
 * authority, because a revocation a holder can watch flip back is not one.
 */
export const SpreadsheetControlInterface = M.interface('SpreadsheetControl', {
  setAllowedSheets: M.call(M.or(M.arrayOf(M.string()), M.null())).returns(),
  setAllowedRanges: M.call(M.or(M.arrayOf(M.string()), M.null())).returns(),
  setMaxCellsPerRead: M.call(M.number()).returns(),
  setMaxCellsPerWrite: M.call(M.number()).returns(),
  setPollIntervalMs: M.call(M.number()).returns(),
  setMaxRequestsPerMinute: M.call(M.number()).returns(),
  revokeWrites: M.call().returns(),
  revoke: M.call().returns(),
  help: M.call().returns(M.string()),
});

/** Append is its own authority class: it may add rows and read nothing. */
export const SpreadsheetAppenderInterface = M.interface('SpreadsheetAppender', {
  append: M.callWhen(M.string(), CellValuesShape).returns(AppendedRowsShape),
  part: M.call(M.string()).returns(M.remotable('SpreadsheetAppender')),
  sheet: M.call(M.string()).returns(M.remotable('SpreadsheetAppender')),
  range: M.call(M.string()).returns(M.remotable('SpreadsheetAppender')),
  help: M.call().returns(M.string()),
});

/** Overwrite without read-back: a drop box, not a window. */
export const SpreadsheetWriteOnlyInterface = M.interface(
  'SpreadsheetWriteOnly',
  {
    write: M.callWhen(M.string(), CellValuesShape).returns(UpdatedCellsShape),
    clear: M.callWhen(M.string()).returns(),
    part: M.call(M.string()).returns(M.remotable('SpreadsheetWriteOnly')),
    sheet: M.call(M.string()).returns(M.remotable('SpreadsheetWriteOnly')),
    range: M.call(M.string()).returns(M.remotable('SpreadsheetWriteOnly')),
    help: M.call().returns(M.string()),
  },
);
