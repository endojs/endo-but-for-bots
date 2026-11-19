// @ts-check
// M5 W5.1: how a preset becomes a session (designs/m5-interfaces.md 2.3)
// and the M5 Operator (2.2), in the factory vat program in Node with
// in-memory fakes. The session program is a fake maker that records its
// `make` argument.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { createHash } from 'node:crypto';

/* eslint-disable import/no-relative-packages */
import {
  shapes,
  methodNames,
  textOf,
  texts,
} from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { subscriptionTexts } from '../../guest/lib/subscription-texts.js';
import { makeFactoryKit, stagingSources } from '../../guest/factory/factory.js';
import { makeStartCount } from '../../guest/factory/starts.js';
import { makeProgramStore } from '../../guest/factory/root.js';
import { makeRowTable } from '../../guest/factory/rows.js';
import { serviceBuilders } from '../../guest/factory/services.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makePromiseKit, matches } = /** @type {GuestGlobals} */ (
  globalThis
);

const PROGRAM_SOURCE = '/* fake session program */';

/**
 * @param {object} [options]
 * @param {(args: any) => Promise<void> | void} [options.beforeMake]
 */
const setup = ({ beforeMake } = {}) => {
  /** @type {any[]} */
  const made = [];
  let retired = 0;
  const makeMaker = () =>
    Far('SpareMaker', {
      /** @param {any} args */
      make: async args => {
        await beforeMake?.(args);
        made.push(args);
        return harden({
          session: Far('Session', {}),
          internal: Far('SessionInternal', {}),
        });
      },
    });
  const vats = Far('ThixotropeWorkerController', {
    createWorker: async () =>
      Far('ThixotropeWorkerFacade', {
        /** @param {string} source */
        evaluate: async source =>
          source === stagingSources.evaluate ? makeMaker() : true,
        retire: async () => {
          retired += 1;
        },
      }),
  });
  const admin = Far('AgentHostAdmin', {
    forSession: () =>
      Far('SessionHostFacet', { liveChannel: async () => undefined }),
    bindSession: () => undefined,
    onStart: () => Far('Registration', { cancel: () => undefined }),
  });
  const programs = makeProgramStore();
  const digest = createHash('sha256')
    .update(PROGRAM_SOURCE, 'utf8')
    .digest('hex');
  programs.load({ digest, index: 0, count: 1, text: PROGRAM_SOURCE });
  const rows = makeRowTable();
  const kit = makeFactoryKit({
    admin,
    vats,
    programs,
    rows,
    starts: makeStartCount(),
  });
  return { kit, made, rows, retired: () => retired };
};

const backend = Far('Backend', {
  describe: () => harden({ kind: 'scripted', label: 'Scripted backend' }),
  open: async () => undefined,
});
const notes = Far('Notes', { read: () => 'notes' });
const calc = Far('Calc', {});

/** @param {Record<string, any>} [extra] */
const custom = (extra = {}) =>
  harden({ label: 'Helper', template: 'general', ...extra });

test('the M5 Operator answers the one catalogue and inventory', async t => {
  const { kit } = setup();
  const catalog = await E(kit.operator).getPresets();
  t.is(catalog, kit.catalog.facet);
  t.is(await E(kit.operator).getPresets(), catalog);
  t.is(await E(kit.operator).getInventory(), kit.inventory.facet);
  t.truthy(await E(kit.operator).getFactory());
  for (const name of methodNames.Operator) {
    t.is(typeof (/** @type {any} */ (kit.operator)[name]), 'function', name);
  }
  const listed = await E(kit.factory).listPresets();
  t.deepEqual(listed, await E(catalog).list());
  t.is(listed[0], kit.chatOnly);
});

test('a session from a user preset gets its endowments and a config snapshot without instructions', async t => {
  const { kit, made } = setup();
  const catalog = kit.catalog.facet;
  const { preset } = await E(catalog).create(
    custom({
      instructions: 'Answer in French.',
      endowments: [
        { label: 'notes', value: notes },
        { label: 'calc', value: calc },
      ],
    }),
    0,
  );
  await E(kit.factory).createSession(harden({ preset, backend }));
  t.is(made.length, 1);
  const { config, services } = made[0];
  t.deepEqual(
    services.endowments.map((/** @type {any} */ e) => [e.label, e.value]),
    [
      ['notes', notes],
      ['calc', calc],
    ],
  );
  t.like(config.preset, {
    label: 'Helper',
    template: 'general',
    endowmentLabels: ['notes', 'calc'],
    revision: 0,
  });
  t.false('instructions' in config.preset);
  t.regex(config.systemPrompt, /Answer in French\./);
  t.true(matches(config, shapes.SessionConfig));
  t.true(matches(services, shapes.SessionServices));
});

test('chat-only gives no endowments field; the default preset is chat-only', async t => {
  const { kit, made } = setup();
  await E(kit.factory).createSession(harden({ backend }));
  const { config, services } = made[0];
  t.false('endowments' in services);
  t.like(config.preset, { label: 'chat-only', template: 'chat-only' });
});

test('foreign, deleted and unavailable presets are refused before any row', async t => {
  const { kit, made, rows } = setup();
  const foreign = Far('Preset', {
    describe: () => harden({ label: 'chat-only', builtIn: true }),
    snapshot: () => harden({ label: 'chat-only' }),
  });
  await t.throwsAsync(
    E(kit.factory).createSession(harden({ preset: foreign, backend })),
    { message: texts.unknownPreset },
  );
  await t.throwsAsync(
    E(kit.factory).createSession(
      harden({ preset: kit.catalog.builtIn('development'), backend }),
    ),
    { message: textOf.presetNeeds('git-workspace') },
  );
  const { preset, revision } = await E(kit.catalog.facet).create(custom(), 0);
  await E(preset).delete(revision);
  await t.throwsAsync(
    E(kit.factory).createSession(harden({ preset, backend })),
    { message: texts.presetDeleted },
  );
  t.is(made.length, 0);
  t.is(rows.all().length, 0);
});

test('model defaults come from the preset; an option the caller gave wins', async t => {
  const { kit, made } = setup();
  const { preset } = await E(kit.catalog.facet).create(
    custom({ backend, modelId: 'model-a' }),
    0,
  );
  await E(kit.factory).createSession(harden({ preset }));
  t.is(made[0].config.modelId, 'model-a');
  t.is(made[0].config.backendTitle, 'Scripted backend');
  await E(kit.factory).createSession(harden({ preset, modelId: 'model-b' }));
  t.is(made[1].config.modelId, 'model-b');
  // A preset effort goes to M4's check since M4 lifted NOT_YET (2.3 step 1;
  // INT-M5): a backend that is not a subscription pool refuses it.
  const effort = await E(kit.catalog.facet).create(
    custom({ label: 'e', backend, modelId: 'm', reasoningEffort: 'high' }),
    1,
  );
  await t.throwsAsync(
    E(kit.factory).createSession(harden({ preset: effort.preset })),
    { message: subscriptionTexts.effortNotSupported },
  );
});

test('a save between the snapshot and the services fails the creation with presetChanged and rolls it back', async t => {
  const gate = makePromiseKit();
  const kit0 = setup();
  // Hold the creation in the backend's describe(), which the resolvers
  // await together with the snapshot; save the preset meanwhile.
  let hold = true;
  const slowBackend = Far('Backend', {
    describe: async () => {
      if (hold) await gate.promise;
      return harden({ kind: 'scripted', label: 'Slow' });
    },
    open: async () => undefined,
  });
  const { kit, made, rows } = kit0;
  const { preset } = await E(kit.catalog.facet).create(
    custom({ endowments: [{ label: 'notes', value: notes }] }),
    0,
  );
  const creating = E(kit.factory).createSession(
    harden({ preset, backend: slowBackend }),
  );
  await new Promise(resolve => setImmediate(resolve));
  await E(preset).save(custom({ endowments: [] }), 1);
  gate.resolve(undefined);
  await t.throwsAsync(creating, { message: texts.presetChanged });
  t.is(made.length, 0);
  t.is(rows.all().filter(row => !row.dropped).length, 0);
  t.is(kit.pendingCreations(), 0);
  hold = false;
  // The next creation reads the new revision and succeeds.
  await E(kit.factory).createSession(harden({ preset, backend: slowBackend }));
  t.is(made.length, 1);
  t.false('endowments' in made[0].services);
});

test('a make argument over frameBytes fails the creation with presetTooLarge', async t => {
  const { kit, made, rows } = setup();
  const wide = (/** @type {number} */ units) => '€'.repeat(units);
  const { preset } = await E(kit.catalog.facet).create(
    harden({
      label: wide(limits.presetLabelUnits),
      template: 'general',
      // The composed prompt stays inline (under inlineBytes).
      instructions: wide(400),
      backend,
      modelId: wide(256),
      endowments: Array.from({ length: limits.maxEndowments }, (_, i) =>
        harden({
          label: `${i}${wide(limits.endowmentLabelUnits - 2)}`,
          value: notes,
        }),
      ),
    }),
    0,
  );
  await t.throwsAsync(
    E(kit.factory).createSession(harden({ preset, title: wide(100) })),
    { message: texts.presetTooLarge },
  );
  t.is(made.length, 0);
  t.is(rows.all().filter(row => !row.dropped).length, 0);
});

test('the presetEndowments builder is appended to serviceBuilders', async t => {
  t.true(serviceBuilders.length >= 3);
  const presetEndowments = serviceBuilders[2];
  t.deepEqual(
    await presetEndowments(
      /** @type {any} */ ({ preset: Far('Preset', {}), presetSnapshot: {} }),
    ),
    {},
  );
  t.deepEqual(
    await presetEndowments(
      /** @type {any} */ ({
        preset: Far('Preset', {}),
        presetSnapshot: { revision: 0 },
      }),
    ),
    {},
  );
});
