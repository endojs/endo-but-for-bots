// @ts-nocheck - Component test with happy-dom

import '@endo/init/debug.js';

import test from 'ava';
import { options } from 'preact';
import { createInlineDefine } from '@endo/spaces-util/inline-define.js';
import { createDOM, tick, waitFor } from '../helpers/dom-setup.js';

const { document: testDocument } = createDOM();

// Mount inline-define into a bare container, matching how inline-command-form.js
// uses it: createInlineDefine({ $container, onSubmit, onExpand, onCancel,
// onValidityChange }) then focus()/isValid()/setDisabled()/dispose().
const setupDefine = async (t, overrides = {}) => {
  const $container = testDocument.createElement('div');
  $container.className = 'inline-eval-container';
  testDocument.body.appendChild($container);

  const events = { submit: [], expand: [], cancel: 0, validity: [] };

  const api = createInlineDefine({
    $container,
    onSubmit: data => events.submit.push(data),
    onExpand: data => events.expand.push(data),
    onCancel: () => {
      events.cancel += 1;
    },
    onValidityChange: valid => events.validity.push(valid),
    ...overrides,
  });

  t.teardown(() => {
    api.dispose();
    $container.remove();
  });
  await waitFor(() => !!$container.querySelector('.inline-eval-input'));
  return { $container, api, events };
};

const fireInput = ($el, value) => {
  $el.value = value;
  $el.dispatchEvent(new testDocument.defaultView.Event('input'));
};

const fireKeyDown = ($el, key, init = {}) => {
  $el.dispatchEvent(
    new testDocument.defaultView.KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
};

test.serial('renders the source input and no slots initially', async t => {
  const { $container, api } = await setupDefine(t);

  const $source = $container.querySelector('.inline-eval-input');
  t.truthy($source, 'source input rendered');
  t.is(
    $container.querySelectorAll('.inline-eval-endowment-group').length,
    0,
    'no slot rows initially',
  );
  t.false(api.isValid(), 'empty source is invalid');
});

test.serial('typing into the source updates getData and validity', async t => {
  const { $container, api, events } = await setupDefine(t);

  const $source = $container.querySelector('.inline-eval-input');
  fireInput($source, '1 + 1');
  await waitFor(() => api.isValid());

  t.deepEqual(
    api.getData(),
    { source: '1 + 1', slots: [] },
    'getData reflects source',
  );
  t.true(api.isValid(), 'non-empty source is valid');
  t.true(events.validity.includes(true), 'onValidityChange fired with true');
});

test.serial('typing @ at the start spawns a slot row', async t => {
  const { $container } = await setupDefine(t);

  const $source = $container.querySelector('.inline-eval-input');
  fireInput($source, '@');
  await waitFor(
    () =>
      $container.querySelectorAll('.inline-eval-endowment-group').length === 1,
  );

  t.is(
    $container.querySelectorAll('.inline-eval-endowment-group').length,
    1,
    'one slot row created',
  );
  // The @ is stripped from the source.
  const $source2 = $container.querySelector('.inline-eval-input');
  t.is($source2.value, '', 'leading @ stripped from source');
});

test.serial('slot codeName and label feed getData', async t => {
  const { $container, api } = await setupDefine(t);

  const $source = $container.querySelector('.inline-eval-input');
  fireInput($source, '@');
  await waitFor(() => !!$container.querySelector('.inline-eval-petname'));

  const $codeName = $container.querySelector('.inline-eval-petname');
  fireInput($codeName, 'foo');
  await waitFor(() => !!$container.querySelector('.inline-eval-codename'));
  const $label = $container.querySelector('.inline-eval-codename');
  fireInput($label, 'a foo thing');
  await waitFor(() => $label.value === 'a foo thing');

  // Source still needs a value to be valid.
  const $source2 = $container.querySelector('.inline-eval-input');
  fireInput($source2, 'foo()');
  await waitFor(() => api.isValid());

  t.deepEqual(
    api.getData(),
    { source: 'foo()', slots: [{ codeName: 'foo', label: 'a foo thing' }] },
    'getData includes the slot',
  );
  t.true(api.isValid());
});

test.serial('Enter on the source submits parsed data', async t => {
  const { $container, api, events } = await setupDefine(t);

  const $source = $container.querySelector('.inline-eval-input');
  fireInput($source, 'doThing()');
  await waitFor(() => api.isValid());
  fireKeyDown($source, 'Enter');
  await waitFor(() => events.submit.length === 1);

  t.is(events.submit.length, 1, 'onSubmit fired once');
  t.deepEqual(events.submit[0], { source: 'doThing()', slots: [] });
});

test.serial('Enter on empty source does not submit', async t => {
  const { $container, events } = await setupDefine(t);

  const $source = $container.querySelector('.inline-eval-input');
  fireKeyDown($source, 'Enter');
  // Settle delay before a negative assertion (no submit should occur); there is
  // no positive condition to poll for.
  await tick(20);

  t.is(events.submit.length, 0, 'no submit on empty source');
});

test.serial('Cmd-Enter expands with a cursor position', async t => {
  const { $container, api, events } = await setupDefine(t);

  const $source = $container.querySelector('.inline-eval-input');
  fireInput($source, 'expr');
  await waitFor(() => api.isValid());
  fireKeyDown($source, 'Enter', { metaKey: true });
  await waitFor(() => events.expand.length === 1);

  t.is(events.expand.length, 1, 'onExpand fired once');
  t.is(events.expand[0].source, 'expr');
  t.is(
    typeof events.expand[0].cursorPosition,
    'number',
    'cursorPosition present',
  );
});

test.serial('Escape on the source cancels', async t => {
  const { $container, events } = await setupDefine(t);

  const $source = $container.querySelector('.inline-eval-input');
  fireKeyDown($source, 'Escape');
  await waitFor(() => events.cancel === 1);

  t.is(events.cancel, 1, 'onCancel fired');
});

test.serial('setData populates source and slots', async t => {
  const { $container, api } = await setupDefine(t);

  api.setData({
    source: 'compose(a, b)',
    slots: [
      { codeName: 'a', label: 'first' },
      { codeName: 'b', label: 'second' },
    ],
  });
  await waitFor(
    () =>
      $container.querySelectorAll('.inline-eval-endowment-group').length === 2,
  );

  t.is(
    $container.querySelectorAll('.inline-eval-endowment-group').length,
    2,
    'two slot rows from setData',
  );
  const $source = $container.querySelector('.inline-eval-input');
  t.is($source.value, 'compose(a, b)', 'source set');
  t.deepEqual(api.getData(), {
    source: 'compose(a, b)',
    slots: [
      { codeName: 'a', label: 'first' },
      { codeName: 'b', label: 'second' },
    ],
  });
});

test.serial('clear empties source and slots', async t => {
  const { $container, api } = await setupDefine(t);

  api.setData({ source: 'x', slots: [{ codeName: 'a', label: 'first' }] });
  await waitFor(
    () =>
      $container.querySelectorAll('.inline-eval-endowment-group').length === 1,
  );
  t.is($container.querySelectorAll('.inline-eval-endowment-group').length, 1);

  api.clear();
  await waitFor(
    () =>
      $container.querySelectorAll('.inline-eval-endowment-group').length === 0,
  );

  t.is(
    $container.querySelectorAll('.inline-eval-endowment-group').length,
    0,
    'slots cleared',
  );
  const $source = $container.querySelector('.inline-eval-input');
  t.is($source.value, '', 'source cleared');
  t.deepEqual(api.getData(), { source: '', slots: [] });
  t.false(api.isValid());
});

test.serial('setDisabled disables the source and slot inputs', async t => {
  const { $container, api } = await setupDefine(t);

  api.setData({ source: 'x', slots: [{ codeName: 'a', label: 'l' }] });
  await waitFor(() => !!$container.querySelector('.inline-eval-petname'));

  api.setDisabled(true);
  await waitFor(
    () => $container.querySelector('.inline-eval-input')?.disabled === true,
  );

  const $source = $container.querySelector('.inline-eval-input');
  t.true($source.disabled, 'source disabled');
  const $codeName = $container.querySelector('.inline-eval-petname');
  t.true($codeName.disabled, 'slot code name disabled');
  const $label = $container.querySelector('.inline-eval-codename');
  t.true($label.disabled, 'slot label disabled');

  api.setDisabled(false);
  await waitFor(
    () => $container.querySelector('.inline-eval-input')?.disabled === false,
  );
  const $source2 = $container.querySelector('.inline-eval-input');
  t.false($source2.disabled, 're-enabled');
});

test.serial('label defaults to codeName when blank', async t => {
  const { $container, api } = await setupDefine(t);

  const $source = $container.querySelector('.inline-eval-input');
  fireInput($source, '@');
  await waitFor(() => !!$container.querySelector('.inline-eval-petname'));
  const $codeName = $container.querySelector('.inline-eval-petname');
  fireInput($codeName, 'bar');
  await waitFor(() => $codeName.value === 'bar');
  const $source2 = $container.querySelector('.inline-eval-input');
  fireInput($source2, 'bar');
  await waitFor(() => api.getData().slots.length === 1);

  t.deepEqual(api.getData().slots, [{ codeName: 'bar', label: 'bar' }]);
});

test.serial('dispose unmounts the view', async t => {
  const { $container, api } = await setupDefine(t);

  const $source = $container.querySelector('.inline-eval-input');
  fireInput($source, 'x');
  await waitFor(() => api.isValid());

  api.dispose();
  await waitFor(() => !$container.querySelector('.inline-eval-input'));

  t.falsy(
    $container.querySelector('.inline-eval-input'),
    'view removed after dispose',
  );
});

// Keep passive effects pending until after interaction, without relying on the
// relative speed of the runner and Preact's animation-frame scheduler.
for (const interaction of ['input', 'setData']) {
  test.serial(
    `mount replays ${interaction} before passive effects`,
    async t => {
      const previousRaf = options.requestAnimationFrame;
      const pending = [];
      options.requestAnimationFrame = callback => pending.push(callback);
      t.teardown(() => {
        options.requestAnimationFrame = previousRaf;
        for (const callback of pending.splice(0)) callback();
      });
      const { $container, api } = await setupDefine(t);
      t.true(pending.length > 0, 'mount effect has not flushed');

      if (interaction === 'input') {
        fireInput($container.querySelector('.inline-eval-input'), '@');
      } else {
        api.setData({
          source: 'thing',
          slots: [{ codeName: 'thing', label: 'Thing' }],
        });
        api.setDisabled(true);
      }
      for (const callback of pending.splice(0)) callback();
      await waitFor(
        () => !!$container.querySelector('.inline-eval-endowment-group'),
      );
      const source = $container.querySelector('.inline-eval-input');
      t.is(source.value, interaction === 'input' ? '' : 'thing');
      t.is(source.disabled, interaction === 'setData');
    },
  );
}
