// @ts-check
// A tiny guest program for the bundle-guest unit test: it reads the prelude
// off globalThis and imports one relative module.
import { joinWords } from './words.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, M } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

export const make = () =>
  Far('Tiny', {
    /** @param {string[]} words */
    say: words => {
      mustMatch(harden(words), M.arrayOf(M.string()));
      return joinWords(words);
    },
  });
