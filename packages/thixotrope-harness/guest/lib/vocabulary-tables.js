// @ts-check
/**
 * The interface tables the gateway's vocabulary is built from (HR-SYN-7;
 * designs/m3-interfaces.md 4.4 rule 4 and 6.3): one explicit list, next to
 * the tables, in place of a file-name glob. `GW/vocabulary.js`
 * `harnessNames` walks the patterns each entry answers; an entry whose
 * module fails to load fails this module's import, and an entry whose
 * `patterns()` throws or answers no array is an error at gateway start
 * (the bind fails), never a logged skip.
 *
 * A module of `guest/lib/` that exports a guard or pattern (directly or as
 * an entry of an exported table) is either listed in `vocabularyTables` or
 * named in `vocabularyExclusions` with the reason; `test/adapter/
 * gateway-vocabulary-tables.test.js` checks both directions and that every
 * interface guard such a module exports contributes its keys and methods,
 * except a module excluded as not browser-sendable (`notBrowserSendable`:
 * its objects are reached only by a vat or an adapter, never through the
 * gateway, so its names stay out of the vocabulary; D-M6-10). A listed or
 * excluded module may also be one that exports only builders (a function
 * answering its tables): the test checks that the file exists. A new or
 * renamed table module is therefore a red test, not a silently narrower
 * gateway.
 *
 * Node only: no vat program imports this module (it would bundle every
 * table). The guest prelude must be on `globalThis` before it is imported.
 */
import * as base from './interfaces.js';
import * as m3 from './interfaces-m3.js';
import * as m4 from './interfaces-m4.js';
// The cross-lane seam unit (WX.1): mail (m9-interfaces.md V1) and speech
// (m11-interfaces.md H3).
import { mailTables } from './guards/mail.js';
import { postOfficeTables } from './guards/post-office.js';
import * as speech from './speech-guards.js';

/**
 * @typedef {object} VocabularyTable
 * @property {string} file the module's path under `guest/lib/`
 * @property {() => unknown} patterns the shapes and interface guards whose
 *   record keys and method names a browser may send (an array)
 */

/** @type {readonly VocabularyTable[]} */
export const vocabularyTables = harden([
  {
    file: 'interfaces.js',
    // The session's and the factory's tables, M5's included since the
    // fold (F2, HR-SYN-1).
    patterns: () => [
      ...Object.values(base.shapes),
      ...Object.values(base.interfaces),
    ],
  },
  { file: 'interfaces-m3.js', patterns: () => m3.vocabularyShapes() },
  { file: 'interfaces-m4.js', patterns: () => m4.vocabularyShapes() },
  // Mail and subagents (m9-interfaces.md 6.2 V1; WX.1); the fold moves the
  // entries into the vat tables and these two lines go.
  {
    file: 'guards/mail.js',
    patterns: () => [...Object.values(mailTables().shapes)],
  },
  {
    file: 'guards/post-office.js',
    patterns: () => [
      ...Object.values(postOfficeTables().shapes),
      ...Object.values(postOfficeTables().interfaces),
    ],
  },
  // Voice (m11-interfaces.md 11 H3; WX.1).
  { file: 'speech-guards.js', patterns: () => speech.vocabularyShapes() },
]);

/**
 * Table modules of `guest/lib/` that are not listed, and why. Each one's
 * interface guards must still be covered by the listed tables (the test
 * checks it).
 * @type {Readonly<Record<string, string>>}
 */
export const vocabularyExclusions = harden({
  'guards/base.js': 'the exec slice of interfaces.js, re-exported whole by it',
  'guards/session.js':
    'the session slice of interfaces.js, re-exported whole by it',
  'guards/factory.js':
    'the factory slice of interfaces.js, re-exported whole by it',
  // WX.1: the four lanes' guard modules that are not listed.
  'guards/environments.js':
    'environments manager vat and adapter table; no browser path reaches these objects',
});

/**
 * Excluded modules whose objects no browser path reaches (D-M6-10; m8
 * G-4): their interface guards need not contribute their names, and do
 * not. Each is also in `vocabularyExclusions`.
 * @type {readonly string[]}
 */
export const notBrowserSendable = harden(['guards/environments.js']);
