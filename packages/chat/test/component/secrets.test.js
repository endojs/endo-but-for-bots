// @ts-nocheck - Component test with happy-dom

import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/pass-style';
import { decodeBase64 } from '@endo/base64';

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
      description: 'Release publishing',
      state: 'active',
      generation: 1n,
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
    });
    const admin = Far('MockSecretAdmin', {
      getSummary: () => summary,
      replaceBase64: value => calls.push(['replace', value]),
      setDescription: description => calls.push(['description', description]),
      revoke: () => calls.push(['revoke']),
      delete: () => calls.push(['delete']),
    });
    const catalog = Far('MockSecretCatalog', {
      list: () => [
        {
          secretId: summary.secretId,
          summary,
          petNamePaths: [['release-token'], ['secrets', 'github-release']],
          admin,
        },
      ],
    });
    const audit = Far('MockSecretAudit', {
      list: () => [],
    });
    const importer = Far('MockSecretImporter', {
      createBase64: (name, description, value) => {
        calls.push(['create', name, description, value]);
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
    let cleanedUp = false;
    t.teardown(() => {
      if (!cleanedUp) cleanup();
    });
    await waitFor(() => $parent.querySelector('.secret-card'));

    t.is(
      $parent.querySelector('.secret-card input[name="description"]').value,
      'Release publishing',
    );
    t.false($parent.textContent.includes(canary));
    t.false($parent.textContent.includes('readBase64'));
    t.false('__getMethodNames__' in summary);
    t.false(
      $parent
        .querySelector('.secret-summary')
        .textContent.includes('Release publishing'),
    );
    t.true($parent.textContent.includes('release-token'));
    t.true($parent.textContent.includes('secrets/github-release'));

    const $createPanel = $parent.querySelector('.secret-create-panel');
    const $danger = $parent.querySelector('.secret-danger');
    t.false($createPanel.open);
    t.false($danger.open);

    const $clearClipboard = [...$parent.querySelectorAll('button')].find(
      button => button.textContent === 'Clear clipboard',
    );
    $clearClipboard.click();
    await waitFor(() => clipboardWrites.length === 1);
    t.deepEqual(clipboardWrites, ['']);
    t.true($parent.textContent.includes('Clipboard overwritten'));

    const $create = $parent.querySelector('.secret-create-form');
    t.true($createPanel.contains($create));
    $createPanel.open = true;
    $createPanel.dispatchEvent(new Event('toggle'));
    const $name = $create.elements.namedItem('name');
    const $description = $create.elements.namedItem('description');
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
    t.true($danger.contains($replacement));
    t.is(
      $parent.querySelector('.secret-card input[name="description"]').value,
      'Release publishing',
    );
    $value.value = canary;
    $value.dispatchEvent(new Event('input', { bubbles: true }));
    $createPanel.open = false;
    $createPanel.dispatchEvent(new Event('toggle'));
    t.is($value.value, '');
    $createPanel.open = true;
    $createPanel.dispatchEvent(new Event('toggle'));
    $name.value = 'release';
    $name.dispatchEvent(new Event('input', { bubbles: true }));
    $description.value = 'Release publishing';
    $description.dispatchEvent(new Event('input', { bubbles: true }));
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

    $danger.open = true;
    $danger.dispatchEvent(new Event('toggle'));
    $replacement.value = canary;
    $replacement.dispatchEvent(new Event('input', { bubbles: true }));
    $danger.open = false;
    $danger.dispatchEvent(new Event('toggle'));
    t.is($replacement.value, '');
    $danger.open = true;
    $danger.dispatchEvent(new Event('toggle'));

    const $descriptionUpdate = $parent.querySelector(
      '.secret-card input[name="description"]',
    );
    $descriptionUpdate.value = 'Publishes release artifacts';
    $descriptionUpdate.dispatchEvent(new Event('input', { bubbles: true }));
    $descriptionUpdate.form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await waitFor(() =>
      calls.some(([operation]) => operation === 'description'),
    );
    t.true(
      calls.some(
        call =>
          call[0] === 'description' &&
          call[1] === 'Publishes release artifacts',
      ),
    );

    const $revoke = $parent.querySelector('.secret-revoke');
    t.is($revoke.textContent, 'Confirm revocation');
    $revoke.click();
    await waitFor(() => calls.some(([operation]) => operation === 'revoke'));
    t.true(calls.some(([operation]) => operation === 'revoke'));

    $value.value = canary;
    $value.dispatchEvent(new Event('input', { bubbles: true }));
    cleanup();
    cleanedUp = true;
    t.is($value.value, '');
  },
);

test.serial(
  'secret Space serializes mutations and refreshes failed audit events',
  async t => {
    const document = testDocument;
    const canary = 'CANARY-error-must-not-render';
    const summary = harden({
      secretId: 'secret-race-test',
      description: 'Race test',
      state: 'active',
      generation: 1n,
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
    });
    let resolveReplace;
    const replaceGate = new Promise(resolve => {
      resolveReplace = resolve;
    });
    const replaceCalls = [];
    let auditEvents = [];
    const admin = Far('BlockingSecretAdmin', {
      getSummary: () => summary,
      replaceBase64: value => {
        replaceCalls.push(value);
        return replaceGate;
      },
      setDescription: () => {
        auditEvents = [
          harden({
            eventId: 'failed-event',
            secretId: summary.secretId,
            operation: 'set-description',
            outcome: 'failed',
            generation: 1n,
            occurredAt: '2026-09-03T00:00:01.000Z',
            operationId: 'failed-operation',
            reasonCode: 'SET_DESCRIPTION_FAILED',
          }),
        ];
        throw new Error(canary);
      },
      revoke: () => undefined,
      delete: () => undefined,
    });
    const catalog = Far('RaceSecretCatalog', {
      list: () => [
        { secretId: summary.secretId, summary, petNamePaths: [], admin },
      ],
    });
    const audit = Far('RaceSecretAudit', {
      list: () => auditEvents,
    });
    const powers = Far('RaceSecretPowers', {
      lookup: path => {
        const key = Array.isArray(path) ? path.join('/') : path;
        if (key === '@secrets/catalog') return catalog;
        if (key === '@secrets/audit') return audit;
        throw new Error('unknown path');
      },
    });

    const $parent = document.createElement('div');
    document.body.appendChild($parent);
    const cleanup = secretsComponent($parent, powers, []);
    t.teardown(cleanup);
    await waitFor(() => $parent.querySelector('.secret-card'));

    const $danger = $parent.querySelector('.secret-danger');
    $danger.open = true;
    $danger.dispatchEvent(new Event('toggle'));
    const $replacement = $danger.querySelector('input[name="value"]');
    $replacement.value = 'replacement';
    $replacement.dispatchEvent(new Event('input', { bubbles: true }));
    const $replaceForm = $danger.querySelector('.secret-replace-form');
    $replaceForm.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    $replaceForm.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await waitFor(() => replaceCalls.length === 1);
    t.is(replaceCalls.length, 1);
    t.true($parent.querySelector('.secret-revoke').disabled);
    t.true($parent.querySelector('button[type="submit"]').disabled);

    resolveReplace();
    await waitFor(() => !$parent.querySelector('.secret-revoke').disabled);

    const $description = $parent.querySelector(
      '.secret-card input[name="description"]',
    );
    $description.value = 'Fail this update';
    $description.dispatchEvent(new Event('input', { bubbles: true }));
    $description.form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await waitFor(() => $parent.textContent.includes('set-description'));
    t.true($parent.textContent.includes('failed'));
    t.true($parent.textContent.includes('Secret operation failed.'));
    t.false($parent.textContent.includes(canary));
  },
);

test.serial('secret Space orders and deletes revoked records', async t => {
  const document = testDocument;
  const activeSummary = harden({
    secretId: 'active-secret',
    description: 'Still usable',
    state: 'active',
    generation: 1n,
    createdAt: '2026-09-03T00:00:01.000Z',
    updatedAt: '2026-09-03T00:00:01.000Z',
  });
  const revokedSummary = harden({
    secretId: 'revoked-secret',
    description: 'No longer usable',
    state: 'revoked',
    generation: 2n,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:02.000Z',
  });
  let includeRevoked = true;
  const deleted = [];
  const activeAdmin = Far('ActiveSecretAdmin', {
    replaceBase64: () => undefined,
    setDescription: () => undefined,
    revoke: () => undefined,
    delete: () => undefined,
  });
  const revokedAdmin = Far('RevokedSecretAdmin', {
    replaceBase64: () => undefined,
    setDescription: () => undefined,
    revoke: () => undefined,
    delete: () => {
      deleted.push(revokedSummary.secretId);
      includeRevoked = false;
    },
  });
  const catalog = Far('OrderedSecretCatalog', {
    list: () => [
      ...(includeRevoked
        ? [
            {
              secretId: revokedSummary.secretId,
              summary: revokedSummary,
              petNamePaths: [['secrets', 'retired']],
              admin: revokedAdmin,
            },
          ]
        : []),
      {
        secretId: activeSummary.secretId,
        summary: activeSummary,
        petNamePaths: [['secrets', 'current']],
        admin: activeAdmin,
      },
    ],
  });
  const audit = Far('OrderedSecretAudit', { list: () => [] });
  const powers = Far('OrderedSecretPowers', {
    lookup: path => {
      const key = Array.isArray(path) ? path.join('/') : path;
      if (key === '@secrets/catalog') return catalog;
      if (key === '@secrets/audit') return audit;
      throw new Error('unknown path');
    },
  });

  const $parent = document.createElement('div');
  document.body.appendChild($parent);
  const cleanup = secretsComponent($parent, powers, []);
  t.teardown(cleanup);
  await waitFor(() => $parent.querySelectorAll('.secret-card').length === 2);

  const cards = [...$parent.querySelectorAll('.secret-card')];
  t.true(cards[0].classList.contains('secret-active'));
  t.true(cards[1].classList.contains('secret-revoked'));
  t.is(
    cards[0].querySelector('.secret-replace-section h3').textContent,
    'Replace value',
  );
  t.is(
    cards[0].querySelector('.secret-revoke-section h3').textContent,
    'Revoke access',
  );
  t.true(cards[1].textContent.includes('secrets/retired'));

  cards[1].querySelector('.secret-delete').click();
  await waitFor(() => deleted.length === 1);
  await waitFor(() => $parent.querySelectorAll('.secret-card').length === 1);
  t.deepEqual(deleted, ['revoked-secret']);
});

test.serial('secret Space ingests a file byte for byte', async t => {
  const document = testDocument;
  const calls = [];
  const catalog = Far('MockSecretCatalog', { list: () => [] });
  const audit = Far('MockSecretAudit', { list: () => [] });
  const importer = Far('MockSecretImporter', {
    createBase64: (name, description, value) => {
      calls.push(['create', name, description, value]);
      return harden({
        secretId: 'secret-file',
        description,
        state: 'active',
        generation: 1n,
        createdAt: '2026-09-04T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:00.000Z',
      });
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

  // Bytes that are not valid UTF-8 and include a NUL: a text round trip would
  // corrupt them, so this pins that the file path stays binary-exact.
  const raw = new Uint8Array([0x00, 0xff, 0xfe, 0x41, 0x0a, 0x80, 0x7f]);
  const $parent = document.createElement('div');
  document.body.appendChild($parent);
  const cleanup = secretsComponent(
    $parent,
    powers,
    [],
    async () => {},
    async () => ({ name: 'id_ed25519', bytes: new Uint8Array(raw) }),
  );
  t.teardown(cleanup);

  // 'No secrets yet.' renders only once the initial load settles; the file
  // button is disabled while loading.
  await waitFor(() => $parent.textContent.includes('No secrets yet.'));
  const $createPanel = $parent.querySelector('.secret-create-panel');
  $createPanel.open = true;
  $createPanel.dispatchEvent(new Event('toggle'));

  const $create = $parent.querySelector('.secret-create-form');
  const $name = $create.elements.namedItem('name');
  const $description = $create.elements.namedItem('description');
  const $value = $create.elements.namedItem('value');

  const $readFile = [...$parent.querySelectorAll('button')].find(
    button => button.textContent === 'Read from file…',
  );
  t.truthy($readFile);
  $readFile.click();
  t.true(await waitFor(() => $parent.textContent.includes('id_ed25519')));

  // The view learns the name and length, never the bytes.
  t.true($parent.textContent.includes('7 bytes'));
  t.false($parent.textContent.includes('AP/+QQqAfw=='));
  // The typed field yields to the file rather than competing with it.
  t.true($value.disabled);

  $name.value = 'ssh-key';
  $name.dispatchEvent(new Event('input', { bubbles: true }));
  $description.value = 'Deploy key';
  $description.dispatchEvent(new Event('input', { bubbles: true }));
  $create.dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
  await waitFor(() => calls.length === 1);

  const [[, name, description, value]] = calls;
  t.is(name, 'ssh-key');
  t.is(description, 'Deploy key');
  // Decodes back to exactly the bytes the file held.
  t.deepEqual([...decodeBase64(value)], [...raw]);

  // The panel forgets the file once the secret is stored.
  t.true(await waitFor(() => !$parent.textContent.includes('id_ed25519')));
  t.true($parent.textContent.includes('No file chosen'));
});
