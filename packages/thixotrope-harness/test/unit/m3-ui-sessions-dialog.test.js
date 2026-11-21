// @ts-check
// "Start a new session" (R6-38, R6-39; m3-interfaces.md 9.1, 9.3; W3.5) in
// happy-dom over the real controller and the fake powers: presets with an
// unavailable one disabled with its reason, backends, catalogue pages and
// the search filter, "Factory default", the unavailable-catalogue text, the
// effort selection, the `newSession.field` slot, closing, and a failed create.
import test from '@endo/ses-ava/prepare-endo.js';

import { E, Far } from '@endo/far';
import { h, options as preactOptions } from 'preact';

import { makeController } from '../../ui/src/controller/index.js';
import { mount } from '../../ui/src/shell/index.js';
import * as sessionViews from '../../ui/src/sessions/index.js';
import {
  uiTexts,
  uiTextOf,
} from '../../resources/agent-host/impl/gateway/protocol.js';
import { makeFakePowers, makeTestDom } from './_m3-fake-powers.js';

const { discoveryNotes, matchesModel } = sessionViews;

// Hook effects run on the next turn instead of after a 100 ms frame timeout.
/** @type {any} */ (preactOptions).requestAnimationFrame = (
  /** @type {() => void} */ fn,
) => setImmediate(fn);

const flush = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/**
 * @param {any} window
 * @param {any} element
 * @param {string} type
 * @param {Record<string, any>} [init]
 */
const fire = (window, element, type, init = {}) => {
  const EventClass = type.startsWith('key')
    ? window.KeyboardEvent
    : type === 'input' || type === 'change'
      ? window.Event
      : window.MouseEvent;
  element.dispatchEvent(new EventClass(type, { bubbles: true, ...init }));
};

/**
 * A preset object as M2 (no `available`) or M5 (`PresetView`) describes it.
 *
 * @param {Record<string, any>} view
 */
const presetOf = view =>
  Far('Preset', {
    describe: () => harden({ builtIn: false, ...view }),
    snapshot: () => harden({ label: view.label }),
  });

const brokenPreset = Far('Preset', {
  describe: () => {
    throw Error('describe failed');
  },
  snapshot: () => harden({ label: 'broken' }),
});

/**
 * The fake powers, with `listModels` rows offering `efforts[modelId]`
 * (the fake's catalogue offers none).
 *
 * @param {any} fake
 * @param {Record<string, string[]>} efforts
 * @param {Record<string, string>} [titles]
 * @param {Record<string, string>} [defaults]
 */
const withEfforts = async (fake, efforts, titles = {}, defaults = {}) => {
  const inner = await E(fake.powers.operator).getFactory();
  /** @param {any} page */
  const widen = page =>
    harden({
      ...page,
      rows: page.rows.map((/** @type {any} */ row) => ({
        ...row,
        reasoningEfforts: efforts[row.modelId] ?? [],
        ...(defaults[row.modelId]
          ? { defaultReasoningEffort: defaults[row.modelId] }
          : {}),
        title: titles[row.modelId] ?? row.title,
      })),
    });
  const factory = Far('SessionFactory', {
    createSession: options => E(inner).createSession(options),
    listSessions: page => E(inner).listSessions(page),
    sessionListFeed: () => E(inner).sessionListFeed(),
    findSession: key => E(inner).findSession(key),
    listPresets: () => E(inner).listPresets(),
    deleteSession: session => E(inner).deleteSession(session),
    listBackends: () => E(inner).listBackends(),
    listModels: request => E.when(E(inner).listModels(request), widen),
  });
  return harden({
    ...fake.powers,
    operator: Far('Operator', { getFactory: () => factory }),
  });
};

/**
 * @param {{ fake: any, powers?: any, features?: any[], views?: any }} options
 */
const setup = async ({ fake, powers = fake.powers, features = [], views }) => {
  const dom = makeTestDom({ width: 1024 });
  const controller = makeController({
    storage: undefined,
    locks: { request: (_name, callback) => callback() },
    features,
  });
  const shell = mount({
    root: dom.root,
    controller,
    features,
    views: { sessions: views ?? sessionViews },
    window: dom.window,
    schedule: fn => fn(),
  });
  await controller.attach(powers);
  await flush();
  const $ = (/** @type {string} */ selector) =>
    dom.document.querySelector(selector);
  const $$ = (/** @type {string} */ selector) => [
    ...dom.document.querySelectorAll(selector),
  ];
  const open = async () => {
    $('.floot-new-btn').click();
    await flush();
  };
  const dialog = () => $('.thix-new-session');
  /** @param {number} index */
  const card = index => $(`.floot-preset-card[data-preset="${index}"]`);
  /**
   * @param {string} label
   * @param {string} value
   */
  const choose = async (label, value) => {
    const select = $(`select[aria-label="${label}"]`);
    select.value = value;
    fire(dom.window, select, 'change');
    await flush();
  };
  const modelOptions = () =>
    $$('select[aria-label="Model"] option').map(option => option.textContent);
  const close = async () => {
    shell.unmount();
    controller.setConnection('reconnecting');
    await flush();
    await dom.close();
  };
  return {
    dom,
    controller,
    $,
    $$,
    open,
    dialog,
    card,
    choose,
    modelOptions,
    close,
  };
};

test('helpers: model filter and discovery notes (A-9, R6-38)', t => {
  t.true(matchesModel({ title: 'Big Model', modelId: 'big-1' }, 'big m'));
  t.true(matchesModel({ title: 'Big Model', modelId: 'big-1' }, ' BIG-1 '));
  t.false(matchesModel({ title: 'Big Model', modelId: 'big-1' }, 'small'));
  t.true(matchesModel({ title: 'x', modelId: 'y' }, ''));
  t.deepEqual(discoveryNotes({ rows: [], state: 'ok' }), []);
  t.deepEqual(discoveryNotes({ rows: [{}], state: 'unavailable' }), [
    uiTexts.lastModelList,
  ]);
  t.deepEqual(
    discoveryNotes({ rows: [], state: 'unavailable', error: 'down' }),
    [uiTexts.accountsUnreachable, 'down'],
  );
});

test.serial(
  'presets: available, unavailable with its reason, a failed describe',
  async t => {
    const fake = makeFakePowers({
      presets: [
        presetOf({ label: 'chat-only' }),
        presetOf({
          label: 'development',
          description: 'A shell and a workspace',
          available: false,
          unavailableReason: 'needs a shell',
        }),
        presetOf({ label: 'general', available: true }),
        brokenPreset,
      ],
    });
    const { open, dialog, card, close, $ } = await setup({ fake });
    await open();
    t.truthy(dialog());
    t.is(
      $('.floot-modal-title').textContent,
      uiTexts.startNewSession,
      'titled as R6-38',
    );
    t.is(card(0).querySelector('.floot-preset-name').textContent, 'chat-only');
    t.false(card(0).disabled, 'missing `available` counts as available');
    t.false(card(2).disabled);
    t.true(card(1).disabled);
    t.is(
      card(1).querySelector('.thix-preset-reason').textContent,
      'needs a shell',
    );
    t.true(card(3).disabled);
    t.is(
      card(3).querySelector('.thix-preset-reason').textContent,
      uiTextOf.statusError('describe failed'),
    );
    card(1).click();
    await flush();
    t.is(
      fake.control.callsOf('SessionFactory', 'createSession').length,
      0,
      'an unavailable preset cannot be chosen',
    );
    t.truthy(dialog());
    await close();
  },
);

test.serial(
  'Factory default creates with the preset only; the dialog closes',
  async t => {
    const fake = makeFakePowers({
      presets: [presetOf({ label: 'chat-only' }), presetOf({ label: 'other' })],
    });
    const { open, dialog, card, close, controller, modelOptions } = await setup(
      {
        fake,
      },
    );
    await open();
    t.is(modelOptions()[0], uiTexts.factoryDefault);
    t.deepEqual(modelOptions(), [
      uiTexts.factoryDefault,
      'scripted-model — scripted-model (default)',
    ]);
    card(1).click();
    await flush();
    const creates = fake.control.callsOf('SessionFactory', 'createSession');
    t.is(creates.length, 1);
    const options = creates[0][2];
    t.is(
      options.preset,
      (await E(E(fake.powers.operator).getFactory()).listPresets())[1],
    );
    t.false('backend' in options);
    t.false('modelId' in options);
    t.false(
      'reasoningEffort' in options,
      'factory resolves effort for its default model',
    );
    t.is(dialog(), null);
    t.is(controller.getState().newSessionOpen, false);
    t.truthy(controller.getState().activeKey);
    await close();
  },
);

test.serial(
  'versioned provider slugs remain independently selectable when titles coincide',
  async t => {
    const fake = makeFakePowers();
    fake.control.addBackend('ChatGPT', {
      models: ['gpt-6-astra', 'gpt-6.2-astra'],
    });
    const powers = await withEfforts(
      fake,
      {},
      { 'gpt-6-astra': 'Astra', 'gpt-6.2-astra': 'Astra' },
    );
    const { open, choose, close, modelOptions, card } = await setup({
      fake,
      powers,
    });
    await open();
    await choose('Backend', '1');
    t.deepEqual(modelOptions(), [
      uiTexts.factoryDefault,
      'Astra — gpt-6-astra (default)',
      'Astra — gpt-6.2-astra',
    ]);
    await choose('Model', '1');
    card(0).click();
    await flush();
    const creates = fake.control.callsOf('SessionFactory', 'createSession');
    t.is(creates.length, 1);
    t.is(creates[0][2].modelId, 'gpt-6.2-astra');
    await close();
  },
);

test.serial('backends, catalogue pages, search and a chosen model', async t => {
  const fake = makeFakePowers();
  const many = Array.from(
    { length: 60 },
    (_, i) => `m-${String(i).padStart(2, '0')}`,
  );
  const second = fake.control.addBackend('Second', { models: many });
  const { open, choose, close, modelOptions, $, $$, card, dom } = await setup({
    fake,
  });
  await open();
  t.deepEqual(
    $$('select[aria-label="Backend"] option').map(o => o.textContent),
    ['Scripted', 'Second'],
  );
  const firstLoads = fake.control.callsOf('SessionFactory', 'listModels');
  t.is(firstLoads.length, 1, 'the catalogue is read when the dialog opens');

  await choose('Backend', '1');
  const loads = fake.control.callsOf('SessionFactory', 'listModels');
  t.is(loads.length, 2);
  t.is(loads[1][2].backend, second);
  t.is(modelOptions().length, 51, 'Factory default and the first page');
  t.truthy($('.thix-more-models'));

  $('.thix-more-models').click();
  await flush();
  const more = fake.control.callsOf('SessionFactory', 'listModels');
  t.is(more.length, 3);
  t.is(more[2][2].after, 'm-49');
  t.is(more[2][2].backend, second);
  t.is(modelOptions().length, 61);
  t.is($('.thix-more-models'), null, 'no further page');

  const search = $('input[aria-label="Search models"]');
  search.value = 'M-5';
  fire(dom.window, search, 'input');
  await flush();
  t.deepEqual(modelOptions(), [
    uiTexts.factoryDefault,
    ...many.slice(50).map(m => `${m} — ${m}`),
  ]);
  search.value = 'nothing like it';
  fire(dom.window, search, 'input');
  await flush();
  t.deepEqual(modelOptions(), [uiTexts.factoryDefault]);
  t.regex($('.thix-model-status').textContent, /No models match/);
  search.value = 'm-5';
  fire(dom.window, search, 'input');
  await flush();

  // m-53 is the fourth row of the filtered list, row 53 of the catalogue.
  await choose('Model', '53');
  card(0).click();
  await flush();
  const creates = fake.control.callsOf('SessionFactory', 'createSession');
  t.is(creates.length, 1);
  t.is(creates[0][2].backend, second);
  t.is(creates[0][2].modelId, 'm-53');
  t.is(
    creates[0][2].preset,
    (await E(E(fake.powers.operator).getFactory()).listPresets())[0],
  );
  await close();
});

test.serial(
  'an unavailable catalogue shows its text; Factory default still starts',
  async t => {
    const fake = makeFakePowers();
    fake.control.addBackend('Down', { state: 'unavailable' });
    const { open, choose, close, $, modelOptions, card } = await setup({
      fake,
    });
    await open();
    await choose('Backend', '1');
    const note = $('.floot-discovery-note');
    t.truthy(note);
    t.is(
      note.textContent,
      `${uiTexts.accountsUnreachable}catalogue unavailable`,
    );
    t.deepEqual(modelOptions(), [uiTexts.factoryDefault]);
    card(0).click();
    await flush();
    t.is(fake.control.callsOf('SessionFactory', 'createSession').length, 1);
    await close();
  },
);

test.serial(
  'model-specific effort defaults and overrides ignore legacy preset effort',
  async t => {
    const fake = makeFakePowers({
      presets: [presetOf({ label: 'thinker', reasoningEffort: 'high' })],
    });
    fake.control.addBackend('Effortful', {
      models: ['plain', 'deep', 'other'],
    });
    const powers = await withEfforts(fake, {
      deep: ['low', 'medium', 'high'],
      other: ['low', 'high'],
    });
    const { open, choose, close, card, $ } = await setup({
      fake,
      powers,
    });
    await open();
    await choose('Backend', '1');
    await choose('Model', '0');
    await choose('Model', '1');
    const effort = () => $('select[aria-label="Reasoning effort"]');
    t.is(effort().value, 'medium');
    await choose('Reasoning effort', 'high');
    await choose('Model', '2');
    t.is(effort().value, '');
    await choose('Model', '0');
    t.is(effort(), null);
    await choose('Model', '1');
    t.is(effort().value, 'medium');
    await choose('Reasoning effort', 'low');
    card(0).click();
    await flush();
    const creates = fake.control.callsOf('SessionFactory', 'createSession');
    t.is(creates.length, 1);
    t.is(creates[0][2].modelId, 'deep');
    t.is(creates[0][2].reasoningEffort, 'low');
    await close();
  },
);

test.serial(
  'a saved development model exposes its provider default and permits an override',
  async t => {
    let backend;
    const preset = Far('Preset', {
      describe: () =>
        harden({
          label: 'Development',
          template: 'development',
          backend,
          modelId: 'dev',
          reasoningEffort: 'obsolete',
        }),
    });
    const fake = makeFakePowers({ presets: [preset] });
    backend = fake.control.addBackend('Development provider', {
      models: ['other', 'dev'],
    });
    const powers = await withEfforts(
      fake,
      { dev: ['low', 'high'] },
      {},
      { dev: 'high' },
    );
    const { open, choose, close, card, $ } = await setup({ fake, powers });
    await open();
    await choose('Backend', '1');
    const modelReads = () =>
      fake.control.callsOf('SessionFactory', 'listModels').length;
    const readsBeforePreview = modelReads();
    card(0).click();
    await flush();
    t.is(modelReads(), readsBeforePreview);
    t.is($('select[aria-label="Reasoning effort"]').value, 'high');
    t.is(fake.control.callsOf('SessionFactory', 'createSession').length, 0);
    await choose('Reasoning effort', 'low');
    $('.floot-preset-card').click();
    await flush();
    const creates = fake.control.callsOf('SessionFactory', 'createSession');
    t.is(creates.length, 1);
    t.is(creates[0][2].preset, preset);
    t.is(creates[0][2].reasoningEffort, 'low');
    t.is(creates[0][2].modelId, 'dev');
    t.is(creates[0][2].backend, backend);
    await close();
  },
);

test.serial(
  'slot newSession.field renders with context; a throwing field is isolated',
  async t => {
    /** @type {any[]} */
    const seen = [];
    const features = [
      {
        id: 'network.toggle',
        slot: 'newSession.field',
        component: (/** @type {any} */ props) => {
          seen.push(props.context);
          return h('label', { class: 'fixture-field' }, 'Internet access');
        },
      },
      {
        id: 'network.broken',
        slot: 'newSession.field',
        order: 50,
        component: () => {
          throw Error('field broke');
        },
      },
    ];
    const fake = makeFakePowers();
    const { open, close, $, controller, card } = await setup({
      fake,
      features,
    });
    await open();
    t.is($('.fixture-field')?.textContent, 'Internet access');
    t.is(seen.at(-1), controller.featureContext());
    const slot = $('.thix-new-session [data-slot="newSession.field"]');
    t.truthy(slot);
    t.is(
      slot.firstChild.textContent,
      `network.broken: ${uiTextOf.statusError('field broke')}`,
      'order 50 comes first, and its error stays in its place',
    );
    t.false(card(0).disabled, 'the dialog still works');
    await close();
  },
);

test.serial('Escape, the backdrop and a failed create', async t => {
  const fake = makeFakePowers();
  const { open, close, $, dialog, controller, card, dom } = await setup({
    fake,
  });
  await open();
  $('.floot-modal-title').click();
  await flush();
  t.truthy(dialog(), 'a click inside does not close');
  $('.floot-modal-backdrop').click();
  await flush();
  t.is(dialog(), null);
  t.false(controller.getState().newSessionOpen);

  await open();
  fire(dom.window, $('input[aria-label="Search models"]'), 'keydown', {
    key: 'Escape',
  });
  await flush();
  t.is(dialog(), null);

  await open();
  fake.control.failNext('SessionFactory', 'createSession', Error('no room'));
  card(0).click();
  await flush();
  t.truthy(dialog(), 'stays open');
  t.is(
    $('.thix-new-session-error')?.textContent,
    uiTextOf.statusError('no room'),
  );
  t.false(card(0).disabled, 'can try again');
  card(0).click();
  await flush();
  t.is(dialog(), null);
  t.is(fake.control.callsOf('SessionFactory', 'createSession').length, 2);
  await close();
});
