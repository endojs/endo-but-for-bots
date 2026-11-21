// @ts-check
// The session sidebar (R6-36, R6-37; m3-interfaces.md 9.3; W3.5) in
// happy-dom over the real controller and the fake powers: rows with their
// circles and two lines, the empty text, live insert/rename/remove, inline
// rename keys, delete with confirm, and the row helpers.
import test from '@endo/ses-ava/prepare-endo.js';

import { options as preactOptions } from 'preact';

import { makeController } from '../../ui/src/controller/index.js';
import { mount } from '../../ui/src/shell/index.js';
import * as sessionViews from '../../ui/src/sessions/index.js';
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

/** @param {any} fake */
const setup = async fake => {
  const dom = makeTestDom({ width: 1024 });
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
    views: { sessions: sessionViews },
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
  dom.document.querySelector('.floot-new-btn').click();
  t.true(controller.getState().newSessionOpen);
  await close();
});

test.serial(
  'rename: ✎ and double-click; Enter saves, Esc cancels, blur saves',
  async t => {
    const fake = makeFakePowers({ sessions: [{ title: 'old' }] });
    const { dom, control, controller, row, close } = await setup(fake);
    const renames = () => control.callsOf('Session', 'rename').map(c => c[2]);
    const input = () => row('s1').querySelector('.floot-session-title-input');

    row('s1').querySelector('[aria-label="Rename"]').click();
    await flush();
    t.truthy(input());
    t.is(input().value, 'old');
    t.is(controller.getState().activeKey, undefined, '✎ does not select');
    input().value = 'new';
    fire(dom.window, input(), 'input');
    fire(dom.window, input(), 'keydown', { key: 'Enter' });
    await flush();
    t.deepEqual(renames(), ['new']);
    t.is(input(), null);
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
  'delete asks Delete "<title>"? and deletes only when confirmed',
  async t => {
    const fake = makeFakePowers({ sessions: [{ title: 'doomed' }] });
    const { control, row, rows, close } = await setup(fake);
    const target = control.session('s1');
    const globals = /** @type {any} */ (globalThis);
    /** @type {string[]} */
    const asked = [];
    let answer = false;
    globals.confirm = (/** @type {string} */ text) => {
      asked.push(text);
      return answer;
    };
    try {
      row('s1').querySelector('[aria-label="Delete"]').click();
      await flush();
      t.deepEqual(asked, [uiTextOf.confirmDelete('doomed')]);
      t.is(control.callsOf('SessionFactory', 'deleteSession').length, 0);
      t.is(rows().length, 1);
      answer = true;
      row('s1').querySelector('[aria-label="Delete"]').click();
      await flush();
      const deletes = control.callsOf('SessionFactory', 'deleteSession');
      t.is(deletes.length, 1);
      t.is(deletes[0][2], target, 'the Session object itself');
      t.is(rows().length, 0);
    } finally {
      delete globals.confirm;
    }
    await close();
  },
);
