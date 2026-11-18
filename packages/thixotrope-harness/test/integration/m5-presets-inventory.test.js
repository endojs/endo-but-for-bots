// @ts-check
/**
 * M5 acceptance 13 and 14 (designs/m5-interfaces.md 8.1; W5.1), through the
 * daemon from the m1a state template (split from `m5-presets.test.js` by
 * XC so each file stays under 5 minutes):
 *
 * 13. Inventory: add, page, relabel, remove; a duplicate label refused; a
 *     removed entry's methods refuse; `addAll` of 51 refused by the guard;
 *     entries survive a SIGKILL restart.
 * 14. Export and import of presets: user presets come back with label,
 *     template, instructions and model defaults (backend by label), without
 *     endowments.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/m5-presets-inventory.test.js
 */
import '../unit/_m1a-prelude.js';

import { rm } from 'node:fs/promises';
import path from 'node:path';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { textOf, texts } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { exportState, importState } from '../../scripts/export.mjs';
import {
  integrationEnabled,
  shortName,
  takeIntegrationLock,
  tmpRoot,
} from '../template/index.js';
import { open, operatorOf, presetLabelled } from './_m5-presets.js';

takeIntegrationLock(test, 'm5 presets inventory test');

/** @type {string[]} */
const files = [];
test.after.always(() =>
  Promise.all(files.map(file => rm(file, { force: true }))),
);

const run = integrationEnabled ? test.serial : test.skip;

run(
  '13: inventory add, page, relabel, remove; refusals; entries survive a restart',
  async t => {
    t.timeout(4 * 60_000);
    const { state, slice, backend } = await open(t);
    let { inventory } = await operatorOf(slice);
    const entry = await E(inventory).add('notes', backend);
    t.deepEqual(await E(entry).describe(), { label: 'notes' });
    await t.throwsAsync(E(inventory).add('notes', backend), {
      message: textOf.inventoryLabelTaken('notes'),
    });
    const batch = (/** @type {number} */ n, /** @type {number} */ from) =>
      harden(
        Array.from({ length: n }, (_, i) =>
          harden({ label: `item-${from + i}`, value: backend }),
        ),
      );
    await t.throwsAsync(E(inventory).addAll(batch(51, 0)));
    t.is((await E(inventory).list()).rows.length, 1);
    await E(inventory).addAll(batch(50, 0));
    const first = await E(inventory).list();
    t.is(first.rows.length, 50);
    t.is(first.next, 'i50');
    const second = await E(inventory).list(first.next);
    t.deepEqual(
      second.rows.map((/** @type {any} */ row) => row.label),
      ['item-49'],
    );
    await E(entry).relabel('journal');
    t.is(first.rows[0].label, 'notes');
    t.is((await E(inventory).list()).rows[0].label, 'journal');
    const removed = second.rows[0].entry;
    await E(removed).remove();
    await t.throwsAsync(E(removed).describe(), { message: texts.entryRemoved });
    const rev = await E(inventory).rev();

    await state.kill();
    await state.restart();
    await slice.refresh();
    ({ inventory } = await operatorOf(slice));
    t.is(await E(inventory).rev(), rev);
    const page = await E(inventory).list();
    t.is(page.rows.length, 50);
    t.is(page.next, undefined);
    t.is(page.rows[0].label, 'journal');
  },
);

run(
  '14: user presets are exported and imported with model defaults (backend by label), without endowments',
  async t => {
    t.timeout(4 * 60_000);
    const source = await open(t);
    const ops = await operatorOf(source.slice);
    const { revision } = await E(ops.catalog).configuration();
    await E(ops.catalog).create(
      harden({
        label: 'Exported',
        template: 'general',
        description: 'kept',
        instructions: 'Answer in French.',
        backend: source.backend,
        modelId: 'scripted-model',
        endowments: [{ label: 'notes', value: source.backend }],
      }),
      revision,
    );
    const file = path.join(tmpRoot, `${shortName('p')}.jsonl`);
    files.push(file);
    const exported = await exportState({ client: source.state.client, file });
    t.is(exported.presets, 1);
    await source.state.stop();

    const target = await open(t);
    const imported = await importState({
      client: target.state.client,
      file,
      backends: [target.backend],
    });
    t.is(imported.presets, 1);
    const catalog = (await operatorOf(target.slice)).catalog;
    const preset = await presetLabelled(catalog, 'Exported');
    t.truthy(preset);
    const view = await E(preset).describe();
    t.like(view, {
      label: 'Exported',
      template: 'general',
      description: 'kept',
      instructions: 'Answer in French.',
      modelId: 'scripted-model',
      builtIn: false,
    });
    t.deepEqual(view.endowments, []);
    t.is(
      (await E(view.backend).describe()).label,
      (await E(target.backend).describe()).label,
    );
  },
);
