// @ts-check
/**
 * Packages: the objects a message carries into its turn (W5.7;
 * `designs/m5-interfaces.md` 2.6; R3-8, R3-9, R4-29, R4-38, R4-99).
 *
 * `makePackages()` is the per-session table `Map<number, Package>`,
 * `Package = { number, labels, values: Map<label, object>, turnId }`.
 * `number` is a per-session counter from 1 (M9's inbox opens its packages
 * through the same `open`). Labels are Map keys only (rule 12.10).
 *
 * - `open({ number?, labels, values, turnId }) -> number`: `number` when
 *   given (one `reserve` answered), else the next of the counter;
 * - `reserve(above = 0) -> number` (m9-interfaces.md D-M9-7, D-M9-21):
 *   raises the counter, above `above` when given, and opens nothing: an
 *   inbox message keeps its number from delivery to its turn's claim;
 * - `take(number, edge, turnId?) -> object`: the object, when the package
 *   is open (and belongs to `turnId` when given), else throws
 *   `textOf.noPackage` / `textOf.noEdge`. The package keeps the object (an
 *   edge can be adopted twice, as Fae);
 * - `closeTurn(turnId)`: drops every package of the turn. Nothing else
 *   holds the objects afterwards (the queue entry let go of them at the
 *   claim), so they are released (R3-8).
 *
 * `packagesPart` is the `packages` entry of `runtime-parts.js`. Its value:
 * `{ table, hooks }`. `Session.enqueueMessageOnce` (session.js) calls
 * `checkAttachments` before anything is written, then the session's one
 * enqueue with the attachments kept in the entry.
 *
 * The part's hooks (closing over its table):
 * - `onClaim` (seam S3, claim crank, after `TurnStarted`): an entry with
 *   attachments opens a package for the new turn and sets the turn's
 *   `systemNote` to `textOf.mentionLine(number, labels)`; every round
 *   request of that turn carries it (S2), later turns do not.
 * - `onSettle` (settle crank, recovery's settle included) and `onRecover`
 *   (recovery step 6, before that settle): the turn's packages are closed,
 *   their objects released.
 *
 * Guest rules.
 */
import { textOf } from '../lib/guards/session.js';
import { limits } from '../lib/limits.js';
import { isValidLabel } from './labels.js';

/**
 * @typedef {object} Package
 * @property {number} number
 * @property {readonly string[]} labels
 * @property {Map<string, any>} values
 * @property {string} turnId
 *
 * @typedef {ReturnType<typeof makePackages>} Packages
 */
/** @import { HookTurn } from './runtime-parts.js' */

/**
 * 2.6: the refusals of `enqueueMessageOnce`, before anything is written.
 * @param {any} submission inline `{ text }` or a StagedText
 * @param {readonly { label: string }[]} attachments
 */
export const checkAttachments = (submission, attachments) => {
  if (attachments.length > limits.maxAttachments) {
    throw Error(textOf.tooManyAttachments(attachments.length));
  }
  /** @type {Set<string>} */
  const seen = new Set();
  for (const { label } of attachments) {
    if (!isValidLabel(label)) throw Error(textOf.reservedLabel(label));
    if (seen.has(label)) throw Error(textOf.duplicateAttachment(label));
    seen.add(label);
  }
  const max = limits.packageTextUnits;
  const { text } = submission;
  if (typeof text === 'string') {
    if (text.length > max) throw Error(textOf.packageTooLong(text.length));
  } else {
    const bytes = /** @type {number} */ (submission.bytes);
    // A unit is at most 3 bytes, so this is a lower bound of the units.
    if (bytes > 3 * max) {
      throw Error(textOf.packageTooLong(Math.ceil(bytes / 3)));
    }
  }
};
harden(checkAttachments);

export const makePackages = () => {
  /** @type {Map<number, Package>} */
  const open = new Map();
  let last = 0;
  return harden({
    /**
     * @param {{ number?: number, labels: readonly string[], values: Map<string, any>, turnId: string }} pkg
     * @returns {number}
     */
    open: ({ number = (last += 1), labels, values, turnId }) => {
      open.set(number, { number, labels, values, turnId });
      return number;
    },
    /** @param {number} [above] */
    reserve: (above = 0) => {
      last = Math.max(last, above) + 1;
      return last;
    },
    /**
     * @param {number} number
     * @param {string} edge
     * @param {string} [turnId]
     */
    take: (number, edge, turnId) => {
      const pkg = open.get(number);
      if (
        pkg === undefined ||
        (turnId !== undefined && pkg.turnId !== turnId)
      ) {
        throw Error(textOf.noPackage(number));
      }
      if (!pkg.values.has(edge)) throw Error(textOf.noEdge(number, edge));
      return pkg.values.get(edge);
    },
    /** @param {string} turnId */
    closeTurn: turnId => {
      for (const [number, pkg] of open) {
        if (pkg.turnId === turnId) open.delete(number);
      }
    },
    size: () => open.size,
  });
};
harden(makePackages);

export const packagesPart = harden({
  name: /** @type {const} */ ('packages'),
  make: () => {
    const table = makePackages();
    /** @param {HookTurn} turn */
    const closePackages = ({ active }) => {
      table.closeTurn(active.turnId);
    };
    return harden({
      table,
      hooks: harden({
        /**
         * @param {HookTurn} turn
         * @param {any} item the queue entry, or undefined
         */
        onClaim: ({ active }, item) => {
          /** @type {readonly { label: string, value: any }[] | undefined} */
          const attachments = item?.attachments;
          if (attachments === undefined || attachments.length === 0) return;
          const labels = harden(attachments.map(a => a.label));
          const number = table.open({
            labels,
            values: new Map(attachments.map(a => [a.label, a.value])),
            turnId: active.turnId,
          });
          active.systemNote = textOf.mentionLine(number, labels);
        },
        onSettle: closePackages,
        onRecover: closePackages,
      }),
    });
  },
});
