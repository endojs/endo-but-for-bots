// @ts-check
// The conversation's feature slots (m3-interfaces.md 6.2; W3.6): a fixture
// `composer.addon` receives the input and edits it with `replaceRange`
// (caret after the insert); a fixture `message.renderer` receives
// `{ context, turn, record }` with an unknown record field kept, for a
// kept, an archived and a live turn; a throwing renderer is isolated.
// Also the empty conversation and the raw view's printing of presences.
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';
import { h, render } from 'preact';

import { makeController } from '../../ui/src/controller/index.js';
import * as conversation from '../../ui/src/conversation/index.js';
import { mount } from '../../ui/src/shell/index.js';
import { makeFakePowers, makeTestDom } from './_m3-fake-powers.js';

const flush = async (rounds = 20) => {
  await null;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/**
 * @param {any} dom
 * @param {any} element
 * @param {string} type
 */
const click = async (dom, element, type = 'click') => {
  element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true }));
  await flush();
};

/** A `message.renderer` that shows what it was given. */
const rendererFeature = {
  id: 'fixture.renderer',
  slot: 'message.renderer',
  component: (/** @type {any} */ { context, turn, record }) =>
    h(
      'span',
      {
        class: 'fixture-renderer',
        'data-turn': turn.turnId,
        'data-has-turn': turn.turn ? 'yes' : 'no',
        'data-state': turn.status ? turn.status.state : '',
        'data-kind': record.kind ?? record.type,
        'data-input': typeof record.input === 'string' ? record.input : '',
        'data-attachments': JSON.stringify(record.attachments ?? null),
        'data-context': context && context.controller ? 'yes' : 'no',
      },
      'chips',
    ),
};

const throwingRenderer = {
  id: 'fixture.broken',
  slot: 'message.renderer',
  order: 200,
  component: () => {
    throw Error('renderer failed');
  },
};

test.serial(
  'composer.addon receives the input and edits it with replaceRange',
  async t => {
    const dom = makeTestDom();
    /** @type {any[]} */
    const seen = [];
    const addon = {
      id: 'fixture.addon',
      slot: 'composer.addon',
      component: (/** @type {any} */ { context, input, replaceRange }) => {
        seen.push({ ...input, hasContext: Boolean(context && context.powers) });
        return h(
          'button',
          {
            type: 'button',
            class: 'fixture-insert',
            onClick: () => replaceRange(input.caret, input.caret, ' big'),
          },
          `${input.text}|${input.caret}`,
        );
      },
    };
    const fake = makeFakePowers({ sessions: [{ key: 'a' }] });
    const controller = makeController({
      storage: dom.window.localStorage,
      locks: { request: (_name, fn) => fn() },
      features: [addon],
    });
    mount({
      root: dom.root,
      controller,
      features: [addon],
      views: { conversation },
      window: dom.window,
      schedule: fn => fn(),
    });
    await controller.attach(fake.powers);
    await flush();
    await controller.selectSession('a');
    await flush();
    controller.setInput('hello world', 5);
    await flush();
    const button = dom.document.querySelector('.fixture-insert');
    t.is(button?.textContent, 'hello world|5');
    t.true(seen[seen.length - 1].hasContext);
    await click(dom, button);
    const box = dom.document.querySelector('textarea.floot-input');
    t.is(box.value, 'hello big world');
    t.is(box.selectionStart, 9, 'the caret is after the insert');
    t.is(box.selectionEnd, 9);
    t.deepEqual(controller.getState().view?.input, {
      text: 'hello big world',
      caret: 9,
    });
    t.is(
      dom.document.querySelector('.fixture-insert')?.textContent,
      'hello big world|9',
      'the addon re-renders with the new input',
    );
    // replacing a range
    controller.replaceInput(0, 5, 'hi');
    await flush();
    t.is(box.value, 'hi big world');
    t.is(box.selectionStart, 2);
    await dom.close();
  },
);

test.serial(
  'message.renderer: a kept, an archived and a live turn, unknown fields kept',
  async t => {
    const dom = makeTestDom();
    const turn = Far('Turn', {});
    const view = {
      info: { key: 's', title: 't' },
      messages: [
        {
          turnId: 'a1',
          state: 'completed',
          at: 1,
          sealed: true,
          record: {
            kind: 'turn-started',
            turnId: 'a1',
            input: 'archived input',
            at: 1,
            attachments: ['old'],
          },
          records: [
            {
              kind: 'turn-started',
              turnId: 'a1',
              input: 'archived input',
              at: 1,
              attachments: ['old'],
            },
            {
              kind: 'turn-settled',
              turnId: 'a1',
              status: 'completed',
              at: 2,
              final: 'old reply',
            },
          ],
        },
        {
          turnId: 'k1',
          turn,
          state: 'completed',
          at: 3,
          record: {
            kind: 'turn-started',
            turnId: 'k1',
            input: 'kept input',
            at: 3,
            attachments: ['kept'],
          },
          records: [
            {
              kind: 'turn-started',
              turnId: 'k1',
              input: 'kept input',
              at: 3,
              attachments: ['kept'],
            },
            {
              kind: 'round-settled',
              turnId: 'k1',
              round: 0,
              text: 'kept reply',
              callCount: 0,
              usage: {},
              at: 4,
            },
            {
              kind: 'turn-settled',
              turnId: 'k1',
              status: 'completed',
              at: 5,
              final: 'kept reply',
            },
          ],
        },
        {
          turnId: 'l1',
          state: 'running',
          at: 6,
          record: {
            type: 'turn-start',
            turnId: 'l1',
            input: 'live input',
            at: 6,
            attachments: ['live'],
          },
          fold: {
            messages: [],
            streamingText: 'stre',
            phase: 'thinking',
            error: null,
          },
        },
      ],
      streamingText: 'stre',
      phase: 'thinking',
      busy: true,
      current: { turnId: 'l1', state: 'running', round: 0, at: 6 },
      pending: [],
      usage: {},
      earlier: 'none',
      status: '',
      input: { text: '', caret: 0 },
    };
    const controller = {
      getState: () => ({ view }),
      readContent: async () => '',
    };
    const context = {
      controller,
      powers: {},
      extra: () => undefined,
      call: async (/** @type {any} */ fn) => fn(),
    };
    render(
      h(conversation.Conversation, {
        state: { view },
        controller,
        features: [throwingRenderer, rendererFeature],
        context,
        narrow: false,
      }),
      dom.root,
    );
    await flush();
    const shown = [...dom.document.querySelectorAll('.fixture-renderer')].map(
      (/** @type {any} */ el) => ({
        turn: el.getAttribute('data-turn'),
        hasTurn: el.getAttribute('data-has-turn'),
        state: el.getAttribute('data-state'),
        kind: el.getAttribute('data-kind'),
        input: el.getAttribute('data-input'),
        attachments: JSON.parse(el.getAttribute('data-attachments')),
        context: el.getAttribute('data-context'),
      }),
    );
    t.deepEqual(shown, [
      {
        turn: 'a1',
        hasTurn: 'no',
        state: 'completed',
        kind: 'turn-started',
        input: 'archived input',
        attachments: ['old'],
        context: 'yes',
      },
      {
        turn: 'k1',
        hasTurn: 'yes',
        state: 'completed',
        kind: 'turn-started',
        input: 'kept input',
        attachments: ['kept'],
        context: 'yes',
      },
      {
        turn: 'l1',
        hasTurn: 'no',
        state: 'running',
        kind: 'turn-start',
        input: 'live input',
        attachments: ['live'],
        context: 'yes',
      },
    ]);
    // once per turn, under the turn's user message
    for (const turnElement of dom.document.querySelectorAll('.thix-turn')) {
      const children = [...turnElement.children];
      t.true(children[0].classList.contains('user'));
      t.is(children[1].getAttribute('data-slot'), 'message.renderer');
      t.is(turnElement.querySelectorAll('.fixture-renderer').length, 1);
      t.is(
        turnElement.querySelector('[data-feature="fixture.broken"]')
          ?.textContent,
        'fixture.broken: error: renderer failed',
        'a throwing renderer is an error line in its slot',
      );
    }
    t.deepEqual(
      [
        ...dom.document.querySelectorAll(
          '.floot-msg-row.assistant > .floot-msg',
        ),
      ].map((/** @type {any} */ el) => el.textContent),
      ['old reply', 'kept reply', 'stre'],
    );
    render(null, dom.root);
    await dom.close();
  },
);

test.serial(
  'message.renderer on a live turn through the controller keeps the event as delivered',
  async t => {
    const dom = makeTestDom();
    const fake = makeFakePowers({ sessions: [{ key: 'a' }] });
    const controller = makeController({
      storage: dom.window.localStorage,
      locks: { request: (_name, fn) => fn() },
      features: [rendererFeature],
    });
    mount({
      root: dom.root,
      controller,
      features: [rendererFeature],
      views: { conversation },
      window: dom.window,
      schedule: fn => fn(),
    });
    await controller.attach(fake.powers);
    await flush();
    await controller.selectSession('a');
    await flush();
    fake.control.publish('a', [
      {
        type: 'turn-start',
        turnId: 'x1',
        input: 'with chips',
        at: fake.control.now() + 1,
        attachments: [{ label: 'file' }],
      },
    ]);
    await flush();
    const element = dom.document.querySelector('.fixture-renderer');
    t.is(element?.getAttribute('data-turn'), 'x1');
    t.is(element?.getAttribute('data-kind'), 'turn-start');
    t.is(element?.getAttribute('data-state'), 'running');
    t.deepEqual(JSON.parse(element?.getAttribute('data-attachments')), [
      { label: 'file' },
    ]);
    await dom.close();
  },
);

test.serial('the empty conversation', async t => {
  const dom = makeTestDom();
  const view = {
    info: {},
    messages: [],
    pending: [],
    busy: false,
    earlier: 'none',
    input: { text: '', caret: 0 },
  };
  render(
    h(conversation.Conversation, {
      state: { view },
      controller: {},
      features: [],
      context: /** @type {any} */ ({}),
    }),
    dom.root,
  );
  await flush();
  t.is(
    dom.document.querySelector('.floot-empty-state')?.textContent,
    'Say hello to Floot.',
  );
  t.is(dom.document.querySelector('.floot-history-earlier'), null);
  render(null, dom.root);
  await dom.close();
});
