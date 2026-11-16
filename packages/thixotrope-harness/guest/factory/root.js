// @ts-check
/**
 * The harness root and the session-program store (M1a W1a.6; architecture
 * 3.1, D-4, rule 12.11; `designs/m1a-interfaces.md` sections 3.4 and 9).
 *
 * `HarnessRoot` is the installed application's value (inventory `harness`,
 * operator only): `getOperator()`, `status()` and `loadSessionProgram`.
 * Provisioning loads the session program in pieces (each at most
 * `programPieceBytes` UTF-8 bytes, so the message that carries it, and the
 * one the factory forwards to a new worker, stays within `frameBytes`);
 * the store keeps the pieces and makes them the current program once every
 * index is present. A new digest replaces the program for later creations
 * only; loading the current digest again is a no-op.
 *
 * The vat has no hash function: `digest` is the provisioner's sha256 of
 * the source and is trusted as given (the root is operator-only).
 *
 * Guest rules: prelude globals only; pieces are kept in a `Map` keyed by
 * index while loading and as an array once complete.
 */
import { interfaces } from '../lib/interfaces.js';
import { limits } from '../lib/limits.js';
import { utf8Bytes } from '../lib/bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { RowTable } from './rows.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);

/**
 * Bytes kept free in a staging message for its envelope: the piece travels
 * with `digest`, `index`, `count` and their keys into this vat, and with
 * the staging source and the `chunk` key into a new worker.
 */
export const PIECE_ENVELOPE_BYTES = 1024;
/** The largest program piece, in UTF-8 bytes (23,552). */
export const programPieceBytes = limits.frameBytes - PIECE_ENVELOPE_BYTES;
/** Most pieces of one program. */
export const MAX_PROGRAM_PIECES = 64;
/**
 * The largest program the store keeps: the staged-source bound. The
 * session program's budget is `sessionProgramBytes` (200,000), checked by
 * provisioning and the `session.program` perf row, not here.
 */
export const maxProgramBytes = limits.execSourceBytes;

/**
 * @typedef {object} SessionProgram
 * @property {string} digest sha256 hex of the source (the provisioner's)
 * @property {readonly string[]} pieces in order; joined they are the source
 * @property {number} bytes UTF-8 bytes of the source
 */

/**
 * @typedef {object} ProgramStore
 * @property {() => SessionProgram | undefined} current
 * @property {(piece: { digest: string, index: number, count: number, text: string }) => { complete: boolean, bytes: number }} load
 */

/** @returns {ProgramStore} */
export const makeProgramStore = () => {
  /** @type {SessionProgram | undefined} */
  let program;
  /** @type {{ digest: string, count: number, pieces: Map<number, string>, bytes: number } | undefined} */
  let loading;

  /** @param {{ digest: string, index: number, count: number, text: string }} piece */
  const load = ({ digest, index, count, text }) => {
    if (!/^[0-9a-f]{64}$/.test(digest))
      throw Error('A session program digest is 64 lower-case hex digits');
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PROGRAM_PIECES)
      throw Error(
        `A session program has 1 to ${MAX_PROGRAM_PIECES} pieces, not ${count}`,
      );
    if (!Number.isSafeInteger(index) || index >= count)
      throw Error(`Piece index ${index} is not below the count ${count}`);
    if (program !== undefined && program.digest === digest)
      return harden({ complete: true, bytes: program.bytes });
    const bytes = utf8Bytes(text);
    if (bytes > programPieceBytes)
      throw Error(
        `A session program piece is at most ${programPieceBytes} bytes, not ${bytes}`,
      );
    if (
      loading === undefined ||
      loading.digest !== digest ||
      loading.count !== count
    ) {
      loading = { digest, count, pieces: new Map(), bytes: 0 };
    }
    const current = loading;
    if (!current.pieces.has(index)) {
      if (current.bytes + bytes > maxProgramBytes) {
        loading = undefined;
        throw Error(
          `A session program is at most ${maxProgramBytes} bytes in this build`,
        );
      }
      current.pieces.set(index, text);
      current.bytes += bytes;
    }
    if (current.pieces.size < count)
      return harden({ complete: false, bytes: current.bytes });
    /** @type {string[]} */
    const pieces = [];
    for (let i = 0; i < count; i += 1) {
      pieces.push(/** @type {string} */ (current.pieces.get(i)));
    }
    program = harden({ digest, pieces, bytes: current.bytes });
    loading = undefined;
    return harden({ complete: true, bytes: program.bytes });
  };

  return harden({ current: () => program, load });
};
harden(makeProgramStore);

/**
 * @param {object} powers
 * @param {any} powers.operator
 * @param {RowTable} powers.rows
 * @param {ProgramStore} powers.programs
 */
export const makeHarnessRoot = ({ operator, rows, programs }) =>
  makeExo('HarnessRoot', interfaces.HarnessRoot, {
    getOperator: () => operator,
    status: () => {
      const program = programs.current();
      return harden({
        sessions: rows.size(),
        program:
          program === undefined
            ? { digest: '', bytes: 0 }
            : { digest: program.digest, bytes: program.bytes },
      });
    },
    /** @param {any} piece a `shapes.ProgramPiece` (checked by the guard) */
    loadSessionProgram: piece => programs.load(piece),
  });
harden(makeHarnessRoot);
