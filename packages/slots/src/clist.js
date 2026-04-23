// @ts-check

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

import { Direction, Kind, descriptorKey } from './descriptor.js';
import { sessionIdFromLabel } from './session.js';

/** @import { Descriptor } from './descriptor.js' */

const kindFieldName = harden({
  [Kind.Object]: 'object',
  [Kind.Promise]: 'promise',
  [Kind.Answer]: 'answer',
  [Kind.Device]: 'device',
});

/**
 * Create a per-session c-list: a bidirectional map between local
 * values (objects/promises) and their wire descriptors, plus the
 * monotonic counters for allocating local positions.
 *
 * This mirrors `rust/endo/slots/src/session.rs::Session` in shape,
 * but holds plain JS values instead of daemon-side krefs — a peer
 * that wants to associate a descriptor with a kref stores it
 * externally and references the descriptor by [`descriptorKey`].
 *
 * @param {object} opts
 * @param {string} opts.label
 */
export const makeCList = ({ label }) => {
  const id = sessionIdFromLabel(label);

  /** @type {Map<unknown, Descriptor>} */
  const valToDesc = new Map();
  /** @type {Map<string, unknown>} */
  const keyToVal = new Map();

  // Monotonic counters.  Object/Promise/Device start at 1;
  // Answer starts at 0, matching the Rust crate.
  const next = {
    object: 1,
    promise: 1,
    answer: 0,
    device: 1,
  };

  /**
   * @param {0 | 1 | 2 | 3} kind
   * @returns {number}
   */
  const allocLocal = kind => {
    const field = kindFieldName[kind];
    if (!field) {
      throw makeError(X`invalid kind ${q(kind)}`);
    }
    const id2 = next[field];
    next[field] += 1;
    return id2;
  };

  /**
   * Ensure that `val` has a local descriptor in this c-list.
   * Returns the (possibly newly-allocated) descriptor.
   *
   * @param {unknown} val
   * @param {0 | 1 | 2 | 3} [kind]
   * @returns {Descriptor}
   */
  const exportLocal = (val, kind = Kind.Object) => {
    const existing = valToDesc.get(val);
    if (existing) return existing;
    const position = allocLocal(kind);
    /** @type {Descriptor} */
    const desc = harden({ dir: Direction.Local, kind, position });
    valToDesc.set(val, desc);
    keyToVal.set(descriptorKey(desc), val);
    return desc;
  };

  /**
   * Import a remote descriptor, returning an existing local
   * placeholder if one is already registered, or installing the
   * newly-created `makePlaceholder()` return value otherwise.
   *
   * @param {Descriptor} desc
   * @param {() => unknown} makePlaceholder
   * @returns {unknown}
   */
  const importRemote = (desc, makePlaceholder) => {
    const key = descriptorKey(desc);
    const existing = keyToVal.get(key);
    if (existing !== undefined) return existing;
    const placeholder = makePlaceholder();
    keyToVal.set(key, placeholder);
    valToDesc.set(placeholder, harden({ ...desc }));
    return placeholder;
  };

  /**
   * Look up a value by descriptor.
   *
   * @param {Descriptor} desc
   */
  const lookupByDescriptor = desc => keyToVal.get(descriptorKey(desc));

  /**
   * Look up a descriptor by value.
   *
   * @param {unknown} val
   */
  const lookupByValue = val => valToDesc.get(val);

  /**
   * Drop the mapping for a descriptor.  The caller owns refcount
   * bookkeeping; this just removes the entry from the local tables.
   *
   * @param {Descriptor} desc
   */
  const drop = desc => {
    const key = descriptorKey(desc);
    const val = keyToVal.get(key);
    if (val === undefined) return false;
    keyToVal.delete(key);
    valToDesc.delete(val);
    return true;
  };

  return harden({
    id,
    label,
    exportLocal,
    importRemote,
    lookupByDescriptor,
    lookupByValue,
    drop,
    size: () => keyToVal.size,
  });
};
harden(makeCList);
