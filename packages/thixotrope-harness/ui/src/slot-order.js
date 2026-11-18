// @ts-check
/**
 * Slot order (m3-interfaces.md 6.2): the features of one slot by `order`
 * (default 100), collection order among equals. Its own module, with no
 * import of `feature-list.js` (M3-FIX): `features.js` waits on the Node
 * feature list, which imports the views, so a view that reached this
 * function through `features.js` deadlocked the module graph in Node.
 */

/** @import { UiFeature } from '../../resources/agent-host/impl/gateway/contract-m3.js' */

/** The default `order` of a feature within its slot. */
export const DEFAULT_ORDER = 100;

/**
 * The features of one slot, by `order` (default 100), collection order
 * among equals.
 *
 * @param {readonly UiFeature[]} list
 * @param {string} slot
 * @returns {UiFeature[]}
 */
export const selectSlot = (list, slot) =>
  list
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.slot === slot)
    .sort(
      (a, b) =>
        (a.item.order ?? DEFAULT_ORDER) - (b.item.order ?? DEFAULT_ORDER) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
