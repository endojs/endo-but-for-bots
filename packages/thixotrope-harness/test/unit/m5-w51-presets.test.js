// @ts-check
// M5 W5.1: the preset catalogue, presets and record validation in Node
// (designs/m5-interfaces.md 1.3, 2.1, 2.3). Cases ported from Fae
// `test/session/preset-catalog.test.js` at 1315bef86 where the behaviour
// carries over (revision checks, endowment names, template objects, shell
// order, protected templates), plus the harness's own: rights
// amplification, defaults, endowments at a revision and the whole-record
// bound.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { fitsFrame, messageBytes } from '../../guest/lib/bounded.js';
import { shapes, textOf, texts } from '../../guest/lib/interfaces.js';
import {
  BUILTIN_PRESETS,
  isEdgeLabel,
  normalizePresetRecord,
} from '../../guest/lib/preset-catalog.js';
import {
  makePresetCatalog,
  presetEndowmentsAt,
} from '../../guest/factory/presets.js';
import {
  defaultTemplates,
  templateTable,
} from '../../guest/factory/preset-templates.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, matches } = /** @type {GuestGlobals} */ (globalThis);

const scripted = Far('Backend', {
  describe: () => harden({ kind: 'scripted', label: 'Scripted backend' }),
});
const api = Far('Backend', {
  describe: () => harden({ kind: 'anthropic', label: 'API backend' }),
});
const notes = Far('Notes', { read: () => 'notes' });
const calc = Far('Calc', { add: (/** @type {number} */ a) => a });

/** @param {Record<string, any>} [extra] */
const custom = (extra = {}) =>
  harden({ label: 'Helper', template: 'general', ...extra });

const templates = defaultTemplates;

test('built-ins: listed with chat-only first, availability by template objects', async t => {
  const kit = makePresetCatalog();
  const presets = await E(kit.facet).list();
  const views = await Promise.all(presets.map(p => E(p).describe()));
  t.deepEqual(
    views.map(v => v.label),
    ['chat-only', 'development', 'general', 'new-project', 'voice'],
  );
  t.true(views.every(v => v.builtIn));
  t.deepEqual(
    views.map(v => [v.label, v.available, v.unavailableReason]),
    [
      ['chat-only', true, undefined],
      // No environments admin attached (guest/factory/environments.js).
      ['development', false, texts.runnerRequired],
      ['general', true, undefined],
      ['new-project', false, texts.runnerRequired],
      ['voice', false, texts.runnerRequired],
    ],
  );
  for (const view of views) t.true(matches(view, shapes.PresetView));
  const configuration = await E(kit.facet).configuration();
  t.is(configuration.revision, 0);
  t.is(configuration.defaultPreset, kit.builtIn('chat-only'));
  t.is(await E(kit.facet).defaultPreset(), kit.builtIn('chat-only'));
  t.is(kit.list()[0], kit.builtIn('chat-only'));
  t.throws(() => kit.builtIn('rsi'), { message: texts.unknownPreset });
});

test('default preset: general once a runner allows public internet and general is available', t => {
  const kit = makePresetCatalog({
    templates: harden({ ...templates, internet: [{ available: () => true }] }),
  });
  t.is(kit.defaultPreset(), kit.builtIn('general'));
  const blocked = makePresetCatalog({
    templates: harden({ ...templates, internet: [{ available: () => false }] }),
  });
  t.is(blocked.defaultPreset(), blocked.builtIn('chat-only'));
});

test('object providers make a template available (M6 seam)', async t => {
  /** @type {any[]} */
  const seen = [];
  const kit = makePresetCatalog({
    templates: harden({
      ...templates,
      providers: [
        {
          kind: 'git-workspace',
          available: (/** @type {any} */ context) => {
            seen.push(context);
            return undefined;
          },
          build: async () => harden({ label: 'workspace', value: notes }),
        },
        {
          kind: 'development-environment',
          available: () => 'No runner is configured',
          build: async () => harden({ label: 'shell', value: notes }),
        },
      ],
    }),
    defaultsContext: harden({ marker: 1 }),
  });
  const newProject = await E(kit.builtIn('new-project')).describe();
  t.true(newProject.available);
  const development = await E(kit.builtIn('development')).describe();
  t.is(development.unavailableReason, 'No runner is configured');
  t.is(seen[0].marker, 1);
});

test('edits are revision checked: one of two writers at a revision wins', async t => {
  const kit = makePresetCatalog();
  const { preset, revision } = await E(kit.facet).create(custom(), 0);
  t.is(revision, 1);
  t.is(kit.list().at(-1), preset);
  // A saves at r and gets r + 1; B's save at r is refused, then B re-reads.
  t.is(await E(preset).save(custom({ instructions: 'A wins.' }), revision), 2);
  await t.throwsAsync(
    E(preset).save(custom({ instructions: 'B loses.' }), revision),
    { message: texts.presetStale },
  );
  const view = await E(preset).describe();
  t.is(view.instructions, 'A wins.');
  t.is(view.revision, 1);
  // Two creations at one revision: exactly one succeeds (Fae).
  const outcomes = await Promise.allSettled([
    E(kit.facet).create(custom({ label: 'one' }), 2),
    E(kit.facet).create(custom({ label: 'two' }), 2),
  ]);
  t.is(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  t.is(outcomes.filter(o => o.status === 'rejected').length, 1);
  t.is((await E(kit.facet).configuration()).revision, 3);
});

test('delete, reset and the built-in rules (Fae)', async t => {
  const kit = makePresetCatalog();
  const general = kit.builtIn('general');
  await t.throwsAsync(E(general).delete(0), {
    message: texts.builtInNotDeletable,
  });
  await t.throwsAsync(
    E(kit.builtIn('chat-only')).save(custom({ template: 'general' }), 0),
    { message: texts.builtInTemplateFixed },
  );
  t.is(
    await E(general).save(
      custom({ label: 'general', instructions: 'Be brief.' }),
      0,
    ),
    1,
  );
  t.is(await E(general).reset(1), 2);
  const view = await E(general).describe();
  t.is(view.instructions, '');
  t.is(view.revision, 2);
  t.is(view.description, BUILTIN_PRESETS[2].description);

  const { preset } = await E(kit.facet).create(custom(), 2);
  await t.throwsAsync(E(preset).reset(3), { message: texts.onlyBuiltInReset });
  await t.throwsAsync(E(preset).delete(2), { message: texts.presetStale });
  t.is(await E(preset).delete(3), 4);
  t.false(kit.list().includes(preset));
  for (const call of [
    () => E(preset).describe(),
    () => E(preset).snapshot(),
    () => E(preset).save(custom(), 4),
    () => E(preset).delete(4),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(call(), { message: texts.presetDeleted });
  }
  t.throws(() => kit.withDefaults(harden({ preset })), {
    message: texts.presetDeleted,
  });
});

test('at most maxPresets presets, built-ins included', async t => {
  const kit = makePresetCatalog();
  let revision = 0;
  const room = limits.maxPresets - BUILTIN_PRESETS.length;
  for (let i = 0; i < room; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    ({ revision } = await E(kit.facet).create(
      custom({ label: `p${i}` }),
      revision,
    ));
  }
  t.is(kit.list().length, limits.maxPresets);
  await t.throwsAsync(E(kit.facet).create(custom(), revision), {
    message: texts.tooManyPresets,
  });
});

test('endowment names: explicit objects and unambiguous non-reserved labels (Fae)', async t => {
  const kit = makePresetCatalog();
  for (const label of [
    '@host',
    'user',
    'tools',
    'subagents',
    'x/y',
    '__proto__',
    'constructor',
    'prototype',
    '.',
    '..',
    'docs@home',
    'tab\there',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      E(kit.facet).create(custom({ endowments: [{ label, value: notes }] }), 0),
      { message: textOf.reservedEndowment(label) },
      label,
    );
  }
  t.throws(
    () =>
      normalizePresetRecord(
        custom({ endowments: [{ label: 'source', value: 'locator' }] }),
        { templates },
      ),
    { message: textOf.endowmentNotObject('source') },
  );
  t.throws(
    () =>
      normalizePresetRecord(
        custom({ endowments: [{ label: ' ', value: notes }] }),
        {
          templates,
        },
      ),
    { message: textOf.invalidField('endowment name') },
  );
  await t.throwsAsync(
    E(kit.facet).create(
      custom({
        endowments: [
          { label: 'notes', value: notes },
          { label: 'notes', value: calc },
        ],
      }),
      0,
    ),
    { message: textOf.duplicateEndowment('notes') },
  );
  // A template object's label is taken too.
  await t.throwsAsync(
    E(kit.facet).create(
      custom({
        objects: [{ kind: 'git-workspace', label: 'workspace' }],
        endowments: [{ label: 'workspace', value: notes }],
      }),
      0,
    ),
    { message: textOf.duplicateEndowment('workspace') },
  );
  // The guard refuses 33 endowments before validation.
  const many = Array.from({ length: 33 }, (_, i) =>
    harden({ label: `e${i}`, value: notes }),
  );
  await t.throwsAsync(E(kit.facet).create(custom({ endowments: many }), 0));
  t.throws(
    () => normalizePresetRecord(custom({ endowments: many }), { templates }),
    { message: texts.invalidEndowments },
  );
  const { preset } = await E(kit.facet).create(
    custom({
      endowments: [
        { label: 'notes', value: notes },
        { label: 'calc', value: calc },
      ],
    }),
    0,
  );
  const view = await E(preset).describe();
  t.is(view.endowments[0].value, notes);
  t.deepEqual((await E(preset).snapshot()).endowmentLabels, ['notes', 'calc']);
  t.true(isEdgeLabel('notes'));
  t.false(isEdgeLabel('x'.repeat(81)));
});

test('template objects: allowed, canonical order, dependencies (Fae)', t => {
  const voice = BUILTIN_PRESETS[4];
  t.throws(
    () =>
      normalizePresetRecord(
        custom({ objects: [{ kind: 'host-powers', label: 'endo' }] }),
        { templates },
      ),
    { message: texts.invalidTemplateObject },
  );
  t.throws(
    () =>
      normalizePresetRecord(harden({ ...voice, objects: [voice.objects[1]] }), {
        templates,
      }),
    { message: texts.shellNeedsWorkspace },
  );
  t.throws(
    () =>
      normalizePresetRecord(
        harden({ ...voice, objects: [voice.objects[0], voice.objects[0]] }),
        { templates },
      ),
    { message: texts.invalidTemplateObject },
  );
  const saved = normalizePresetRecord(
    harden({ ...voice, objects: [...voice.objects].reverse() }),
    { templates },
  );
  t.deepEqual(
    saved.objects.map(o => o.label),
    ['workspace', 'shell'],
  );
  t.throws(
    () =>
      normalizePresetRecord(
        custom({
          template: 'development',
          objects: [{ kind: 'git-workspace', label: 'workspace' }],
        }),
        { templates },
      ),
    { message: texts.templateObjectsRequired },
  );
  t.throws(
    () => normalizePresetRecord(custom({ template: 'rsi' }), { templates }),
    { message: texts.unknownTemplate },
  );
  t.deepEqual(
    templateTable.map(item => item.template),
    ['development', 'chat-only', 'general', 'new-project'],
  );
});

test('chat-only takes no endowment and network off; network policy defaults by template', t => {
  t.throws(
    () =>
      normalizePresetRecord(
        custom({
          template: 'chat-only',
          endowments: [{ label: 'notes', value: notes }],
        }),
        { templates },
      ),
    { message: texts.chatOnlyRule },
  );
  t.throws(
    () =>
      normalizePresetRecord(
        custom({ template: 'chat-only', networkPolicy: 'public-internet' }),
        { templates },
      ),
    { message: texts.chatOnlyRule },
  );
  t.throws(
    () =>
      normalizePresetRecord(custom({ networkPolicy: 'lan' }), { templates }),
    { message: texts.invalidNetworkPolicy },
  );
  t.is(
    normalizePresetRecord(custom({ template: 'chat-only' }), { templates })
      .networkPolicy,
    'off',
  );
  t.is(
    normalizePresetRecord(custom(), { templates }).networkPolicy,
    'public-internet',
  );
});

test('model defaults need a backend, and an API backend a model (R6-55)', async t => {
  t.throws(
    () => normalizePresetRecord(custom({ modelId: 'm' }), { templates }),
    { message: texts.backendForDefaults },
  );
  t.throws(
    () =>
      normalizePresetRecord(custom({ reasoningEffort: 'high' }), { templates }),
    { message: texts.backendForDefaults },
  );
  // Applied when the caller knows the backend's kind (the catalogue's
  // synchronous guards cannot ask the backend; see presets.js).
  t.throws(
    () =>
      normalizePresetRecord(custom({ backend: api }), {
        templates,
        backendKind: 'anthropic',
      }),
    { message: texts.modelForBackend },
  );
  t.notThrows(() =>
    normalizePresetRecord(custom({ backend: scripted }), {
      templates,
      backendKind: 'scripted',
    }),
  );
  const kit = makePresetCatalog();
  const { preset, revision } = await E(kit.facet).create(
    custom({ backend: scripted }),
    0,
  );
  t.is((await E(preset).describe()).backend, scripted);
  await E(preset).save(
    custom({ backend: api, modelId: 'model-a', reasoningEffort: 'high' }),
    revision,
  );
  const view = await E(preset).describe();
  t.like(view, { modelId: 'model-a', reasoningEffort: 'high' });
  const snapshot = await E(preset).snapshot();
  t.like(snapshot, { modelId: 'model-a', reasoningEffort: 'high' });
  t.false('backend' in snapshot);
  t.throws(
    () => normalizePresetRecord(custom({ label: '  ' }), { templates }),
    { message: textOf.invalidField('preset title') },
  );
});

test('snapshot: data only, widened shape, configSnapshot drops instructions', async t => {
  const kit = makePresetCatalog();
  const { preset } = await E(kit.facet).create(
    custom({
      instructions: 'Answer in French.',
      endowments: [{ label: 'notes', value: notes }],
    }),
    0,
  );
  const snapshot = await E(preset).snapshot();
  t.deepEqual(snapshot, {
    label: 'Helper',
    template: 'general',
    networkPolicy: 'public-internet',
    objects: [],
    endowmentLabels: ['notes'],
    revision: 0,
    instructions: 'Answer in French.',
  });
  t.true(matches(snapshot, shapes.PresetSnapshot));
  const config = kit.configSnapshot(snapshot);
  t.false('instructions' in config);
  t.true(matches(config, shapes.PresetSnapshot));
  t.false('instructions' in (await E(kit.builtIn('chat-only')).snapshot()));
});

test('withDefaults: amplification refuses foreign, deleted and unavailable presets; fills model defaults', async t => {
  const kit = makePresetCatalog();
  const foreign = Far('Preset', { snapshot: () => harden({ label: 'x' }) });
  t.throws(() => kit.withDefaults(harden({ preset: foreign })), {
    message: texts.unknownPreset,
  });
  // Another catalogue's preset is foreign here too.
  const other = makePresetCatalog();
  t.throws(
    () => kit.withDefaults(harden({ preset: other.builtIn('chat-only') })),
    { message: texts.unknownPreset },
  );
  t.throws(
    () => kit.withDefaults(harden({ preset: kit.builtIn('development') })),
    { message: texts.runnerRequired },
  );
  t.is(kit.withDefaults(harden({})).preset, kit.builtIn('chat-only'));

  const { preset } = await E(kit.facet).create(
    custom({ backend: api, modelId: 'model-a', reasoningEffort: 'low' }),
    0,
  );
  t.like(kit.withDefaults(harden({ preset })), {
    backend: api,
    modelId: 'model-a',
    reasoningEffort: 'low',
  });
  // An option the caller gave wins.
  t.like(kit.withDefaults(harden({ preset, modelId: 'model-b' })), {
    backend: api,
    modelId: 'model-b',
    reasoningEffort: 'low',
  });
  // Another backend: the preset's model is not carried over to it.
  const other2 = kit.withDefaults(harden({ preset, backend: scripted }));
  t.is(other2.backend, scripted);
  t.false('modelId' in other2);
  t.false('reasoningEffort' in other2);
  t.is(kit.recordOf(preset).modelId, 'model-a');
});

test('endowments are read at the snapshot revision (2.3 step 3)', async t => {
  const kit = makePresetCatalog();
  const { preset, revision } = await E(kit.facet).create(
    custom({ endowments: [{ label: 'notes', value: notes }] }),
    0,
  );
  const snapshot = await E(preset).snapshot();
  t.deepEqual(
    kit.endowmentsAt(preset, snapshot.revision).map(e => e.value),
    [notes],
  );
  t.is(presetEndowmentsAt(Far('Other', {}), 0), undefined);
  await E(preset).save(custom({ endowments: [] }), revision);
  t.throws(() => kit.endowmentsAt(preset, snapshot.revision), {
    message: texts.presetChanged,
  });
  t.deepEqual(kit.endowmentsAt(preset, snapshot.revision + 1), []);
});

test('export records leave endowments out; import creates a user preset', async t => {
  const kit = makePresetCatalog();
  await E(kit.facet).create(
    custom({
      instructions: 'x',
      backend: api,
      modelId: 'model-a',
      endowments: [{ label: 'notes', value: notes }],
    }),
    0,
  );
  const records = kit.exportRecords();
  t.is(records.length, 1);
  t.false('endowments' in records[0]);
  t.is(records[0].backend, api);
  const fresh = makePresetCatalog();
  const { preset } = await fresh.importRecord(records[0]);
  t.like(await E(preset).describe(), {
    label: 'Helper',
    instructions: 'x',
    modelId: 'model-a',
    endowments: [],
  });
});

test('a development workspace seed survives views, snapshots and preset export/import', async t => {
  const catalog = makePresetCatalog();
  const workspaceSeed = harden({
    project: 'thixotrope',
    commit: 'a1'.repeat(20),
  });
  const development = {
    ...BUILTIN_PRESETS[0],
    label: 'Thixotrope development',
  };
  const { preset } = await E(catalog.facet).create(
    harden({ ...development, workspaceSeed }),
    0,
  );
  t.deepEqual((await E(preset).describe()).workspaceSeed, workspaceSeed);
  t.deepEqual((await E(preset).snapshot()).workspaceSeed, workspaceSeed);
  const [record] = catalog.exportRecords();
  const restored = makePresetCatalog().importRecord(record);
  t.deepEqual(
    (await E(restored.preset).snapshot()).workspaceSeed,
    workspaceSeed,
  );
  const saved = harden({
    ...development,
    workspaceSeed: { ...workspaceSeed, commit: 'cd'.repeat(20) },
  });
  const before = await E(preset).snapshot();
  await E(preset).save(saved, 1);
  t.deepEqual(before.workspaceSeed, workspaceSeed);
  t.deepEqual((await E(preset).snapshot()).workspaceSeed, saved.workspaceSeed);
  for (const commit of [
    'abc',
    'A'.repeat(40),
    'x'.repeat(40),
    `${'a'.repeat(39)}\n`,
  ]) {
    t.throws(
      () =>
        normalizePresetRecord(
          { ...development, workspaceSeed: { ...workspaceSeed, commit } },
          { templates },
        ),
      { message: 'Invalid workspace seed' },
    );
  }
  t.throws(
    () => normalizePresetRecord(custom({ workspaceSeed }), { templates }),
    { message: 'Workspace seeds require a development preset' },
  );
});

// ---------------------------------------------------------------- the bound

/** A string of `units` three-byte characters. */
/** @param {number} units */
const wide = units => '€'.repeat(units);

/**
 * The largest record the guard admits: every field at its bound, three-byte
 * text, 32 endowments and 16 template objects.
 */
const maximalRecord = () =>
  harden({
    label: wide(limits.presetLabelUnits),
    template: 'general',
    description: wide(limits.presetDescriptionUnits),
    instructions: wide(limits.presetInstructionsUnits),
    networkPolicy: 'public-internet',
    backend: scripted,
    modelId: wide(limits.modelIdUnits),
    reasoningEffort: wide(limits.effortUnits),
    objects: Array.from({ length: limits.maxTemplateObjects }, () =>
      harden({
        kind: wide(limits.templateKindUnits),
        label: wide(limits.endowmentLabelUnits),
      }),
    ),
    endowments: Array.from({ length: limits.maxEndowments }, (_, i) =>
      harden({
        label: `${i}${wide(limits.endowmentLabelUnits - 2)}`,
        value: notes,
      }),
    ),
  });

test('guard boundary: the maximal guard-accepted record is refused as too large', async t => {
  const record = maximalRecord();
  t.true(matches(record, shapes.PresetRecord));
  t.true(messageBytes(record) > limits.presetRecordBytes);
  // Validation stops at the template objects first; the size is the last
  // check, so measure it with objects the template allows.
  const allowed = harden({ ...record, objects: [] });
  t.true(matches(allowed, shapes.PresetRecord));
  t.throws(() => normalizePresetRecord(allowed, { templates }), {
    message: texts.presetTooLarge,
  });
  const kit = makePresetCatalog();
  await t.throwsAsync(E(kit.facet).create(allowed, 0), {
    message: texts.presetTooLarge,
  });
  t.is(kit.revision(), 0);
  t.is(kit.list().length, BUILTIN_PRESETS.length);
});

test('guard boundary: a record of exactly presetRecordBytes is accepted and its view fits a frame', async t => {
  // Three-byte text in every field but the instructions, which take the
  // rest (three-byte units, then one or two ASCII units for the remainder).
  const base = harden({
    label: wide(limits.presetLabelUnits),
    template: 'general',
    description: wide(limits.presetDescriptionUnits),
    instructions: '',
    networkPolicy: 'public-internet',
    backend: scripted,
    modelId: wide(limits.modelIdUnits),
    reasoningEffort: wide(limits.effortUnits),
    objects: [{ kind: 'git-workspace', label: 'workspace' }],
    endowments: Array.from({ length: limits.maxEndowments }, (_, i) =>
      harden({
        label: `${i}${wide(limits.endowmentLabelUnits - 2)}`,
        value: notes,
      }),
    ),
  });
  const room = limits.presetRecordBytes - messageBytes(base);
  const units = Math.floor(room / 3);
  const instructions = `${wide(units)}${'a'.repeat(room - units * 3)}`;
  t.true(instructions.length <= limits.presetInstructionsUnits);
  const record = harden({ ...base, instructions });
  t.true(matches(record, shapes.PresetRecord));
  t.is(messageBytes(record), limits.presetRecordBytes);
  const normal = normalizePresetRecord(record, { templates });
  t.is(messageBytes(normal), limits.presetRecordBytes);
  // One byte more is refused.
  t.throws(
    () =>
      normalizePresetRecord(
        harden({ ...record, instructions: `${instructions}a` }),
        { templates },
      ),
    { message: texts.presetTooLarge },
  );
  const kit = makePresetCatalog({
    templates: harden({
      ...templates,
      providers: [
        {
          kind: 'git-workspace',
          available: () => 'r'.repeat(100),
          build: async () => harden({ label: 'workspace', value: notes }),
        },
      ],
    }),
  });
  const { preset } = await E(kit.facet).create(record, 0);
  const view = await E(preset).describe();
  t.is(view.unavailableReason, 'r'.repeat(100));
  t.true(matches(view, shapes.PresetView));
  t.true(fitsFrame(view, limits.frameBytes - 1024));
});
