// @ts-check
// W5.8 preset editor (m5-interfaces.md 2.1, 4.1 item 7; R6-55, P-49):
// fields and the record they send, Save / Save as new / Delete / Reset /
// Discard, a stale save refused with the catalogue's text and the edits
// kept, a save on one page seen by another after Reload, a record over
// presetRecordBytes refused before sending, and the panel in happy-dom.
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';
import { h, render } from 'preact';

import { feature } from '../../ui/src/presets/feature.js';
import { PresetEditor } from '../../ui/src/presets/PresetEditor.js';
import {
  formOf,
  makePresetEditor,
  recordOf,
} from '../../ui/src/presets/editor.js';
import {
  presetRecordBytes,
  presetRecordSize,
} from '../../ui/src/presets/size.js';
import { presetTexts, presetTooLarge } from '../../ui/src/presets/texts.js';
import { makeFakePowers, makeTestDom } from './_m3-fake-powers.js';

// The catalogue's texts (factory `texts`, guest/lib/guards/factory.js).
const STALE = 'Preset settings changed elsewhere. Reload before saving.';
const NOT_DELETABLE = 'Built-in presets can be reset, not deleted';

test('editing a development preset preserves its pinned project revision', t => {
  const workspaceSeed = { project: 'thixotrope', commit: 'a'.repeat(40) };
  const form = formOf({
    label: 'project',
    template: 'development',
    workspaceSeed,
  });
  t.deepEqual(
    recordOf({ ...form, label: 'project copy' }).workspaceSeed,
    workspaceSeed,
  );
  t.false('workspaceSeed' in recordOf({ ...form, template: 'chat-only' }));
});

test('the compatibility project source stays separate from editable default objects', t => {
  const marker = {
    label: 'thixotrope-project-source',
    value: Far('Source', {}),
  };
  const form = formOf({
    label: 'project',
    template: 'development',
    endowments: [marker],
  });
  t.deepEqual(form.endowments, []);
  t.deepEqual(recordOf(form).endowments, [marker]);
  t.deepEqual(recordOf({ ...form, template: 'general' }).endowments, []);
});

/**
 * An in-memory `PresetCatalog` with the contract's methods and CAS rule,
 * and an `Inventory` (pages of 50), shared by the pages of a test.
 *
 * @param {{ inventory?: number }} [options]
 */
const makeFakeCatalog = ({ inventory: inventorySize = 3 } = {}) => {
  /** @type {any[][]} */
  const calls = [];
  let revision = 1;
  /** @type {Array<{ preset: any, state: any }>} */
  const presets = [];
  const defaults = {
    description: '',
    instructions: '',
    networkPolicy: 'off',
    objects: [],
    endowments: [],
  };
  /** @param {number} expected */
  const cas = expected => {
    if (expected !== revision) throw Error(STALE);
    revision += 1;
    return revision;
  };
  /**
   * @param {any} record
   * @param {boolean} builtIn
   */
  const add = (record, builtIn) => {
    const state = {
      record: { ...defaults, ...record },
      original: { ...defaults, ...record },
      builtIn,
      revision: 0,
    };
    const preset = Far('Preset', {
      describe: () =>
        harden({
          ...state.record,
          builtIn,
          revision: state.revision,
          available: state.record.template !== 'development',
          ...(state.record.template === 'development'
            ? { unavailableReason: 'needs a workspace' }
            : {}),
        }),
      /**
       * @param {any} next
       * @param {number} expected
       */
      save: (next, expected) => {
        calls.push(['save', next, expected]);
        const answer = cas(expected);
        state.record = { ...defaults, ...next };
        state.revision += 1;
        return answer;
      },
      /** @param {number} expected */
      delete: expected => {
        calls.push(['delete', expected]);
        if (builtIn) throw Error(NOT_DELETABLE);
        const answer = cas(expected);
        presets.splice(
          presets.findIndex(item => item.preset === preset),
          1,
        );
        return answer;
      },
      /** @param {number} expected */
      reset: expected => {
        calls.push(['reset', expected]);
        const answer = cas(expected);
        state.record = { ...state.original };
        state.revision += 1;
        return answer;
      },
    });
    presets.push({ preset, state });
    return preset;
  };
  add({ label: 'Chat only', template: 'chat-only' }, true);
  add(
    {
      label: 'General',
      template: 'general',
      objects: Array.from({ length: 4 }, (_, i) => ({
        kind: 'git-workspace',
        label: `${'€'.repeat(79)}${i}`,
      })),
    },
    true,
  );
  add({ label: 'Development', template: 'development' }, true);
  const catalog = Far('PresetCatalog', {
    list: () => harden(presets.map(item => item.preset)),
    configuration: () =>
      harden({
        revision,
        presets: presets.map(item => item.preset),
        defaultPreset: presets[0].preset,
      }),
    /**
     * @param {any} record
     * @param {number} expected
     */
    create: (record, expected) => {
      calls.push(['create', record, expected]);
      const answer = cas(expected);
      const preset = add(record, false);
      return harden({ preset, revision: answer });
    },
    defaultPreset: () => presets[0].preset,
  });
  const things = Array.from({ length: inventorySize }, (_, i) => ({
    label: ['notes', 'calc', 'mail'][i] ?? `thing-${i}`,
    value: Far('Thing', {}),
  }));
  const inventory = Far('Inventory', {
    /** @param {string} [cursor] */
    list: cursor => {
      const start = cursor === undefined ? 0 : Number(cursor.slice(1));
      const slice = things.slice(start, start + 50);
      return harden({
        rows: slice.map(thing => ({
          entry: Far('InventoryEntry', {}),
          label: thing.label,
          value: thing.value,
        })),
        rev: 1,
        ...(start + 50 < things.length ? { next: `i${start + 50}` } : {}),
      });
    },
  });
  return { catalog, inventory, calls, things, presets };
};

/** @param {ReturnType<typeof makeFakeCatalog>} fake */
const pageOver = fake =>
  makeFakePowers({
    operatorMethods: {
      getPresets: () => fake.catalog,
      getInventory: () => fake.inventory,
    },
  });

/**
 * @param {() => boolean} predicate
 * @param {number} [ms]
 */
const waitFor = async (predicate, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};

/** @param {any} powers */
const openEditor = async powers => {
  const editor = makePresetEditor({ powers });
  editor.start();
  await waitFor(() => editor.getState().phase !== 'loading');
  return editor;
};

test('feature shape: one app.panel "Presets"', t => {
  t.is(feature.id, 'presets');
  t.is(feature.slot, 'app.panel');
  t.is(feature.label, 'Presets');
  t.is(feature.component, PresetEditor);
});

test('loads the catalogue, backends and inventory; fields round-trip to a record', async t => {
  const fake = makeFakeCatalog({ inventory: 120 });
  const { powers } = pageOver(fake);
  const editor = await openEditor(powers);
  const state = editor.getState();
  t.is(state.phase, 'ready');
  t.is(state.revision, 1);
  t.deepEqual(
    state.entries.map(entry => entry.view.label),
    ['Chat only', 'General', 'Development'],
  );
  t.is(state.selected, 0);
  t.is(state.backends.length, 1);
  t.is(state.backends[0].label, 'Scripted');
  t.is(state.inventory.length, 120, 'three inventory pages read');

  editor.select(1);
  editor.setField('label', 'Mine');
  editor.setField('description', 'd');
  editor.setField('instructions', 'Be brief.');
  editor.setField('networkPolicy', 'public-internet');
  editor.setBackend(0);
  await waitFor(() => editor.getState().models.length > 0);
  editor.setField('modelId', editor.getState().models[0].modelId);
  editor.setField('reasoningEffort', 'high');
  editor.addEndowment(0);
  editor.addEndowment(0); // the same object twice: kept once
  editor.addEndowment(1);
  editor.relabelEndowment(1, 'calculator');
  t.true(editor.getState().dirty);
  const record = recordOf(/** @type {any} */ (editor.getState().form));
  t.deepEqual(Object.keys(record).sort(), [
    'backend',
    'description',
    'endowments',
    'instructions',
    'label',
    'modelId',
    'networkPolicy',
    'objects',
    'reasoningEffort',
    'template',
  ]);
  t.is(record.backend, state.backends[0].backend);
  t.deepEqual(
    record.endowments.map(endowment => endowment.label),
    ['notes', 'calculator'],
  );
  t.is(record.endowments[0].value, fake.things[0].value);
  t.is(record.endowments[1].value, fake.things[1].value);

  editor.removeEndowment(0);
  editor.setBackend(-1);
  const plain = recordOf(/** @type {any} */ (editor.getState().form));
  t.false('backend' in plain);
  t.false('modelId' in plain, 'the factory default clears model defaults');
  t.false('reasoningEffort' in plain);
  t.deepEqual(
    plain.endowments.map(endowment => endowment.label),
    ['calculator'],
  );

  editor.discard();
  t.false(editor.getState().dirty);
  t.deepEqual(
    editor.getState().form,
    formOf(editor.getState().entries[1].view),
  );
});

test('Save, Save as new, Delete with confirmation, Reset', async t => {
  const fake = makeFakeCatalog();
  const { powers } = pageOver(fake);
  const editor = await openEditor(powers);

  editor.select(1);
  editor.setField('instructions', 'Saved text');
  await editor.save();
  t.is(editor.getState().notice, presetTexts.saved);
  t.is(editor.getState().error, undefined);
  t.deepEqual(fake.calls.at(-1)?.slice(0, 1), ['save']);
  t.is(fake.calls.at(-1)?.[2], 1, 'the revision this page read');
  t.is(editor.getState().revision, 2);
  t.is(editor.getState().selected, 1);
  t.is(editor.getState().form?.instructions, 'Saved text');
  t.false(editor.getState().dirty);

  editor.setField('label', 'Copy');
  await editor.saveAsNew();
  t.is(editor.getState().notice, presetTexts.created);
  t.is(editor.getState().entries.length, 4);
  t.is(editor.getState().selected, 3, 'the new preset is selected');
  t.is(editor.getState().entries[3].view.label, 'Copy');
  t.false(editor.getState().entries[3].view.builtIn);

  // Delete asks first, then deletes.
  await editor.remove();
  t.true(editor.getState().confirmDelete);
  t.is(fake.calls.filter(call => call[0] === 'delete').length, 0);
  await editor.remove();
  t.is(editor.getState().notice, presetTexts.deleted);
  t.is(editor.getState().entries.length, 3);
  t.is(editor.getState().selected, 0);

  // A built-in's delete is refused by the catalogue: its text is shown.
  await editor.remove();
  await editor.remove();
  t.is(editor.getState().error, NOT_DELETABLE);

  editor.select(1);
  await editor.reset();
  t.is(editor.getState().notice, presetTexts.resetDone);
  t.is(editor.getState().form?.instructions, '');
});

test("a save on one page appears on another after Reload; the other page's stale save is refused and its edits kept", async t => {
  const fake = makeFakeCatalog();
  const a = await openEditor(pageOver(fake).powers);
  const b = await openEditor(pageOver(fake).powers);

  a.select(1);
  a.setField('instructions', 'from A');
  await a.save();
  t.is(a.getState().revision, 2);

  b.select(1);
  b.setField('instructions', 'from B');
  const before = fake.calls.length;
  await b.save();
  t.is(b.getState().error, STALE);
  t.is(fake.calls.length, before + 1, 'sent once, refused by the catalogue');
  t.true(b.getState().dirty, 'the edits are kept');
  t.is(b.getState().form?.instructions, 'from B');

  await b.reload();
  t.is(b.getState().revision, 2);
  t.is(b.getState().form?.instructions, 'from A');
  t.false(b.getState().dirty);
  t.is(b.getState().selected, 1, 'the selection survives a reload');
});

test('a record over presetRecordBytes is refused before sending', async t => {
  const fake = makeFakeCatalog({ inventory: 32 });
  const { powers } = pageOver(fake);
  const editor = await openEditor(powers);
  editor.select(1); // General, with four template objects of 80 three-byte units
  editor.setField('instructions', '€'.repeat(4096));
  editor.setField('description', '€'.repeat(500));
  await editor.save();
  t.is(editor.getState().error, undefined, 'about 15 KB fits');
  t.is(fake.calls.filter(call => call[0] === 'save').length, 1);

  editor.setField('label', '€'.repeat(120));
  for (let i = 0; i < 32; i += 1) {
    editor.addEndowment(i);
    editor.relabelEndowment(
      i,
      `${'€'.repeat(78)}${String(i).padStart(2, '0')}`,
    );
  }
  const sizeOf = () =>
    presetRecordSize(recordOf(/** @type {any} */ (editor.getState().form)));
  const size = sizeOf();
  t.true(size > presetRecordBytes, `${size} bytes`);
  const sent = fake.calls.length;
  await editor.save();
  t.is(editor.getState().error, presetTooLarge);
  t.is(fake.calls.length, sent, 'nothing sent');
  await editor.saveAsNew();
  t.is(editor.getState().error, presetTooLarge);
  t.is(fake.calls.length, sent, 'nothing sent');
  t.true(editor.getState().dirty, 'the edits are kept');

  // Trimming the instructions to the bound lets it through.
  const trim = Math.ceil((size - presetRecordBytes) / 3);
  editor.setField('instructions', '€'.repeat(4096 - trim));
  t.true(sizeOf() <= presetRecordBytes);
  t.true(sizeOf() > presetRecordBytes - 3);
  await editor.save();
  t.is(editor.getState().error, undefined);
  t.is(fake.calls.length, sent + 1);
});

/**
 * @param {any} window
 * @param {any} element
 * @param {string} type
 */
const fire = (window, element, type) => {
  const EventClass = type === 'click' ? window.MouseEvent : window.Event;
  element.dispatchEvent(new EventClass(type, { bubbles: true }));
};

test.serial(
  'the panel in happy-dom: list, built-in controls, edit and save, a refusal shown',
  async t => {
    const dom = makeTestDom();
    const fake = makeFakeCatalog();
    const { powers } = pageOver(fake);
    const context = harden({
      powers,
      extra: () => undefined,
      controller: {},
      call: (/** @type {() => Promise<unknown>} */ fn) => fn(),
    });
    const draw = () => render(h(PresetEditor, { context }), dom.root);
    draw();
    const q = (/** @type {string} */ selector) =>
      dom.document.querySelector(selector);
    await waitFor(
      () => dom.document.querySelectorAll('.thix-preset-item').length === 3,
    );
    const items = [...dom.document.querySelectorAll('.thix-preset-item')];
    t.true(items[0].textContent.includes(presetTexts.builtIn));
    t.true(items[2].textContent.includes(presetTexts.unavailable));

    // A built-in: template fixed, Reset offered, Delete not.
    t.true(q('select[name="template"]').disabled);
    t.truthy(q('button[name="reset"]'));
    t.is(q('button[name="delete"]'), null);
    t.true(q('button[name="save"]').disabled, 'nothing to save yet');

    const instructions = q('textarea[name="instructions"]');
    instructions.value = 'Typed in the panel';
    fire(dom.window, instructions, 'input');
    await waitFor(() => !q('button[name="save"]').disabled);
    fire(dom.window, q('button[name="save"]'), 'click');
    await waitFor(() => q('.thix-preset-notice') !== null);
    t.is(q('.thix-preset-notice').textContent, presetTexts.saved);
    t.is(fake.presets[0].state.record.instructions, 'Typed in the panel');

    // Add an object from the inventory picker.
    const picker = q('select[name="addObject"]');
    picker.value = '1';
    fire(dom.window, picker, 'change');
    await waitFor(() => q('input[name="endowment-0"]') !== null);
    t.is(q('input[name="endowment-0"]').value, 'calc');

    // Another page saves first: this page's save shows the refusal.
    const other = await openEditor(pageOver(fake).powers);
    other.setField('description', 'elsewhere');
    await other.save();
    fire(dom.window, q('button[name="save"]'), 'click');
    await waitFor(() => q('.thix-preset-error') !== null);
    t.is(q('.thix-preset-error').textContent, STALE);
    t.is(q('input[name="endowment-0"]').value, 'calc', 'edits kept');

    // A user preset: Delete offered, Reset not.
    fire(dom.window, q('button[name="reload"]'), 'click');
    await waitFor(() => q('input[name="endowment-0"]') === null);
    fire(dom.window, q('button[name="saveAsNew"]'), 'click');
    await waitFor(
      () => dom.document.querySelectorAll('.thix-preset-item').length === 4,
    );
    await waitFor(() => q('button[name="delete"]') !== null);
    t.is(q('button[name="reset"]'), null);
    t.false(q('select[name="template"]').disabled);

    render(null, dom.root);
    await dom.close();
  },
);
