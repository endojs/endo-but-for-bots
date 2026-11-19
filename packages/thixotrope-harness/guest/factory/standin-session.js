// @ts-check
/**
 * A stand-in session program for the factory's own tests (M1a W1a.6).
 *
 * Not the session program: W1a.4/W1a.5 write `guest/session/main.js`, and
 * W1a.7 switches provisioning to it. This module lets the factory's
 * creation path (createWorker, staged bundle, evaluating crank,
 * `make(config)`) be tested end to end now. It is bundled on its own
 * (`bundleGuest('guest/factory/standin-session.js')`), never by the
 * factory's `main.js`.
 *
 * It satisfies the contract's guards: `makeSpareMaker()` returns a
 * `SpareMaker`; `make` returns a guarded `Session` and `SessionInternal`
 * (the one `Session` guard since the fold, F2). Session methods that need
 * the turn machinery throw; the methods it has no state for (`findTurn`,
 * `enqueueMessageOnce`, `grants`, `blobPage`, `deleteSelf`, the export and
 * import) refuse. Two titles given to
 * `rename` drive the factory tests:
 * - `STANDIN_WORKING` reports `activity: 'working'` (as a claim would);
 * - `STANDIN_HALT` loops until the crank budget halts the vat (a lost
 *   session, D-17).
 * Any other title is a plain rename, reported to the row.
 *
 * Guest rules: prelude globals only.
 */
import { interfaces } from '../lib/guards/factory.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, makeExo } = /** @type {GuestGlobals} */ (globalThis);

export const STANDIN_WORKING = 'stand-in: working';
export const STANDIN_HALT = 'stand-in: halt';
const NOT_HERE = 'The stand-in session has no turns';

/**
 * An M2 method the stand-in does not implement (m2-interfaces.md 1.3: the
 * folded guard names it, so the exo needs it; a call refuses).
 * @param {string} method
 */
const refuse = method => () => {
  throw Error(`The stand-in session does not implement ${method}`);
};

const zeroUsage = harden({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
  context: { usedTokens: 0, windowTokens: 0 },
  turns: 0,
  incompleteTurns: 0,
});

/** @param {any} makeArgs `shapes.MakeArgs` (checked by the guard) */
const makeSession = ({ config, rowReporter }) => {
  let title = config.title;
  /** @type {'passive' | 'working' | 'error'} */
  let activity = 'passive';
  let rev = 1;
  const info = () =>
    harden({
      key: config.key,
      title,
      backendTitle: config.backendTitle,
      modelId: config.modelId,
      presetLabel: config.preset.label,
      createdAt: config.createdAt,
    });
  const session = makeExo('Session', interfaces.Session, {
    getInfo: info,
    /** @param {string} next */
    rename: next => {
      if (next === STANDIN_HALT) {
        for (;;) {
          rev += 1;
        }
      }
      if (next === STANDIN_WORKING) {
        activity = 'working';
        E.sendOnly(rowReporter).changed(harden({ activity }));
        return undefined;
      }
      title = next;
      rev += 1;
      E.sendOnly(rowReporter).changed(harden({ title }));
      return undefined;
    },
    watch: () =>
      harden({ rev, info: info(), pending: { entries: [] }, usage: zeroUsage }),
    enqueueOnce: () => {
      throw Error(NOT_HERE);
    },
    getSubmissionReceipt: () => undefined,
    listPending: () => harden({ entries: [] }),
    startTurn: () => {
      throw Error(NOT_HERE);
    },
    getCurrentTurn: () => undefined,
    getHistoryPage: () => harden({ turns: [] }),
    getUsage: () => zeroUsage,
    findTurn: () => {
      throw Error(NOT_HERE);
    },
    enqueueMessageOnce: () => {
      throw Error(NOT_HERE);
    },
    grants: refuse('grants'),
    // The environment and mail methods (WX.1).
    emergencyStop: refuse('emergencyStop'),
    resume: refuse('resume'),
    getExecutionState: refuse('getExecutionState'),
  });
  const internal = makeExo('SessionInternal', interfaces.SessionInternal, {
    rowSnapshot: () =>
      harden({ title, activity, messageCount: 0, queuedCount: 0 }),
    blobPage: refuse('blobPage'),
    deleteSelf: refuse('deleteSelf'),
    exportState: refuse('exportState'),
    importState: refuse('importState'),
    deliverMail: refuse('deliverMail'),
    cancelMail: refuse('cancelMail'),
  });
  return harden({ session, internal });
};

/** The program's entry: the completion value of the evaluating crank. */
export const makeSpareMaker = () => {
  let made = false;
  return makeExo('SpareMaker', interfaces.SpareMaker, {
    /** @param {any} makeArgs */
    make: makeArgs => {
      if (made) throw Error('This session vat was already made');
      made = true;
      return makeSession(makeArgs);
    },
  });
};
harden(makeSpareMaker);
