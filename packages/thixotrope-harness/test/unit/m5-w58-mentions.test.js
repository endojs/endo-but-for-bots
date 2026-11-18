// @ts-check
// W5.8 mention addon and attachment chips (m5-interfaces.md 4.1 items 2-3;
// R6-40, P-40): the `@` query rule, suggestions from inventory pages and
// `replaceRange`, keyboard choice, `send` with and without chips through
// the controller's addon chain, a resend after a reconnect (same chips) and
// after a simulated reload (`attachmentsLost`, draft kept), and the chips
// renderer with and without `attachments`.
import test from '@endo/ses-ava/prepare-endo.js';

import { E, Far } from '@endo/far';
import { h, render } from 'preact';

import { makeController } from '../../ui/src/controller/index.js';
import { DRAFT_PREFIX } from '../../ui/src/controller/drafts.js';
import { feature } from '../../ui/src/mentions/feature.js';
import {
  MENTION_PREFIX,
  attachmentLabels,
  makeMentions,
  matchRows,
  mentionQuery,
} from '../../ui/src/mentions/mentions.js';
import {
  attachmentsLost,
  maxAttachments,
  mentionTexts,
} from '../../ui/src/mentions/texts.js';
import { makeFakePowers, makeTestDom } from './_m3-fake-powers.js';

/** A `localStorage` stand-in. */
const makeStorage = () => {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    map,
    /** @param {string} key */
    getItem: key =>
      map.has(key) ? /** @type {string} */ (map.get(key)) : null,
    /**
     * @param {string} key
     * @param {string} value
     */
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    /** @param {string} key */
    removeItem: key => {
      map.delete(key);
    },
    /** @param {number} index */
    key: index => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
};

const LABELS = ['notes', 'notebook', 'annotated', 'calc', 'mail'];

/**
 * Fake powers with an inventory of `LABELS` and then `extra` more rows
 * (pages of 50), and a probe Composer that records every `submit` with
 * all its arguments and can fail the next ones.
 *
 * @param {{ extra?: number }} [options]
 */
const setupPowers = ({ extra = 0 } = {}) => {
  const labels = [
    ...LABELS,
    ...Array.from({ length: extra }, (_, i) => `item-${i}`),
  ];
  const things = new Map(labels.map(label => [label, Far('Thing', {})]));
  /** @type {any[]} */
  const pages = [];
  const inventory = Far('Inventory', {
    /** @param {string} [cursor] */
    list: cursor => {
      pages.push(cursor);
      const start = cursor === undefined ? 0 : Number(cursor.slice(1));
      const slice = labels.slice(start, start + 50);
      return harden({
        rows: slice.map(label => ({
          entry: Far('InventoryEntry', {}),
          label,
          value: things.get(label),
        })),
        rev: 1,
        ...(start + 50 < labels.length ? { next: `i${start + 50}` } : {}),
      });
    },
  });
  const fake = makeFakePowers({
    sessions: [{ title: 'one' }],
    operatorMethods: { getInventory: () => inventory },
  });
  /** @type {any[][]} */
  const submits = [];
  let failures = 0;
  const composer = Far('Composer', {
    /** @param {any[]} args */
    submit: async (...args) => {
      submits.push(args);
      if (failures > 0) {
        failures -= 1;
        throw Error('connection lost');
      }
      const [session, text, requestId] = args;
      return E(fake.powers.composer).submit(session, text, requestId);
    },
    /** @param {any[]} args */
    edit: (...args) => E(fake.powers.composer).edit(...args),
  });
  const powers = harden({ ...fake.powers, composer });
  return {
    powers,
    control: fake.control,
    things,
    pages,
    submits,
    /** @param {number} n */
    failNext: n => {
      failures = n;
    },
  };
};

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

const locks = harden({
  /**
   * @param {string} _name
   * @param {() => Promise<any>} callback
   */
  request: (_name, callback) => callback(),
});

/**
 * A controller attached to `powers` with the session open, and the
 * addon rendered as a Composer would render the slot.
 *
 * @param {ReturnType<typeof setupPowers>} page
 * @param {{ storage: ReturnType<typeof makeStorage>, mentions?: ReturnType<typeof makeMentions>, dom?: any }} options
 */
const openPage = async (page, { storage, mentions, dom }) => {
  const m = mentions ?? makeMentions({ storage: () => storage });
  const controller = makeController({
    storage,
    locks,
    features: m.features,
  });
  await controller.attach(page.powers);
  const key = controller.getState().sessions[0].key;
  await controller.selectSession(key);
  const draw = () => {
    if (!dom) return;
    const state = controller.getState();
    render(
      h(m.MentionAddon, {
        context: controller.featureContext(),
        input: state.view ? state.view.input : { text: '', caret: 0 },
        replaceRange: controller.replaceInput,
      }),
      dom.root,
    );
  };
  const stop = controller.subscribe(draw);
  draw();
  return { m, controller, key, draw, stop };
};

test('feature shape: the addon with send, and the chips renderer', t => {
  t.true(Array.isArray(feature));
  t.deepEqual(
    feature.map(item => [item.id, item.slot, typeof item.send]),
    [
      ['mentions.addon', 'composer.addon', 'function'],
      ['mentions.chips', 'message.renderer', 'undefined'],
    ],
  );
});

test('the @ query: at the start or after white space, up to 80 label characters', t => {
  t.deepEqual(mentionQuery('@', 1), { start: 0, end: 1, query: '' });
  t.deepEqual(mentionQuery('see @no', 7), { start: 4, end: 7, query: 'no' });
  t.deepEqual(mentionQuery('see @no more', 7), {
    start: 4,
    end: 7,
    query: 'no',
  });
  t.deepEqual(mentionQuery('line\n@ca', 8), { start: 5, end: 8, query: 'ca' });
  t.is(mentionQuery('mail a@b', 8), undefined, 'not inside a word');
  t.is(mentionQuery('@no te', 6), undefined, 'white space ends it');
  t.is(mentionQuery('@a/b', 4), undefined);
  t.is(mentionQuery('see no', 6), undefined);
  t.deepEqual(mentionQuery(`@${'x'.repeat(80)}`, 81)?.query, 'x'.repeat(80));
  t.is(mentionQuery(`@${'x'.repeat(81)}`, 82), undefined);
  t.deepEqual(
    matchRows(
      LABELS.map(label => ({ label })),
      'NO',
    ).map(row => row.label),
    ['notes', 'notebook', 'annotated'],
    'case folded, prefix matches first',
  );
});

test.serial(
  'typing @ lists inventory labels from every page; a choice calls replaceRange and keeps a chip',
  async t => {
    const dom = makeTestDom();
    const page = setupPowers({ extra: 60 });
    const storage = makeStorage();
    const { m, controller, key, stop } = await openPage(page, {
      storage,
      dom,
    });
    const q = (/** @type {string} */ selector) =>
      dom.document.querySelector(selector);
    const options = () =>
      [...dom.document.querySelectorAll('.thix-mention-option')].map(
        option => option.dataset.label,
      );

    controller.setInput('see @no');
    t.truthy(q('.thix-mention-menu'));
    await waitFor(() => options().length > 0);
    t.deepEqual(options(), ['notes', 'notebook', 'annotated']);
    await waitFor(() => page.pages.length === 2);
    t.deepEqual(page.pages, [undefined, 'i50'], 'two pages of 65 entries');

    controller.setInput('see @item-5');
    t.deepEqual(
      options(),
      [
        'item-5',
        'item-50',
        'item-51',
        'item-52',
        'item-53',
        'item-54',
        'item-55',
        'item-56',
      ],
      'labels from the second page, at most eight',
    );

    controller.setInput('see @zzz');
    t.is(q('.thix-mention-note')?.textContent, mentionTexts.noMatches);

    controller.setInput('see @no and more', 7);
    await waitFor(() => options().length === 3);
    q('.thix-mention-option[data-label="notes"]').dispatchEvent(
      new dom.window.MouseEvent('mousedown', { bubbles: true }),
    );
    t.deepEqual(controller.getState().view?.input, {
      text: 'see @notes  and more',
      caret: 11,
    });
    t.is(q('.thix-mention-menu'), null, 'the list closes');
    t.deepEqual(
      m.chipsFor(key).map(chip => chip.label),
      ['notes'],
    );
    t.is(m.chipsFor(key)[0].value, page.things.get('notes'));
    t.is(
      q('.thix-attachment-chip.pending')?.dataset.label,
      'notes',
      'the pending chip is shown',
    );

    // A typed or pasted @word stays text: no chip.
    controller.setInput('see @notes  and @calc');
    t.deepEqual(
      m.chipsFor(key).map(chip => chip.label),
      ['notes'],
    );

    // The chip's remove button drops it.
    q('.thix-attachment-remove').dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true }),
    );
    t.deepEqual(m.chipsFor(key), []);

    stop();
    render(null, dom.root);
    await dom.close();
  },
);

test.serial(
  'keyboard: arrows move, Enter chooses without reaching the composer, Escape closes',
  async t => {
    const dom = makeTestDom();
    const page = setupPowers();
    const storage = makeStorage();
    const { m, controller, key, stop } = await openPage(page, {
      storage,
      dom,
    });
    const textarea = dom.document.createElement('textarea');
    dom.document.body.appendChild(textarea);
    let composerKeys = 0;
    textarea.addEventListener('keydown', () => {
      composerKeys += 1;
    });
    /** @param {string} name */
    const press = async name => {
      textarea.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true }),
      );
      // Preact re-renders a hook's state change on a later tick.
      await new Promise(resolve => setTimeout(resolve, 5));
    };
    const highlighted = () =>
      dom.document.querySelector('.thix-mention-option.on')?.dataset.label;

    controller.setInput('@n');
    await waitFor(() => highlighted() !== undefined);
    t.is(highlighted(), 'notes');
    await press('ArrowDown');
    t.is(highlighted(), 'notebook');
    await press('ArrowUp');
    await press('ArrowUp');
    t.is(highlighted(), 'annotated', 'wraps around');
    await press('Enter');
    t.is(composerKeys, 0, 'the composer never saw the keys');
    t.is(controller.getState().view?.input.text, '@annotated ');
    t.deepEqual(
      m.chipsFor(key).map(chip => chip.label),
      ['annotated'],
    );

    controller.setInput('@annotated @ca');
    await waitFor(() => highlighted() === 'calc');
    await press('Escape');
    t.is(dom.document.querySelector('.thix-mention-menu'), null);
    await press('Enter');
    t.is(composerKeys, 1, 'with the list closed, keys reach the composer');

    stop();
    render(null, dom.root);
    await dom.close();
  },
);

test('send: chips go as attachments in insertion order; without chips the plain submit runs', async t => {
  const page = setupPowers();
  const storage = makeStorage();
  const { m, controller, key } = await openPage(page, { storage });

  await controller.send('hello');
  t.is(page.submits.length, 1);
  t.is(page.submits[0].length, 3, 'Composer.submit(session, text, requestId)');

  m.addChip(key, { label: 'notes', value: page.things.get('notes') });
  m.addChip(key, { label: 'calc', value: page.things.get('calc') });
  m.addChip(key, { label: 'mail', value: page.things.get('mail') });
  const receipt = await controller.send('read @notes with @calc');
  t.is(receipt?.duplicate, false);
  t.is(page.submits.length, 2);
  const [, text, , options] = page.submits[1];
  t.is(text, 'read @notes with @calc');
  t.deepEqual(
    options.attachments.map((/** @type {any} */ a) => a.label),
    ['notes', 'calc'],
    'mail was removed from the text: dropped',
  );
  t.is(options.attachments[0].value, page.things.get('notes'));
  t.is(options.attachments[1].value, page.things.get('calc'));
  t.deepEqual(m.chipsFor(key), [], 'chips dropped after the answer');
  t.false(
    [...storage.map.keys()].some(k => k.startsWith(MENTION_PREFIX)),
    'no label record left',
  );

  // At most maxAttachments chips.
  for (let i = 0; i < maxAttachments; i += 1) {
    t.true(m.addChip(key, { label: `l${i}`, value: Far('Thing', {}) }));
  }
  t.false(m.addChip(key, { label: 'one-more', value: Far('Thing', {}) }));
});

test('a resend after a reconnect sends the same chips; after a reload it throws attachmentsLost and the draft is kept', async t => {
  const page = setupPowers();
  const storage = makeStorage();
  const first = await openPage(page, { storage });

  // The first send's answer is lost.
  page.failNext(1);
  first.m.addChip(first.key, {
    label: 'notes',
    value: page.things.get('notes'),
  });
  await first.controller.send('look at @notes');
  t.true(
    first.controller.getState().view?.sendError?.includes('connection lost'),
  );
  const draftKey = `${DRAFT_PREFIX}${first.key}`;
  const draft = JSON.parse(/** @type {string} */ (storage.getItem(draftKey)));
  t.is(draft.text, 'look at @notes');
  t.deepEqual(
    JSON.parse(
      /** @type {string} */ (
        storage.getItem(`${MENTION_PREFIX}${draft.requestId}`)
      ),
    ),
    ['notes'],
    'the labels (only) are kept beside the draft',
  );
  const stored = [...storage.map.values()].join('\n');
  t.false(stored.includes('Thing'), 'no presence in storage');

  // A reload: a new page (new memory) over the same storage. The resend on
  // attach finds no chips and the text still mentions @notes.
  const second = await openPage(page, {
    storage,
    mentions: makeMentions({ storage: () => storage }),
  });
  const before = page.submits.length;
  await second.controller.attach(page.powers); // resend with the view open
  t.is(page.submits.length, before, 'nothing sent');
  t.is(
    second.controller.getState().view?.sendError,
    `error: ${attachmentsLost}`,
  );
  t.truthy(storage.getItem(draftKey), 'the draft is kept');
  t.throws(
    () =>
      second.m.send({
        context: second.controller.featureContext(),
        session: undefined,
        text: draft.text,
        requestId: draft.requestId,
        resend: true,
      }),
    { message: attachmentsLost },
  );
  // A draft whose text no longer holds the @label resends plainly.
  t.is(
    second.m.send({
      context: second.controller.featureContext(),
      session: undefined,
      text: 'look at it',
      requestId: draft.requestId,
      resend: true,
    }),
    undefined,
  );

  // A reconnect of the first page (chips still in memory) resends them.
  await first.controller.attach(page.powers);
  const resent = page.submits.at(-1);
  t.is(resent?.[2], draft.requestId);
  t.deepEqual(
    resent?.[3].attachments.map((/** @type {any} */ a) => a.label),
    ['notes'],
  );
  t.is(resent?.[3].attachments[0].value, page.things.get('notes'));
  t.is(storage.getItem(draftKey), null, 'the receipt cleared the draft');
  t.false([...storage.map.keys()].some(k => k.startsWith(MENTION_PREFIX)));
});

test('a draft without mention records resends through the plain submit', async t => {
  const storage = makeStorage();
  const m = makeMentions({ storage: () => storage });
  t.is(
    m.send({
      context: /** @type {any} */ ({ controller: { getState: () => ({}) } }),
      session: undefined,
      text: 'plain @words',
      requestId: 'r1',
      resend: true,
    }),
    undefined,
  );
});

test.serial(
  'chips renderer: one "Attached object" chip per label, nothing without attachments',
  async t => {
    const dom = makeTestDom();
    const m = makeMentions({ storage: () => undefined });
    const context = /** @type {any} */ ({});
    const turn = { turnId: 't1' };
    render(
      h(m.AttachmentChips, {
        context,
        turn,
        record: {
          kind: 'turn-started',
          turnId: 't1',
          attachments: ['notes', 'calc'],
        },
      }),
      dom.root,
    );
    const chips = [...dom.document.querySelectorAll('.thix-attachment-chip')];
    t.deepEqual(
      chips.map(chip => chip.dataset.label),
      ['notes', 'calc'],
    );
    t.true(
      chips.every(chip =>
        chip.textContent.includes(mentionTexts.attachedObject),
      ),
    );
    t.is(chips[0].getAttribute('title'), mentionTexts.attachedObject);

    render(
      h(m.AttachmentChips, {
        context,
        turn,
        record: { type: 'turn-start', turnId: 't1', attachments: ['mail'] },
      }),
      dom.root,
    );
    t.is(dom.document.querySelectorAll('.thix-attachment-chip').length, 1);

    render(
      h(m.AttachmentChips, {
        context,
        turn,
        record: { kind: 'turn-started', turnId: 't1' },
      }),
      dom.root,
    );
    t.is(dom.root.innerHTML, '');
    t.deepEqual(attachmentLabels({ attachments: [] }), []);
    t.deepEqual(attachmentLabels({ attachments: ['a', 3] }), ['a']);
    t.deepEqual(attachmentLabels(undefined), []);
    render(null, dom.root);
    await dom.close();
  },
);
