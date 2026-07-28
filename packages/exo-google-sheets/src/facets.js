// @ts-check
/* global setTimeout */

/**
 * The passable facets.
 *
 * Every maker here takes power objects and nothing else — no client, no policy,
 * no allowlists.  What a facet can do is therefore readable from its signature:
 * `makeReader` takes read powers, so a reader cannot write, and no reading of
 * its body is needed to establish that.  The facets hold no conditions about
 * what they are allowed to do, because they were only ever given what they are
 * allowed to do.
 */

import harden from '@endo/harden';
import { makeExo } from '@endo/exo';

import {
  SpreadsheetAppenderInterface,
  SpreadsheetInterface,
  SpreadsheetWriteOnlyInterface,
  SpreadsheetWriterInterface,
} from './interfaces.js';
import { partScope } from './powers.js';

/**
 * @import { makeAppendPowers, makeReadPowers, makeWritePowers } from './powers.js'
 * @typedef {ReturnType<typeof makeReadPowers>} ReadPowers
 * @typedef {ReturnType<typeof makeAppendPowers>} AppendPowers
 * @typedef {ReturnType<typeof makeWritePowers>} WritePowers
 */

const TITLE_FIELDS = harden({ fields: 'properties.title' });
const SHEET_FIELDS = harden({
  fields: 'sheets(properties(sheetId,title,index,gridProperties))',
});

/**
 * A polling async iterator over one range, yielding each time the contents
 * change.  It resolves the range once, against the scope of the powers that
 * minted it, then reads that fully qualified range through the unscoped
 * powers — so each poll is still charged and still re-checked against the
 * host's current allowlists, and a range the host later disallows stops
 * yielding rather than continuing on a stale decision.
 *
 * @param {ReadPowers} powers
 * @param {string} selector
 */
const makeFollower = (powers, selector) => {
  const target = powers.designate(selector);
  const unscoped = powers.unscoped();
  let prior;
  let done = false;
  return harden({
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      await null;
      while (!done) {
        // eslint-disable-next-line no-await-in-loop
        const values = await unscoped.read(target);
        const revision = JSON.stringify(values);
        if (revision !== prior) {
          prior = revision;
          return {
            done: false,
            value: harden({ range: target, values, revision }),
          };
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve =>
          setTimeout(resolve, powers.pollIntervalMs()),
        );
      }
      return { done: true, value: undefined };
    },
    async return() {
      done = true;
      return { done: true, value: undefined };
    },
  });
};

/**
 * The methods a holder of read powers can offer.  Shared by the reader and the
 * writer facets so the writer's read half is literally the reader's, built
 * over the same read powers rather than re-derived beside write authority.
 *
 * @param {ReadPowers} powers
 */
const readMethods = powers => ({
  title: async () => {
    await null;
    const { properties } = await powers.describe(TITLE_FIELDS);
    return properties.title;
  },
  sheets: async () => {
    await null;
    const { sheets } = await powers.describe(SHEET_FIELDS);
    return sheets.map(({ properties }) => ({
      sheetId: properties.sheetId,
      title: properties.title,
      index: properties.index,
      rowCount: properties.gridProperties.rowCount,
      columnCount: properties.gridProperties.columnCount,
    }));
  },
  /** @param {string} selector */
  read: selector => powers.read(selector),
  /** @param {string[]} selectors */
  readBatch: selectors => Promise.all(selectors.map(one => powers.read(one))),
  /** @param {string} selector */
  readRecords: async selector => {
    const [headers = [], ...rows] = await powers.read(selector);
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
  /** @param {string} selector */
  follow: selector => makeFollower(powers, selector),
});

/** @param {WritePowers} powers */
const writeMethods = powers => ({
  /**
   * @param {string} selector
   * @param {any[][]} values
   */
  write: (selector, values) => powers.update(selector, values),
  /** @param {string} selector */
  clear: selector => powers.clear(selector),
});

/** @param {AppendPowers} powers */
const appendMethods = powers => ({
  /**
   * @param {string} selector
   * @param {any[][]} rows
   */
  append: (selector, rows) => powers.append(selector, rows),
});

/**
 * A read-only spreadsheet facet.
 *
 * @param {ReadPowers} powers
 */
export const makeReader = powers =>
  makeExo(
    'Spreadsheet',
    SpreadsheetInterface,
    /** @type {any} */ ({
      ...readMethods(powers),
      /** @param {string} designation A tab name, an A1 range, or both. */
      part: designation => makeReader(powers.narrow(partScope(designation))),
      /** @param {string} name */
      sheet: name => makeReader(powers.narrow({ sheet: name })),
      /** @param {string} selector */
      range: selector => makeReader(powers.narrow({ range: selector })),
      help: () => 'Spreadsheet: confined read-only Google Sheets capability.',
    }),
  );
harden(makeReader);

/**
 * An append-only facet: it may add rows within its scope and cannot read or
 * overwrite.
 *
 * @param {AppendPowers} powers
 */
export const makeAppender = powers =>
  makeExo(
    'SpreadsheetAppender',
    SpreadsheetAppenderInterface,
    /** @type {any} */ ({
      ...appendMethods(powers),
      /** @param {string} designation A tab name, an A1 range, or both. */
      part: designation => makeAppender(powers.narrow(partScope(designation))),
      /** @param {string} name */
      sheet: name => makeAppender(powers.narrow({ sheet: name })),
      /** @param {string} selector */
      range: selector => makeAppender(powers.narrow({ range: selector })),
      help: () =>
        'SpreadsheetAppender: confined append-only Google Sheets capability.',
    }),
  );
harden(makeAppender);

/**
 * A write-only facet: it may overwrite and clear within its scope and cannot
 * read back.
 *
 * @param {WritePowers} powers
 */
export const makeWriteOnly = powers =>
  makeExo(
    'SpreadsheetWriteOnly',
    SpreadsheetWriteOnlyInterface,
    /** @type {any} */ ({
      ...writeMethods(powers),
      /** @param {string} designation A tab name, an A1 range, or both. */
      part: designation => makeWriteOnly(powers.narrow(partScope(designation))),
      /** @param {string} name */
      sheet: name => makeWriteOnly(powers.narrow({ sheet: name })),
      /** @param {string} selector */
      range: selector => makeWriteOnly(powers.narrow({ range: selector })),
      help: () =>
        'SpreadsheetWriteOnly: confined write-only Google Sheets capability.',
    }),
  );
harden(makeWriteOnly);

/**
 * The full read-write facet.  Its attenuation methods hand back facets built
 * over a strict subset of its own powers, so what a delegate cannot do is a
 * fact about the object it holds rather than a promise about how it is used.
 *
 * @param {{ read: ReadPowers, append: AppendPowers, write: WritePowers }} powers
 */
export const makeWriter = powers => {
  /** @param {import('./powers.js').Scope} patch */
  const narrow = patch =>
    harden({
      read: powers.read.narrow(patch),
      append: powers.append.narrow(patch),
      write: powers.write.narrow(patch),
    });
  const writes = writeMethods(powers.write);
  return makeExo(
    'SpreadsheetWriter',
    SpreadsheetWriterInterface,
    /** @type {any} */ ({
      ...readMethods(powers.read),
      ...appendMethods(powers.append),
      ...writes,
      /** @param {{ range: string, values: any[][] }[]} updates */
      writeBatch: updates =>
        Promise.all(
          updates.map(({ range, values }) => writes.write(range, values)),
        ),
      /** @param {string} designation A tab name, an A1 range, or both. */
      part: designation => makeWriter(narrow(partScope(designation))),
      /** @param {string} name */
      sheet: name => makeWriter(narrow({ sheet: name })),
      /** @param {string} selector */
      range: selector => makeWriter(narrow({ range: selector })),
      readOnly: () => makeReader(powers.read),
      appendOnly: () => makeAppender(powers.append),
      writeOnly: () => makeWriteOnly(powers.write),
      help: () =>
        'SpreadsheetWriter: confined read-write Google Sheets capability.',
    }),
  );
};
harden(makeWriter);
