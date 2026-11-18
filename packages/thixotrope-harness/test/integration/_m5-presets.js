// @ts-check
/**
 * Shared by the M5 preset files (`m5-presets.test.js`: acceptance 2, K1,
 * K2; `m5-presets-inventory.test.js`: acceptance 13, 14): a slice from the
 * m1a state template with a scripted backend, the operator's catalogue and
 * inventory, and a preset found again by its label.
 */
import { E } from '@endo/far';

import { sliceScript } from '../fixtures/scripts/m1a-slice.js';
import { startFromTemplate } from '../template/index.js';
import { makeSlice, sliceTemplate } from './_m1a-slice.js';

/** @type {Awaited<ReturnType<typeof sliceTemplate>> | undefined} */
let template;

/** @param {import('ava').ExecutionContext} t */
export const open = async t => {
  template ??= await sliceTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(harden(sliceScript));
  return { state, slice, ...made };
};

/**
 * The catalogue and inventory of a slice's operator.
 * @param {any} slice
 */
export const operatorOf = async slice => {
  const operator = await E(slice.harness).getOperator();
  return {
    operator,
    catalog: await E(operator).getPresets(),
    inventory: await E(operator).getInventory(),
  };
};

/**
 * A preset found again by its label (presences die with their client).
 * @param {any} catalog
 * @param {string} label
 */
export const presetLabelled = async (catalog, label) => {
  for (const preset of await E(catalog).list()) {
    // eslint-disable-next-line no-await-in-loop
    if ((await E(preset).describe()).label === label) return preset;
  }
  return undefined;
};
