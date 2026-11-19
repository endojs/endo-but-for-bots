// @ts-check
// Test helper for W2.4 (queue and submissions): the real session
// (guest/session/session.js) over in-memory fakes of the Backend, Endpoint,
// publisher, host facet and row reporter, as m1a-session-turn.test.js has
// them, cut to what the queue tests need. Import after `_m1a-prelude.js`.
// The adapter has incarnations: `restartAdapter()` kills the current one
// and breaks every pending lease with the retired text, as a restart does.

/* eslint-disable import/no-relative-packages */
import { RETIRED_TEXT } from '../../guest/lib/retired.js';
import { makeSession } from '../../guest/session/session.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/** Let every pending microtask and eventual send run. */
export const drain = () => new Promise(resolve => setImmediate(resolve));

export const AT = 1_700_000_000_000;

let serial = 0;
/**
 * A fresh A.4 request id issued at `at`.
 * @param {number} [at]
 */
export const requestId = (at = AT) => {
  serial += 1;
  return `${at}-00000000-0000-4000-8000-${`${serial}`.padStart(12, '0')}`;
};

const usage = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/**
 * @param {object} [options]
 * @param {readonly any[]} [options.parts] runtime parts
 * @param {(options: any) => any} [options.makeQueue]
 */
export const makeQueueSession = async ({ parts, makeQueue } = {}) => {
  /** @type {any[]} */
  const rounds = [];
  /** @type {any[]} */
  const leases = [];
  /** @type {any[]} */
  const published = [];
  let since = AT - 60_000;

  const makeIncarnation = () => {
    const state = { dead: false };
    const publisher = Far('LivePublisher', {
      publish: (/** @type {any} */ batch) => {
        if (state.dead) throw Error(`ocapn hub: ${RETIRED_TEXT}`);
        published.push(batch);
      },
    });
    const endpoint = Far('Endpoint', {
      holdTurn: () => {
        if (state.dead) return Promise.reject(Error(`hub: ${RETIRED_TEXT}`));
        const kit = makePromiseKit();
        leases.push(kit);
        return kit.promise;
      },
      releaseTurn: () => {},
      startRound: (/** @type {any} */ req) => {
        if (!state.dead) rounds.push(req);
      },
      cancelRound: () => {},
      armDeadline: () => {},
      disarm: () => {},
    });
    const ports = harden({ endpoint, publisher, tools: harden([]), since });
    return { state, ports };
  };
  let incarnation = makeIncarnation();

  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => incarnation.ports,
  });
  const outside = Far('LivePublisher', {
    publish: (/** @type {any} */ batch) => published.push(batch),
  });
  const host = Far('SessionHostFacet', { liveChannel: () => outside });
  const rowReporter = Far('RowReporter', { changed: () => {} });
  const config = harden({
    key: 's1',
    title: 'queue test',
    backendTitle: 'fake',
    modelId: 'scripted',
    preset: harden({ label: 'chat-only' }),
    createdAt: AT,
    userInitiated: true,
  });
  const { session, internal } = makeSession(
    { config, services: { backend, host }, rowReporter },
    harden({
      ...(parts === undefined ? {} : { parts }),
      ...(makeQueue === undefined ? {} : { makeQueue }),
    }),
  );
  await drain();

  /** Inputs of the turns the provider was asked to start, in order. */
  const sent = () =>
    rounds
      .filter(req => req.round === 0)
      .map(req => {
        const started = req.append.findLast(
          (/** @type {any} */ r) => r.kind === 'turn-started',
        );
        return started?.input;
      })
      .filter(input => input !== undefined);

  return {
    session,
    internal,
    rounds,
    published,
    sent,
    /**
     * Submit inline text (crank A, then the open's answer).
     * @param {string} text
     * @param {string} [id]
     */
    submit: async (text, id = requestId()) => {
      const receipt = session.enqueueOnce(harden({ text }), id, AT);
      await drain();
      return receipt;
    },
    /**
     * Finish the current turn's round 0 without tool calls.
     * @param {string} [text]
     */
    finish: async (text = 'done') => {
      const req = rounds[rounds.length - 1];
      req.sink.dispatching(0);
      req.sink.roundFinal(
        harden({ round: 0, text, toolCalls: harden([]), usage, at: AT + 1 }),
      );
      await drain();
    },
    /** Previews of the waiting entries, oldest first. */
    pending: () =>
      session.listPending().entries.map((/** @type {any} */ e) => e.preview),
    hold: () => session.listPending().hold,
    /**
     * The adapter restarts: its objects become tombstones and every pending
     * lease breaks with the retired text (the turn's recovery runs).
     */
    restartAdapter: async () => {
      incarnation.state.dead = true;
      since += 1_000_000;
      incarnation = makeIncarnation();
      for (const kit of leases.splice(0)) {
        kit.reject(Error(`ocapn hub: ${RETIRED_TEXT}`));
      }
      await drain();
    },
  };
};
