// @ts-check

/**
 * A minimal persistent value cell, the analog of Goblins'
 * `(goblins actor-lib cell)` — and a demonstration of the library-env
 * convention: this module exports both the maker and `cellEnv`, the
 * persistence environment hosts compose into their own env to permit
 * cells to restore.
 */

import harden from '@endo/harden';
import { M } from '@endo/patterns';

import { makePersistenceEnv } from './env.js';
import { definePersistentExoClass } from './class.js';

export const cellEnv = makePersistenceEnv();
harden(cellEnv);

const ValueCellI = M.interface('ValueCell', {
  get: M.call().returns(M.any()),
  set: M.call(M.any()).returns(),
});

/**
 * @param {unknown} [value]
 */
export const makeValueCell = definePersistentExoClass(
  cellEnv,
  '@endo/portrait/cell.js#makeValueCell',
  ValueCellI,
  (value = undefined) => ({ value }),
  {
    get() {
      return this.state.value;
    },
    /** @param {unknown} value */
    set(value) {
      this.state.value = value;
    },
  },
);
harden(makeValueCell);
