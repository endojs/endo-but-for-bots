// @ts-check
/* eslint-disable import/no-relative-packages */
// The app shell (m3-interfaces.md 6.2, 9; W3.4) in happy-dom: overlay
// texts, slot rendering with a throwing feature isolated, the Settings view
// (app.panel and session.settings sections), the drawer at 640 px and not at 641 px, the status bar,
// header rename, and region views.
import test from '@endo/ses-ava/prepare-endo.js';

import { h } from 'preact';
import { useState } from 'preact/hooks';

import { makeController } from '../../ui/src/controller/index.js';
import { mount, overlayText, usageLabel } from '../../ui/src/shell/index.js';
import {
  uiTexts,
  uiTextOf,
} from '../../resources/agent-host/impl/gateway/protocol.js';
import { NewSession } from '../../ui/src/sessions/index.js';
import {
  settingsSettleMs,
  settingsTexts,
} from '../../ui/src/shell/Settings.js';
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
  'app.panel is a Settings section; hooks in a feature re-render',
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
    t.is(dom.document.querySelector('[data-panel]'), null, 'no header chip');
    dom.document.querySelector('button[aria-label="Settings"]').click();
    const button = dom.document.querySelector('button[data-section="secrets"]');
    t.is(button.textContent, 'Secrets');
    button.click();
    t.deepEqual(controller.getState().settings, { section: 'secrets' });
    t.is(dom.document.querySelector('.has-powers').textContent, 'yes');
    dom.document.querySelector('.bump').click();
    await flush();
    t.is(dom.document.querySelector('.bump').textContent, 'n=1');
    dom.document.querySelector('button[aria-label="Settings"]').click();
    t.is(dom.document.querySelector('.panel-body'), null);
    t.is(controller.getState().settings, undefined);
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
  t.is(dom.document.querySelector('.thix-sidebar-toggle'), null);
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
  'header: the title is a button that renames; Enter saves, Esc cancels, focus returns',
  async t => {
    const fake = makeFakePowers({ sessions: [{ title: 'old title' }] });
    const { dom, controller, powers, control } = await setup({ fake });
    await controller.attach(powers);
    await controller.selectSession('s1');
    await flush();
    const title = () => dom.document.querySelector('.floot-header-title');
    t.is(title().textContent, 'old title');
    t.is(title().tagName, 'BUTTON', 'reachable by Tab');
    t.is(
      title().getAttribute('aria-label'),
      uiTextOf.renameSession('old title'),
    );
    // Enter or Space on a focused button is a click.
    title().click();
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
    t.is(dom.document.activeElement, title(), 'focus back on the title');
    title().click();
    await flush();
    input = dom.document.querySelector('.floot-header-title-input');
    fire(dom.window, input, 'keydown', { key: 'Escape' });
    await flush();
    t.is(control.callsOf('Session', 'rename').length, 1);
    t.truthy(title());
    t.is(dom.document.activeElement, title(), 'focus back after Esc');
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

test.serial(
  'Settings: one labelled control, with or without a session; Escape closes it',
  async t => {
    const views = {
      conversation: {
        Conversation: () => h('div', { class: 'view-conversation' }),
        Composer: () => h('div', { class: 'view-composer' }),
      },
    };
    const features = [
      { id: 'zeta', slot: 'app.panel', label: 'Zeta', component: () => 'Z' },
      { id: 'alpha', slot: 'app.panel', label: 'Alpha', component: () => 'A' },
      {
        id: 'hidden',
        slot: 'app.panel',
        label: 'Hidden',
        when: () => false,
        component: () => 'H',
      },
      // Answers nothing (an environment's section without a shell).
      { id: 'empty', slot: 'session.settings', component: () => null },
    ];
    const { dom, controller, powers } = await setup({ features, views });
    const $ = (/** @type {string} */ selector) =>
      dom.document.querySelector(selector);
    const sectionIds = () =>
      [...dom.document.querySelectorAll('.thix-settings-nav button')].map(
        button => button.getAttribute('data-section'),
      );
    await controller.attach(powers);
    await flush();
    const toggle = () => $('button[aria-label="Settings"]');
    t.truthy(toggle(), 'available with no session open');
    t.is(toggle().getAttribute('title'), 'Open settings');
    t.is(toggle().getAttribute('aria-expanded'), 'false');
    t.regex(toggle().textContent, /Settings/);
    toggle().click();
    await flush();
    t.is(toggle().getAttribute('aria-expanded'), 'true');
    t.deepEqual(sectionIds(), ['zeta', 'alpha'], 'slot order, when() kept');
    t.is($('.thix-settings-section[data-panel="zeta"]')?.textContent, 'Z');
    t.is(
      $('.thix-settings-nav [aria-selected="true"]')?.getAttribute(
        'data-section',
      ),
      'zeta',
    );
    $('button[data-section="alpha"]').click();
    await flush();
    t.is($('.thix-settings-section[data-panel="alpha"]')?.textContent, 'A');
    fire(dom.window, dom.document.body, 'keydown', { key: 'Escape' });
    await flush();
    t.is(controller.getState().settings, undefined);
    t.is($('.thix-settings'), null);

    await controller.selectSession('s1');
    await flush();
    t.truthy($('.view-composer'));
    t.truthy($('.floot-status-bar'));
    toggle().click();
    await flush();
    t.deepEqual(
      controller.getState().settings,
      { section: 'alpha' },
      'the last section is remembered',
    );
    t.is($('.thix-settings-section[data-panel="alpha"]')?.textContent, 'A');
    t.deepEqual(sectionIds(), ['zeta', 'alpha'], 'no empty This session');
    t.is($('.view-composer'), null, 'no composer under Settings');
    t.is($('.view-conversation'), null);
    t.is($('.floot-status-bar'), null, 'no status bar under Settings');
    toggle().click();
    await flush();
    t.truthy($('.view-conversation'), 'back to the session');
    t.truthy($('.view-composer'));
    await dom.close();
  },
);

test.serial(
  'Settings: This session is listed once a session.settings section shows something',
  async t => {
    /** @type {(value: boolean) => void} */
    let reveal = () => {};
    const Late = () => {
      const [shown, setShown] = useState(false);
      reveal = setShown;
      return shown ? h('section', { class: 'late-section' }, 'late') : null;
    };
    const features = [
      { id: 'alpha', slot: 'app.panel', label: 'Alpha', component: () => 'A' },
      { id: 'late', slot: 'session.settings', component: Late },
    ];
    const { dom, controller, powers } = await setup({ features });
    const $ = (/** @type {string} */ selector) =>
      dom.document.querySelector(selector);
    await controller.attach(powers);
    await controller.selectSession('s1');
    await flush();
    controller.openSettings();
    await flush();
    t.is($('button[data-section="session"]'), null, 'nothing to show yet');
    t.is(
      $('.thix-settings')?.getAttribute('data-selected'),
      null,
      'no global section mounted while the session sections settle',
    );
    t.is($('.thix-settings-empty')?.textContent, settingsTexts.loading);
    reveal(true);
    await flush();
    t.is($('button[data-section="session"]')?.textContent, 'This session');
    t.is(
      $('.thix-settings')?.getAttribute('data-selected'),
      'session',
      'the session section is the default',
    );
    t.false($('.thix-settings-section[data-section="session"]').hidden);
    t.is($('.late-section')?.textContent, 'late');
    $('button[data-section="alpha"]').click();
    await flush();
    t.true($('.thix-settings-section[data-section="session"]').hidden);
    $('button[data-section="session"]').click();
    await flush();
    t.deepEqual(controller.getState().settings, { section: 'session' });
    reveal(false);
    await flush();
    t.is($('button[data-section="session"]'), null);
    t.is(
      $('.thix-settings')?.getAttribute('data-selected'),
      'alpha',
      'an emptied section falls back to the first listed',
    );
    await controller.selectSession('s1');
    t.is(controller.getState().settings, undefined, 'navigation closes it');
    await dom.close();
  },
);

test.serial(
  'Settings: Escape in a field, or handled by the New session dialog, leaves it open',
  async t => {
    const Field = () => h('input', { class: 'field' });
    const features = [
      { id: 'alpha', slot: 'app.panel', label: 'Alpha', component: Field },
    ];
    const views = { sessions: { NewSession } };
    const { dom, controller, powers } = await setup({ features, views });
    const $ = (/** @type {string} */ selector) =>
      dom.document.querySelector(selector);
    await controller.attach(powers);
    await flush();
    controller.openSettings();
    await flush();
    fire(dom.window, $('.field'), 'keydown', { key: 'Escape' });
    await flush();
    t.truthy($('.thix-settings'), 'Escape in an input stays with the input');

    controller.openNewSession();
    await flush();
    const dialog = $('[role="dialog"]');
    t.truthy(dialog);
    fire(dom.window, dialog, 'keydown', { key: 'Escape' });
    await flush();
    t.false(controller.getState().newSessionOpen, 'the dialog closed');
    t.truthy($('.thix-settings'), 'Settings stayed open under it');
    // Also while the dialog is open but the key lands outside it.
    controller.openNewSession();
    await flush();
    fire(dom.window, dom.document.body, 'keydown', { key: 'Escape' });
    await flush();
    t.truthy($('.thix-settings'));
    controller.closeNewSession();
    await flush();
    fire(dom.window, dom.document.body, 'keydown', { key: 'Escape' });
    await flush();
    t.is($('.thix-settings'), null, 'one Escape per layer');
    await dom.close();
  },
);

test.serial(
  'Settings: a tablist; focus moves in on open and back on close; arrows move',
  async t => {
    const features = [
      { id: 'alpha', slot: 'app.panel', label: 'Alpha', component: () => 'A' },
      { id: 'beta', slot: 'app.panel', label: 'Beta', component: () => 'B' },
    ];
    const { dom, controller, powers } = await setup({ features });
    const $ = (/** @type {string} */ selector) =>
      dom.document.querySelector(selector);
    await controller.attach(powers);
    await flush();
    const toggle = () => $('button[aria-label="Settings"]');
    t.is(toggle().getAttribute('aria-controls'), null, 'no dangling id');
    toggle().focus();
    toggle().click();
    await flush();
    t.is(toggle().getAttribute('aria-controls'), 'thix-settings');
    t.truthy(dom.document.getElementById('thix-settings'));
    const tab = (/** @type {string} */ id) =>
      $(`[role="tab"][data-section="${id}"]`);
    t.is($('[role="tablist"]')?.getAttribute('aria-orientation'), 'vertical');
    t.is(dom.document.activeElement, tab('alpha'), 'focus on the selected tab');
    t.is(tab('alpha').getAttribute('aria-selected'), 'true');
    t.is(tab('beta').getAttribute('aria-selected'), 'false');
    t.is(tab('alpha').tabIndex, 0);
    t.is(tab('beta').tabIndex, -1);
    const panel = $('[role="tabpanel"]');
    t.is(panel.id, tab('alpha').getAttribute('aria-controls'));
    t.is(panel.getAttribute('aria-labelledby'), tab('alpha').id);
    t.is($('[aria-current]'), null);
    fire(dom.window, tab('alpha'), 'keydown', { key: 'ArrowDown' });
    t.is(dom.document.activeElement, tab('beta'));
    fire(dom.window, tab('beta'), 'keydown', { key: 'ArrowDown' });
    t.is(dom.document.activeElement, tab('alpha'), 'wraps');
    fire(dom.window, tab('alpha'), 'keydown', { key: 'End' });
    t.is(dom.document.activeElement, tab('beta'));
    t.is(
      controller.getState().settings?.section,
      undefined,
      'moving focus does not select',
    );
    dom.document.activeElement.click();
    await flush();
    t.is(tab('beta').getAttribute('aria-selected'), 'true');
    fire(dom.window, dom.document.activeElement, 'keydown', { key: 'Escape' });
    await flush();
    t.is($('.thix-settings'), null);
    t.is(dom.document.activeElement, toggle(), 'focus back on the control');
    await dom.close();
  },
);

test.serial(
  'Settings: with no section chosen, no global panel mounts just to be replaced',
  async t => {
    let mounts = 0;
    const Subscriptions = () => {
      useState(() => {
        mounts += 1;
      });
      return h('div', { class: 'subs' }, 'S');
    };
    /** @type {(value: boolean) => void} */
    let reveal = () => {};
    const Late = () => {
      const [shown, setShown] = useState(false);
      reveal = setShown;
      return shown ? h('p', { class: 'late' }, 'late') : null;
    };
    const features = [
      {
        id: 'accounts',
        slot: 'app.panel',
        label: 'Subscriptions',
        component: Subscriptions,
      },
      { id: 'late', slot: 'session.settings', component: Late },
    ];
    const { dom, controller, powers } = await setup({ features });
    const $ = (/** @type {string} */ selector) =>
      dom.document.querySelector(selector);
    await controller.attach(powers);
    await controller.selectSession('s1');
    await flush();
    controller.openSettings();
    await flush();
    t.is(mounts, 0, 'waiting for This session');
    reveal(true);
    await flush();
    t.is($('.thix-settings')?.getAttribute('data-selected'), 'session');
    t.is(mounts, 0, 'Subscriptions never flashed');
    controller.closeSettings();
    await flush();

    // The session section never shows: after the bound, the first global
    // section, kept when This session turns up later.
    await controller.selectSession('s1');
    await flush();
    controller.openSettings();
    await flush();
    t.is(mounts, 0);
    await new Promise(resolve => setTimeout(resolve, settingsSettleMs + 100));
    await flush();
    t.is($('.thix-settings')?.getAttribute('data-selected'), 'accounts');
    t.is(mounts, 1);
    reveal(true);
    await flush();
    t.truthy($('button[data-section="session"]'), 'listed once it shows');
    t.is(
      $('.thix-settings')?.getAttribute('data-selected'),
      'accounts',
      'no jump',
    );
    t.is(mounts, 1);
    await dom.close();
  },
);

test.serial('Settings: a page-wide error shows above the section', async t => {
  const features = [
    { id: 'alpha', slot: 'app.panel', label: 'Alpha', component: () => 'A' },
  ];
  const { dom, controller, powers } = await setup({ features });
  await controller.attach(powers);
  await flush();
  controller.openSettings();
  await flush();
  await t.throwsAsync(
    controller.featureContext().call(() => Promise.reject(Error('boom'))),
  );
  await flush();
  t.regex(
    String(dom.document.querySelector('.thix-settings-status')?.textContent),
    /boom/,
  );
  await dom.close();
});
