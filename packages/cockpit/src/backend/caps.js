// @ts-check
//
// The capability model at the heart of the cockpit's thesis: authority lives
// in the caps a thread holds, not in its prompt. Attenuation is by SELECTION
// (subset), never by minting a lesser cap from a greater one — see
// designs/garden-cockpit.md § "Known gap to flag". A child thread may only be
// handed caps its parent already holds, and a read-only cap may not be
// upgraded to read-write.

export const READ_ONLY = 'readOnly';
harden(READ_ONLY);
export const READ_WRITE = 'readWrite';
harden(READ_WRITE);

/**
 * @typedef {object} Cap
 * @property {string} name   lexical binding name in the agent's scope
 * @property {string} kind   'workspace' | 'git' | any named-power kind
 * @property {'readOnly' | 'readWrite' | undefined} mode
 * @property {unknown} [value] the live capability object bound into scope
 */

/**
 * @param {{ name: string, kind: string, mode?: string, value?: unknown }} spec
 * @returns {Cap}
 */
export const makeCap = ({
  name,
  kind,
  mode = undefined,
  value = undefined,
}) => {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('cap name must be a non-empty string');
  }
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new Error('cap kind must be a non-empty string');
  }
  if (mode !== undefined && mode !== READ_ONLY && mode !== READ_WRITE) {
    throw new Error(`cap mode must be ${READ_ONLY}, ${READ_WRITE}, or absent`);
  }
  return harden({ name, kind, mode, value });
};
harden(makeCap);

/**
 * The mode lattice: read-only is an attenuation of read-write; a cap with no
 * mode is comparable only to the same absence.
 *
 * @param {string | undefined} child
 * @param {string | undefined} parent
 */
export const modeLeq = (child, parent) => {
  if (child === parent) return true;
  return child === READ_ONLY && parent === READ_WRITE;
};
harden(modeLeq);

/**
 * Is `child` an attenuation of (≤) `parent`? Same name and kind, mode ≤.
 *
 * @param {Cap} child
 * @param {Cap} parent
 */
export const capLeq = (child, parent) =>
  child.name === parent.name &&
  child.kind === parent.kind &&
  modeLeq(child.mode, parent.mode);
harden(capLeq);

/**
 * Every child cap must be ≤ some parent cap — the harness-enforced subset rule.
 *
 * @param {Cap[]} childCaps
 * @param {Cap[]} parentCaps
 */
export const capsSubset = (childCaps, parentCaps) =>
  childCaps.every(c => parentCaps.some(p => capLeq(c, p)));
harden(capsSubset);

/**
 * Explain the first reason `childCaps` is not a subset of `parentCaps`, or
 * undefined if it is a valid attenuation. Used for delegation error messages.
 *
 * @param {Cap[]} childCaps
 * @param {Cap[]} parentCaps
 * @returns {string | undefined}
 */
export const subsetViolation = (childCaps, parentCaps) => {
  for (const c of childCaps) {
    const held = parentCaps.find(p => p.name === c.name && p.kind === c.kind);
    if (held === undefined) {
      return `cap "${c.name}" (${c.kind}) is not held by the parent`;
    }
    if (!modeLeq(c.mode, held.mode)) {
      return `cap "${c.name}" cannot upgrade ${held.mode} to ${c.mode}`;
    }
  }
  return undefined;
};
harden(subsetViolation);

/**
 * A serialisable view of a cap (drops the live `value`) for the wire / UI.
 *
 * @param {Cap} cap
 */
export const capView = cap =>
  harden({ name: cap.name, kind: cap.kind, mode: cap.mode });
harden(capView);
