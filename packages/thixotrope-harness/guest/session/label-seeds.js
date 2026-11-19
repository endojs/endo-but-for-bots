// @ts-check
/**
 * Label seeds (W5.3; `designs/m5-interfaces.md` 2.4.1, section 11): a hook
 * table, append-only. Each entry is
 *
 *   { label, from(services, config) -> object | undefined }
 *
 * and binds the object it answers under `label` (source `preset`) when the
 * session is made, after the preset's endowments. M6 appends `workspace`
 * and `shell` (the environment's objects, when the preset selects them).
 * A seed whose label is taken fails `make` (the preset catalogue's
 * validation makes that unreachable).
 */

/** @import { LabelSeed } from './labels.js' */

/**
 * @typedef {object} LabelSeedEntry
 * @property {string} label
 * @property {(services: any, config: any) => any} from
 */

/** @type {readonly LabelSeedEntry[]} */
export const labelSeeds = harden([
  // m6-interfaces.md 3.8 (seam L-1): the `Git` writer and the `Shell`.
  { label: 'workspace', from: (/** @type {any} */ s) => s?.workspace },
  { label: 'shell', from: (/** @type {any} */ s) => s?.shell },
]);

/**
 * The seeds of one session, in order: `services.endowments` (source
 * `endowment`), then each entry of `table` that answers an object.
 * @param {any} services SessionServices
 * @param {any} config SessionConfig
 * @param {readonly LabelSeedEntry[]} [table]
 * @returns {LabelSeed[]}
 */
export const seedsFor = (services, config, table = labelSeeds) => {
  /** @type {LabelSeed[]} */
  const seeds = [];
  for (const { label, value } of services?.endowments ?? []) {
    seeds.push(harden({ label, value, source: 'endowment' }));
  }
  for (const entry of table) {
    const value = entry.from(services, config);
    if (value !== undefined) {
      seeds.push(harden({ label: entry.label, value, source: 'preset' }));
    }
  }
  return harden(seeds);
};
harden(seedsFor);
