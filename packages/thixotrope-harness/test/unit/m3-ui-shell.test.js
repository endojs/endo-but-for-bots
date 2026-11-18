// @ts-check
/* eslint-disable import/no-relative-packages */
// The app shell (m3-interfaces.md 6.2, 9; W3.4) in happy-dom: overlay
// texts, slot rendering with a throwing feature isolated, app.panel from the
// header menu, the drawer at 640 px and not at 641 px, the status bar,
// header rename, and region views.
import test from '@endo/ses-ava/prepare-endo.js';

import { h } from 'preact';
import { useState } from 'preact/hooks';

import { makeController } from '../../ui/src/controller/index.js';
import { mount, overlayText, usageLabel } from '../../ui/src/shell/index.js';
import {
  uiTexts,
  uiTextOf,
} from '../../resources/agent-host/impl/gateway/contract-m3.js';
import { makeFakePowers, makeTestDom } from './_m3-fake-powers.js';

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/**
 * @param {{ width?: number, features?: any[], views?: any, fake?: any }} [options]
 */
const setup = async ({
  width = 1024,
  features = [],
  views = {},
  fake,
} = {}) => {
  const dom = makeTestDom({ width });
  const { powers, control } =
    fake ?? makeFakePowers({ sessions: [{ turns: 1 }] });
  const controller = makeController({
    storage: undefined,
    locks: { request: (_name, callback) => callback() },
    features,
  });
  const shell = mount({
    root: dom.root,
    controller,
    features,
    views,
    window: dom.window,
    schedule: fn => fn(),
  });
  return { dom, controller, shell, powers, control };
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

test.serial('overlay texts for every connection state', async t => {
  t.is(overlayText('open'), undefined);
  t.is(overlayText('reconnecting'), uiTexts.reconnecting);
  t.is(overlayText('connecting'), uiTexts.reconnecting);
  t.is(overlayText('starting'), uiTexts.serverStarting);
  t.is(overlayText('refused', 'Sign-in refused'), 'Sign-in refused');
  t.is(overlayText('unconfigured'), uiTexts.gatewayNotConfigured);
  const { dom, controller, powers } = await setup();
  const overlay = () => dom.document.querySelector('.thix-overlay');
  t.is(overlay()?.textContent, uiTexts.reconnecting, 'before the first attach');
  await controller.attach(powers);
  await flush();
  t.is(overlay(), null);
  controller.setConnection('starting');
  t.is(overlay()?.textContent, uiTexts.serverStarting);
  controller.setConnection('unconfigured', uiTexts.queryConfigRefused);
  t.is(overlay()?.textContent, uiTexts.queryConfigRefused);
  t.is(overlay()?.getAttribute('role'), 'alert');
  await dom.close();
});

test.serial(
  'slots: order, when, and a throwing feature shown as an error line',
  async t => {
    const chip = (/** @type {string} */ id, /** @type {number} */ order) => ({
      id,
      slot: 'statusbar.chip',
      order,
      component: () => h('span', { class: 'chip' }, id),
    });
    const features = [
      chip('accounts.b', 20),
      chip('accounts.a', 10),
      {
        id: 'broken',
        slot: 'statusbar.chip',
        order: 15,
        component: () => {
          throw Error('render failed');
        },
      },
      {
        id: 'hidden',
        slot: 'statusbar.chip',
        when: () => false,
        component: () => h('span', { class: 'chip' }, 'hidden'),
      },
    ];
    const { dom, controller, powers } = await setup({ features });
    await controller.attach(powers);
    await flush();
    const slot = dom.document.querySelector('[data-slot="statusbar.chip"]');
    t.deepEqual(
      [...slot.querySelectorAll('.chip')].map(
        /** @param {any} node */ node => node.textContent,
      ),
      ['accounts.a', 'accounts.b'],
    );
    const error = slot.querySelector('.thix-feature-error');
    t.is(error.textContent, `broken: ${uiTextOf.statusError('render failed')}`);
    t.is(error.getAttribute('data-feature'), 'broken');
    t.truthy(
      dom.document.querySelector('.floot-header'),
      'the page still renders',
    );
    await dom.close();
  },
);

test.serial(
  'app.panel opens from the header menu; hooks in a feature re-render',
  async t => {
    const Panel = ({ context }) => {
      const [count, setCount] = useState(0);
      return h(
        'div',
        { class: 'panel-body' },
        h('span', { class: 'has-powers' }, context.powers ? 'yes' : 'no'),
        h(
          'button',
          { class: 'bump', onClick: () => setCount(count + 1) },
          `n=${count}`,
        ),
      );
    };
    const features = [
      { id: 'secrets', slot: 'app.panel', label: 'Secrets', component: Panel },
    ];
    const { dom, controller, powers } = await setup({ features });
    await controller.attach(powers);
    await flush();
    const button = dom.document.querySelector('[data-panel="secrets"]');
    t.is(button.textContent, 'Secrets');
    button.click();
    t.is(controller.getState().panel, 'secrets');
    t.is(dom.document.querySelector('.has-powers').textContent, 'yes');
    dom.document.querySelector('.bump').click();
    await flush();
    t.is(dom.document.querySelector('.bump').textContent, 'n=1');
    dom.document.querySelector('button[data-panel="secrets"]').click();
    t.is(dom.document.querySelector('.panel-body'), null);
    await dom.close();
  },
);

test.serial(
  'at 640 px the sidebar is a drawer opened with ☰ over a backdrop',
  async t => {
    const { dom, controller, powers } = await setup({ width: 640 });
    await controller.attach(powers);
    await flush();
    const app = () => dom.document.querySelector('.thix-app');
    const menu = () => dom.document.querySelector('.thix-menu-btn');
    t.is(app().getAttribute('data-drawer'), 'closed');
    t.false(
      dom.document.querySelector('.floot-sidebar').classList.contains('open'),
    );
    t.is(dom.document.querySelector('.floot-backdrop'), null);
    menu().click();
    t.is(app().getAttribute('data-drawer'), 'open');
    t.true(
      dom.document.querySelector('.floot-sidebar').classList.contains('open'),
    );
    dom.document.querySelector('.floot-backdrop').click();
    t.is(app().getAttribute('data-drawer'), 'closed');
    await dom.close();
  },
);

test.serial('at 641 px there is no drawer and no ☰', async t => {
  const { dom, controller, powers } = await setup({ width: 641 });
  await controller.attach(powers);
  await flush();
  t.is(
    dom.document.querySelector('.thix-app').getAttribute('data-drawer'),
    'none',
  );
  t.is(dom.document.querySelector('.thix-menu-btn'), null);
  t.true(
    dom.document.querySelector('.floot-sidebar').classList.contains('open'),
  );
  await dom.close();
});

test.serial('status bar shows getUsage as ↑in ↓out · ctx N%', async t => {
  const fake = makeFakePowers({ sessions: [{}] });
  const { dom, controller, powers, control } = await setup({ fake });
  await controller.attach(powers);
  await controller.selectSession('s1');
  await flush();
  await controller.send('count me');
  control.finish('s1', { final: 'done' });
  await flush();
  const usage = controller.getState().view?.usage;
  t.is(
    dom.document.querySelector('.thix-usage').textContent,
    usageLabel(usage),
  );
  t.is(usageLabel(usage), uiTextOf.usage(10, 5, 1));
  t.is(
    usageLabel({
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 3,
      outputTokens: 7,
      reasoningOutputTokens: 4,
      context: { usedTokens: 333, windowTokens: 1000 },
    }),
    '↑123 ↓11 · ctx 33%',
  );
  await dom.close();
});

test.serial(
  'header: double-click the title, Enter renames; Esc cancels',
  async t => {
    const fake = makeFakePowers({ sessions: [{ title: 'old title' }] });
    const { dom, controller, powers, control } = await setup({ fake });
    await controller.attach(powers);
    await controller.selectSession('s1');
    await flush();
    const title = () => dom.document.querySelector('.floot-header-title');
    t.is(title().textContent, 'old title');
    fire(dom.window, title(), 'dblclick');
    await flush();
    let input = dom.document.querySelector('.floot-header-title-input');
    t.truthy(input);
    input.value = 'new title';
    fire(dom.window, input, 'input');
    await flush();
    input = dom.document.querySelector('.floot-header-title-input');
    fire(dom.window, input, 'keydown', { key: 'Enter' });
    await flush();
    t.deepEqual(
      control.callsOf('Session', 'rename').map(call => call[2]),
      ['new title'],
    );
    fire(dom.window, title(), 'dblclick');
    await flush();
    input = dom.document.querySelector('.floot-header-title-input');
    fire(dom.window, input, 'keydown', { key: 'Escape' });
    await flush();
    t.is(control.callsOf('Session', 'rename').length, 1);
    t.truthy(title());
    await dom.close();
  },
);

test.serial(
  'region views receive the shell props; the dialog opens from the empty state',
  async t => {
    /** @type {any[]} */
    const seen = [];
    const views = {
      sessions: {
        Sidebar: (/** @type {any} */ props) => {
          seen.push([
            'Sidebar',
            props.open,
            typeof props.controller.selectSession,
          ]);
          return h('aside', { class: 'floot-sidebar view-sidebar' });
        },
        NewSession: () => h('div', { class: 'view-new-session' }),
      },
      conversation: {
        Conversation: (/** @type {any} */ props) =>
          h('div', { class: 'view-conversation' }, props.state.view.info.title),
        Composer: () => h('div', { class: 'view-composer' }),
      },
    };
    const fake = makeFakePowers({ sessions: [{ title: 'chat one' }] });
    const { dom, controller, powers } = await setup({ fake, views });
    await controller.attach(powers);
    await flush();
    t.truthy(dom.document.querySelector('.view-sidebar'));
    t.deepEqual(seen.at(-1), ['Sidebar', true, 'function']);
    t.is(dom.document.querySelector('.view-conversation'), null);
    dom.document.querySelector('.thix-start-btn').click();
    t.truthy(dom.document.querySelector('.view-new-session'));
    controller.closeNewSession();
    await controller.selectSession('s1');
    await flush();
    t.is(
      dom.document.querySelector('.view-conversation').textContent,
      'chat one',
    );
    t.truthy(dom.document.querySelector('.view-composer'));
    await dom.close();
  },
);
