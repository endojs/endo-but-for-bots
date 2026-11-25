// @ts-check
// The session sidebar (R6-36, R6-37; m3-interfaces.md 9.3; W3.5) in
// happy-dom over the real controller and the fake powers: rows with their
// circles and two lines, the empty text, live insert/rename/remove, inline
// rename keys, keyboard reach, the inline delete confirmation, and the row
// helpers.
import test from '@endo/ses-ava/prepare-endo.js';

import { options as preactOptions } from 'preact';

import { makeController } from '../../ui/src/controller/index.js';
import { mount } from '../../ui/src/shell/index.js';
import * as sessionViews from '../../ui/src/sessions/index.js';
import { Conversation } from '../../ui/src/conversation/Conversation.js';
import {
  uiTexts,
  uiTextOf,
} from '../../resources/agent-host/impl/gateway/protocol.js';
import { makeFakePowers, makeTestDom } from './_m3-fake-powers.js';

const {
  countsLabel,
  lifecycleNote,
  runtimeLabel,
  sessionStatusOf,
  statusLabels,
} = sessionViews;

// Hook effects run on the next turn instead of after a 100 ms frame timeout.
/** @type {any} */ (preactOptions).requestAnimationFrame = (
  /** @type {() => void} */ fn,
) => setImmediate(fn);

const flush = async (rounds = 20) => {
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
    : type === 'input' || type === 'blur'
      ? window.Event
      : window.MouseEvent;
  element.dispatchEvent(new EventClass(type, { bubbles: true, ...init }));
};

/**
 * @param {any} fake
 * @param {number} [width]
 * @param {boolean} [transcript]
 */
const setup = async (fake, width = 1024, transcript = false) => {
  const dom = makeTestDom({ width });
  const { powers, control } = fake;
  const controller = makeController({
    storage: undefined,
    locks: { request: (_name, callback) => callback() },
    features: [],
  });
  const shell = mount({
    root: dom.root,
    controller,
    features: [],
    views: {
      sessions: sessionViews,
      ...(transcript && { conversation: { Conversation } }),
    },
    window: dom.window,
    schedule: fn => fn(),
  });
  await controller.attach(powers);
  await flush();
  /** @param {string} key */
  const row = key => dom.document.querySelector(`[data-key="${key}"]`);
  const rows = () => [...dom.document.querySelectorAll('.floot-session-item')];
  // Stop drawing and the controller's pumps before the window goes.
  const close = async () => {
    shell.unmount();
    controller.setConnection('reconnecting');
    await flush();
    await dom.close();
  };
  return { dom, controller, shell, control, row, rows, close };
};

test.serial('row helpers: circle, note, runtime line and counts (R6-36)', t => {
  t.is(sessionStatusOf({ state: 'ready', activity: 'passive' }), 'passive');
  t.is(sessionStatusOf({ state: 'ready', activity: 'working' }), 'working');
  t.is(sessionStatusOf({ state: 'ready', activity: 'error' }), 'error');
  t.is(sessionStatusOf({ state: 'creating', activity: 'passive' }), 'working');
  t.is(sessionStatusOf({ state: 'deleting', activity: 'error' }), 'working');
  t.is(sessionStatusOf({ state: 'error', activity: 'passive' }), 'error');
  t.is(sessionStatusOf({ state: 'lost', activity: 'working' }), 'error');
  t.is(sessionStatusOf({ state: 'ready', activity: 'odd' }), 'passive');
  t.is(lifecycleNote('ready'), undefined);
  t.is(lifecycleNote('creating'), 'Starting…');
  t.is(lifecycleNote('deleting'), 'Deleting…');
  t.is(lifecycleNote('lost'), 'Unavailable: lost');
  t.is(
    runtimeLabel({ backendTitle: 'API', modelId: 'm-1', effort: 'high' }),
    'API · m-1 · high',
  );
  t.is(runtimeLabel({ backendTitle: 'API', modelId: 'm-1' }), 'API · m-1');
  t.is(
    countsLabel({ messageCount: 3, queuedCount: 1 }),
    uiTextOf.rowCounts(3, 1),
  );
  t.is(countsLabel({}), uiTextOf.rowCounts(0, 0));
});

test.serial(
  'rows show circle, title, runtime and counts; empty text',
  async t => {
    const empty = await setup(makeFakePowers());
    const emptyText = empty.dom.document.querySelector('.floot-session-empty');
    t.is(emptyText?.textContent, uiTexts.noSessions);
    t.is(
      empty.dom.document.querySelector('.floot-sidebar-title').textContent,
      uiTexts.sessions,
    );
    await empty.close();

    const fake = makeFakePowers({
      sessions: [
        {
          title: 'first',
          backendTitle: 'Scripted',
          modelId: 'scripted-model',
          effort: 'high',
          turns: 2,
          pending: ['a'],
        },
        { title: 'busy', activity: 'working' },
        { title: 'broken', state: 'lost' },
        { title: 'making', state: 'creating' },
      ],
    });
    const { dom, row, rows, close } = await setup(fake);
    t.deepEqual(
      rows().map(el => el.getAttribute('data-key')),
      ['s4', 's3', 's2', 's1'],
    );
    t.is(dom.document.querySelector('.floot-session-empty'), null);
    const first = row('s1');
    t.is(first.querySelector('.floot-session-name').textContent, 'first');
    t.is(
      first.querySelector('.floot-session-runtime').textContent,
      'Scripted · scripted-model · high',
    );
    t.is(
      first.querySelector('.floot-session-sub').textContent,
      uiTextOf.rowCounts(2, 1),
    );
    /** @param {string} key */
    const circle = key =>
      row(key).querySelector('.floot-status-dot').getAttribute('aria-label');
    t.is(circle('s1'), statusLabels.passive);
    t.is(circle('s2'), statusLabels.working);
    t.is(circle('s3'), statusLabels.error);
    t.is(circle('s4'), statusLabels.working);
    t.true(
      row('s3')
        .querySelector('.floot-status-dot')
        .classList.contains('floot-status-dot-error'),
    );
    t.is(
      row('s3').querySelector('.thix-session-note').textContent,
      'Unavailable: lost',
    );
    t.is(row('s1').querySelector('.thix-session-note'), null);
    await close();
  },
);

test.serial('the list follows the feed: insert, rename, remove', async t => {
  const fake = makeFakePowers({ sessions: [{ title: 'one' }] });
  const { dom, controller, control, row, rows, close } = await setup(fake);
  t.is(rows().length, 1);
  control.addSession({ title: 'two' });
  await flush();
  const keys = () => rows().map(el => el.getAttribute('data-key'));
  t.deepEqual(keys(), ['s2', 's1']);
  control.patchRow('s1', { activity: 'working' });
  await flush();
  t.deepEqual(keys(), ['s2', 's1']);
  t.is(row('s2').querySelector('.floot-session-name').textContent, 'two');
  control.patchRow('s2', { title: 'renamed', activity: 'working' });
  await flush();
  t.is(row('s2').querySelector('.floot-session-name').textContent, 'renamed');
  t.is(
    row('s2').querySelector('.floot-status-dot').getAttribute('aria-label'),
    statusLabels.working,
  );
  await controller.attach(fake.powers);
  await flush();
  t.deepEqual(keys(), ['s2', 's1']);
  control.removeSession('s1');
  await flush();
  t.is(rows().length, 1);
  t.is(row('s1'), null);
  control.removeSession('s2');
  await flush();
  t.is(
    dom.document.querySelector('.floot-session-empty')?.textContent,
    uiTexts.noSessions,
  );
  await close();
});

test.serial('selecting a row opens it; + opens the dialog', async t => {
  const fake = makeFakePowers({
    sessions: [{ title: 'one' }, { title: 'two' }],
  });
  const { dom, controller, row, close } = await setup(fake);
  row('s2').click();
  await flush();
  t.is(controller.getState().activeKey, 's2');
  t.true(row('s2').classList.contains('active'));
  t.false(row('s1').classList.contains('active'));
  const newButton = dom.document.querySelector('.floot-new-btn');
  t.is(newButton.getAttribute('aria-label'), uiTexts.newSession);
  t.truthy(newButton.querySelector('svg[aria-hidden="true"]'), 'an icon');
  newButton.click();
  t.true(controller.getState().newSessionOpen);
  await close();
});

test.serial(
  'keyboard: each row is an open button with aria-current, then Rename and Delete',
  async t => {
    const fake = makeFakePowers({
      sessions: [{ title: 'one' }, { title: 'two' }],
    });
    const { controller, row, close } = await setup(fake);
    /** @param {string} key */
    const open = key => row(key).querySelector('[data-action="open"]');
    t.is(open('s1').tagName, 'BUTTON');
    t.is(open('s1').getAttribute('type'), 'button');
    t.is(open('s1').getAttribute('aria-current'), null);
    // Enter or Space on the focused button is a click.
    open('s1').focus();
    open('s1').click();
    await flush();
    t.is(controller.getState().activeKey, 's1');
    t.is(open('s1').getAttribute('aria-current'), 'true');
    t.is(open('s2').getAttribute('aria-current'), null);
    // Tab order inside a row: open, Rename, Delete, all real buttons.
    t.deepEqual(
      [...row('s1').querySelectorAll('button')].map(button => [
        button.getAttribute('data-action'),
        button.getAttribute('aria-label'),
        button.hasAttribute('tabindex'),
      ]),
      [
        ['open', null, false],
        ['rename', uiTextOf.renameSession('one'), false],
        ['delete', uiTextOf.deleteSession('one'), false],
      ],
    );
    for (const action of ['rename', 'delete']) {
      const button = row('s1').querySelector(`[data-action="${action}"]`);
      t.truthy(button.querySelector('svg[aria-hidden="true"]'), action);
      t.false(/[\u2700-\u27bf\u{1f000}-\u{1faff}]/u.test(button.textContent));
    }
    await close();
  },
);

test.serial(
  'rename: the Rename button and double-click; Enter saves, Esc cancels, blur saves',
  async t => {
    const fake = makeFakePowers({ sessions: [{ title: 'old' }] });
    const { dom, control, controller, row, close } = await setup(fake);
    const renames = () => control.callsOf('Session', 'rename').map(c => c[2]);
    const input = () => row('s1').querySelector('.floot-session-title-input');

    row('s1').querySelector('[data-action="rename"]').click();
    await flush();
    t.truthy(input());
    t.is(input().value, 'old');
    t.is(controller.getState().activeKey, undefined, 'Rename does not select');
    input().value = 'new';
    fire(dom.window, input(), 'input');
    fire(dom.window, input(), 'keydown', { key: 'Enter' });
    await flush();
    t.deepEqual(renames(), ['new']);
    t.is(input(), null);
    t.is(
      dom.document.activeElement,
      row('s1').querySelector('[data-action="open"]'),
      'Enter returns focus to the row',
    );
    await flush();
    t.is(row('s1').querySelector('.floot-session-name').textContent, 'new');

    fire(
      dom.window,
      row('s1').querySelector('.floot-session-name'),
      'dblclick',
    );
    await flush();
    t.truthy(input());
    input().value = 'discarded';
    fire(dom.window, input(), 'input');
    fire(dom.window, input(), 'keydown', { key: 'Escape' });
    await flush();
    t.is(input(), null);
    t.deepEqual(renames(), ['new'], 'Esc saves nothing');
    t.is(
      dom.document.activeElement,
      row('s1').querySelector('[data-action="open"]'),
      'Esc returns focus to the row',
    );

    fire(
      dom.window,
      row('s1').querySelector('.floot-session-name'),
      'dblclick',
    );
    await flush();
    input().value = '  by blur  ';
    fire(dom.window, input(), 'input');
    fire(dom.window, input(), 'blur', { bubbles: false });
    await flush();
    t.deepEqual(renames(), ['new', 'by blur'], 'trimmed');

    fire(
      dom.window,
      row('s1').querySelector('.floot-session-name'),
      'dblclick',
    );
    await flush();
    input().value = '   ';
    fire(dom.window, input(), 'input');
    fire(dom.window, input(), 'keydown', { key: 'Enter' });
    await flush();
    t.deepEqual(renames(), ['new', 'by blur'], 'a blank title is not sent');
    await close();
  },
);

test.serial(
  'delete asks Delete "<title>"? inline and deletes only when confirmed',
  async t => {
    const fake = makeFakePowers({ sessions: [{ title: 'doomed' }] });
    const { dom, controller, control, row, rows, close } = await setup(fake);
    const target = control.session('s1');
    const globals = /** @type {any} */ (globalThis);
    globals.confirm = () => t.fail('the browser confirm is not used');
    const form = () => row('s1').querySelector('[data-form="delete"]');
    /** @param {string} action */
    const button = action =>
      row('s1').querySelector(`[data-action="${action}"]`);
    const deletes = () => control.callsOf('SessionFactory', 'deleteSession');
    try {
      t.is(form(), null);
      button('delete').click();
      await flush();
      t.truthy(form());
      t.is(form().getAttribute('role'), 'group');
      t.is(form().getAttribute('aria-label'), uiTextOf.confirmDelete('doomed'));
      t.is(
        form().querySelector('.thix-row-confirm-text').textContent,
        uiTextOf.confirmDelete('doomed'),
      );
      t.is(button('confirm-delete').textContent, uiTexts.delete);
      t.is(button('cancel-delete').textContent, uiTexts.cancel);
      t.is(
        dom.document.activeElement,
        button('cancel-delete'),
        'focus on Cancel',
      );
      t.is(
        controller.getState().activeKey,
        undefined,
        'Delete does not select',
      );

      button('cancel-delete').click();
      await flush();
      t.is(form(), null);
      t.is(
        dom.document.activeElement,
        button('delete'),
        'focus back on Delete',
      );
      t.is(deletes().length, 0);

      button('delete').click();
      await flush();
      fire(dom.window, button('cancel-delete'), 'keydown', { key: 'Escape' });
      await flush();
      t.is(form(), null, 'Esc cancels');
      t.is(deletes().length, 0);
      t.is(rows().length, 1);

      button('delete').click();
      await flush();
      button('confirm-delete').click();
      await flush();
      t.is(deletes().length, 1);
      t.is(deletes()[0][2], target, 'the Session object itself');
      t.is(
        controller.getState().activeKey,
        undefined,
        'confirm does not select',
      );
      t.is(rows().length, 0);
    } finally {
      delete globals.confirm;
    }
    await close();
  },
);

test.serial(
  'agent inventory reads the selected session while expanded and follows its revisions',
  async t => {
    const longLabel = 'saved-'.repeat(20);
    const longPreview = '界'.repeat(70);
    let revision = 0;
    let wait = false;
    /** @type {(page: any) => void} */
    let finish = () => {};
    const fake = makeFakePowers({
      sessions: [
        {
          key: 'one',
          inventoryPage: cursor => {
            if (wait)
              return new Promise(resolve => {
                finish = resolve;
              });
            return cursor === undefined
              ? harden({
                  rev: revision,
                  rows: [
                    {
                      label: 'tools/paper',
                      kind: 'value',
                      preview: String(revision),
                    },
                  ],
                  next: 'more',
                })
              : harden({
                  rev: revision,
                  rows: [
                    { label: 'alpha', kind: 'value', preview: 'null' },
                    { label: 'tools', kind: 'object' },
                    { label: 'tools/zinc', kind: 'object' },
                    ...(revision === 0
                      ? [
                          {
                            label: `tools/nested/${longLabel}`,
                            kind: 'value',
                            preview: longPreview,
                            truncated: true,
                          },
                        ]
                      : []),
                    { label: 'format', kind: 'object' },
                  ],
                });
          },
        },
        { key: 'two', inventoryPage: () => harden({ rev: 0, rows: [] }) },
        { key: 'legacy' },
      ],
    });
    const { dom, controller, control, close } = await setup(fake);
    const panel = () => dom.document.querySelector('.thix-session-inventory');
    const toggle = () =>
      fire(
        dom.window,
        dom.document.querySelector('.thix-inventory-toggle'),
        'click',
      );
    const reads = () => control.callsOf('Session', 'getInventoryPage').length;
    try {
      await controller.selectSession('one');
      t.is(reads(), 0);
      toggle();
      await flush();
      const directory = (/** @type {string} */ path) =>
        panel().querySelector(`li[data-directory="${path}"]`);
      const children = (/** @type {any} */ list) =>
        [...list.children].map(
          item => item.dataset.label || `${item.dataset.directory}/`,
        );
      const folderButton = () => directory('tools').querySelector('button');
      const folderList = () => directory('tools').querySelector('ul');
      t.deepEqual(
        children(panel().querySelector('ul[aria-label="Inventory items"]')),
        ['alpha', 'format', 'tools', 'tools/'],
      );
      t.deepEqual(children(folderList()), [
        'tools/nested/',
        'tools/paper',
        'tools/zinc',
      ]);
      const nested = directory('tools/nested').querySelector('ul');
      t.false(nested.hidden);
      t.deepEqual(children(nested), [`tools/nested/${longLabel}`]);
      const longRow = nested.firstElementChild;
      t.is(
        longRow.querySelector('.thix-inventory-label').textContent,
        longLabel,
      );
      t.is(longRow.querySelector('code').textContent, `${longPreview}…`);
      t.is(panel().querySelector('[data-label="tools"] code'), null);
      t.is(
        panel().querySelector('[data-label="alpha"] code').textContent,
        'null',
      );
      t.is(reads(), 2);
      t.is(folderButton().getAttribute('aria-expanded'), 'true');
      folderButton().focus();
      t.is(dom.document.activeElement, folderButton());
      folderButton().click();
      await flush();
      t.true(folderList().hidden);
      revision += 1;
      control.publish('one', [{ type: 'inventory', revision }]);
      await flush();
      t.is(folderButton().getAttribute('aria-expanded'), 'false');
      t.true(folderList().hidden);
      folderButton().click();
      await flush();
      t.deepEqual(children(folderList()), ['tools/paper', 'tools/zinc']);
      t.is(
        panel().querySelector('[data-label="tools/paper"] code').textContent,
        '1',
      );
      toggle();
      await flush();
      const before = reads();
      revision += 1;
      control.publish('one', [{ type: 'inventory', revision }]);
      await flush();
      t.is(reads(), before);
      wait = true;
      toggle();
      await flush();
      await controller.selectSession('two');
      await flush();
      finish(
        harden({
          rev: revision,
          rows: [{ label: 'former-session', kind: 'object' }],
        }),
      );
      await flush();
      t.true(panel().textContent.includes('inventory is empty'));
      t.false(panel().textContent.includes('former-session'));
      await controller.selectSession('legacy');
      await flush();
      t.true(panel().textContent.includes('does not support inventory'));
      controller.setConnection('reconnecting');
      await flush();
      t.true(panel().textContent.includes('offline'));
    } finally {
      await close();
    }
  },
);

test.serial(
  'closing the mobile inventory drawer pauses inventory reads; reopening recovers after a failed page',
  async t => {
    let unavailable = true;
    const fake = makeFakePowers({
      sessions: [
        {
          key: 'mobile',
          inventoryPage: () => {
            if (unavailable) throw Error('page unavailable');
            return harden({
              rev: 2,
              rows: [{ label: 'journal', kind: 'object' }],
            });
          },
        },
      ],
    });
    const { dom, controller, control, close } = await setup(fake, 390);
    try {
      await controller.selectSession('mobile');
      const heading = dom.document.querySelector('.thix-inventory-toggle');
      t.is(heading.getAttribute('aria-expanded'), 'false');
      fire(dom.window, heading, 'click');
      await flush();
      const panel = dom.document.querySelector('.thix-session-inventory');
      t.true(panel.textContent.includes('Inventory unavailable.'));
      unavailable = false;
      fire(dom.window, panel.querySelector('[role="status"] button'), 'click');
      await flush();
      t.truthy(panel.querySelector('[data-label="journal"]'));
      fire(dom.window, heading, 'click');
      await flush();
      const requests = control.callsOf('Session', 'getInventoryPage').length;
      control.publish('mobile', [{ type: 'inventory', revision: 2 }]);
      await flush();
      t.is(control.callsOf('Session', 'getInventoryPage').length, requests);
      fire(dom.window, heading, 'click');
      await flush();
      t.is(control.callsOf('Session', 'getInventoryPage').length, requests + 1);
      t.truthy(panel.querySelector('[data-label="journal"]'));
    } finally {
      await close();
    }
  },
);

test.serial(
  'a revision change mid-page replaces all older inventory rows',
  async t => {
    const fake = makeFakePowers({
      sessions: [
        {
          key: 'changing',
          inventoryPage: cursor =>
            cursor === undefined
              ? harden({
                  rev: 1,
                  rows: [{ label: 'old', kind: 'object' }],
                  next: '1.1',
                })
              : harden({
                  rev: 2,
                  rows: [{ label: 'current', kind: 'value', preview: '42' }],
                }),
        },
      ],
    });
    const { dom, controller, close } = await setup(fake);
    try {
      await controller.selectSession('changing');
      fire(
        dom.window,
        dom.document.querySelector('.thix-inventory-toggle'),
        'click',
      );
      await flush();
      t.is(dom.document.querySelector('[data-label="old"]'), null);
      t.is(
        dom.document.querySelector('[data-label="current"] code').textContent,
        '42',
      );
    } finally {
      await close();
    }
  },
);

test.serial(
  'reattaching replaces the inventory source even at the same session key and revision',
  async t => {
    const current = (/** @type {string} */ label) =>
      makeFakePowers({
        sessions: [
          {
            key: 's1',
            inventoryPage: () =>
              harden({ rev: 0, rows: [{ label, kind: 'object' }] }),
          },
        ],
      });
    const first = current('oldBinding');
    const next = current('newBinding');
    const { dom, controller, close } = await setup(first);
    try {
      await controller.selectSession('s1');
      fire(
        dom.window,
        dom.document.querySelector('.thix-inventory-toggle'),
        'click',
      );
      await flush();
      t.truthy(dom.document.querySelector('[data-label="oldBinding"]'));
      controller.setConnection('reconnecting');
      await flush();
      await controller.attach(next.powers);
      await flush();
      t.is(dom.document.querySelector('[data-label="oldBinding"]'), null);
      t.truthy(dom.document.querySelector('[data-label="newBinding"]'));
      t.is(first.control.callsOf('Session', 'getInventoryPage').length, 1);
    } finally {
      await close();
    }
  },
);

test.serial(
  'inspection follows child identities across levels and reconnects, preserving the root draft',
  async t => {
    const children = (/** @type {string} */ childKey) =>
      makeFakePowers({
        sessions: [
          {
            key: 'root',
            title: 'Research',
            inventoryPage: () =>
              harden({
                rev: 0,
                rows: [
                  { label: 'subagents/scout', kind: 'subagent', childKey },
                ],
              }),
          },
          {
            key: childKey,
            title: 'A distinct child title',
            parent: { key: 'root', name: 'scout' },
            turns: 1,
            inventoryPage: () =>
              harden({
                rev: 0,
                rows: [
                  {
                    label: 'subagents/reader',
                    kind: 'subagent',
                    childKey: 'deep',
                  },
                ],
              }),
          },
          {
            key: 'deep',
            title: 'Nested',
            parent: { key: childKey, name: 'reader' },
            turns: 2,
          },
          { key: 'other', title: 'Other root' },
        ],
      });
    const fake = children('child');
    const { controller, dom, close } = await setup(fake);
    try {
      await controller.selectSession('root');
      controller.setInput('saved root text', 4);
      const click = (/** @type {string} */ selector) =>
        fire(dom.window, dom.document.querySelector(selector), 'click');
      click('.thix-inventory-toggle');
      await flush();
      const scout = dom.document.querySelector(
        '[data-directory="subagents"] [data-label="subagents/scout"] > button',
      );
      t.is(scout.getAttribute('aria-label'), 'Inspect scout');
      t.is(scout.querySelector('.thix-inventory-label').textContent, 'scout');
      scout.click();
      await flush();
      t.is(controller.getState().activeKey, 'child');
      t.deepEqual(
        fake.control
          .callsOf('Operator', 'findSubagentSession')
          .map(args => args.slice(3)),
        [['scout', 'child']],
      );
      t.is(controller.getState().view?.messages.length, 1);
      t.deepEqual(
        controller.getState().sessions.map(r => r.key),
        ['root', 'other'],
      );
      t.is(dom.document.querySelector('[aria-label="Settings"]'), null);
      await controller.send('ignored');
      await controller.stop();
      await controller.deleteSession('child');
      t.is(fake.control.callsOf('Composer', 'submit').length, 0);
      t.is(fake.control.callsOf('SessionFactory', 'deleteSession').length, 0);
      click('[aria-label="Inspect reader"]');
      await flush();
      t.is(controller.getState().view?.messages.length, 2);
      t.is(
        dom.document.querySelectorAll('.thix-session-path button').length,
        2,
      );
      controller.setConnection('reconnecting');
      const again = children('child');
      await controller.attach(again.powers);
      t.is(controller.getState().activeKey, 'deep');
      t.deepEqual(
        again.control
          .callsOf('Operator', 'findSubagentSession')
          .map(args => args.slice(3)),
        [
          ['scout', 'child'],
          ['reader', 'deep'],
        ],
      );
      await controller.openAncestor('child');
      t.is(controller.getState().activeKey, 'child');
      controller.setConnection('reconnecting');
      await controller.attach(children('replacement').powers);
      t.is(controller.getState().activeKey, 'root');
      t.deepEqual(controller.getState().view?.input, {
        text: 'saved root text',
        caret: 4,
      });
      t.truthy(dom.document.querySelector('[aria-label="Settings"]'));
    } finally {
      await close();
    }
  },
);

test.serial(
  'switching roots while a child lookup is outstanding discards its answer',
  async t => {
    let finish = () => {};
    const fake = makeFakePowers({
      beforeChildLookup: () =>
        new Promise(resolve => {
          finish = () => resolve();
        }),
      sessions: [
        { key: 'one' },
        { key: 'child', parent: { key: 'one', name: 'scout' } },
        { key: 'two' },
      ],
    });
    const { controller, close } = await setup(fake);
    try {
      await controller.selectSession('one');
      const opening = controller.openSubagent('one', 'scout', 'child');
      await flush();
      await controller.selectSession('two');
      finish();
      await opening;
      t.is(controller.getState().activeKey, 'two');
      t.deepEqual(
        controller.getState().sessionPath.map(s => s.key),
        ['two'],
      );
      t.is(controller.getState().view?.info.key, 'two');
      t.is(controller.getState().status, '');
    } finally {
      await close();
    }
  },
);

test.serial(
  'a breadcrumb restores the same turn and offset from older transcript pages',
  async t => {
    const { controller, dom, close } = await setup(
      makeFakePowers({
        pageTurns: 2,
        sessions: [
          { key: 'root', turns: 8 },
          { key: 'child', parent: { key: 'root', name: 'scout' } },
        ],
      }),
      1024,
      true,
    );
    const proto = dom.window.HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(
      proto,
      'getBoundingClientRect',
    );
    // Happy DOM has no layout. Lay turns out in 100px blocks relative to
    // the transcript scrollport so offset assertions exercise the real component.
    Object.defineProperty(proto, 'getBoundingClientRect', {
      configurable: true,
      value() {
        const el = this.closest('.thix-conversation');
        const index = el
          ? [...el.querySelectorAll('[data-turn]')].indexOf(this)
          : -1;
        const top = index < 0 ? 0 : index * 100 - el.scrollTop;
        return { top, bottom: top + 100 };
      },
    });
    try {
      await controller.selectSession('root');
      await controller.loadEarlier();
      await controller.loadEarlier();
      await flush();
      const scroller = dom.document.querySelector('.thix-conversation');
      Object.defineProperties(scroller, {
        scrollHeight: { value: 600 },
        clientHeight: { value: 150 },
      });
      scroller.scrollTop = 125;
      const target = scroller.querySelectorAll('[data-turn]')[1];
      const turn = target.getAttribute('data-turn');
      t.is(target.getBoundingClientRect().top, -25);
      await controller.openSubagent('root', 'scout', 'child');
      await controller.openAncestor('root');
      await flush();
      const restored = dom.document.querySelector('.thix-conversation');
      t.deepEqual(controller.getState().view?.readingPosition, {
        turnId: turn,
        offset: -25,
      });
      const targetAgain = [...restored.querySelectorAll('[data-turn]')].find(
        row => row.getAttribute('data-turn') === turn,
      );
      t.truthy(targetAgain);
      t.is(targetAgain?.getBoundingClientRect().top, -25);
      t.is(controller.getState().view?.messages.length, 6);
    } finally {
      if (original)
        Object.defineProperty(proto, 'getBoundingClientRect', original);
      else delete proto.getBoundingClientRect;
      await close();
    }
  },
);
