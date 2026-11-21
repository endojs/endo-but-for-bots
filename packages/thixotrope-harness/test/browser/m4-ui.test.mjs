// @ts-check
/* eslint-disable no-await-in-loop -- each step waits for the previous one */
/* eslint-disable import/no-relative-packages */
/**
 * M4 acceptance 14 and the browser part of 15 (designs/m4-interfaces.md
 * 9.1, 17; XD), in headless Chromium through `startBrowserGateway`, on the
 * `m4` template, against the fake subscription and OAuth servers
 * (127.0.0.1):
 *
 * 14. The account chips of a pool session update live from a turn sent by
 *     the page (one member's credential expired: renewed through the fake
 *     OAuth server); the Subscriptions panel lists the pool through
 *     `SecretsAdmin.subscriptions()` -> `accounts()` of the real manager vat
 *     and Refresh reads both members. The Secrets panel creates, replaces,
 *     fails a stale replace with `GENERATION_CONFLICT`, edits a description,
 *     shows the audit, revokes and deletes after the revoke. Size probe: a
 *     value of 1,040,382 ASCII letters (`browserSecretBytes` JSON-escaped)
 *     is written from the page through the gateway's large-call writer
 *     (`GW/extensions/secrets.js`) and the catalogue shows its bytes and a
 *     new generation; one letter more is refused in the page with
 *     `subscriptionTexts.secretTooLargeForBrowser` and no frame is sent. No value
 *     appears in the DOM or in any frame from the gateway.
 * 15 (browser part). No access token, refresh token or typed value in the
 *     page's network log (HTTP requests and frames received; credentials
 *     not in frames sent either) or the DOM; after a clean stop, none of
 *     them and no 64-byte marker of either size-probe value under the state
 *     directory or in the supervisor's stderr.
 * Rule 4a (m3-interfaces.md 4.4): an unknown method sent from the page to
 *     vat objects (Operator, SecretsAdmin, SessionFactory) is refused with
 *     `gatewayTexts.unknownMethod`; every other call the page made is
 *     admitted (the gateway logged no other refusal).
 *
 *   THIX_AGENT=me corepack yarn test:browser test/browser/m4-ui.test.mjs
 */
import '../unit/_m1a-prelude.js';

import { randomBytes } from 'node:crypto';

import test from 'ava';

import { E } from '@endo/far';

import { subscriptionLimits } from '../../guest/lib/subscription-limits.js';
import { subscriptionTexts } from '../../guest/lib/subscription-texts.js';
import { gatewayTexts } from '../../resources/agent-host/impl/gateway/protocol.js';
import { sealTo } from '../../resources/agent-host/impl/secrets/seal.js';
import { startFakeOAuthServer } from '../fixtures/fake-oauth-server.mjs';
import {
  readingHeaders,
  startFakeSubscriptionServer,
} from '../fixtures/fake-subscription-server.mjs';
import { waitFor } from '../integration/_m1a-slice.js';
import { grepState } from '../integration/_m2-secrets.js';
import {
  CLAUDE_MODEL,
  CODEX_MODEL,
  TOKEN_PREFIXES,
  credentialText,
  fakeDefaults,
  m4Template,
  m4View,
  makePool,
  makeValueSecret,
  tokenOf,
} from '../integration/_m4.js';
import { browserSkipReason, startBrowserGateway } from './_harness.mjs';

const skip = await browserSkipReason();
const run = skip === undefined ? test.serial : test.skip;
if (skip) test(`[browser] m4-ui skipped: ${skip}`, t => t.pass());

const POOL = 'Browser pool';
const SECRET = 'xd browser secret';

/**
 * `count` ASCII letters, random per run, so a 64-byte piece of the value is
 * a marker no file holds by chance.
 * @param {number} count
 */
const letters = count => {
  const bytes = randomBytes(count);
  for (let i = 0; i < count; i += 1) bytes[i] = 97 + (bytes[i] % 26);
  return bytes.toString('latin1');
};

/**
 * An init script (runs in each page before its own scripts and lockdown):
 * remembers every slot the gateway sent with its alleged interface, and
 * lets the test send one raw `CTP_CALL` on the page's socket and read its
 * answer. The answers to the test's questions (`q-7700...`) are taken
 * before the page's CapTP sees them (it never asked them).
 */
const probeSockets = () => {
  const g = /** @type {any} */ (globalThis);
  const Native = g.WebSocket;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  /** @type {any[]} */
  const sockets = [];
  /** @type {Record<string, string>} slot (gateway naming) -> iface */
  const slots = {};
  /**
   * Slots by how the page got them: `key:<record key>` (a field of an
   * answer, as `operator` of the `GatewayPowers`) or `returned:<method>`
   * (the answer of a call the page made). Vat presences carry no useful
   * alleged interface through the hub, so this is how a test names them.
   * @type {Record<string, string>}
   */
  const named = {};
  /** @type {Record<string, string>} the page's question id -> method */
  const questions = {};
  /** @type {Record<string, any>} */
  const answers = {};
  /** @type {{ epoch: unknown }} */
  const last = { epoch: undefined };
  /** @param {any} data */
  const textOf = data => {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer)
      return decoder.decode(new Uint8Array(data));
    if (ArrayBuffer.isView(data))
      return decoder.decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
    return undefined;
  };
  /**
   * @param {any} capdata
   * @param {string | undefined} method the call this answers
   */
  const collect = (capdata, method) => {
    if (!capdata || typeof capdata.body !== 'string') return;
    /** @param {any} value */
    const slotOf = value =>
      value && value['@qclass'] === 'slot'
        ? capdata.slots[value.index]
        : undefined;
    const walk = (/** @type {any} */ value) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        const slot = slotOf(value);
        if (typeof slot === 'string') {
          slots[slot] = String(value.iface ?? '');
        } else {
          for (const [key, inner] of Object.entries(value)) {
            const held = slotOf(inner);
            if (typeof held === 'string') named[`key:${key}`] = held;
            walk(inner);
          }
        }
      }
    };
    try {
      const body = JSON.parse(capdata.body);
      const returned = slotOf(body);
      if (method !== undefined && typeof returned === 'string')
        named[`returned:${method}`] = returned;
      walk(body);
    } catch {
      // not capdata
    }
  };
  class Probed extends Native {
    /** @param {any[]} args */
    constructor(...args) {
      super(...args);
      sockets.push(this);
      // Added before the page sets `onmessage`, so it runs first.
      this.addEventListener('message', (/** @type {any} */ event) => {
        const text = textOf(event.data);
        if (text === undefined) return;
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        if (
          message.type === 'CTP_RETURN' &&
          String(message.answerID).startsWith('q-7700')
        ) {
          answers[message.answerID] = message;
          event.stopImmediatePropagation();
          return;
        }
        if (message.type === 'CTP_RETURN')
          collect(message.result, questions[message.answerID]);
      });
    }

    /** @param {any} data */
    send(data) {
      const text = textOf(data);
      if (text !== undefined) {
        try {
          const message = JSON.parse(text);
          if (message.epoch !== undefined) last.epoch = message.epoch;
          if (message.type === 'CTP_CALL') {
            const [method] = JSON.parse(message.method.body);
            if (typeof method === 'string')
              questions[message.questionID] = method;
          }
        } catch {
          // not JSON
        }
      }
      super.send(data);
    }
  }
  g.WebSocket = Probed;
  g.thixProbe = {
    slots: () => ({ ...slots }),
    named: () => ({ ...named }),
    answer: (/** @type {string} */ id) => answers[id],
    /**
     * @param {string} slot as the gateway sent it (`o+N`)
     * @param {string} method
     * @param {string} questionID `q-7700...`
     */
    call: (slot, method, questionID) => {
      const target = `${slot[0]}${slot[1] === '+' ? '-' : '+'}${slot.slice(2)}`;
      const socket = sockets[sockets.length - 1];
      socket.send(
        encoder.encode(
          JSON.stringify({
            type: 'CTP_CALL',
            epoch: last.epoch,
            questionID,
            target,
            method: { body: JSON.stringify([method, []]), slots: [] },
          }),
        ),
      );
    },
  };
};

/** Methods the Secrets panel calls (an action or the catalogue re-read). */
const secretsMethods = new Set([
  'replace',
  'catalog',
  'create',
  'admin',
  'getSecrets',
  'setDescription',
  'revoke',
  'delete',
]);

/**
 * The method a sent frame calls, if it is a `CTP_CALL`.
 * @param {string} text
 * @returns {unknown}
 */
const methodOf = text => {
  try {
    const message = JSON.parse(text);
    if (message.type !== 'CTP_CALL') return undefined;
    return JSON.parse(message.method.body)[0];
  } catch {
    return undefined;
  }
};

/**
 * @param {any} page
 * @param {string} text
 */
const domHas = async (page, text) => (await page.content()).includes(text);

run(
  '[browser] Codex account chip shows confirmed five-hour and weekly allowances',
  async t => {
    t.timeout(4 * 60_000);
    const reset = Math.floor(Date.now() / 1000);
    const server = await startFakeSubscriptionServer({
      defaults: {
        ...fakeDefaults,
        'GET /backend-api/wham/usage': {
          body: {
            plan_type: 'plus',
            rate_limit: {
              limit_reached: false,
              primary_window: {
                used_percent: 0,
                limit_window_seconds: 18_000,
                reset_at: reset + 18_000,
              },
              secondary_window: {
                used_percent: 67,
                limit_window_seconds: 604_800,
                reset_at: reset + 604_800,
              },
            },
          },
        },
      },
    });
    t.teardown(() => server.close());
    const harness = await startBrowserGateway({ template: await m4Template() });
    t.teardown(() => harness.close());
    const m4 = await m4View(harness.state);
    const { secret } = await makeValueSecret(
      m4,
      'browser allowance',
      credentialText('codex', { accessToken: tokenOf('quota') }),
    );
    const label = 'Allowance pool';
    const { backend } = await makePool(m4, {
      kind: 'codex-pool',
      label,
      members: [{ label: 'member', credential: secret }],
      baseUrl: server.url,
    });
    await E(m4.slice.factory).createSession(
      harden({
        title: 'quota check',
        preset: m4.slice.chatOnly,
        backend,
        modelId: CODEX_MODEL,
        at: Date.now(),
      }),
    );
    const { page } = harness;
    await page
      .locator('.floot-session-item', { hasText: 'quota check' })
      .click();
    const chip = page.locator(`.m4-chips[data-pool="${label}"] .m4-chip`);
    await chip.waitFor();
    const panelButton = page.locator('button[data-panel="accounts"]');
    await panelButton.click();
    const pool = page.locator('.m4-subscriptions .m4-pool', { hasText: label });
    await pool.locator('button[data-action="refresh-pool"]').click();
    await pool.locator('.m4-account[data-provenance="observed"]').waitFor();
    t.true(server.requests().some(r => r.path === '/backend-api/wham/usage'));
    await panelButton.click();
    await waitFor(
      async () => {
        const text = await chip.innerText();
        return (
          text.includes('weekly 67% used') && text.includes('5h quota 0% used')
        );
      },
      15_000,
      'both confirmed periods and usage percentages in the session chip',
    );
  },
);

run('[browser] M4 acceptance 14, 15 (browser part) and rule 4a', async t => {
  t.timeout(4.5 * 60_000);
  const started = Date.now();
  /** @type {Record<string, number>} */
  const ms = {};
  const mark = (/** @type {string} */ name) => {
    ms[name] = Date.now() - started;
  };

  const oauth = await startFakeOAuthServer();
  t.teardown(() => oauth.close());
  const tokens = { a: tokenOf('xda'), b: tokenOf('xdb') };
  const tags = new Map(Object.entries(tokens).map(([k, v]) => [v, k]));
  const server = await startFakeSubscriptionServer({
    credentialTag: value =>
      tags.get(value) ??
      (value.startsWith('fake-access-') ? 'renewed' : 'other'),
    defaults: fakeDefaults,
  });
  t.teardown(() => server.close());
  /** Refresh tokens issued to the members (values the grep looks for). */
  /** @type {string[]} */
  const refreshTokens = [];

  /** @param {{ root: any, operator: any }} powers */
  const provision = async ({ operator }) => {
    const secrets = await E(operator).getSecrets();
    const subs = await E(secrets).subscriptions();
    const writer = await E(secrets).openWriter();
    const publicKey = await E(writer).publicKey();
    /**
     * @param {string} label
     * @param {Record<string, unknown>} fields
     */
    const member = async (label, fields) => {
      const secret = await E(secrets).create(
        harden({ label: `${label} credential`, description: 'xd' }),
      );
      await E(writer).replace(
        secret,
        sealTo(
          publicKey,
          credentialText('claude', /** @type {any} */ (fields)),
        ),
      );
      return secret;
    };
    const issued = oauth.issue();
    refreshTokens.push(issued.refreshToken);
    // Member a's access token has expired: the first round renews it.
    const a = await E(subs).makeMember(
      harden({
        provider: 'claude',
        label: 'member a',
        credential: await member('member a', {
          accessToken: tokens.a,
          refreshToken: issued.refreshToken,
          expiresAtMs: Date.now() - 1000,
        }),
      }),
    );
    const b = await E(subs).makeMember(
      harden({
        provider: 'claude',
        label: 'member b',
        credential: await member('member b', { accessToken: tokens.b }),
        declared: {
          plan: 'max',
          windows: [{ name: 'secondary', usedPercent: 10 }],
        },
      }),
    );
    const backend = await E(subs).makePool(
      harden({
        kind: 'claude-pool',
        label: POOL,
        members: [a, b],
        baseUrl: server.url,
        usageUrl: `${server.url}/api/oauth/usage`,
        tokenUrl: oauth.tokenUrl,
      }),
    );
    const factory = await E(operator).getFactory();
    const [preset] = await E(factory).listPresets();
    await E(factory).createSession(
      harden({
        title: 'pool chat',
        preset,
        backend,
        modelId: CLAUDE_MODEL,
        at: Date.now(),
      }),
    );
  };

  const harness = await startBrowserGateway({
    template: await m4Template(),
    provision,
    initScript: probeSockets,
  });
  const { page, client, state, gatewayLog } = harness;
  let stopped = false;
  try {
    mark('started');
    // The page's network log: HTTP requests and WebSocket frames.
    /** @type {string[]} */
    const requests = [];
    /** @type {string[]} */
    const received = [];
    /** @type {string[]} */
    const sent = [];
    /** @param {any} payload */
    const frameText = payload =>
      typeof payload === 'string' ? payload : payload.toString('utf8');
    page.on('request', (/** @type {any} */ request) => {
      requests.push(
        [
          request.url(),
          JSON.stringify(request.headers()),
          request.postData() ?? '',
        ].join('\n'),
      );
    });
    page.on('websocket', (/** @type {any} */ ws) => {
      ws.on('framereceived', (/** @type {any} */ frame) =>
        received.push(frameText(frame.payload)),
      );
      ws.on('framesent', (/** @type {any} */ frame) =>
        sent.push(frameText(frame.payload)),
      );
    });
    // The page was opened before these listeners: load it again.
    await page.reload();

    const operator = client.powers.operator;
    const secrets = await E(operator).getSecrets();
    const writer = await E(secrets).openWriter();
    const publicKey = await E(writer).publicKey();

    // ---- account chips, live, from a turn the page sends ----
    await page.locator('.floot-session-item', { hasText: 'pool chat' }).click();
    const chips = page.locator(`.m4-chips[data-pool="${POOL}"] .m4-chip`);
    await chips.first().waitFor();
    t.is(await chips.count(), 2, 'one chip per member');
    const resetSec = Math.floor(Date.now() / 1000) + 86_400;
    server.push({
      sse: 'claude-text.sse',
      headers: readingHeaders('claude', {
        primaryPercent: 20,
        secondaryPercent: 37,
        primaryResetSec: resetSec - 3600,
        secondaryResetSec: resetSec,
      }),
    });
    const input = page.locator('textarea.floot-input');
    await input.fill('hello pool');
    await input.press('Enter');
    await waitFor(
      async () =>
        (await chips.allTextContents()).some(
          text =>
            text.includes('weekly 37% used') &&
            text.includes('5h quota 20% used'),
        ),
      60_000,
      'one account chip identifies both confirmed quota windows',
      100,
    );
    mark('chipLive');
    const served = server
      .requests()
      .filter(r => r.method === 'POST')
      .map(r => r.credential);
    t.true(served.length >= 1, 'the round reached the fake server');
    t.true(
      served.every(tag => tag !== 'other'),
      `served with known credentials: ${served.join(', ')}`,
    );

    // ---- Subscriptions panel: SecretsAdmin.subscriptions() -> accounts ----
    await page.locator('button[data-panel="accounts"]').click();
    const pool = page.locator('.m4-subscriptions .m4-pool', {
      hasText: POOL,
    });
    await pool.waitFor();
    t.is(await pool.locator('.m4-account').count(), 2);
    const usageReads = () =>
      server.requests().filter(r => r.path === '/api/oauth/usage').length;
    const readsBefore = usageReads();
    await pool.locator('button[data-action="refresh-pool"]').click();
    await waitFor(
      async () =>
        (await pool
          .locator('.m4-account[data-provenance="observed"]')
          .count()) === 2,
      30_000,
      'both members observed after Refresh',
      100,
    );
    t.is(usageReads() - readsBefore, 2, 'Refresh read both members');
    await page.locator('button[data-panel="accounts"]').click(); // close
    mark('subscriptions');

    // ---- Secrets panel ----
    await page.locator('button[data-panel="secrets"]').click();
    const panel = page.locator('.m4-secrets');
    await panel.waitFor();
    const values = {
      v1: letters(40),
      v2: letters(41),
      stale: letters(42),
      v3: letters(43),
    };
    const create = panel.locator('form[data-form="create"]');
    await create.locator('input[name="label"]').fill(SECRET);
    await create.locator('input[name="description"]').fill('made in a page');
    await create.locator('input[name="value"]').fill(values.v1);
    await create.locator('button[data-action="create"]').click();
    const row = panel.locator('li.m4-secret', { hasText: SECRET });
    const facts = row.locator('.m4-secret-facts');
    /** @param {string} text */
    const factsBecome = text =>
      waitFor(
        async () => (await facts.textContent()) === text,
        30_000,
        `the row shows ${text}`,
        50,
      );
    await factsBecome(`gen 1 · ${values.v1.length} bytes · active`);
    const replace = async (/** @type {string} */ value) => {
      await row.locator('button[data-action="replace"]').click();
      await row.locator('input[name="value"]').fill(value);
      await row.locator('button[data-action="send"]').click();
    };
    await replace(values.v2);
    await factsBecome(`gen 2 · ${values.v2.length} bytes · active`);

    // A stale generation: another writer (Node, sealed) replaced it.
    const catalog = await E(secrets).catalog();
    const entry = catalog.entries.find(
      (/** @type {any} */ e) => e.label === SECRET,
    );
    await E(writer).replace(entry.secret, sealTo(publicKey, values.stale), 2);
    await replace(values.v3);
    await panel.locator('.m4-error').waitFor();
    t.true(
      (await panel.locator('.m4-error').textContent()).includes(
        'GENERATION_CONFLICT',
      ),
      'a stale replace fails GENERATION_CONFLICT',
    );
    await factsBecome(`gen 3 · ${values.stale.length} bytes · active`);

    // Description.
    await row.locator('button[data-action="describe"]').click();
    await row.locator('input[name="description"]').fill('edited in a page');
    await row.locator('button[data-action="save"]').click();
    await waitFor(
      async () =>
        (await row.locator('.m4-secret-description').textContent()) ===
        'edited in a page',
      30_000,
      'the description',
      50,
    );
    mark('secretsBasic');

    // Size probe through the large-call writer: exactly the bound.
    const fitting = letters(subscriptionLimits.browserSecretBytes - 2);
    t.is(
      Buffer.byteLength(JSON.stringify(fitting)),
      subscriptionLimits.browserSecretBytes,
    );
    const over = letters(subscriptionLimits.browserSecretBytes - 1);
    const markers = [
      fitting.slice(500_000, 500_064),
      over.slice(500_000, 500_064),
    ];
    /** @param {string} value @param {string} name */
    const replaceFromFile = async (value, name) => {
      await row.locator('button[data-action="replace"]').click();
      await row.locator('input[name="file"]').setInputFiles({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from(value, 'latin1'),
      });
      await row.locator('button[data-action="send"]').click();
    };
    const sentBefore = sent.length;
    await replaceFromFile(fitting, 'fitting.txt');
    await factsBecome(`gen 4 · ${fitting.length} bytes · active`);
    t.is(fitting.length, 1_040_382);
    t.true(
      sent.slice(sentBefore).some(text => text.includes(markers[0])),
      'the value went over the page socket',
    );
    mark('sizeFits');

    // One letter more: refused in the page, nothing sent.
    const framesBefore = sent.length;
    await replaceFromFile(over, 'over.txt');
    await waitFor(
      async () =>
        (await panel
          .locator('.m4-error')
          .textContent()
          .catch(() => '')) === subscriptionTexts.secretTooLargeForBrowser,
      30_000,
      'the in-page refusal',
      50,
    );
    await new Promise(resolve => setTimeout(resolve, 1000));
    // The page keeps its live subscriptions going (accounts `next()`,
    // the session view), so other frames may pass in this second; none
    // carries the value and the panel called nothing.
    const during = sent.slice(framesBefore);
    t.false(
      during.some(text => text.includes(markers[1])),
      'no frame carries the refused value',
    );
    const called = during.map(methodOf).filter(name => name !== undefined);
    t.deepEqual(
      called.filter(name => secretsMethods.has(String(name))),
      [],
      `no Secrets call for the refused value (frames: ${JSON.stringify(called)})`,
    );
    t.is(
      await facts.textContent(),
      `gen 4 · ${fitting.length} bytes · active`,
      'the secret is unchanged',
    );
    mark('sizeRefused');

    // Audit of this secret.
    await row.locator('button[data-action="audit"]').click();
    const audit = panel.locator(`.m4-audit[data-audit="${SECRET}"]`);
    await audit.locator('.m4-audit-events li').first().waitFor();
    const lines = await audit.locator('.m4-audit-events li').allTextContents();
    t.true(
      lines.some(line => line.includes(`${SECRET} create succeeded`)),
      lines.join('\n'),
    );
    t.true(lines.some(line => line.includes(`${SECRET} replace succeeded`)));
    await audit.locator('button[data-action="close-audit"]').click();

    // Revoke, then delete after the revoke.
    await row.locator('button[data-action="revoke"]').click();
    await row.locator('button[data-action="confirm-revoke"]').click();
    await waitFor(
      async () => (await row.getAttribute('data-state')) === 'revoked',
      30_000,
      'revoked',
      50,
    );
    await row.locator('button[data-action="delete"]').click();
    await row.locator('button[data-action="confirm-delete"]').click();
    await waitFor(async () => (await row.count()) === 0, 30_000, 'deleted', 50);
    mark('secretsDone');

    // ---- rule 4a: unknown methods toward vat objects ----
    const slots = await page.evaluate(() =>
      /** @type {any} */ (globalThis).thixProbe.named(),
    );
    // Vat presences, as the page got them: the powers' `operator`
    // (harness vat), `getSecrets()` (manager vat: M4 `SecretsAdmin`) and
    // `getFactory()` (factory vat).
    const probes = [
      ['Operator', 'key:operator'],
      ['SecretsAdmin', 'returned:getSecrets'],
      ['SessionFactory', 'returned:getFactory'],
    ].map(([name, how], i) => ({
      name,
      slot: slots[how],
      id: `q-7700${i}`,
    }));
    for (const probe of probes) {
      t.truthy(
        probe.slot,
        `the page holds a ${probe.name}: ${JSON.stringify(slots)}`,
      );
      if (probe.slot !== undefined) {
        await page.evaluate(
          ([slot, id]) =>
            /** @type {any} */ (globalThis).thixProbe.call(
              slot,
              'noSuchMethodXD',
              id,
            ),
          [probe.slot, probe.id],
        );
      }
    }
    for (const probe of probes.filter(p => p.slot !== undefined)) {
      /** @type {any} */
      let answer;
      await waitFor(
        async () => {
          answer = await page.evaluate(
            id => /** @type {any} */ (globalThis).thixProbe.answer(id),
            probe.id,
          );
          return answer !== undefined;
        },
        10_000,
        `the answer to the ${probe.name} probe`,
        50,
      );
      t.is(
        JSON.parse(answer.exception?.body ?? '{}').message,
        gatewayTexts.unknownMethod,
        `${probe.name}: unknown method refused`,
      );
    }
    const probed = probes.filter(p => p.slot !== undefined).length;
    await waitFor(
      async () => gatewayLog.refused('method').length >= probed,
      10_000,
      'the refusals logged',
      100,
    );
    t.deepEqual(
      gatewayLog.refused().map(line => line.rule),
      Array(probed).fill('method'),
      'the probes are the only refused calls: every call of the page was admitted',
    );
    t.is(
      received.filter(text => text.includes(gatewayTexts.unknownMethod)).length,
      probed,
      'the page received unknown method only for the probes',
    );
    mark('rule4a');

    // ---- acceptance 15, browser part ----
    const credentials = [
      tokens.a,
      tokens.b,
      ...refreshTokens,
      ...TOKEN_PREFIXES,
    ];
    const typed = [values.v1, values.v2, values.stale, values.v3, ...markers];
    /** @type {string[]} */
    const hits = [];
    for (const needle of [...credentials, ...typed]) {
      if (requests.some(text => text.includes(needle)))
        hits.push(`request ${needle.slice(0, 12)}`);
      if (received.some(text => text.includes(needle)))
        hits.push(`received ${needle.slice(0, 12)}`);
      if (await domHas(page, needle)) hits.push(`dom ${needle.slice(0, 12)}`);
    }
    for (const needle of credentials) {
      if (sent.some(text => text.includes(needle)))
        hits.push(`sent ${needle.slice(0, 12)}`);
    }
    // The page's own storage (X-FIX): localStorage, sessionStorage and the
    // names of its IndexedDB databases (the UI keeps none).
    const stored = await page.evaluate(async () => {
      const idb = /** @type {any} */ (globalThis).indexedDB;
      const databases =
        typeof idb?.databases === 'function'
          ? (await idb.databases()).map((/** @type {any} */ db) => db.name)
          : [];
      return JSON.stringify({
        l: { ...localStorage },
        s: { ...sessionStorage },
        databases,
      });
    });
    t.is(typeof stored, 'string', 'the page storage was read');
    for (const needle of [...credentials, ...typed]) {
      if (stored.includes(needle)) hits.push(`storage ${needle.slice(0, 12)}`);
    }
    t.deepEqual(
      hits,
      [],
      'nothing in the network log, the DOM or the page storage',
    );
    t.true(requests.length > 0 && received.length > 0, 'the log saw traffic');

    // After a clean stop: nothing under the state directory.
    await state.stop();
    stopped = true;
    /** @type {string[]} */
    const stateHits = [];
    for (const needle of [...credentials, ...typed]) {
      for (const { file, encoding } of await grepState(state.root, needle))
        stateHits.push(
          `${file.slice(state.root.length)} (${encoding}) ${needle.slice(0, 12)}`,
        );
      if (state.stderrTail().includes(needle))
        stateHits.push(`stderr ${needle.slice(0, 12)}`);
    }
    t.deepEqual(stateHits, [], 'no credential, value or marker in the state');
    t.true(
      (await grepState(state.root, POOL)).length > 0,
      'the control text is found by the grep',
    );
    mark('grep');
    t.log(
      JSON.stringify({
        ms,
        frames: { sent: sent.length, received: received.length },
        served,
        refreshes: oauth.requests().filter(r => r.grant === 'refresh_token')
          .length,
      }),
    );
  } catch (error) {
    t.log(
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
    t.log(state.stderrTail().slice(-3000));
    throw error;
  } finally {
    if (stopped) {
      // The supervisor is down: the client and gateway close quietly.
    }
    await harness.close();
  }
});
