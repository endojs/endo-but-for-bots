// @ts-nocheck - Component test with happy-dom

import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/pass-style';
import { createDOM, tick, waitFor } from '../helpers/dom-setup.js';

const { document: testDocument } = createDOM();

/**
 * A minimal Far powers mock recording the create-verb calls the flows drive.
 */
const makePowers = ({ names = [], forms = [] } = {}) => {
  const calls = [];
  const powers = Far('MockPowers', {
    provideMount: async (hostPath, petName) => {
      calls.push({ method: 'provideMount', args: [hostPath, petName] });
    },
    provideScratchMount: async petName => {
      calls.push({ method: 'provideScratchMount', args: [petName] });
    },
    list: async () => names,
    listMessages: async () => forms,
    reverseLocate: async locator => {
      const form = forms.find(f => f.from === locator);
      return form && form.senderNames ? form.senderNames : [];
    },
    submit: async (number, values) => {
      calls.push({ method: 'submit', args: [number, values] });
    },
  });
  return { powers, calls };
};

const setup = ({ names = [], forms = [] } = {}) => {
  const $button = testDocument.createElement('button');
  const $menu = testDocument.createElement('div');
  const $modal = testDocument.createElement('div');
  testDocument.body.append($button, $menu, $modal);
  const { powers, calls } = makePowers({ names, forms });
  return { $button, $menu, $modal, powers, calls };
};

// Controlled confined inputs commit their value into component state via an
// onInput-triggered re-render; that re-render is async, so callers `await tick`
// after driving inputs and before the click that reads the committed state
// (mirrors form-request-inbox.test.js).
const fireClick = $el => {
  $el.click();
};

const fireInput = ($input, value) => {
  $input.value = value;
  $input.dispatchEvent(
    new testDocument.defaultView.Event('input', { bubbles: true }),
  );
};

test.afterEach(() => {
  testDocument.body.innerHTML = '';
});

test('the + button opens a pop-over menu listing five item types', async t => {
  const { createInventoryCreateMenu } = await import('../../create-menu.js');
  const { $button, $menu, $modal, powers } = setup();
  createInventoryCreateMenu({
    $button,
    $menuContainer: $menu,
    $modalContainer: $modal,
    getPowers: () => powers,
  });

  fireClick($button);
  await waitFor(() => !!$menu.querySelector('.create-menu'));

  const items = $menu.querySelectorAll('.create-menu-item');
  t.is(items.length, 5, 'menu lists the five whole-cloth item types');
  const labels = [...$menu.querySelectorAll('.create-menu-label')].map(el =>
    el.textContent.replace('soon', '').trim(),
  );
  t.deepEqual(labels, [
    'Filesystem mount',
    'Scratch space',
    'Passable value',
    'Structured value',
    'New agent',
  ]);
  t.is($button.getAttribute('aria-expanded'), 'true');
});

test('filesystem mount flow calls provideMount with path and pet name', async t => {
  const { createInventoryCreateMenu } = await import('../../create-menu.js');
  const { $button, $menu, $modal, powers, calls } = setup();
  createInventoryCreateMenu({
    $button,
    $menuContainer: $menu,
    $modalContainer: $modal,
    getPowers: () => powers,
  });

  fireClick($button);
  await waitFor(() => !!$menu.querySelector('.create-menu-item'));
  // First menu item is "Filesystem mount".
  fireClick($menu.querySelector('.create-menu-item'));
  await waitFor(() => !!$modal.querySelector('.create-modal'));

  const [$petName, $path] = $modal.querySelectorAll('.create-modal-input');
  fireInput($petName, 'my-files');
  fireInput($path, '/home/me/project');
  await tick();
  fireClick($modal.querySelector('.create-modal-submit'));

  await waitFor(() => calls.some(c => c.method === 'provideMount'));
  const call = calls.find(c => c.method === 'provideMount');
  t.deepEqual(call.args, ['/home/me/project', 'my-files']);
  // Modal closes on success.
  await waitFor(() => !$modal.querySelector('.create-modal'));
  t.pass();
});

test('scratch space flow calls provideScratchMount with pet name', async t => {
  const { createInventoryCreateMenu } = await import('../../create-menu.js');
  const { $button, $menu, $modal, powers, calls } = setup();
  createInventoryCreateMenu({
    $button,
    $menuContainer: $menu,
    $modalContainer: $modal,
    getPowers: () => powers,
  });

  fireClick($button);
  await waitFor(() => $menu.querySelectorAll('.create-menu-item').length >= 2);
  // Second menu item is "Scratch space".
  fireClick($menu.querySelectorAll('.create-menu-item')[1]);
  await waitFor(() => !!$modal.querySelector('.create-modal'));

  fireInput($modal.querySelector('.create-modal-input'), 'scratchpad');
  await tick();
  fireClick($modal.querySelector('.create-modal-submit'));

  await waitFor(() => calls.some(c => c.method === 'provideScratchMount'));
  const call = calls.find(c => c.method === 'provideScratchMount');
  t.deepEqual(call.args, ['scratchpad']);
});

test('mount flow rejects a special (@-prefixed) pet name locally', async t => {
  const { createInventoryCreateMenu } = await import('../../create-menu.js');
  const { $button, $menu, $modal, powers, calls } = setup();
  createInventoryCreateMenu({
    $button,
    $menuContainer: $menu,
    $modalContainer: $modal,
    getPowers: () => powers,
  });

  fireClick($button);
  await waitFor(() => !!$menu.querySelector('.create-menu-item'));
  fireClick($menu.querySelector('.create-menu-item'));
  await waitFor(() => !!$modal.querySelector('.create-modal'));

  const [$petName, $path] = $modal.querySelectorAll('.create-modal-input');
  fireInput($petName, '@self');
  fireInput($path, '/tmp/x');
  await tick();
  fireClick($modal.querySelector('.create-modal-submit'));

  await waitFor(() => !!$modal.querySelector('.create-modal-error'));
  t.regex(
    $modal.querySelector('.create-modal-error').textContent,
    /reserved special/,
  );
  t.false(calls.some(c => c.method === 'provideMount'));
});

test('passable value shows a documented placeholder, not a form', async t => {
  const { createInventoryCreateMenu } = await import('../../create-menu.js');
  const { $button, $menu, $modal, powers } = setup();
  createInventoryCreateMenu({
    $button,
    $menuContainer: $menu,
    $modalContainer: $modal,
    getPowers: () => powers,
  });

  fireClick($button);
  await waitFor(() => $menu.querySelectorAll('.create-menu-item').length >= 3);
  // Third item is "Passable value".
  fireClick($menu.querySelectorAll('.create-menu-item')[2]);
  await waitFor(() => !!$modal.querySelector('.create-modal-placeholder'));

  t.is($modal.querySelector('.create-modal-badge').textContent, 'Coming soon');
  t.is($modal.querySelectorAll('.create-modal-input').length, 0);
});

test('new-agent wizard renders three panes and submits to an outstanding form', async t => {
  const { createInventoryCreateMenu } = await import('../../create-menu.js');
  // One outstanding form message from the Lal manager handle.
  const forms = [
    {
      type: 'form',
      number: 7n,
      from: 'endo://lal-locator',
      senderNames: ['setup-lal'],
    },
  ];
  const { $button, $menu, $modal, powers, calls } = setup({
    names: ['lal'],
    forms,
  });
  createInventoryCreateMenu({
    $button,
    $menuContainer: $menu,
    $modalContainer: $modal,
    getPowers: () => powers,
  });

  fireClick($button);
  await waitFor(() => $menu.querySelectorAll('.create-menu-item').length >= 5);
  // Fifth item is "New agent".
  fireClick($menu.querySelectorAll('.create-menu-item')[4]);
  await waitFor(() => !!$modal.querySelector('.wizard-modal'));

  // Pane 1: harness radios (Lal / Fae / Genie).
  t.is($modal.querySelectorAll('.wizard-radio-row').length, 3);
  // Advance to pane 2 (inference source).
  fireClick($modal.querySelector('.create-modal-submit')); // Next
  await waitFor(() =>
    $modal.querySelector('.wizard-pane-title').textContent.includes('2.'),
  );
  // Default provider is Anthropic (apiKey) — paste a key and a model.
  fireInput($modal.querySelector('#wizard-apikey'), 'sk-test');
  fireInput($modal.querySelector('#wizard-model'), 'claude-sonnet-4-6');
  await tick();
  fireClick($modal.querySelector('.create-modal-submit')); // Next
  await waitFor(() =>
    $modal.querySelector('.wizard-pane-title').textContent.includes('3.'),
  );
  // Pane 3: endowment checklist (documentation-only) + agent pet name.
  t.true($modal.querySelectorAll('.wizard-endowment-row').length >= 9);
  fireInput($modal.querySelector('#wizard-petname'), 'assistant');
  await tick();
  fireClick($modal.querySelector('.create-modal-submit')); // Create agent

  await waitFor(() => calls.some(c => c.method === 'submit'));
  const call = calls.find(c => c.method === 'submit');
  t.is(call.args[0], 7n);
  t.deepEqual(call.args[1], {
    name: 'assistant',
    host: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-6',
    authToken: 'sk-test',
  });
});

test('wizard surfaces a clear error when no provisioning form is outstanding', async t => {
  const { createInventoryCreateMenu } = await import('../../create-menu.js');
  const { $button, $menu, $modal, powers } = setup({ names: [], forms: [] });
  createInventoryCreateMenu({
    $button,
    $menuContainer: $menu,
    $modalContainer: $modal,
    getPowers: () => powers,
  });

  fireClick($button);
  await waitFor(() => $menu.querySelectorAll('.create-menu-item').length >= 5);
  fireClick($menu.querySelectorAll('.create-menu-item')[4]);
  await waitFor(() => !!$modal.querySelector('.wizard-modal'));

  fireClick($modal.querySelector('.create-modal-submit')); // to pane 2
  await waitFor(() =>
    $modal.querySelector('.wizard-pane-title').textContent.includes('2.'),
  );
  fireInput($modal.querySelector('#wizard-apikey'), 'sk-test');
  fireInput($modal.querySelector('#wizard-model'), 'claude-sonnet-4-6');
  await tick();
  fireClick($modal.querySelector('.create-modal-submit')); // to pane 3
  await waitFor(() =>
    $modal.querySelector('.wizard-pane-title').textContent.includes('3.'),
  );
  fireInput($modal.querySelector('#wizard-petname'), 'assistant');
  await tick();
  fireClick($modal.querySelector('.create-modal-submit')); // Create agent

  await waitFor(() => !!$modal.querySelector('.create-modal-error'));
  t.regex(
    $modal.querySelector('.create-modal-error').textContent,
    /No outstanding provisioning form/,
  );
});
