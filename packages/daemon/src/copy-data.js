// @ts-check

import { Fail } from '@endo/errors';
import { passStyleOf } from '@endo/pass-style';

/** @import { PureData } from '@endo/pass-style' */

/**
 * Validate pass-by-copy session data without admitting nested capabilities,
 * promises, errors, or accessors. Inspect descriptors before passStyleOf so
 * an ordinary nested accessor is refused without evaluating its getter.
 * This uses the existing pass-style rules for frozen passable containers;
 * it is not a membrane for arbitrary local JavaScript proxies.
 *
 * @type {(value: unknown) => asserts value is PureData}
 */
export const assertCopyData = value => {
  /** @type {unknown[]} */
  const pending = [value];
  /** @type {Set<object>} */
  const objects = new Set();
  while (pending.length !== 0) {
    const next = pending.pop();
    typeof next !== 'function' || Fail`Session protocol requires copy data`;
    if (typeof next !== 'object' || next === null || objects.has(next)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    objects.add(next);
    for (const key of Reflect.ownKeys(next)) {
      const descriptor = Object.getOwnPropertyDescriptor(next, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw Fail`Session protocol copy data cannot contain accessors`;
      }
      pending.push(descriptor.value);
    }
  }
  // Establish passability, including valid container shapes and no cycles.
  passStyleOf(value);
  for (const object of objects) {
    const style = passStyleOf(object);
    style === 'copyRecord' ||
      style === 'copyArray' ||
      style === 'tagged' ||
      style === 'byteArray' ||
      Fail`Session protocol requires copy data, not ${style}`;
  }
};
harden(assertCopyData);
