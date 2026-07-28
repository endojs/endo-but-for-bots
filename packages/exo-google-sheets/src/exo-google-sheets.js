// @ts-check
/* global setTimeout */
/* eslint-disable no-await-in-loop */

import harden from '@endo/harden';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const CellValuesShape = M.arrayOf(M.arrayOf(M.scalar()));
const UpdateShape = M.splitRecord(
  { range: M.string(), values: CellValuesShape },
  {},
);

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

export const SpreadsheetControlInterface = M.interface('SpreadsheetControl', {
  setAllowedSheets: M.call(M.or(M.arrayOf(M.string()), M.null())).returns(),
  setAllowedRanges: M.call(M.or(M.arrayOf(M.string()), M.null())).returns(),
  setReadOnly: M.call(M.boolean()).returns(),
  setMaxCellsPerRead: M.call(M.number()).returns(),
  setPollIntervalMs: M.call(M.number()).returns(),
  setMaxRequestsPerMinute: M.call(M.number()).returns(),
  revoke: M.call().returns(),
  help: M.call().returns(M.string()),
});

const AppenderInterface = M.interface('SpreadsheetAppender', {
  append: M.callWhen(M.string(), CellValuesShape).returns(M.record()),
  sheet: M.call(M.string()).returns(M.remotable('SpreadsheetAppender')),
  range: M.call(M.string()).returns(M.remotable('SpreadsheetAppender')),
  help: M.call().returns(M.string()),
});
const WriteOnlyInterface = M.interface('SpreadsheetWriteOnly', {
  write: M.callWhen(M.string(), CellValuesShape).returns(M.record()),
  clear: M.callWhen(M.string()).returns(),
  sheet: M.call(M.string()).returns(M.remotable('SpreadsheetWriteOnly')),
  range: M.call(M.string()).returns(M.remotable('SpreadsheetWriteOnly')),
  help: M.call().returns(M.string()),
});

const columnNumber = letters =>
  [...letters.toUpperCase()].reduce(
    (number, letter) => number * 26 + letter.charCodeAt(0) - 64,
    0,
  );
const parseA1 = value => {
  const bang = value.lastIndexOf('!');
  // eslint-disable-next-line @endo/restrict-comparison-operands
  const sheetPart = bang < 0 ? undefined : value.slice(0, bang);
  // eslint-disable-next-line @endo/restrict-comparison-operands
  const cells = bang < 0 ? value : value.slice(bang + 1);
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(cells);
  if (!match) return undefined;
  const [, startColumn, startRow, endColumn, endRow] = match;
  return {
    sheet:
      sheetPart && sheetPart.startsWith("'") && sheetPart.endsWith("'")
        ? sheetPart.slice(1, -1).replace(/''/g, "'")
        : sheetPart,
    left: columnNumber(startColumn),
    top: Number(startRow),
    right: columnNumber(endColumn || startColumn),
    bottom: Number(endRow || startRow),
  };
};
const contains = (outer, inner) => {
  // eslint-disable-next-line @endo/restrict-comparison-operands
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.right >= inner.right &&
    outer.bottom >= inner.bottom
  );
};
const sheetPrefix = sheet =>
  /[ !']/.test(sheet) ? `'${sheet.replace(/'/g, "''")}'` : sheet;

/**
 * Make attenuated spreadsheet facets around a portable Sheets client.
 *
 * @param {any} client
 * @param {{ maxRequestsPerMinute?: number, maxCellsPerRead?: number, pollIntervalMs?: number }} [options]
 */
export const makeExoSpreadsheet = (client, options = {}) => {
  if (!client || !client.values || !client.spreadsheets)
    throw new TypeError('A Sheets client is required');
  let allowedSheets = null;
  let allowedRanges = null;
  let readOnly = false;
  let revoked = false;
  let maxCellsPerRead = options.maxCellsPerRead || 10_000;
  let pollIntervalMs = options.pollIntervalMs || 30_000;
  let maxRequestsPerMinute = options.maxRequestsPerMinute || 60;
  let tokens = maxRequestsPerMinute;
  let lastRefill = Date.now();

  const charge = () => {
    if (revoked) throw new Error('Spreadsheet capability has been revoked');
    const now = Date.now();
    tokens = Math.min(
      maxRequestsPerMinute,
      tokens + ((now - lastRefill) * maxRequestsPerMinute) / 60_000,
    );
    lastRefill = now;
    if (tokens < 1) throw new Error('Spreadsheet request throttle exceeded');
    tokens -= 1;
  };
  const confined = (selector, scope = {}) => {
    if (typeof selector !== 'string' || selector.length === 0)
      throw new TypeError('range must be a non-empty A1 string');
    const parsed = parseA1(selector);
    const scopeRange = scope.range && parseA1(scope.range);
    const sheet =
      parsed && parsed.sheet
        ? parsed.sheet
        : scope.sheet || (scopeRange && scopeRange.sheet);
    if (scope.sheet && sheet && sheet !== scope.sheet)
      throw new Error('Range escapes the sheet scope');
    if (allowedSheets && (!sheet || !allowedSheets.has(sheet)))
      throw new Error('Sheet is not allowed');
    if (
      scopeRange &&
      parsed &&
      !contains(scopeRange, { ...parsed, sheet: undefined })
    )
      throw new Error('Range escapes the range scope');
    const full =
      sheet && !(parsed && parsed.sheet)
        ? `${sheetPrefix(sheet)}!${selector}`
        : selector;
    if (
      allowedRanges &&
      !allowedRanges.some(range => {
        const allowed = parseA1(range);
        const candidate = parseA1(full);
        return (
          allowed &&
          candidate &&
          allowed.sheet === candidate.sheet &&
          contains(allowed, candidate)
        );
      })
    )
      throw new Error('Range is not allowed');
    return full;
  };
  const ensureCells = values => {
    const count = values.reduce((total, row) => total + row.length, 0);
    // eslint-disable-next-line @endo/restrict-comparison-operands
    if (count > maxCellsPerRead)
      throw new Error('Read exceeds maximum cell count');
    return harden(values.map(row => harden([...row])));
  };
  const read = async (range, scope) => {
    charge();
    const result = await client.values.get(confined(range, scope));
    return ensureCells(result.values || []);
  };
  const makeFacet = (kind, scope = {}) => {
    const narrow = (methodKind, field) => value =>
      makeFacet(methodKind, { ...scope, [field]: value });
    const common = {
      sheet: narrow(kind, 'sheet'),
      range: narrow(kind, 'range'),
      help: () => `${kind}: confined Google Sheets capability.`,
    };
    if (kind === 'read' || kind === 'writer') {
      Object.assign(common, {
        title: async () =>
          (await client.spreadsheets.get({ fields: 'properties.title' }))
            .properties.title,
        sheets: async () =>
          (
            await client.spreadsheets.get({
              fields: 'sheets(properties(sheetId,title,index,gridProperties))',
            })
          ).sheets.map(({ properties }) => ({
            sheetId: properties.sheetId,
            title: properties.title,
            index: properties.index,
            rowCount: properties.gridProperties.rowCount,
            columnCount: properties.gridProperties.columnCount,
          })),
        read: range => read(range, scope),
        readBatch: async ranges =>
          Promise.all(ranges.map(range => read(range, scope))),
        readRecords: async range => {
          const [headers = [], ...rows] = await read(range, scope);
          return harden(
            rows.map(row =>
              harden(
                Object.fromEntries(
                  headers.map((header, index) => [
                    String(header),
                    row[index] ?? null,
                  ]),
                ),
              ),
            ),
          );
        },
        follow: range => {
          const target = confined(range, scope);
          let prior;
          let done = false;
          return harden({
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              while (!done) {
                const values = await read(target, {});
                const revision = JSON.stringify(values);
                if (revision !== prior) {
                  prior = revision;
                  return {
                    done: false,
                    value: harden({ range: target, values, revision }),
                  };
                }
                await new Promise(resolve =>
                  setTimeout(resolve, pollIntervalMs),
                );
              }
              return { done: true, value: undefined };
            },
            async return() {
              done = true;
              return { done: true, value: undefined };
            },
          });
        },
      });
    }
    if (kind === 'writer')
      Object.assign(common, {
        write: async (range, values) => {
          if (readOnly) throw new Error('Spreadsheet is read-only');
          charge();
          const result = await client.values.update(
            confined(range, scope),
            values,
          );
          return harden({
            updatedRange: result.updatedRange,
            updatedCells: result.updatedCells,
          });
        },
        writeBatch: async updates =>
          Promise.all(
            updates.map(({ range, values }) => common.write(range, values)),
          ),
        append: async (range, rows) => {
          if (readOnly) throw new Error('Spreadsheet is read-only');
          charge();
          const result = await client.values.append(
            confined(range, scope),
            rows,
          );
          return harden({
            updatedRange: result.updates.updatedRange,
            appendedRows: result.updates.updatedRows,
          });
        },
        clear: async range => {
          if (readOnly) throw new Error('Spreadsheet is read-only');
          charge();
          await client.values.clear(confined(range, scope));
        },
        readOnly: () => makeFacet('read', scope),
        appendOnly: () => makeFacet('append', scope),
        writeOnly: () => makeFacet('write', scope),
      });
    if (kind === 'append')
      common.append = async (range, rows) => {
        if (readOnly) throw new Error('Spreadsheet is read-only');
        charge();
        const result = await client.values.append(confined(range, scope), rows);
        return harden({
          updatedRange: result.updates.updatedRange,
          appendedRows: result.updates.updatedRows,
        });
      };
    if (kind === 'write')
      Object.assign(common, {
        write: async (range, values) => {
          if (readOnly) throw new Error('Spreadsheet is read-only');
          charge();
          const result = await client.values.update(
            confined(range, scope),
            values,
          );
          return harden({
            updatedRange: result.updatedRange,
            updatedCells: result.updatedCells,
          });
        },
        clear: async range => {
          if (readOnly) throw new Error('Spreadsheet is read-only');
          charge();
          await client.values.clear(confined(range, scope));
        },
      });
    const iface =
      kind === 'read'
        ? SpreadsheetInterface
        : kind === 'writer'
          ? SpreadsheetWriterInterface
          : kind === 'append'
            ? AppenderInterface
            : WriteOnlyInterface;
    return makeExo(`${kind}Spreadsheet`, iface, /** @type {any} */ (common));
  };
  const spreadsheet = makeFacet('read');
  const writer = makeFacet('writer');
  const control = makeExo('SpreadsheetControl', SpreadsheetControlInterface, {
    setAllowedSheets: titles => {
      allowedSheets = titles === null ? null : new Set(titles);
    },
    setAllowedRanges: ranges => {
      allowedRanges = ranges === null ? null : [...ranges];
    },
    setReadOnly: flag => {
      readOnly = flag;
    },
    setMaxCellsPerRead: value => {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError('max cells must be positive');
      maxCellsPerRead = value;
    },
    setPollIntervalMs: value => {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError('poll interval must be non-negative');
      pollIntervalMs = value;
    },
    setMaxRequestsPerMinute: value => {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError('request limit must be positive');
      maxRequestsPerMinute = value;
      tokens = Math.min(tokens, value);
    },
    revoke: () => {
      revoked = true;
    },
    help: () => 'SpreadsheetControl: host-only policy and revocation controls.',
  });
  return /** @type {any} */ (harden({ spreadsheet, writer, control }));
};
harden(makeExoSpreadsheet);
