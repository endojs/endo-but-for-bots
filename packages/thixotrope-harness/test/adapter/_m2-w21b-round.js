// @ts-check
// M2 W2.1b test helper: one provider round through the Endpoint against the
// fake provider server (127.0.0.1, D-M2-4), with a guarded fake TurnSink
// (the folded guards check every message as the session vat would), the
// session's channel and real blob files under H/tmp. Shared by
// m2-w21b-anthropic.test.js and m2-w21b-retry.test.js; the same shape as
// W2.1a's runRound in m2-w21a-openrouter.test.js, for any API provider.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable import/no-relative-packages */
import { interfaces } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { makeEndpoint } from '../../resources/agent-host/impl/endpoint.js';
import { makeTimers } from '../../resources/agent-host/impl/timers.js';
import { makeChannelRegistry } from '../../resources/agent-host/impl/channels.js';
import { BODY_MARKER } from '../fixtures/fake-provider-server.mjs';
import { makeTestBlobs } from './_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makeExo } = /** @type {GuestGlobals} */ (globalThis);

export const timers = makeTimers();
/** A placeholder key (never a real credential). */
export const KEY = 'not a real key';
const harnessTmp = new URL('../../tmp/', import.meta.url).pathname;

/**
 * @param {() => boolean} predicate
 * @param {number} [ms]
 */
export const until = async (predicate, ms = 5000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw Error('timed out waiting');
    // eslint-disable-next-line no-await-in-loop
    await timers.delay(2);
  }
};

const makeFakeTurn = ({ dispatch = true } = {}) => {
  /** @type {any[]} */
  const finals = [];
  /** @type {any[]} */
  const failures = [];
  /** @type {any[]} */
  const progress = [];
  const turn = makeExo('Turn', interfaces.Turn, {
    getStatus: () =>
      harden({ turnId: 't1', state: 'running', round: 0, at: 0 }),
    cancel: () => undefined,
    whenFinished: async () =>
      harden({ turnId: 't1', state: 'running', round: 0, at: 0 }),
    resolve: () => undefined,
    getContent: () => harden({ records: [] }),
  });
  const sink = makeExo('TurnSink', interfaces.TurnSink, {
    dispatching: () => dispatch,
    roundFinal: (/** @type {any} */ r) => {
      finals.push(r);
    },
    roundFailed: (/** @type {any} */ f) => {
      failures.push(f);
    },
    deadline: () => undefined,
    progress: (/** @type {any} */ p) => {
      progress.push(p);
      return true;
    },
    // WX.1: the context window's method; nothing here asks to compact.
    compacted: () => harden({ go: false }),
  });
  return { turn, sink, finals, failures, progress };
};

/**
 * A fresh blob directory under H/tmp (rule 6). `mkdtemp`, not a pid and a
 * counter: AVA runs test files in worker threads of one process, so two
 * files importing this helper would share `<pid>-1` and remove each
 * other's files.
 */
const testBlobs = () => {
  mkdirSync(harnessTmp, { recursive: true });
  return makeTestBlobs({ dir: mkdtempSync(join(harnessTmp, 'w21b-')) });
};

/**
 * Run one round of `makeProvider` through the Endpoint.
 * @param {(options: any) => any} makeProvider
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.modelId
 * @param {any[]} [options.transcript]
 * @param {any[]} [options.tools]
 * @param {Record<string, unknown>} [options.spec]
 * @param {Record<string, unknown>} [options.requestOptions]
 * @param {() => Promise<string>} [options.readKey]
 * @param {any} [options.system]
 * @param {boolean} [options.wait]
 * @param {number} [options.waitMs]
 * @param {any} [options.retry]
 * @param {string} [options.unexpectedFailure] the backend kind's fixed
 *   reason for a round whose provider threw (the Endpoint's option)
 */
export const runApiRound = async (
  makeProvider,
  {
    baseUrl,
    modelId,
    transcript = [{ kind: 'message', role: 'user', content: 'hi' }],
    tools = [],
    spec = {},
    requestOptions = {},
    readKey = async () => KEY,
    system,
    wait = true,
    waitMs = 5000,
    retry,
    unexpectedFailure = 'api round test: the provider threw',
  },
) => {
  const blobs = testBlobs();
  /** @type {any[]} */
  const log = [];
  const provider = makeProvider({
    label: 'api-test',
    spec: { baseUrl, ...spec },
    readKey,
    timers,
    log: (/** @type {string} */ kind, fields = {}) =>
      log.push({ kind, ...fields }),
    blobs: blobs.store,
    ...(retry === undefined ? {} : { retry }),
  });
  const channels = makeChannelRegistry();
  const owner = Far('Session', {});
  const channel = channels.channelFor(owner);
  const subscription = channel.subscribe();
  const endpoint = makeEndpoint({
    provider,
    channel,
    timers,
    prepare: async () => harden({ transcript }),
    owner,
    unexpectedFailure,
  });
  const fake = makeFakeTurn();
  void E(endpoint).holdTurn(fake.turn);
  const startedAt = Date.now();
  E.sendOnly(endpoint).startRound(
    harden({
      turn: fake.turn,
      sink: fake.sink,
      turnId: 't1',
      round: 0,
      base: { count: 0, epoch: 0 },
      append: [{ kind: 'turn-started', turnId: 't1', input: 'hi', at: 1 }],
      tools,
      options: { modelId, ...requestOptions },
      ...(system === undefined ? {} : { system }),
    }),
  );
  const settled = () => fake.finals.length + fake.failures.length > 0;
  if (wait) await until(settled, waitMs);
  const settledAt = Date.now();
  /** Deltas a subscriber received (drains what is queued). */
  const deltas = async () => {
    /** @type {string[]} */
    const out = [];
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await Promise.race([
        E(subscription).next(),
        timers.delay(50).then(() => undefined),
      ]);
      if (batch === undefined) return out;
      for (const delivery of batch.deliveries) {
        if (delivery.event.type === 'delta') out.push(delivery.event.text);
      }
      if (batch.closed) return out;
    }
  };
  return {
    ...fake,
    log,
    blobs,
    endpoint,
    deltas,
    settled,
    elapsedMs: settledAt - startedAt,
    cleanup: () => blobs.cleanup(),
  };
};

/**
 * Nothing a round recorded carries a provider body or the key.
 * @param {import('ava').ExecutionContext} t
 * @param {any} r
 */
export const noBodyOrKey = (t, r) => {
  const seen = JSON.stringify([r.finals, r.failures, r.progress, r.log]);
  t.false(seen.includes(BODY_MARKER), 'no provider body');
  t.false(seen.includes(KEY), 'no key');
};
