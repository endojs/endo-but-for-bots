// @ts-check
/**
 * M4 acceptance 6 and 13 through the daemon (W4.8; `designs/m4-interfaces.md`
 * 5.3, 5.4, 17), against the fake subscription server on 127.0.0.1, from
 * the `m4` template:
 *
 * 6. Catalogue through the pool `Backend` (manager vat, then the adapter's
 *    pool catalogue): `codex-pool` lists the R4-18 intersection of two
 *    members; `claude-pool` lists the R4-19 union with efforts and the
 *    configured context length (open decision 13); a pool whose members do
 *    not answer reads `unavailable`; a second listing within 15 min reads
 *    nothing (R4-104).
 * 13. Efforts: an unsupported effort is refused at creation, a supported
 *    one is stored and reaches the request (Claude adaptive thinking with
 *    `output_config.effort`; Codex `ultra` sent as `max`); an effort on a
 *    non-pool backend is refused; the R4-30 client header names are on
 *    every inference request; a turn with an attachment (M5's R4-29 line)
 *    sends the two-part system text (`[stored prompt, line]`) as one string
 *    joined with a blank line, to the Claude pool as the `system` text block
 *    after the billing block and to the Codex pool as `instructions` (XB,
 *    after the M5 merge).
 *
 *   corepack yarn test:integration test/integration/m4-catalog.test.js
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { subscriptionTexts } from '../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import { startFakeSubscriptionServer } from '../fixtures/fake-subscription-server.mjs';
import {
  CLAUDE_MODEL,
  CODEX_MODEL,
  credentialText,
  makePool,
  makeValueSecret,
  openSession,
  posts,
  runTurn,
  startM4,
  tokenOf,
} from './_m4.js';

takeIntegrationLock(test, 'm4 catalog test');

const run = integrationEnabled ? test.serial : test.skip;

run(
  'acceptance 6, 13: pool catalogue, cache, unavailable; efforts at creation and on the wire',
  async t => {
    t.timeout(4 * 60_000);
    const m4 = await startM4(t, 'catalog');
    const tokens = {
      a: tokenOf('a'),
      b: tokenOf('b'),
      ca: tokenOf('ca'),
      cb: tokenOf('cb'),
    };
    const tags = new Map(Object.entries(tokens).map(([k, v]) => [v, k]));
    const server = await startFakeSubscriptionServer({
      credentialTag: value => tags.get(value) ?? 'other',
      plan: [
        {
          match: {
            method: 'GET',
            path: '/backend-api/codex/models',
            credential: 'a',
          },
          file: 'codex-models.json',
          repeat: 50,
        },
        {
          match: {
            method: 'GET',
            path: '/backend-api/codex/models',
            credential: 'b',
          },
          file: 'codex-models-b.json',
          repeat: 50,
        },
        {
          match: { method: 'GET', path: '/v1/models', credential: 'ca' },
          file: 'claude-models.json',
          repeat: 50,
        },
        {
          match: { method: 'GET', path: '/v1/models', credential: 'cb' },
          file: 'claude-models-b.json',
          repeat: 50,
        },
      ],
    });
    t.teardown(() => server.close());
    /** @param {string} path */
    const reads = path =>
      server.requests().filter(r => r.method === 'GET' && r.path === path)
        .length;

    /**
     * @param {'claude' | 'codex'} provider
     * @param {string} tag
     */
    const member = async (provider, tag) => {
      const { secret } = await makeValueSecret(
        m4,
        `catalog ${tag}`,
        credentialText(provider, { accessToken: tokens[tag] }),
      );
      return { label: `member ${tag}`, credential: secret };
    };

    // ---- 6. codex-pool: the intersection ----
    const codex = await makePool(m4, {
      kind: 'codex-pool',
      label: 'Codex pool',
      members: [await member('codex', 'a'), await member('codex', 'b')],
      baseUrl: server.url,
    });
    const codexPage = await E(codex.backend).listModels();
    t.is(codexPage.state, 'ok');
    t.deepEqual(
      codexPage.rows.map((/** @type {any} */ r) => r.modelId),
      ['gpt-fake-1', 'gpt-fake-b-only', 'gpt-fake-mini'],
    );
    const shared = codexPage.rows.find(
      (/** @type {any} */ r) => r.modelId === CODEX_MODEL,
    );
    t.deepEqual(shared.reasoningEfforts, ['medium', 'high', 'max']);
    t.is(shared.contextLength, 200_000, 'the smaller window');
    t.is(reads('/backend-api/codex/models'), 2, 'one read per member');
    // R4-104: a second listing within 15 min reads nothing.
    await E(codex.backend).listModels();
    await E(codex.backend).resolveModel(CODEX_MODEL);
    t.is(reads('/backend-api/codex/models'), 2, 'served from the cache');

    // ---- 6. claude-pool: the union, the configured window ----
    const claude = await makePool(m4, {
      kind: 'claude-pool',
      label: 'Claude pool',
      members: [await member('claude', 'ca'), await member('claude', 'cb')],
      baseUrl: server.url,
      extra: { contextLength: 150_000 },
    });
    const claudePage = await E(claude.backend).listModels();
    t.deepEqual(
      claudePage.rows.map((/** @type {any} */ r) => r.modelId),
      [
        'claude-fake-1',
        'claude-haiku-5-5',
        'claude-opus-4-6',
        'claude-sonnet-5',
      ],
    );
    t.true(
      claudePage.rows.every(
        (/** @type {any} */ r) => r.contextLength === 150_000,
      ),
    );
    const sonnet = claudePage.rows.find(
      (/** @type {any} */ r) => r.modelId === CLAUDE_MODEL,
    );
    t.deepEqual(sonnet.reasoningEfforts, [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);

    // ---- 6. no member answers: unavailable ----
    const dead = await startFakeSubscriptionServer();
    const deadUrl = dead.url;
    await dead.close();
    const gone = await makePool(m4, {
      kind: 'claude-pool',
      label: 'Unreachable pool',
      members: [await member('claude', 'ca')].map(m => ({
        ...m,
        label: 'unreachable member',
      })),
      baseUrl: deadUrl,
    });
    const goneMember = gone.members[0];
    t.truthy(goneMember);
    const unavailable = await E(gone.backend).listModels();
    t.is(unavailable.state, 'unavailable');
    t.deepEqual(unavailable.rows, []);
    t.is(unavailable.error, texts.catalogUnavailable);

    // ---- 13. efforts at creation ----
    await t.throwsAsync(
      () =>
        openSession(m4, codex.backend, {
          modelId: 'gpt-fake-mini',
          reasoningEffort: 'high',
        }),
      { message: subscriptionTexts.unsupportedEffort },
    );
    const scripted = await m4.slice.makeBackend({ turns: [] });
    await t.throwsAsync(
      () => openSession(m4, scripted.backend, { reasoningEffort: 'high' }),
      { message: subscriptionTexts.effortNotSupported },
    );

    // Claude: the effort is sent as adaptive thinking.
    const withEffort = await openSession(m4, claude.backend, {
      modelId: CLAUDE_MODEL,
      reasoningEffort: 'high',
    });
    server.push({ sse: 'claude-text.sse' });
    const done = await runTurn(
      m4,
      withEffort.session,
      withEffort.live,
      'effort',
    );
    t.is(done.status.state, 'completed', done.status.error);
    const claudePost = /** @type {any} */ (posts(server).at(-1));
    t.deepEqual(claudePost.json.thinking, { type: 'adaptive' });
    t.deepEqual(claudePost.json.output_config, { effort: 'high' });
    for (const name of [
      'anthropic-beta',
      'x-app',
      'user-agent',
      'authorization',
    ])
      t.true(claudePost.headerNames.includes(name), `R4-30 header ${name}`);
    t.false(claudePost.headerNames.includes('x-api-key'));

    // Codex: `ultra` is sent as `max` (a one-member pool lists `ultra`).
    const solo = await makePool(m4, {
      kind: 'codex-pool',
      label: 'Codex solo',
      members: [await member('codex', 'a')].map(m => ({
        ...m,
        label: 'solo member',
      })),
      baseUrl: server.url,
    });
    const ultra = await openSession(m4, solo.backend, {
      modelId: CODEX_MODEL,
      reasoningEffort: 'ultra',
    });
    server.push({ sse: 'codex-text.sse' });
    const codexDone = await runTurn(m4, ultra.session, ultra.live, 'ultra');
    t.is(codexDone.status.state, 'completed', codexDone.status.error);
    const codexPost = /** @type {any} */ (posts(server).at(-1));
    t.is(codexPost.json.reasoning?.effort, 'max');
    t.is(codexPost.json.store, false);
    t.true(codexPost.headerNames.includes('authorization'));

    // ---- 13. two-part system text (M5's systemTextOf, after the merge) ----
    // A turn with an attachment carries `[stored prompt, R4-29 line]`; the
    // pool provider joins it once per round with a blank line and both
    // wires send one string. The line names the session's first package.
    const line = textOf.mentionLine(1, ['notes']);
    const attachments = [{ label: 'notes', value: scripted.backend }];
    const claudeSystem = /** @type {any[]} */ (claudePost.json.system);
    t.is(claudeSystem.length, 2, 'the billing block, then the system text');
    const storedClaude = claudeSystem[1].text;
    t.true(
      typeof storedClaude === 'string' && storedClaude.length > 0,
      'the stored prompt reaches the Claude pool',
    );
    server.push({ sse: 'claude-text.sse' });
    const claudeMention = await runTurn(
      m4,
      withEffort.session,
      withEffort.live,
      'mention',
      60_000,
      { attachments },
    );
    t.is(claudeMention.status.state, 'completed', claudeMention.status.error);
    const claudeTwo = /** @type {any} */ (posts(server).at(-1)).json.system;
    t.is(claudeTwo.length, 2, 'still one system text block after billing');
    t.deepEqual(claudeTwo[0], claudeSystem[0], 'the billing block unchanged');
    t.is(claudeTwo[1].text, `${storedClaude}\n\n${line}`);

    const storedCodex = codexPost.json.instructions;
    t.true(
      typeof storedCodex === 'string' && storedCodex.length > 0,
      'the stored prompt reaches the Codex pool',
    );
    server.push({ sse: 'codex-text.sse' });
    const codexMention = await runTurn(
      m4,
      ultra.session,
      ultra.live,
      'mention',
      60_000,
      { attachments },
    );
    t.is(codexMention.status.state, 'completed', codexMention.status.error);
    const codexTwo = /** @type {any} */ (posts(server).at(-1)).json;
    t.is(codexTwo.instructions, `${storedCodex}\n\n${line}`);

    // The next turn without an attachment sends the stored prompt alone.
    server.push({ sse: 'claude-text.sse' });
    const plain = await runTurn(
      m4,
      withEffort.session,
      withEffort.live,
      'plain',
    );
    t.is(plain.status.state, 'completed', plain.status.error);
    t.is(
      /** @type {any} */ (posts(server).at(-1)).json.system[1].text,
      storedClaude,
    );
  },
);
