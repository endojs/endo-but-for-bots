// @ts-check
/* eslint-disable import/no-relative-packages */
// W4.7 Secrets panel (P-58; R6-67, R7-26, R7-63; m4-interfaces.md 9.1,
// 16): component tests in happy-dom with M3's fake powers and a fake M4
// Secrets manager. The panel never renders a value; replace sends the
// generation it showed; revoke, then delete; audit paging; the browser size
// bound measured on the JSON-escaped value; a non-UTF-8 file refused.
import test from '@endo/ses-ava/prepare-endo.js';

import { makeController } from '../../ui/src/controller/index.js';
import { mount } from '../../ui/src/shell/index.js';
import { feature as secretsFeature } from '../../ui/src/secrets/feature.js';
import {
  browserValueBytes,
  refuseBrowserValue,
  textOfFileBytes,
} from '../../ui/src/secrets/values.js';
import { secretsTexts } from '../../ui/src/secrets/SecretsPanel.js';
import { m4Limits } from '../../guest/lib/limits-m4.js';
import { m4Texts } from '../../guest/lib/texts-m4.js';
import { makeFakePowers, makeTestDom } from './_m3-fake-powers.js';
import {
  makeFakeSecrets,
  runEffectsPromptly,
  secretFailed,
} from './_m4-ui-fakes.js';

const flush = async (rounds = 20) => {
  await null;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/** A value no page may show; built at run time. */
const marker = () => ['never', 'shown', 'value', '7f3c'].join('-');

/**
 * @param {{ secrets?: ReturnType<typeof makeFakeSecrets> }} [options]
 */
const setup = async ({ secrets = makeFakeSecrets() } = {}) => {
  runEffectsPromptly();
  const dom = makeTestDom();
  const features = [secretsFeature];
  const { powers, control } = makeFakePowers({
    operatorMethods: { getSecrets: () => secrets.getSecrets() },
  });
  const controller = makeController({
    storage: undefined,
    locks: { request: (_name, callback) => callback() },
    features,
  });
  const shell = mount({
    root: dom.root,
    controller,
    features,
    window: dom.window,
    schedule: fn => fn(),
  });
  await controller.attach(powers);
  controller.openPanel('secrets');
  await flush();
  const $ = (/** @type {string} */ selector) =>
    dom.document.querySelector(selector);
  const $$ = (/** @type {string} */ selector) => [
    ...dom.document.querySelectorAll(selector),
  ];
  const click = async (/** @type {any} */ element) => {
    element.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true }),
    );
    await flush();
  };
  /** @param {string} label */
  const rowOf = label =>
    $$('.m4-secret').find(
      li => li.querySelector('.m4-secret-label')?.textContent === label,
    );
  const rowButton = (
    /** @type {string} */ label,
    /** @type {string} */ action,
  ) => rowOf(label)?.querySelector(`[data-action="${action}"]`);
  /**
   * Whether the page holds `text` as markup or as an input's value.
   *
   * @param {string} text
   */
  const pageHolds = text =>
    dom.document.body.innerHTML.includes(text) ||
    $$('input').some(input => String(input.value).includes(text));
  return {
    dom,
    controller,
    shell,
    secrets,
    control,
    $,
    $$,
    click,
    rowOf,
    rowButton,
    pageHolds,
  };
};

test.serial(
  'values: the browser bound is measured on the JSON-escaped value',
  t => {
    const exact = 'a'.repeat(m4Limits.browserSecretBytes - 2);
    t.is(browserValueBytes(exact), m4Limits.browserSecretBytes);
    t.is(refuseBrowserValue(exact), undefined);
    t.is(refuseBrowserValue(`${exact}a`), m4Texts.secretTooLargeForBrowser);
    // Escapes count: a quote is two bytes in the frame.
    const quotes = '"'.repeat(m4Limits.browserSecretBytes / 2);
    t.is(refuseBrowserValue(quotes), m4Texts.secretTooLargeForBrowser);
    t.deepEqual(textOfFileBytes(new Uint8Array([0x68, 0x69])), { value: 'hi' });
    t.deepEqual(textOfFileBytes(new Uint8Array([0xff, 0xfe, 0x80])), {
      error: m4Texts.secretNotText,
    });
    // Byte-exact: a BOM is kept.
    t.is(
      /** @type {any} */ (
        textOfFileBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))
      ).value,
      '﻿A',
    );
  },
);

test.serial(
  'catalogue: label, description, generation, state and bytes; never a value',
  async t => {
    const secrets = makeFakeSecrets();
    const value = marker();
    secrets.add('provider-key', value);
    secrets.add('empty-one');
    const s = await setup({ secrets });
    t.truthy(s.$('[data-panel="secrets"] .m4-secrets'));
    const facts = s.rowOf('provider-key')?.querySelector('.m4-secret-facts');
    t.is(facts?.textContent, `gen 1 · ${value.length} bytes · active`);
    t.is(
      s.rowOf('empty-one')?.querySelector('.m4-secret-description')
        ?.textContent,
      'empty-one description',
    );
    t.false(s.pageHolds(value));
    await s.dom.close();
  },
);

test.serial(
  'create with a first value: create, then replace at generation 0; field cleared',
  async t => {
    const s = await setup();
    const value = marker();
    /** @type {any} */ (s.$('[data-form="create"] [name="label"]')).value =
      'new-secret';
    /** @type {any} */ (
      s.$('[data-form="create"] [name="description"]')
    ).value = 'made in the page';
    /** @type {any} */ (s.$('[data-form="create"] [name="value"]')).value =
      value;
    const form = s.$('[data-form="create"]');
    form?.dispatchEvent(
      new s.dom.window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();
    t.deepEqual(s.secrets.callsOf('SecretsAdmin.create')[0][2], {
      label: 'new-secret',
      description: 'made in the page',
    });
    t.deepEqual(s.secrets.callsOf('SecretWriter.replace'), [
      ['SecretWriter', 'replace', 'new-secret', value.length, 0],
    ]);
    t.is(s.$('.m4-notice')?.textContent, secretsTexts.created);
    t.is(
      s.rowOf('new-secret')?.querySelector('.m4-secret-facts')?.textContent,
      `gen 1 · ${value.length} bytes · active`,
    );
    t.false(s.pageHolds(value), 'the value is not in the page after sending');
    t.is(s.secrets.records[0].value, value, 'the writer received it');
    await s.dom.close();
  },
);

test.serial(
  'replace sends the generation shown; a stale one fails GENERATION_CONFLICT',
  async t => {
    const secrets = makeFakeSecrets();
    secrets.add('rotating', 'first');
    const s = await setup({ secrets });
    await s.click(s.rowButton('rotating', 'replace'));
    /** @type {any} */ (s.$('[data-form="replace"] [name="value"]')).value =
      marker();
    await s.click(s.$('[data-form="replace"] [data-action="send"]'));
    t.deepEqual(s.secrets.callsOf('SecretWriter.replace').at(-1), [
      'SecretWriter',
      'replace',
      'rotating',
      marker().length,
      1,
    ]);
    t.is(s.$('.m4-notice')?.textContent, secretsTexts.replaced);
    t.regex(String(s.rowOf('rotating')?.textContent), /gen 2/);

    // Someone else replaces it; the panel still shows generation 2.
    s.secrets.writer.replace(s.secrets.records[0].secret, 'elsewhere');
    await s.click(s.rowButton('rotating', 'replace'));
    /** @type {any} */ (s.$('[data-form="replace"] [name="value"]')).value =
      marker();
    await s.click(s.$('[data-form="replace"] [data-action="send"]'));
    t.deepEqual(s.secrets.callsOf('SecretWriter.replace').at(-1)?.[4], 2);
    t.is(s.$('.m4-error')?.textContent, secretFailed('GENERATION_CONFLICT'));
    t.regex(
      String(s.rowOf('rotating')?.textContent),
      /gen 3/,
      'the catalogue is read again after a failure',
    );
    t.false(s.pageHolds(marker()));
    // An empty value is not sent.
    const before = s.secrets.callsOf('SecretWriter.replace').length;
    await s.click(s.$('[data-form="replace"] [data-action="send"]'));
    t.is(s.$('.m4-error')?.textContent, secretsTexts.noValue);
    t.is(s.secrets.callsOf('SecretWriter.replace').length, before);
    await s.dom.close();
  },
);

test.serial('description edit, revoke, then delete after revoke', async t => {
  const secrets = makeFakeSecrets();
  secrets.add('old-key', 'v');
  const s = await setup({ secrets });
  t.is(s.rowButton('old-key', 'delete'), null, 'no delete before revoke');

  await s.click(s.rowButton('old-key', 'describe'));
  /** @type {any} */ (
    s.$('[data-form="describe"] [name="description"]')
  ).value = 'retired provider key';
  await s.click(s.$('[data-form="describe"] [data-action="save"]'));
  t.deepEqual(s.secrets.callsOf('Secret.setDescription')[0].slice(3), [
    'retired provider key',
  ]);
  t.is(
    s.rowOf('old-key')?.querySelector('.m4-secret-description')?.textContent,
    'retired provider key',
  );

  await s.click(s.rowButton('old-key', 'revoke'));
  t.is(s.secrets.callsOf('Secret.revoke').length, 0, 'revoke asks first');
  await s.click(s.$('[data-form="revoke"] [data-action="confirm-revoke"]'));
  t.is(s.secrets.callsOf('Secret.revoke').length, 1);
  t.is(s.rowOf('old-key')?.getAttribute('data-state'), 'revoked');
  t.is(s.rowButton('old-key', 'replace'), null, 'no replace once revoked');

  await s.click(s.rowButton('old-key', 'delete'));
  await s.click(s.$('[data-form="delete"] [data-action="confirm-delete"]'));
  t.is(s.secrets.callsOf('Secret.delete').length, 1);
  t.is(s.rowOf('old-key'), undefined);
  await s.dom.close();
});

test.serial(
  'audit: newest first, 100 a page, older pages by `before`, per secret or all',
  async t => {
    const secrets = makeFakeSecrets();
    const record = secrets.add('busy-key', 'v0');
    for (let i = 1; i <= 149; i += 1) {
      secrets.writer.replace(record.secret, `v${i}`);
    }
    secrets.add('quiet-key');
    const s = await setup({ secrets });
    await s.click(s.rowButton('busy-key', 'audit'));
    const reads = s.secrets.callsOf('AuditReader.page');
    t.is(reads.length, 1);
    t.is(reads[0][2].secret, record.secret);
    t.is(reads[0][2].limit, 100);
    t.is(reads[0][2].before, undefined);
    let lines = s.$$('.m4-audit-event').map(li => li.textContent);
    t.is(lines.length, 100);
    t.regex(String(lines[0]), / busy-key replace succeeded gen 150$/);

    await s.click(s.$('[data-action="older"]'));
    const second = s.secrets.callsOf('AuditReader.page')[1][2];
    t.is(typeof second.before, 'number');
    lines = s.$$('.m4-audit-event').map(li => li.textContent);
    t.is(lines.length, 151, 'create + 150 replaces');
    t.regex(String(lines[150]), / busy-key create succeeded$/);
    t.is(s.$('[data-action="older"]'), null, 'no more pages');

    await s.click(s.$('[data-action="audit-all"]'));
    t.is(s.secrets.callsOf('AuditReader.page')[2][2].secret, undefined);
    t.regex(
      String(s.$$('.m4-audit-event')[0]?.textContent),
      / quiet-key create succeeded$/,
    );
    t.is(s.secrets.callsOf('SecretsAdmin.auditReader').length, 1, 'one reader');
    await s.dom.close();
  },
);

test.serial(
  'size bound: browserSecretBytes is sent, one byte more is refused in the page',
  async t => {
    const secrets = makeFakeSecrets();
    secrets.add('big');
    const s = await setup({ secrets });
    const exact = 'x'.repeat(m4Limits.browserSecretBytes - 2);

    await s.click(s.rowButton('big', 'replace'));
    /** @type {any} */ (s.$('[data-form="replace"] [name="value"]')).value =
      `${exact}x`;
    await s.click(s.$('[data-form="replace"] [data-action="send"]'));
    t.is(s.$('.m4-error')?.textContent, m4Texts.secretTooLargeForBrowser);
    t.is(s.secrets.callsOf('SecretWriter.replace').length, 0, 'nothing sent');
    t.is(
      /** @type {any} */ (s.$('[data-form="replace"] [name="value"]')).value,
      '',
    );

    /** @type {any} */ (s.$('[data-form="replace"] [name="value"]')).value =
      exact;
    await s.click(s.$('[data-form="replace"] [data-action="send"]'));
    t.deepEqual(s.secrets.callsOf('SecretWriter.replace'), [
      ['SecretWriter', 'replace', 'big', exact.length, 0],
    ]);
    t.is(
      s.rowOf('big')?.querySelector('.m4-secret-facts')?.textContent,
      `gen 1 · ${exact.length} bytes · active`,
    );

    // Create refuses before creating anything.
    /** @type {any} */ (s.$('[data-form="create"] [name="label"]')).value =
      'huge';
    /** @type {any} */ (
      s.$('[data-form="create"] [name="description"]')
    ).value = 'too big';
    /** @type {any} */ (s.$('[data-form="create"] [name="value"]')).value =
      `${exact}x`;
    s.$('[data-form="create"]')?.dispatchEvent(
      new s.dom.window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();
    t.is(s.$('.m4-error')?.textContent, m4Texts.secretTooLargeForBrowser);
    t.is(s.secrets.callsOf('SecretsAdmin.create').length, 0);
    await s.dom.close();
  },
);

test.serial(
  'files: a non-UTF-8 file is refused; a text file is sent byte-exact',
  async t => {
    const secrets = makeFakeSecrets();
    secrets.add('from-file');
    const s = await setup({ secrets });
    /** @param {number[]} bytes */
    const choose = bytes => {
      const picker = s.$('[data-form="replace"] [name="file"]');
      Object.defineProperty(picker, 'files', {
        configurable: true,
        value: [
          { arrayBuffer: async () => new Uint8Array(bytes).buffer.slice(0) },
        ],
      });
    };
    await s.click(s.rowButton('from-file', 'replace'));
    choose([0xff, 0xfe, 0x00, 0x80]);
    await s.click(s.$('[data-form="replace"] [data-action="send"]'));
    t.is(s.$('.m4-error')?.textContent, m4Texts.secretNotText);
    t.is(s.secrets.callsOf('SecretWriter.replace').length, 0);

    choose([0x7b, 0x7d, 0x0a]);
    await s.click(s.$('[data-form="replace"] [data-action="send"]'));
    t.is(s.secrets.callsOf('SecretWriter.replace').length, 1);
    t.is(s.secrets.records[0].value, '{}\n');
    await s.dom.close();
  },
);

test.serial(
  'catalogue pages: More reads the next page; actions keep the pages read',
  async t => {
    const secrets = makeFakeSecrets({ pageEntries: 2 });
    for (const label of ['a', 'b', 'c', 'd', 'e']) secrets.add(label);
    const s = await setup({ secrets });
    t.is(s.$$('.m4-secret').length, 2);
    await s.click(s.$('[data-action="more"]'));
    t.is(s.$$('.m4-secret').length, 4);
    await s.click(s.rowButton('c', 'revoke'));
    await s.click(s.$('[data-form="revoke"] [data-action="confirm-revoke"]'));
    t.is(s.$$('.m4-secret').length, 4, 'two pages read again');
    await s.click(s.$('[data-action="more"]'));
    t.is(s.$$('.m4-secret').length, 5);
    t.is(s.$('[data-action="more"]'), null);
    await s.dom.close();
  },
);
