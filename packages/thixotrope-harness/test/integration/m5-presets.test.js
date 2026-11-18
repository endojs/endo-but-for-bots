// @ts-check
/**
 * M5 acceptance 2 with kill points K1 and K2 (designs/m5-interfaces.md 5,
 * 8.1; W5.1), through the daemon from the m1a state template (the real
 * factory program, a scripted backend):
 *
 *  2. Catalogue edits and revisions: two control clients; A saves at r
 *     (answer r + 1); B's save at r is refused stale; B re-reads A's
 *     record; deleting a built-in is refused, `reset` restores it; a record
 *     of three-byte text over `presetRecordBytes` is refused and changes
 *     nothing. K1: a save killed before or after its answer is applied at
 *     most once and a retry at the old revision is refused stale. K2: a
 *     creation from a preset with endowments killed while it runs leaves
 *     nothing half-made; the next creation from it gets its endowments.
 *
 * Acceptance 13 and 14 are in `m5-presets-inventory.test.js` (XC split the
 * file, which held 334 s, so each stays under 5 minutes).
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/m5-presets.test.js
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { texts } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { emit } from '../../perf/_harness.mjs';
import { names } from '../../scripts/provision-steps.js';
import { sliceScript } from '../fixtures/scripts/m1a-slice.js';
import {
  TEMPLATE_WORKSPACE,
  integrationEnabled,
  takeIntegrationLock,
} from '../template/index.js';
import { waitFor } from './_m1a-slice.js';
import { open, operatorOf, presetLabelled } from './_m5-presets.js';

takeIntegrationLock(test, 'm5 presets test');

const run = integrationEnabled ? test.serial : test.skip;

/** @param {number} units */
const wide = units => '€'.repeat(units);

run(
  '2 and K1: revisions between two clients, built-in rules, the size bound, a save killed before or after its answer',
  async t => {
    t.timeout(4 * 60_000);
    const { state, slice, backend } = await open(t);
    const a = await operatorOf(slice);
    // A second control client on the same state.
    const clientB = await state.connect({ workspace: TEMPLATE_WORKSPACE });
    t.teardown(() => clientB.close());
    const harnessB = await clientB.call('lookup', names.harness);
    const b = {
      catalog: await E(await E(harnessB).getOperator()).getPresets(),
    };

    const { revision: r0 } = await E(a.catalog).configuration();
    const created = await E(a.catalog).create(
      harden({ label: 'Helper', template: 'general', instructions: 'v1' }),
      r0,
    );
    const r = created.revision;
    const presetB = await presetLabelled(b.catalog, 'Helper');
    t.truthy(presetB);
    const s0 = performance.now();
    t.is(
      await E(created.preset).save(
        harden({ label: 'Helper', template: 'general', instructions: 'A' }),
        r,
      ),
      r + 1,
    );
    const saveMs = performance.now() - s0;
    await t.throwsAsync(
      E(presetB).save(
        harden({ label: 'Helper', template: 'general', instructions: 'B' }),
        r,
      ),
      { message: texts.presetStale },
    );
    t.is((await E(presetB).describe()).instructions, 'A');
    t.is((await E(b.catalog).configuration()).revision, r + 1);

    // Built-ins: delete refused, reset restores.
    const general = await presetLabelled(a.catalog, 'general');
    await t.throwsAsync(E(general).delete(r + 1), {
      message: texts.builtInNotDeletable,
    });
    const r2 = await E(general).save(
      harden({ label: 'general', template: 'general', instructions: 'x' }),
      r + 1,
    );
    const r3 = await E(general).reset(r2);
    t.is((await E(general).describe()).instructions, '');

    // Three-byte text just over the whole-record bound: refused, nothing
    // changes.
    const over = harden({
      label: wide(limits.presetLabelUnits),
      template: 'general',
      backend,
      description: wide(limits.presetDescriptionUnits),
      instructions: wide(limits.presetInstructionsUnits),
      modelId: wide(256),
      endowments: Array.from({ length: limits.maxEndowments }, (_, i) =>
        harden({ label: `${i}${wide(78)}`, value: backend }),
      ),
    });
    await t.throwsAsync(E(a.catalog).create(over, r3), {
      message: texts.presetTooLarge,
    });
    t.is((await E(a.catalog).configuration()).revision, r3);
    t.is(
      await presetLabelled(a.catalog, wide(limits.presetLabelUnits)),
      undefined,
    );

    // K1 (after the answer): the save is durable across a SIGKILL.
    await state.kill();
    await state.restart();
    await slice.refresh();
    let ops = await operatorOf(slice);
    let helper = await presetLabelled(ops.catalog, 'Helper');
    t.is((await E(helper).describe()).instructions, 'A');
    t.is((await E(ops.catalog).configuration()).revision, r3);

    // K1 (before the answer): kill while the save is in flight; afterwards
    // it is applied at most once, and a retry at the old revision is stale
    // if it was.
    void E(helper)
      .save(
        harden({ label: 'Helper', template: 'general', instructions: 'K1' }),
        r3,
      )
      .catch(() => undefined);
    await state.kill();
    await state.restart();
    await slice.refresh();
    ops = await operatorOf(slice);
    helper = await presetLabelled(ops.catalog, 'Helper');
    const after = await E(ops.catalog).configuration();
    const view = await E(helper).describe();
    t.true(
      (after.revision === r3 && view.instructions === 'A') ||
        (after.revision === r3 + 1 && view.instructions === 'K1'),
      JSON.stringify({ revision: after.revision, r3 }),
    );
    if (after.revision === r3 + 1) {
      await t.throwsAsync(
        E(helper).save(
          harden({ label: 'Helper', template: 'general', instructions: 'K1' }),
          r3,
        ),
        { message: texts.presetStale },
      );
    } else {
      t.is(
        await E(helper).save(
          harden({ label: 'Helper', template: 'general', instructions: 'K1' }),
          r3,
        ),
        r3 + 1,
      );
    }
    emit({
      metric: 'm5.presets.k1',
      appliedBeforeKill: after.revision === r3 + 1,
      saveMs: Math.round(saveMs),
      by: 'W5.1',
    });
  },
);

run(
  'K2: a creation from a preset with endowments killed while it runs leaves nothing half-made',
  async t => {
    t.timeout(4 * 60_000);
    const { state, slice, backend } = await open(t);
    const notes = (await slice.makeBackend(harden(sliceScript), { label: 'n' }))
      .backend;
    let ops = await operatorOf(slice);
    const { revision } = await E(ops.catalog).configuration();
    await E(ops.catalog).create(
      harden({
        label: 'Endowed',
        template: 'general',
        backend,
        endowments: [{ label: 'notes', value: notes }],
      }),
      revision,
    );
    let preset = await presetLabelled(ops.catalog, 'Endowed');
    const workersBefore = new Set(
      (await slice.workers()).map((/** @type {any} */ w) => w.workerId),
    );
    const c0 = Date.now();
    const creating = E(slice.factory)
      .createSession(harden({ title: 'cut', preset, at: Date.now() }))
      .catch(() => undefined);
    await waitFor(
      async () =>
        Date.now() - c0 > 300 ||
        (await slice.workers()).some(
          (/** @type {any} */ w) => !workersBefore.has(w.workerId),
        ),
      30_000,
      'a new vat or 300 ms',
      20,
    );
    await state.kill();
    await creating;
    await state.restart();
    await slice.refresh();
    const settled = await waitFor(
      async () => {
        const page = await E(slice.factory).listSessions();
        const status = await E(slice.harness).status();
        return status.sessions === page.rows.length ? page : undefined;
      },
      30_000,
      'no half-made row',
    );
    t.true(
      settled.rows.every((/** @type {any} */ r) => r.state === 'ready'),
      JSON.stringify(settled.rows.map((/** @type {any} */ r) => r.state)),
    );
    // The preset is intact and the next creation from it succeeds (the
    // backend comes from the preset; the session holds the endowment, which
    // W5.3's label map shows).
    ops = await operatorOf(slice);
    preset = await presetLabelled(ops.catalog, 'Endowed');
    const view = await E(preset).describe();
    t.deepEqual(
      view.endowments.map((/** @type {any} */ e) => e.label),
      ['notes'],
    );
    const session = await E(slice.factory).createSession(
      harden({ title: 'whole', preset, at: Date.now() }),
    );
    t.like(await E(session).getInfo(), { presetLabel: 'Endowed' });
    emit({
      metric: 'm5.presets.k2',
      listed: settled.rows.length,
      by: 'W5.1',
    });
  },
);
