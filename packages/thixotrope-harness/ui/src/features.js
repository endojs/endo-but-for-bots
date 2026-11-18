// @ts-check
/**
 * The UI feature collector (m3-interfaces.md 6.2; W3.4). Every
 * `ui/src/<dir>/feature.js` exports `feature`: one `UiFeature` or an array of
 * them. `ui/build.mjs` generates the list of those files (directory-name
 * order) into the bundle in place of `./feature-list.js`; in Node,
 * `./feature-list.js` finds the same files itself. Nobody edits this file or
 * a list to add a feature: a lane adds its directory.
 *
 * A `feature.js` must not import this module (the Node list loads the
 * feature files while this module waits for it); slot components receive
 * what they need through their props.
 */
import { uiSlots } from '../../resources/agent-host/impl/gateway/contract-m3.js';
import { featureEntries } from './feature-list.js';
import { DEFAULT_ORDER, selectSlot } from './slot-order.js';

export { DEFAULT_ORDER, selectSlot };

/** @import { UiFeature } from '../../resources/agent-host/impl/gateway/contract-m3.js' */

const slotSet = new Set(uiSlots);

/**
 * Check and flatten the `feature` exports of feature modules, in the order
 * given (directory-name order, then array order within a file). Throws on a
 * missing export, an unknown slot, a missing component, an id that is not
 * the directory name or `<dir>.<part>`, and a duplicate id: the build fails.
 *
 * @param {Array<{ dir: string, module: Record<string, any> }>} entries
 * @returns {UiFeature[]}
 */
export const collectFeatures = entries => {
  /** @type {UiFeature[]} */
  const collected = [];
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const { dir, module } of entries) {
    const exported = module.feature;
    if (exported === undefined || exported === null) {
      throw Error(`ui/src/${dir}/feature.js has no "feature" export`);
    }
    const list = Array.isArray(exported) ? exported : [exported];
    if (list.length === 0) {
      throw Error(`ui/src/${dir}/feature.js exports an empty feature array`);
    }
    for (const item of list) {
      const id = item && item.id;
      if (typeof id !== 'string' || id === '') {
        throw Error(`ui/src/${dir}/feature.js: a feature has no id`);
      }
      if (id !== dir && !id.startsWith(`${dir}.`)) {
        throw Error(
          `ui/src/${dir}/feature.js: feature id "${id}" must be "${dir}" or "${dir}.<part>"`,
        );
      }
      const previous = seen.get(id);
      if (previous !== undefined) {
        throw Error(
          `duplicate UI feature id "${id}" (ui/src/${previous}/feature.js and ui/src/${dir}/feature.js)`,
        );
      }
      if (!slotSet.has(item.slot)) {
        throw Error(
          `ui/src/${dir}/feature.js: feature "${id}" names unknown slot "${item.slot}"`,
        );
      }
      if (typeof item.component !== 'function') {
        throw Error(
          `ui/src/${dir}/feature.js: feature "${id}" has no component function`,
        );
      }
      if (item.send !== undefined && item.slot !== 'composer.addon') {
        throw Error(
          `ui/src/${dir}/feature.js: feature "${id}" has send but is not a composer.addon`,
        );
      }
      seen.set(id, dir);
      collected.push(item);
    }
  }
  return collected;
};

/** Every collected `UiFeature`, in collection order. */
export const features = Object.freeze(collectFeatures(featureEntries));

/**
 * The collected features of one slot (`uiSlots`), in slot order.
 *
 * @param {string} slot
 * @returns {UiFeature[]}
 */
export const featuresFor = slot => selectSlot(features, slot);
