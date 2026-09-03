// @ts-nocheck - Component test with happy-dom

import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/pass-style';

import { createDOM, tick } from '../helpers/dom-setup.js';
import { secretsComponent } from '../../secrets-component.js';

const { document: testDocument } = createDOM();

const waitFor = async (predicate, timeoutMs = 5000) => {
  await null;
  const deadline = Date.now() + timeoutMs;
  let value = predicate();
  while (!value && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await tick(20);
    value = predicate();
  }
  return value;
};

test.serial(
  'secret Space never receives or renders read authority',
  async t => {
    const document = testDocument;
    const canary = 'CANARY-ui-must-not-render';
    const calls = [];
    const summary = harden({
      secretId: 'secret-1234567890',
      purpose: 'Release publishing',
      state: 'active',
      generation: 1n,
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
    });
    const admin = Far('MockSecretAdmin', {
      getSummary: () => summary,
      replaceBase64: value => calls.push(['replace', value]),
      setPurpose: purpose => calls.push(['purpose', purpose]),
      revoke: () => calls.push(['revoke']),
    });
    const catalog = Far('MockSecretCatalog', {
      list: () => [{ secretId: summary.secretId, summary, admin }],
    });
    const audit = Far('MockSecretAudit', {
      list: () => [],
    });
    const importer = Far('MockSecretImporter', {
      createBase64: (name, purpose, value) => {
        calls.push(['create', name, purpose, value]);
        return summary;
      },
    });
    const powers = Far('MockSecretPowers', {
      lookup: path => {
        const key = Array.isArray(path) ? path.join('/') : path;
        if (key === '@secrets/catalog') return catalog;
        if (key === '@secrets/audit') return audit;
        if (key === '@secrets/create') return importer;
        throw new Error('unknown path');
      },
    });

    const $parent = document.createElement('div');
    document.body.appendChild($parent);
    const clipboardWrites = [];
    const cleanup = secretsComponent($parent, powers, [], async text => {
      clipboardWrites.push(text);
    });
    t.teardown(cleanup);
    await waitFor(() => $parent.querySelector('.secret-card'));

    t.true($parent.textContent.includes('Release publishing'));
    t.false($parent.textContent.includes(canary));
    t.false($parent.textContent.includes('readBase64'));
    t.false('__getMethodNames__' in summary);

    const $clearClipboard = [...$parent.querySelectorAll('button')].find(
      button => button.textContent === 'Clear clipboard',
    );
    $clearClipboard.click();
    await waitFor(() => clipboardWrites.length === 1);
    t.deepEqual(clipboardWrites, ['']);
    t.true($parent.textContent.includes('Clipboard overwritten'));

    const $create = $parent.querySelector('.secret-create-form');
    const $name = $create.elements.namedItem('name');
    const $purpose = $create.elements.namedItem('purpose');
    const $value = $create.elements.namedItem('value');
    const $replacement = $parent.querySelector(
      '.secret-card input[name="value"]',
    );
    t.is($value.type, 'password');
    t.is($replacement.type, 'password');
    t.is($value.autocomplete, 'off');
    t.is($replacement.autocomplete, 'off');
    t.is($value.getAttribute('data-1p-ignore'), 'true');
    t.is($replacement.getAttribute('data-lpignore'), 'true');
    $name.value = 'release';
    $name.dispatchEvent(new Event('input', { bubbles: true }));
    $purpose.value = 'Release publishing';
    $purpose.dispatchEvent(new Event('input', { bubbles: true }));
    $value.value = canary;
    $value.dispatchEvent(new Event('input', { bubbles: true }));
    $create.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await waitFor(() => calls.some(([operation]) => operation === 'create'));

    const createCall = calls.find(([operation]) => operation === 'create');
    t.deepEqual(createCall, [
      'create',
      'release',
      'Release publishing',
      'Q0FOQVJZLXVpLW11c3Qtbm90LXJlbmRlcg==',
    ]);
    t.is($value.value, '');
    t.false($parent.textContent.includes(canary));

    const $revoke = $parent.querySelector('.secret-revoke');
    t.is($revoke.textContent, 'Confirm revocation');
    $revoke.click();
    await waitFor(() => calls.some(([operation]) => operation === 'revoke'));
    t.true(calls.some(([operation]) => operation === 'revoke'));
  },
);
