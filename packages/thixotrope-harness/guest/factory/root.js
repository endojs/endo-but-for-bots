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
import { interfaces, shapes } from '../lib/guards/factory.js';
import { limits } from '../lib/limits.js';
import { utf8Bytes } from '../lib/bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { RowTable } from './rows.js' */
/** @import { Pool } from './pool.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

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
 * session program's budget is `sessionProgramBytes` (240,000), checked by
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

/**
 * @param {object} [options]
 * @param {string} [options.what] the program's name in refusals (M1b: the
 *   exec program has its own store)
 * @returns {ProgramStore}
 */
export const makeProgramStore = ({ what = 'session program' } = {}) => {
  /** @type {SessionProgram | undefined} */
  let program;
  /** @type {{ digest: string, count: number, pieces: Map<number, string>, bytes: number } | undefined} */
  let loading;

  /** @param {{ digest: string, index: number, count: number, text: string }} piece */
  const load = ({ digest, index, count, text }) => {
    if (!/^[0-9a-f]{64}$/.test(digest))
      throw Error(`A ${what} digest is 64 lower-case hex digits`);
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PROGRAM_PIECES)
      throw Error(
        `A ${what} has 1 to ${MAX_PROGRAM_PIECES} pieces, not ${count}`,
      );
    if (!Number.isSafeInteger(index) || index >= count)
      throw Error(`Piece index ${index} is not below the count ${count}`);
    if (program !== undefined && program.digest === digest)
      return harden({ complete: true, bytes: program.bytes });
    const bytes = utf8Bytes(text);
    if (bytes > programPieceBytes)
      throw Error(
        `A ${what} piece is at most ${programPieceBytes} bytes, not ${bytes}`,
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
          `A ${what} is at most ${maxProgramBytes} bytes in this build`,
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

/** @param {SessionProgram | undefined} program */
const programInfo = program =>
  program === undefined
    ? { digest: '', bytes: 0 }
    : { digest: program.digest, bytes: program.bytes };

/**
 * The operator settings M2 adds (m2-interfaces.md 1.4, 8.4, 10; W2.7): the
 * backends `listBackends` offers, the default backend and model of a
 * creation that names none (R4-21, R4-88) and the turn deadline (0: off).
 * The pool's own fields stay in `pool.js` `makePoolSettings`; `current()`
 * answers both as one `HarnessSettings` (export, 7.3).
 * @param {{ pool?: () => Record<string, number> }} [powers]
 */
export const makeHarnessSettings = ({ pool } = {}) => {
  /** @type {{ backends: any[], defaultBackend: any, defaultModelId: string | undefined, turnDeadlineMs: number }} */
  const current = {
    backends: [],
    defaultBackend: undefined,
    defaultModelId: undefined,
    turnDeadlineMs: 0,
  };
  return harden({
    /** @param {any} changes `shapes.HarnessSettings` */
    set: changes => {
      mustMatch(changes, shapes.HarnessSettings);
      if (changes.backends !== undefined)
        current.backends = [...changes.backends];
      if (changes.defaultBackend !== undefined)
        current.defaultBackend = changes.defaultBackend;
      if (changes.defaultModelId !== undefined)
        current.defaultModelId = changes.defaultModelId;
      if (changes.turnDeadlineMs !== undefined)
        current.turnDeadlineMs = changes.turnDeadlineMs;
    },
    backends: () => harden([...current.backends]),
    defaultBackend: () => current.defaultBackend,
    defaultModelId: () => current.defaultModelId,
    turnDeadlineMs: () => current.turnDeadlineMs,
    /** Every setting as one `shapes.HarnessSettings`. */
    current: () => {
      /** @type {Record<string, any>} */
      const all = { ...(pool?.() ?? {}), backends: [...current.backends] };
      if (current.defaultBackend !== undefined)
        all.defaultBackend = current.defaultBackend;
      if (current.defaultModelId !== undefined)
        all.defaultModelId = current.defaultModelId;
      all.turnDeadlineMs = current.turnDeadlineMs;
      return harden(all);
    },
  });
};
harden(makeHarnessSettings);

/** @typedef {ReturnType<typeof makeHarnessSettings>} HarnessSettings */

/** Export methods called on a root made without them (M1a tests). */
export const NO_EXPORT_TEXT = 'This harness root has no export';

/** Pool methods called on a root made without a pool (M1a tests). */
export const NO_POOL_TEXT = 'This harness root has no spare pool';

/**
 * The harness root (`interfaces.HarnessRoot`: M1b W1b.5 added the exec
 * program, pool settings and `whenSettled`; M2 W2.7 the export and import). Without `pool` (M1a tests)
 * `status()` has no `pool` or `execProgram` and the pool methods throw.
 * @param {object} powers
 * @param {any} powers.operator
 * @param {RowTable} powers.rows
 * @param {ProgramStore} powers.programs the session program
 * @param {ProgramStore} [powers.execPrograms] the exec program (M1b)
 * @param {Pool} [powers.pool] (M1b)
 * @param {HarnessSettings} [powers.settings] the M2 settings (W2.7)
 * @param {{ exportPage: (cursor?: string) => any, importSession: (options: any) => Promise<any> }} [powers.exports]
 *   data-only export and importing (W2.7, `export.js`)
 */
export const makeHarnessRoot = ({
  operator,
  rows,
  programs,
  execPrograms,
  pool,
  settings,
  exports,
}) => {
  const needExports = () => {
    if (exports === undefined) throw Error(NO_EXPORT_TEXT);
    return exports;
  };
  const needPool = () => {
    if (pool === undefined || execPrograms === undefined)
      throw Error(NO_POOL_TEXT);
    return { pool, execPrograms };
  };
  return makeExo('HarnessRoot', interfaces.HarnessRoot, {
    getOperator: () => operator,
    status: () => {
      const base = {
        sessions: rows.size(),
        program: programInfo(programs.current()),
      };
      if (pool === undefined || execPrograms === undefined) return harden(base);
      return harden({
        ...base,
        execProgram: programInfo(execPrograms.current()),
        pool: pool.status(),
      });
    },
    /** @param {any} piece a `shapes.ProgramPiece` (checked by the guard) */
    loadSessionProgram: piece => {
      const answer = programs.load(piece);
      if (answer.complete) pool?.programChanged();
      return answer;
    },
    /** @param {any} piece a `shapes.ProgramPiece` (checked by the guard) */
    loadExecProgram: piece => {
      const parts = needPool();
      const answer = parts.execPrograms.load(piece);
      if (answer.complete) parts.pool.programChanged();
      return answer;
    },
    /** @param {any} changes `shapes.HarnessSettings` (checked by the guard) */
    configure: changes => {
      const parts = needPool();
      settings?.set(changes);
      return parts.pool.configure(changes);
    },
    whenSettled: () => needPool().pool.whenSettled(),
    /** @param {string} [cursor] M2 W2.7 (m2-interfaces.md 7.3) */
    exportState: cursor => needExports().exportPage(cursor),
    /** @param {any} options M2 W2.7: a creation listed once imported */
    importSession: options => needExports().importSession(options),
  });
};
harden(makeHarnessRoot);
