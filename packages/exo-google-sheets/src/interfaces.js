// @ts-check

/**
 * Interface guards for the spreadsheet facets.
 *
 * Each guard describes one *authority class*, and the vocabulary is the whole
 * statement of what a holder may do: a `Spreadsheet` has no `write` method
 * because a reader holds no write authority to name, not because a reader is
 * asked politely not to call it.
 */

import { M } from '@endo/patterns';

const CellValuesShape = M.arrayOf(M.arrayOf(M.scalar()));
const UpdateShape = M.splitRecord(
  { range: M.string(), values: CellValuesShape },
  {},
);

/** The read-only surface: no method here can change a cell. */
export const SpreadsheetInterface = M.interface('Spreadsheet', {
  title: M.callWhen().returns(M.string()),
  sheets: M.callWhen().returns(M.arrayOf(M.record())),
  sheet: M.call(M.string()).returns(M.remotable('Spreadsheet')),
  range: M.call(M.string()).returns(M.remotable('Spreadsheet')),
  read: M.callWhen(M.string()).returns(CellValuesShape),
  readBatch: M.callWhen(M.arrayOf(M.string())).returns(
    M.arrayOf(CellValuesShape),
  ),
  readRecords: M.callWhen(M.string()).returns(M.arrayOf(M.record())),
  follow: M.call(M.string()).returns(M.any()),
  help: M.call().returns(M.string()),
});

/**
 * The read-write surface.  Its `readOnly` / `appendOnly` / `writeOnly` methods
 * are *authority selection*: each mints a fresh facet built over strictly
 * fewer powers, rather than the same object carrying a narrower mood.
 */
export const SpreadsheetWriterInterface = M.interface('SpreadsheetWriter', {
  title: M.callWhen().returns(M.string()),
  sheets: M.callWhen().returns(M.arrayOf(M.record())),
  sheet: M.call(M.string()).returns(M.remotable('SpreadsheetWriter')),
  range: M.call(M.string()).returns(M.remotable('SpreadsheetWriter')),
  read: M.callWhen(M.string()).returns(CellValuesShape),
  readBatch: M.callWhen(M.arrayOf(M.string())).returns(
    M.arrayOf(CellValuesShape),
  ),
  readRecords: M.callWhen(M.string()).returns(M.arrayOf(M.record())),
  follow: M.call(M.string()).returns(M.any()),
  help: M.call().returns(M.string()),
  write: M.callWhen(M.string(), CellValuesShape).returns(M.record()),
  writeBatch: M.callWhen(M.arrayOf(UpdateShape)).returns(M.arrayOf(M.record())),
  append: M.callWhen(M.string(), CellValuesShape).returns(M.record()),
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
  setPollIntervalMs: M.call(M.number()).returns(),
  setMaxRequestsPerMinute: M.call(M.number()).returns(),
  revokeWrites: M.call().returns(),
  revoke: M.call().returns(),
  help: M.call().returns(M.string()),
});

/** Append is its own authority class: it may add rows and read nothing. */
export const SpreadsheetAppenderInterface = M.interface('SpreadsheetAppender', {
  append: M.callWhen(M.string(), CellValuesShape).returns(M.record()),
  sheet: M.call(M.string()).returns(M.remotable('SpreadsheetAppender')),
  range: M.call(M.string()).returns(M.remotable('SpreadsheetAppender')),
  help: M.call().returns(M.string()),
});

/** Overwrite without read-back: a drop box, not a window. */
export const SpreadsheetWriteOnlyInterface = M.interface(
  'SpreadsheetWriteOnly',
  {
    write: M.callWhen(M.string(), CellValuesShape).returns(M.record()),
    clear: M.callWhen(M.string()).returns(),
    sheet: M.call(M.string()).returns(M.remotable('SpreadsheetWriteOnly')),
    range: M.call(M.string()).returns(M.remotable('SpreadsheetWriteOnly')),
    help: M.call().returns(M.string()),
  },
);
