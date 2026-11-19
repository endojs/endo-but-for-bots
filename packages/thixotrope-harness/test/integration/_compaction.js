// @ts-check
/**
 * Helpers of the compaction integration files (`compaction.test.js`,
 * `compaction-restart.test.js`; `designs/m8-interfaces.md` 12) and the
 * compaction perf check: one served state from the m1a template with the
 * fake provider server on 127.0.0.1, a Secret read by an Anthropic API
 * backend (the catalogue answers the 200,000-token window, D-M8-12), turns
 * run through the Composer and awaited on the live channel, the records of
 * a turn, and the fake server's view of each request (a summary call or a
 * model round, and what its first message is).
 *
 * The provider key is a short placeholder, never a credential; the Secrets
 * wrapping key file lives under H/tmp and is removed with the state.
 */
/* eslint-disable no-await-in-loop -- pages and turns run in order */
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { E } from '@endo/far';

import { summaryInstruction } from '../../resources/agent-host/impl/providers/compaction.js';
import {
  anthropicEvents,
  startFakeProviderServer,
} from '../fixtures/fake-provider-server.mjs';
import { shortName, startFromTemplate, tmpRoot } from '../template/index.js';
import { makeSlice, requestId, sliceTemplate, waitFor } from './_m1a-slice.js';
import { replaceSealed } from './_m2-secrets.js';

/** The Anthropic model of the fake catalogue (no context length listed). */
export const ANTHROPIC_MODEL = 'claude-haiku-4-5';

/** The window the Anthropic catalogue gives a row without one (D-M8-12). */
export const ANTHROPIC_WINDOW = 200_000;

/** Input tokens over 70 % of the Anthropic window. */
export const OVER_THRESHOLD = 150_000;

/**
 * A served state with the fake provider server and an Anthropic backend
 * whose key is a Secret's read grant. `cleanup()` stops the state and the
 * server and removes the key file (a file's `test.after.always`).
 * @param {{ template?: typeof sliceTemplate, snapshotEveryDeliveries?: number, idleSleepMs?: number }} [options]
 */
export const openCompactionState = async ({
  template: getTemplate = sliceTemplate,
  snapshotEveryDeliveries,
  idleSleepMs,
} = {}) => {
  const keyDir = path.join(tmpRoot, `${shortName('k')}`);
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const server = await startFakeProviderServer({
    plan: [
      {
        match: { method: 'GET', path: '/v1/models' },
        file: 'anthropic-models.json',
        repeat: 1000,
      },
    ],
  });
  const template = await getTemplate();
  const state = await startFromTemplate(template, {
    secretsKeyFile: path.join(keyDir, 'secrets.key'),
    snapshotEveryDeliveries,
    idleSleepMs,
  });
  const slice = await makeSlice(state);
  const secrets = await E(slice.admin).getSecrets();
  const secret = await E(secrets).create(
    harden({ label: 'provider key', description: 'fake server key' }),
  );
  const writer = await E(secrets).openWriter();
  await replaceSealed(writer, secret, ['not', 'a', 'key'].join(' '));
  const keyGrant = await E(secret).makeReadGrant();
  const anthropic = await E(slice.admin).makeBackend(
    harden({
      kind: 'anthropic',
      label: 'Anthropic',
      keyGrant,
      modelId: ANTHROPIC_MODEL,
      baseUrl: server.anthropicBaseUrl,
    }),
  );
  const cleanup = async () => {
    await state.cleanup?.();
    await server.close();
    rmSync(keyDir, { recursive: true, force: true });
  };
  return { state, slice, server, anthropic, cleanup };
};

/**
 * A session on the Anthropic backend, with its live subscription.
 * @param {any} slice
 * @param {any} backend
 * @param {string} [title]
 */
export const anthropicSession = async (
  slice,
  backend,
  title = 'compaction',
) => {
  const session = await E(slice.factory).createSession(
    harden({
      title,
      preset: slice.chatOnly,
      backend,
      modelId: ANTHROPIC_MODEL,
      at: Date.now(),
    }),
  );
  return { session, live: await slice.subscribe(session) };
};

/**
 * A plan entry: one streamed Anthropic reply.
 * @param {string} text
 * @param {{ input?: number, output?: number }} [tokens]
 */
export const reply = (text, { input = 1000, output = 50 } = {}) => ({
  events: anthropicEvents({
    deltas: text.length > 4000 ? (text.match(/[^]{1,4000}/g) ?? []) : [text],
    usage: { input_tokens: input, output_tokens: output },
  }),
});

/**
 * Text of `bytes` ASCII characters, distinct per `tag`.
 * @param {string} tag
 * @param {number} bytes
 */
export const filler = (tag, bytes) =>
  `${tag}: ${'lorem ipsum dolor sit amet '.repeat(Math.ceil(bytes / 27))}`.slice(
    0,
    bytes,
  );

/**
 * Submit through the Composer and wait for the turn's `end` or `abort` on
 * the live channel (or only its `turn-start` with `settle: false`).
 * @param {any} slice
 * @param {any} session
 * @param {any} live
 * @param {string} input
 * @param {{ settle?: boolean, ms?: number }} [options]
 */
export const runTurn = async (
  slice,
  session,
  live,
  input,
  { settle = true, ms = 60_000 } = {},
) => {
  const from = /** @type {number} */ (live.deliveries.length);
  const receipt = await E(slice.composer).submit(session, input, requestId());
  const turn = await waitFor(
    async () =>
      receipt.turn ??
      (await E(session).getSubmissionReceipt(receipt.requestId))?.turn,
    30_000,
    `the turn of ${input}`,
  );
  const { turnId } = await E(turn).getStatus();
  const events = () =>
    live.deliveries
      .slice(from)
      .map((/** @type {any} */ d) => d.event)
      .filter((/** @type {any} */ e) => e.turnId === turnId);
  if (settle) {
    await waitFor(
      () => events().some(e => e.type === 'end' || e.type === 'abort'),
      ms,
      `the end of ${input}`,
      10,
    );
  }
  return { turn, turnId, events };
};

/**
 * Every record of one turn (`Turn.getContent` pages).
 * @param {any} turn
 * @returns {Promise<any[]>}
 */
export const contentOf = async turn => {
  /** @type {any[]} */
  const out = [];
  /** @type {string | undefined} */
  let cursor;
  for (;;) {
    const page = await E(turn).getContent(cursor);
    out.push(...page.records);
    if (page.next === undefined) return out;
    cursor = page.next;
  }
};

/**
 * The record kinds of one turn.
 * @param {any} turn
 */
export const kindsOf = async turn =>
  (await contentOf(turn)).map((/** @type {any} */ r) => r.kind);

/**
 * The fake server's model requests (`POST /v1/messages`) from index
 * `from`, each as: `summary` (its first message starts with the R4-36
 * instruction), `tools` (the count it offered), the first message's role
 * and text, and the parsed body.
 * @param {any} server
 * @param {number} [from]
 */
export const modelRequests = (server, from = 0) =>
  server
    .requests()
    .filter(
      (/** @type {any} */ r) =>
        r.method === 'POST' && r.path === '/v1/messages',
    )
    .slice(from)
    .map((/** @type {any} */ r) => {
      const first = r.json?.messages?.[0];
      const content = first?.content;
      const text =
        typeof content === 'string'
          ? content
          : (content ?? [])
              .filter((/** @type {any} */ c) => c.type === 'text')
              .map((/** @type {any} */ c) => c.text)
              .join('');
      return {
        summary: text.startsWith(summaryInstruction),
        tools: (r.json?.tools ?? []).length,
        role: first?.role,
        text,
        messages: r.json?.messages ?? [],
        closed: r.closed,
        json: r.json,
      };
    });

/**
 * The count of model requests so far.
 * @param {any} server
 */
export const modelRequestCount = server => modelRequests(server).length;

/**
 * Kill the supervisor (SIGKILL), serve the same copy again, and find the
 * session by key in the new client.
 * @param {any} state
 * @param {any} slice
 * @param {string} key
 */
export const killAndRestart = async (state, slice, key) => {
  await state.kill();
  await state.restart();
  await slice.refresh();
  const session = await E(slice.factory).findSession(key);
  return { session, live: await slice.subscribe(session) };
};

/**
 * Wait until the history page shows the turn in `state`.
 * @param {any} session
 * @param {string} turnId
 * @param {string} state
 * @param {number} [ms]
 */
export const untilTurnState = (session, turnId, state, ms = 90_000) =>
  waitFor(
    async () => {
      const page = await E(session).getHistoryPage();
      const found = page.turns.find(
        (/** @type {any} */ p) => p.turnId === turnId,
      );
      return found?.state === state ? found : undefined;
    },
    ms,
    `turn ${turnId} ${state}`,
    250,
  );
