// @ts-check

/**
 * The passable facets.
 *
 * Every maker here takes power objects and nothing else — no client, no policy,
 * no allowlists.  What a facet can do is therefore readable from its signature:
 * `makeReader` takes read powers, so a reader cannot write, and no reading of
 * its body is needed to establish that.  The facets hold no conditions about
 * what they are allowed to do, because they were only ever given what they are
 * allowed to do.
 *
 * That claim is only worth as much as this module's freedom from ambient
 * authority, so this module reaches for no global.  Waiting between polls is a
 * scheduling authority like any other — the ability to run later is not
 * something a confined facet should be able to help itself to — so the follower
 * awaits `powers.pollDelay()` rather than an ambient `setTimeout`, and a host
 * that hands out no timer gets facets that cannot schedule.
 *
 * Nor does this module import any *value* from `powers.js` — only the types of
 * the power makers, which do not survive to runtime.  Every power it uses
 * arrived as an argument, so there is no path from here to a client, a
 * caretaker, or a policy, and the absence is grep-checkable rather than
 * asserted.  `powers.js` explains why that boundary is drawn where it is.
 */

import harden from '@endo/harden';
import { makeExo } from '@endo/exo';

import {
  SpreadsheetAppenderInterface,
  SpreadsheetInterface,
  SpreadsheetWriteOnlyInterface,
  SpreadsheetWriterInterface,
} from './interfaces.js';
import { partScope, rangeScope } from './a1.js';

const { apply } = Reflect;
const { map } = Array.prototype;
/**
 * @template T,U
 * @param {T[]} array
 * @param {(value: T, index: number) => U} callback
 * @returns {U[]}
 */
const arrayMap = (array, callback) => apply(map, array, [callback]);

/**
 * @import { Scope } from './a1.js'
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
 * The wait between polls is `powers.pollDelay()`, an authority the host
 * granted, and its length remains the host's to change mid-follow.
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
        if (done) return { done: true, value: undefined };
        const revision = JSON.stringify(values);
        if (revision !== prior) {
          prior = revision;
          return {
            done: false,
            value: harden({ range: target, values, revision }),
          };
        }
        // eslint-disable-next-line no-await-in-loop
        await powers.pollDelay();
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
    return arrayMap(sheets, ({ properties }) => ({
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
  readBatch: selectors =>
    Promise.all(arrayMap(selectors, one => powers.read(one))),
  /** @param {string} selector */
  readRecords: async selector => {
    const [headers = [], ...rows] = await powers.read(selector);
    const names = arrayMap(headers, String);
    if (new Set(names).size !== names.length)
      throw new Error('Record headers must be unique');
    return harden(
      arrayMap(rows, row =>
        harden(
          Object.fromEntries(
            arrayMap(names, (name, index) => [name, row[index] ?? null]),
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
      range: selector => makeReader(powers.narrow(rangeScope(selector))),
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
      range: selector => makeAppender(powers.narrow(rangeScope(selector))),
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
      range: selector => makeWriteOnly(powers.narrow(rangeScope(selector))),
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
  /** @param {Scope} patch */
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
      range: selector => makeWriter(narrow(rangeScope(selector))),
      readOnly: () => makeReader(powers.read),
      appendOnly: () => makeAppender(powers.append),
      writeOnly: () => makeWriteOnly(powers.write),
      help: () =>
        'SpreadsheetWriter: confined read-write Google Sheets capability.',
    }),
  );
};
harden(makeWriter);
