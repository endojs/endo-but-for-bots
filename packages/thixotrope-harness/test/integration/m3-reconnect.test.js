// @ts-check
/* eslint-disable no-await-in-loop -- each step waits for the previous one */
/**
 * M3 acceptance 4-7, protocol parts, and kill points K3-K5
 * (designs/m3-interfaces.md 7, 9.2, 12; W3.8) through the gateway: every
 * page is a Node CapTP client over a real loopback WebSocket
 * (`_m3-gateway.js`) doing what the UI controller does after a connection
 * (`watch`, `subscribe(session, rev)`, `getCurrentTurn`, history pages).
 * The browser parts are `test/browser/m3-ui.test.mjs`.
 *
 * 4. A dropped socket: a new connection re-attaches the running turn
 *    (`getCurrentTurn` answers it; `subscribe` from the watched rev keeps
 *    streaming to its end). The gateway down (daemon stopped): connections
 *    are refused; after the restart a page connects on the same port.
 * 5. A page closed mid-turn: the turn finishes on the server and is in the
 *    transcript when another page opens.
 * 6. K3, K4: SIGKILL while a large submission is in flight (before the
 *    enqueue crank, and after its answer was produced but never used);
 *    after the restart the page checks `getSubmissionReceipt(requestId)`
 *    and resends only if there is none: the transcript holds the text once.
 * 7. K5: SIGKILL mid-stream with two pages watching: after the restart
 *    both see the turn `interrupted` or `outcome-unknown`, `resolve` works
 *    and is seen by both, and the provider saw one request for the turn.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/m3-reconnect.test.js
 */
import '../unit/_m1a-prelude.js';

import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

import { emit } from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import {
  collect,
  makeSlice,
  requestId,
  sliceTemplate,
  waitFor,
} from './_m1a-slice.js';
import {
  connectGateway,
  freePort,
  serveGateway,
  useTestWrappingKey,
} from './_m3-gateway.js';

takeIntegrationLock(test, 'm3 reconnect test');

const run = integrationEnabled ? test.serial : test.skip;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** Inputs of the reconnect script. */
const inputs = Object.freeze({
  stream: 'stream',
  stall: 'stall',
  toolHang: 'tool hang',
});

/**
 * 40 chunks 150 ms apart (about 6 s of streaming); a stall; a streamed
 * round whose echo call hangs for 10 minutes (killed inside it: an
 * outcome-unknown turn); else `ok`.
 */
export const reconnectScript = harden({
  turns: [
    {
      input: inputs.stream,
      rounds: [
        {
          chunks: Array.from({ length: 40 }, (_, i) => ({ text: `c${i} ` })),
          chunkDelayMs: 150,
          usage,
        },
      ],
    },
    {
      input: inputs.stall,
      rounds: [{ chunks: [{ text: 'stalling' }], stall: 'untilCancel' }],
    },
    {
      input: inputs.toolHang,
      rounds: [
        {
          chunks: [{ text: 'calling ' }, { text: 'echo' }],
          chunkDelayMs: 100,
          toolCalls: [
            {
              name: 'echo',
              args: JSON.stringify({ text: 'slow', delayMs: 600_000 }),
            },
          ],
          usage,
        },
        { chunks: [{ text: 'done' }], usage },
      ],
    },
    { rounds: [{ chunks: [{ text: 'ok' }], usage }] },
  ],
});

/** @type {Awaited<ReturnType<typeof startFromTemplate>> | undefined} */
let state;
/** @type {(() => void) | undefined} */
let removeKey;
test.after.always(async () => {
  await state?.cleanup();
  removeKey?.();
});

/** @type {Awaited<ReturnType<typeof serveGateway>>} */
let gateway;
/** @type {{ log: () => any[] }} */
let made;

/**
 * A page: one signed-in connection and its factory.
 */
const openPage = async () => {
  const client = await gateway.connect();
  const factory = await E(client.powers.operator).getFactory();
  return { client, powers: client.powers, factory };
};

/**
 * The page's own presence of a session (by its row key, F.2 d).
 * @param {{ factory: any }} page
 * @param {string} key
 */
const sessionOf = (page, key) => E(page.factory).findSession(key);

/**
 * What the controller does for the active session after a connection:
 * `watch()`, `subscribe(session, rev)`, `getCurrentTurn()`.
 * @param {{ powers: any }} page
 * @param {any} session
 */
const attach = async (page, session) => {
  const snapshot = await E(session).watch();
  const feed = collect(
    await E(page.powers.live).subscribe(session, snapshot.rev),
  );
  const current = await E(session).getCurrentTurn();
  return { snapshot, feed, current };
};

/**
 * Every turn preview of a session, newest page first, walked to the start.
 * @param {any} session
 */
const allTurns = async session => {
  /** @type {any[]} */
  const turns = [];
  let page = await E(session).getHistoryPage();
  for (;;) {
    turns.push(...page.turns);
    if (page.next === undefined || page.archived) break;
    page = await E(session).getHistoryPage(page.next);
  }
  return turns;
};

/** @param {any} input a TurnStarted input: text or staged */
const inputText = input =>
  typeof input === 'string' ? input : String(input?.preview ?? '');

/**
 * Turns plus queued entries whose input starts with `marker`.
 * @param {any} session
 * @param {string} marker
 */
const countSubmissions = async (session, marker) => {
  const turns = (await allTurns(session)).filter(tp =>
    inputText(tp.records[0]?.input).startsWith(marker),
  );
  const pending = await E(session).listPending();
  const queued = pending.entries.filter((/** @type {any} */ row) =>
    row.preview.startsWith(marker),
  );
  return turns.length + queued.length;
};

/** Requests the provider logged for a turn. @param {string} turnId */
const requestsFor = turnId =>
  made.log().filter(l => l.kind === 'request' && l.turnId === turnId).length;

/** Echo runs the provider logged for a turn. @param {string} turnId */
const echoStarts = turnId =>
  made
    .log()
    .filter(
      l => l.kind === 'echo-start' && String(l.opId).startsWith(`${turnId}/`),
    ).length;

run(
  'setup: served state, scripted backend, gateway on a fixed port',
  async t => {
    removeKey = useTestWrappingKey('m3rc').remove;
    state = await startFromTemplate(await sliceTemplate());
    const slice = await makeSlice(state);
    made = await slice.makeBackend(reconnectScript);
    await E(slice.harness).configure(harden({ backends: [made.backend] }));
    gateway = await serveGateway(state, { port: await freePort() });
    t.is(gateway.status.state, 'serving');
  },
);

run(
  'acceptance 4 and 5 (protocol): re-attach after a dropped socket; a closed page leaves the turn running',
  async t => {
    const a = await openPage();
    const [preset] = await E(a.factory).listPresets();
    const [backend] = await E(a.factory).listBackends();
    const session = await E(a.factory).createSession(
      harden({ title: 'reconnect', preset, backend, at: Date.now() }),
    );
    const { key } = await E(session).getInfo();
    const first = await attach(a, session);
    const receipt = await E(a.powers.composer).submit(
      session,
      inputs.stream,
      requestId(),
    );
    const { turnId } = await E(receipt.turn).getStatus();
    await first.feed.until(e => e.type === 'delta' && e.turnId === turnId);

    // 4. Drop the socket; a new connection re-attaches.
    a.client.close();
    const closed = await a.client.closed;
    t.log(`socket closed ${closed.code}`);
    const t0 = Date.now();
    const b = await openPage();
    const bSession = await sessionOf(b, key);
    const again = await attach(b, bSession);
    const reattachMs = Date.now() - t0;
    t.truthy(again.current, 'getCurrentTurn answers the running turn');
    const status = await E(again.current.turn).getStatus();
    t.is(status.turnId, turnId);
    t.true(['running', 'cancelling'].includes(status.state));
    const end = await again.feed.until(
      e => (e.type === 'end' || e.type === 'abort') && e.turnId === turnId,
      60_000,
    );
    t.is(again.feed.events()[end].type, 'end');
    t.true(
      again.feed.events().some(e => e.type === 'delta' && e.turnId === turnId),
      'the re-attached page kept receiving deltas',
    );
    emit({ metric: 'm3.reconnect.reattach', unit: 'ms', value: reattachMs });
    await again.feed.stop();

    // 5. Close the page mid-turn; another page later sees it finished.
    const c = await openPage();
    const cSession = await sessionOf(c, key);
    const r2 = await E(c.powers.composer).submit(
      cSession,
      inputs.stream,
      requestId(),
    );
    const { turnId: second } = await E(r2.turn).getStatus();
    c.client.close();
    await c.client.closed;
    const d = await openPage();
    const dSession = await sessionOf(d, key);
    const settled = await waitFor(
      async () => {
        const turns = await allTurns(dSession);
        const tp = turns.find(x => x.turnId === second);
        return tp && tp.state === 'completed' ? tp : undefined;
      },
      60_000,
      'the closed page turn completed',
      200,
    );
    t.is(settled.state, 'completed', 'closing the page cancelled nothing');
    t.is(requestsFor(second), 1);
    b.client.close();
    d.client.close();
  },
);

run(
  'acceptance 4 (protocol): refused while the daemon is down, served again on the same port',
  async t => {
    if (!state) throw Error('setup failed');
    await state.stop();
    await t.throwsAsync(
      connectGateway({ port: gateway.port, origin: gateway.origin }),
      undefined,
      'nothing listens while the daemon is stopped',
    );
    const t0 = Date.now();
    await state.restart();
    const ready = await waitFor(
      async () => {
        try {
          const client = await connectGateway({
            port: gateway.port,
            origin: gateway.origin,
            secret: gateway.secret,
          });
          const powers = await client.signIn();
          return { client, powers };
        } catch {
          return undefined;
        }
      },
      60_000,
      'the gateway after restart',
      100,
    );
    emit({
      metric: 'm3.reconnect.afterRestart',
      unit: 'ms',
      value: Date.now() - t0,
    });
    t.truthy(ready.powers.operator, 'the same secret signs in');
    ready.client.close();
  },
);

run(
  'acceptance 6, K3 and K4: a submission lost to a SIGKILL is resent once',
  async t => {
    if (!state) throw Error('setup failed');
    const page = await openPage();
    const [preset] = await E(page.factory).listPresets();
    const [backend] = await E(page.factory).listBackends();
    const session = await E(page.factory).createSession(
      harden({ title: 'k3k4', preset, backend, at: Date.now() }),
    );
    const { key } = await E(session).getInfo();
    page.client.close();
    /** @type {Record<string, unknown>[]} */
    const outcomes = [];
    // 0 ms: before the staging finished (K3); 'answer': the answer was
    // produced and never used by the page (K4); 60 ms in between.
    for (const when of [0, 60, 'answer']) {
      const p = await openPage();
      const s = await sessionOf(p, key);
      const marker = `k-${when}-${Date.now()} `;
      const text = `${marker}${'z'.repeat(120_000)}`; // staged: over inlineBytes
      const id = requestId();
      const sent = E(p.powers.composer).submit(s, text, id);
      sent.catch(() => {});
      if (when === 'answer') await sent;
      else await delay(/** @type {number} */ (when));
      await state.kill();
      await state.restart();
      // The page's resend rule (9.2): only when no receipt exists.
      const p2 = await waitFor(
        () => openPage().catch(() => undefined),
        60_000,
        'a page after restart',
        100,
      );
      const s2 = await sessionOf(p2, key);
      const before = await E(s2).getSubmissionReceipt(id);
      if (before === undefined)
        await E(p2.powers.composer).submit(s2, text, id);
      else {
        // A duplicate resend must answer the same receipt.
        const dup = await E(p2.powers.composer).submit(s2, text, id);
        t.true(dup.duplicate);
      }
      const count = await waitFor(
        async () => {
          const turns = await allTurns(s2);
          const busy = turns.some(
            tp => tp.state === 'running' || tp.state === 'cancelling',
          );
          const n = Number(await countSubmissions(s2, marker));
          return !busy && n > 0 ? n : 0;
        },
        60_000,
        'the submission settled',
        200,
      );
      t.is(count, 1, `submission ${when}: exactly once`);
      outcomes.push({ when, receiptBeforeResend: before !== undefined });
      p2.client.close();
    }
    t.log(JSON.stringify(outcomes));
    emit({ metric: 'm3.reconnect.k3k4', outcomes });
  },
);

run(
  'acceptance 7, K5: SIGKILL mid-stream with two pages; recovery seen by both',
  async t => {
    if (!state) throw Error('setup failed');
    const a = await openPage();
    const b = await openPage();
    const [preset] = await E(a.factory).listPresets();
    const [backend] = await E(a.factory).listBackends();
    const session = await E(a.factory).createSession(
      harden({ title: 'k5', preset, backend, at: Date.now() }),
    );
    const { key } = await E(session).getInfo();
    const feedA = await attach(a, session);
    const feedB = await attach(b, await sessionOf(b, key));
    const receipt = await E(a.powers.composer).submit(
      session,
      inputs.toolHang,
      requestId(),
    );
    const { turnId } = await E(receipt.turn).getStatus();
    await feedA.feed.until(e => e.type === 'delta' && e.turnId === turnId);
    await feedB.feed.until(e => e.type === 'delta' && e.turnId === turnId);
    await waitFor(
      () => echoStarts(turnId) > 0,
      30_000,
      'the echo call running',
      50,
    );
    await state.kill();
    await state.restart();
    const pages = await Promise.all(
      [0, 1].map(() =>
        waitFor(() => openPage().catch(() => undefined), 60_000, 'a page', 100),
      ),
    );
    /** @type {string[]} */
    const seen = [];
    for (const page of pages) {
      const s = await sessionOf(page, key);
      const tp = await waitFor(
        async () =>
          (await allTurns(s)).find(
            x =>
              x.turnId === turnId &&
              (x.state === 'interrupted' || x.state === 'outcome-unknown'),
          ),
        60_000,
        'the recovered status',
        200,
      );
      seen.push(tp.state);
    }
    t.is(seen[0], seen[1], 'both pages show the same recovered state');
    t.is(seen[0], 'outcome-unknown', 'killed inside a tool call');
    t.is(requestsFor(turnId), 1, 'no provider request twice');
    t.is(echoStarts(turnId), 1, 'no tool run twice');

    // Record acknowledgement while idle (R6-51), seen by the other page.
    const s0 = await sessionOf(pages[0], key);
    const turn = await E(s0).findTurn(turnId);
    await E(turn).resolve('acknowledged in test');
    const s1 = await sessionOf(pages[1], key);
    const resolved = await waitFor(
      async () => {
        const status = await E(await E(s1).findTurn(turnId)).getStatus();
        return status.resolution ? status : undefined;
      },
      10_000,
      'the resolution on the other page',
      100,
    );
    t.truthy(resolved.resolution);
    emit({ metric: 'm3.reconnect.k5', state: seen[0], requests: 1 });
    for (const page of pages) page.client.close();
  },
);
