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
 * - `open({ labels, values, turnId }) -> number`;
 * - `take(number, edge, turnId?) -> object`: the object, when the package
 *   is open (and belongs to `turnId` when given), else throws
 *   `textOf.noPackage` / `textOf.noEdge`. The package keeps the object (an
 *   edge can be adopted twice, as Fae);
 * - `closeTurn(turnId)`: drops every package of the turn. Nothing else
 *   holds the objects afterwards (the queue entry let go of them at the
 *   claim), so they are released (R3-8).
 *
 * `packagesPart` is the `packages` entry of `m5-parts.js`. Its value:
 * `{ table, enqueueMessageOnce(submission, requestId, at, attachments) }`.
 * `enqueueMessageOnce` runs inside the Session method's crank (session.js
 * wraps it in `inCrank` after `refuseIfDeleting`): it checks the
 * attachments and the text bound before anything is written, then does
 * what `Session.enqueueOnce` does with the attachments kept in the entry.
 *
 * The turn hooks (`tools/mentions.js`) are module functions called with
 * `{ core, active }`; they find the session's part through `partOf(core)`,
 * a WeakMap from the session's `SessionCore` filled when the part is made
 * (rights amplification, no name).
 *
 * Guest rules.
 */
import { textOf } from '../lib/interfaces-m5.js';
import { limitsM5 } from '../lib/limits-m5.js';
import { isValidLabel } from './labels.js';

/**
 * @typedef {object} Package
 * @property {number} number
 * @property {readonly string[]} labels
 * @property {Map<string, any>} values
 * @property {string} turnId
 *
 * @typedef {ReturnType<typeof makePackages>} Packages
 * @typedef {{ table: Packages, enqueueMessageOnce: (submission: any, requestId: string, at: number, attachments: readonly { label: string, value: any }[]) => any }} PackagesPart
 */

/**
 * 2.6: the refusals of `enqueueMessageOnce`, before anything is written.
 * @param {any} submission inline `{ text }` or a StagedText
 * @param {readonly { label: string }[]} attachments
 */
export const checkAttachments = (submission, attachments) => {
  if (attachments.length > limitsM5.maxAttachments) {
    throw Error(textOf.tooManyAttachments(attachments.length));
  }
  /** @type {Set<string>} */
  const seen = new Set();
  for (const { label } of attachments) {
    if (!isValidLabel(label)) throw Error(textOf.reservedLabel(label));
    if (seen.has(label)) throw Error(textOf.duplicateAttachment(label));
    seen.add(label);
  }
  const max = limitsM5.packageTextUnits;
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
     * @param {{ labels: readonly string[], values: Map<string, any>, turnId: string }} pkg
     * @returns {number}
     */
    open: ({ labels, values, turnId }) => {
      last += 1;
      open.set(last, { number: last, labels, values, turnId });
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

/** @type {WeakMap<object, PackagesPart>} */
const parts = new WeakMap();

/**
 * The session's packages part, from its `SessionCore`.
 * @param {any} core
 * @returns {PackagesPart | undefined}
 */
export const partOf = core =>
  core !== null && typeof core === 'object' ? parts.get(core) : undefined;
harden(partOf);

export const packagesPart = harden({
  name: /** @type {const} */ ('packages'),
  /** @param {any} runtime */
  make: runtime => {
    const table = makePackages();
    /** @type {PackagesPart['enqueueMessageOnce']} */
    const enqueueMessageOnce = (submission, requestId, at, attachments) => {
      checkAttachments(submission, attachments);
      const { runner, queue } = runtime.session;
      runner.see(at);
      const { receipt, added } = queue.enqueueOnce(
        submission,
        requestId,
        at,
        attachments,
      );
      if (!added || runner.claimNext() === undefined) return receipt;
      return queue.receiptFor(requestId) ?? receipt;
    };
    const part = harden({ table, enqueueMessageOnce });
    const core = runtime.session?.core;
    if (core !== undefined) parts.set(core, part);
    return part;
  },
});
