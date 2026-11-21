// @ts-check
// The conversation views (m3-interfaces.md 9.2, 9.3; W3.6) in happy-dom,
// driven by the W3.4 controller over the fake GatewayPowers: streaming
// bubble, thinking row and phase, tool groups and "Thought for", exec
// highlight, raw view, plain text and links, status rows (R6-51), the
// recovery panel's paging and acknowledgement, queue rows and the hold
// line, Stop, blocked sending (A-5), the sendError line, the usage bar and
// large content paging.
import test from '@endo/ses-ava/prepare-endo.js';

import { makeController } from '../../ui/src/controller/index.js';
import * as conversation from '../../ui/src/conversation/index.js';
import { mount, usageLabel } from '../../ui/src/shell/index.js';
import {
  uiTexts,
  uiTextOf,
} from '../../resources/agent-host/impl/gateway/protocol.js';
import { makeFakePowers, makeTestDom } from './_m3-fake-powers.js';

const flush = async (rounds = 20) => {
  await null;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/**
 * Mount the shell with the conversation views over a fake, attach, and open
 * the session `key`.
 *
 * @param {{ fake: { powers: any, control: any }, key: string, features?: any[], locks?: any }} options
 */
const open = async ({ fake, key, features = [], locks }) => {
  const dom = makeTestDom({ width: 1024 });
  const controller = makeController({
    storage: dom.window.localStorage,
    locks: locks === undefined ? { request: (_name, fn) => fn() } : locks,
    features,
  });
  const shell = mount({
    root: dom.root,
    controller,
    features,
    views: { conversation },
    window: dom.window,
    schedule: fn => fn(),
  });
  await controller.attach(fake.powers);
  await flush();
  await controller.selectSession(key);
  await flush();
  const $ = (/** @type {string} */ selector) =>
    dom.document.querySelector(selector);
  const $$ = (/** @type {string} */ selector) => [
    ...dom.document.querySelectorAll(selector),
  ];
  return { dom, controller, shell, $, $$ };
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
    : type === 'input'
      ? window.Event
      : window.MouseEvent;
  element.dispatchEvent(new EventClass(type, { bubbles: true, ...init }));
};

/**
 * Fire an event and let Preact's debounced re-render (local hook state)
 * and the controller's promises settle.
 *
 * @param {any} dom
 * @param {any} element
 * @param {string} type
 * @param {Record<string, any>} [init]
 */
const act = async (dom, element, type, init = {}) => {
  fire(dom.window, element, type, init);
  await flush();
};

/**
 * Type into the composer.
 *
 * @param {any} dom
 * @param {string} text
 */
const typeText = (dom, text) => {
  const box = dom.document.querySelector('textarea.floot-input');
  box.value = text;
  box.setSelectionRange(text.length, text.length);
  fire(dom.window, box, 'input');
  return box;
};

/**
 * @param {any} control
 * @param {string} key
 */
const runningTurnId = (control, key) => {
  const turns = control.turns(key);
  return turns[turns.length - 1].turnId;
};

test.serial(
  'streaming bubble from deltas, thinking row and phase, then the reply',
  async t => {
    const fake = makeFakePowers({ sessions: [{ key: 'a' }] });
    const { dom, controller, $, $$ } = await open({ fake, key: 'a' });
    await controller.send('hello');
    await flush();
    t.is($('.thix-turn .floot-msg-row.user')?.textContent, 'hello');
    t.is($('.thix-thinking-row')?.textContent, '');
    t.is(
      $('.floot-thinking[role="img"]')?.getAttribute('aria-label'),
      uiTexts.thinking,
    );
    t.is($$('.floot-thinking span').length, 3);
    const turnId = runningTurnId(fake.control, 'a');
    fake.control.publish('a', [{ type: 'phase', turnId, phase: 'thinking' }]);
    await flush();
    t.is($('.thix-thinking-row')?.textContent, '');
    t.is($('.floot-thinking')?.getAttribute('aria-label'), uiTexts.thinking);
    fake.control.publish('a', [
      { type: 'phase', turnId, phase: 'using tools' },
    ]);
    await flush();
    t.is($('.thix-phase')?.textContent, 'using tools');
    t.is($('.floot-thinking')?.getAttribute('aria-hidden'), 'true');
    fake.control.delta('a', 'Hel');
    await flush();
    t.is($('.streaming')?.textContent, 'Hel');
    fake.control.delta('a', 'lo');
    await flush();
    t.is($('.streaming')?.textContent, 'Hello');
    t.is($('.thix-thinking-row'), null, 'text replaces the thinking row');
    fake.control.finish('a', { final: 'Hello' });
    await flush();
    t.is($('.streaming'), null);
    t.deepEqual(
      $$('.thix-turn .floot-msg-row.assistant .floot-msg').map(
        el => el.textContent,
      ),
      ['Hello'],
    );
    t.is($('.thix-thinking-row'), null);
    // usage bar (R6-52) equals getUsage()
    const usage = await fake.control.session('a').getUsage();
    t.is($('.thix-usage')?.textContent, usageLabel(usage));
    t.is($('.thix-usage')?.textContent, uiTextOf.usage(10, 5, 1));
    await dom.close();
  },
);

test.serial(
  'tool groups, "Thought for", exec highlight and the raw view',
  async t => {
    t.is(uiTextOf.thoughtFor(62, true), '1m2s');
    const fake = makeFakePowers({ sessions: [{ key: 'a' }] });
    const { dom, controller, $, $$ } = await open({ fake, key: 'a' });
    await controller.send('compute');
    await flush();
    const turnId = runningTurnId(fake.control, 'a');
    fake.control.publish('a', [
      {
        type: 'thinking',
        turnId,
        id: 'th1',
        text: 'Let me   think\nabout it',
        startedAt: 1000,
        endedAt: 63_500,
        truncated: false,
      },
    ]);
    fake.control.tool('a', {
      name: 'exec',
      args: JSON.stringify({ code: 'const x = 1;\nreturn x;' }),
      result: '1',
    });
    fake.control.tool('a', { name: 'read', args: '{"path":"a"}', result: 'A' });
    fake.control.finish('a', { final: 'done' });
    await flush();
    const head = $('.floot-actions-head');
    t.truthy(head);
    t.is(
      $('.floot-actions-count')?.textContent,
      `${uiTextOf.thoughtFor(62, false)} · 2 actions`,
    );
    t.is($('.floot-actions-detail')?.textContent, 'exec, read');
    t.is($('.floot-actions-body'), null, 'closed by default');
    await act(dom, head, 'click');
    const entries = $$('.floot-action-head');
    t.is(entries.length, 3);
    t.is(entries[0].textContent?.includes('Let me think about it'), true);
    await act(dom, entries[1], 'click');
    const code = $('.floot-code');
    t.truthy(code, 'exec source is highlighted');
    t.is(code?.textContent, 'const x = 1;\nreturn x;');
    t.deepEqual(
      [...(code?.querySelectorAll('.floot-tok-keyword') ?? [])].map(
        (/** @type {any} */ el) => el.textContent,
      ),
      ['const', 'return'],
    );
    t.deepEqual(
      $$('.floot-msg-row.assistant > .floot-msg').map(el => el.textContent),
      ['done'],
    );
    // `</>`: raw JSON of the entries as the controller holds them
    const toggle = $('.thix-raw-toggle');
    t.is(toggle?.textContent, uiTexts.rawView);
    await act(dom, toggle, 'click');
    const raw = $('.thix-raw-view')?.textContent ?? '';
    t.true(raw.includes('"type": "turn-start"'));
    t.true(raw.includes(`"turnId": "${turnId}"`));
    t.is($('.floot-actions'), null);
    await act(dom, $('.thix-raw-toggle'), 'click');
    t.is($('.thix-raw-view'), null);
    await dom.close();
  },
);

test.serial('plain text and links (R6-46)', async t => {
  const fake = makeFakePowers({ sessions: [{ key: 'a' }] });
  const { dom, controller, $$ } = await open({ fake, key: 'a' });
  await controller.send('links?');
  await flush();
  fake.control.finish('a', {
    final:
      'See http://127.0.0.1:8/a_(b). <b>not bold</b> https://127.0.0.1:9/x',
  });
  await flush();
  const bubble = $$('.floot-msg-row.assistant .floot-msg')[0];
  const links = [...bubble.querySelectorAll('a')];
  t.deepEqual(
    links.map((/** @type {any} */ a) => a.getAttribute('href')),
    ['http://127.0.0.1:8/a_(b)', 'https://127.0.0.1:9/x'],
  );
  for (const link of links) {
    t.is(link.getAttribute('target'), '_blank');
    t.is(link.getAttribute('rel'), 'noopener noreferrer');
  }
  t.is(bubble.querySelector('b'), null, 'markup stays text');
  t.true(bubble.textContent.includes('<b>not bold</b>'));
  t.true(bubble.textContent.includes('a_(b). '), 'the period stays text');
  await dom.close();
});

test.serial(
  'status rows (R6-51) and Details opens the recovery panel',
  async t => {
    const fake = makeFakePowers({
      sessions: [
        { key: 'a' },
        { key: 'b', turns: 2, lastState: 'interrupted' },
      ],
    });
    const { dom, controller, $, $$ } = await open({ fake, key: 'a' });
    await controller.send('one');
    await flush();
    fake.control.finish('a', { status: 'failed', error: 'provider said no' });
    await flush();
    await controller.send('two');
    await flush();
    fake.control.finish('a', { status: 'cancelled' });
    await flush();
    const rows = $$('.floot-turn-status');
    t.deepEqual(
      rows.map(
        row => row.querySelector('.floot-turn-status-summary')?.textContent,
      ),
      [uiTexts.turnFailed, uiTexts.turnStopped],
    );
    t.is(
      rows[0].querySelector('.thix-turn-status-reason')?.textContent,
      'provider said no',
    );
    await controller.selectSession('b');
    await flush();
    t.deepEqual(
      $$('.floot-turn-status-summary').map(el => el.textContent),
      [uiTexts.turnInterrupted],
    );
    await act(dom, $('.thix-details-btn'), 'click');
    await flush();
    t.is($('.floot-recovery h3')?.textContent, uiTexts.recoveryTitle);
    t.is($('.thix-conversation'), null, 'the panel replaces the conversation');
    await act(dom, $('.thix-recovery-close'), 'click');
    t.truthy($('.thix-conversation'));
    await dom.close();
  },
);

test.serial(
  'recovery panel: kept and archived pages, acknowledgement, blocked sending (A-5)',
  async t => {
    const fake = makeFakePowers({
      sessions: [
        { key: 'r', turns: 5, archived: 2, lastState: 'outcome-unknown' },
      ],
      pageTurns: 2,
    });
    const { dom, $, $$ } = await open({ fake, key: 'r' });
    // A-5: an unresolved outcome-unknown turn blocks sending
    const box = $('textarea.floot-input');
    t.is(box?.disabled, true);
    t.is($('.thix-composer-blocked')?.textContent, uiTexts.turnInterrupted);
    t.is($('.thix-send')?.disabled, true);

    await act(dom, $('.thix-details-btn'), 'click');
    await flush();
    const ids = () =>
      $$('.floot-recovery-turn').map(el => el.getAttribute('data-turn'));
    t.is(ids().length, 2);
    await act(dom, $('.thix-recovery-more'), 'click');
    await flush();
    t.is(ids().length, 3);
    await act(dom, $('.thix-recovery-more'), 'click');
    await flush();
    t.is(ids().length, 5, 'kept then archived turns');
    t.is($('.thix-recovery-more'), null, 'no older page');
    t.is($$('.floot-recovery-turn.sealed').length, 2);
    t.deepEqual(
      fake.control.callsOf('History', 'page').map(call => call.slice(3)),
      [[], ['h3'], ['h2']],
    );

    // acknowledge the newest (outcome-unknown) turn
    const unknown = $('.floot-recovery-turn.unknown');
    t.truthy(unknown);
    await act(dom, unknown.querySelector('.thix-recovery-head'), 'click');
    const ack = () => $('.thix-acknowledge-btn');
    t.is(ack()?.textContent, uiTexts.recordAcknowledgement);
    t.is(ack()?.disabled, true, 'needs a note and the confirmation');
    const note = $('.thix-recovery-note');
    note.value = 'checked the provider: nothing ran';
    await act(dom, note, 'input');
    await act(dom, $('.thix-confirm-effects'), 'click');
    t.is(ack()?.disabled, false);
    await act(dom, ack(), 'click');
    await flush();
    t.deepEqual(
      fake.control.callsOf('Turn', 'resolve').map(call => call[2]),
      ['checked the provider: nothing ran'],
    );
    t.truthy($('.floot-recovery-turn.acknowledged'));
    t.is($('.thix-acknowledge-btn'), null);
    await act(dom, $('.thix-recovery-close'), 'click');
    await flush();
    t.is($('textarea.floot-input')?.disabled, false, 'sending unblocked');
    t.is($('.thix-composer-blocked'), null);
    t.true(
      $('.thix-turn-status-note')?.textContent?.includes(
        'checked the provider: nothing ran',
      ),
    );
    await dom.close();
  },
);

test.serial(
  'queue rows: Send now, Edit, Delete, Send again and the hold line; Stop',
  async t => {
    const fake = makeFakePowers({
      sessions: [
        {
          key: 'q',
          running: 'working',
          pending: ['one', 'two', 'three', 'four'],
        },
      ],
    });
    const { dom, controller, $, $$ } = await open({ fake, key: 'q' });
    const rows = () => $$('.thix-queue .floot-msg-row.pending');
    t.deepEqual(
      rows().map(row => row.querySelector('.floot-msg')?.textContent),
      ['one', 'two', 'three', 'four'],
    );
    const sendNowButtons = () => $$('[data-action="send-now"]');
    t.is(sendNowButtons().length, 1, 'only the head, while a turn runs');
    t.is(sendNowButtons()[0].textContent, uiTexts.sendNow);

    // Edit the second row
    await act(dom, rows()[1].querySelector('[data-action="edit"]'), 'click');
    const editor = $('.floot-pending-input');
    t.is(editor?.value, 'two');
    editor.value = 'two, edited';
    await act(dom, editor, 'input');
    await act(dom, editor, 'keydown', { key: 'Enter' });
    await flush();
    t.is(fake.control.callsOf('Composer', 'edit')[0][3], 'two, edited');
    t.deepEqual(fake.control.pendingTexts('q'), [
      'one',
      'two, edited',
      'three',
      'four',
    ]);

    // Delete the third
    await act(dom, rows()[2].querySelector('[data-action="delete"]'), 'click');
    await flush();
    t.deepEqual(fake.control.pendingTexts('q'), ['one', 'two, edited', 'four']);
    t.is(rows().length, 3);

    // Send now on the head: sendNow; the session cancels the running turn
    // (M2 review), the page sends no Turn.cancel of its own
    await act(dom, sendNowButtons()[0], 'click');
    await flush();
    t.is(fake.control.callsOf('QueueEntry', 'sendNow').length, 1);
    t.is(fake.control.callsOf('Turn', 'cancel').length, 0);
    t.deepEqual(
      $$('.floot-turn-status-summary').map(el => el.textContent),
      [uiTexts.turnStopped],
    );

    // Stop the turn that started from the queue (R6-49)
    t.truthy($('.thix-stop'));
    t.is($('.thix-stop')?.textContent, uiTexts.stop);
    await act(dom, $('.thix-stop'), 'click');
    await flush();
    t.is(fake.control.callsOf('Turn', 'cancel').length, 1);
    t.deepEqual(
      $$('.floot-turn-status-summary').map(el => el.textContent),
      [uiTexts.turnStopped, uiTexts.turnStopped],
    );

    // A held queue: hold line, and the head says Send again after an
    // interruption
    fake.control.setHold('q', {
      reason: 'interrupted',
      message: 'Held: the service restarted.',
    });
    await flush();
    t.is($('.floot-pending-hold')?.textContent, 'Held: the service restarted.');
    t.deepEqual(
      sendNowButtons().map(el => el.textContent),
      [uiTexts.sendAgain],
    );
    t.true(controller.getState().view?.hold !== undefined);
    await dom.close();
  },
);

test.serial(
  'composer: Enter sends, Shift+Enter and IME do not, sendError line',
  async t => {
    const fake = makeFakePowers({ sessions: [{ key: 'a' }] });
    const { dom, controller, $ } = await open({ fake, key: 'a' });
    const box = typeText(dom, 'first');
    await act(dom, box, 'keydown', { key: 'Enter', shiftKey: true });
    await act(dom, box, 'keydown', { key: 'Enter', isComposing: true });
    await act(dom, box, 'keydown', { key: 'Enter', keyCode: 229 });
    await flush();
    t.is(fake.control.callsOf('Composer', 'submit').length, 0);
    fake.control.failNext('Composer', 'submit', Error('gateway away'));
    await act(dom, box, 'keydown', { key: 'Enter' });
    await flush();
    t.is(fake.control.callsOf('Composer', 'submit').length, 1);
    t.is(
      $('.thix-send-error')?.textContent,
      uiTextOf.statusError('gateway away'),
    );
    t.is($('textarea.floot-input')?.value, 'first', 'the text is kept');
    typeText(dom, 'first!');
    t.is($('.thix-send-error'), null, 'an edit clears the error');
    await act(dom, $('.thix-send'), 'click');
    await flush();
    const submits = fake.control.callsOf('Composer', 'submit');
    t.is(submits.length, 2);
    t.is(submits[1][3], 'first!');
    t.is(submits[1][4], submits[0][4], 'the saved request id is reused');
    t.is($('textarea.floot-input')?.value, '');
    t.is(controller.getState().view?.input.text, '');
    // whitespace sends nothing
    typeText(dom, '   ');
    await act(dom, $('.thix-send'), 'click');
    await flush();
    t.is(fake.control.callsOf('Composer', 'submit').length, 2);
    await dom.close();
  },
);

test.serial('composer without Web Locks is disabled with its text', async t => {
  const fake = makeFakePowers({ sessions: [{ key: 'a' }] });
  const { dom, $ } = await open({ fake, key: 'a', locks: null });
  t.is($('textarea.floot-input')?.disabled, true);
  t.is($('.thix-composer-blocked')?.textContent, uiTexts.noWebLocks);
  await dom.close();
});

test.serial(
  'large content: a staged text shows its preview and pages in on Show all',
  async t => {
    const fake = makeFakePowers({ sessions: [{ key: 'a' }] });
    const { dom, $ } = await open({ fake, key: 'a' });
    const line = 'é0123456789abcdefghijklmnopqrstuvwxyz\n';
    const big = line.repeat(1400); // about 54 KB: three Content pages
    const staged = fake.control.stage(big);
    fake.control.publish('a', [
      {
        type: 'turn-start',
        turnId: 'big',
        input: staged,
        at: fake.control.now() + 1,
      },
    ]);
    await flush();
    const button = $('.thix-show-all');
    t.truthy(button);
    t.is(button?.textContent, `Show all (${staged.bytes} bytes)`);
    t.not($('.floot-msg-row.user .floot-msg')?.textContent, big);
    await act(dom, button, 'click');
    await flush();
    t.is($('.thix-show-all'), null);
    t.is($('.floot-msg-row.user .floot-msg')?.textContent, big);
    t.is(fake.control.callsOf('Content', 'read').length, 3);
    await dom.close();
  },
);
