// @ts-check
// M1b W1b.2 in the session vat (guest/session/{context-source,session,turn}.js;
// designs/m1b-interfaces.md 3.3, 9): every RoundRequest carries the
// session's one ContextSource; `base` and `append` stay in step across turns
// (the append carries every record since the previous request, so the
// adapter's cache needs no page pull between turns); the real session's
// requests, fed to the adapter's context cache, project the same context
// incrementally and after a rebuild. In-memory fakes, no timers.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import { makeSession } from '../../guest/session/session.js';
/* eslint-enable import/no-relative-packages */
import { makeContextCache } from '../../resources/agent-host/impl/context-cache.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

const drain = () => new Promise(resolve => setImmediate(resolve));
const AT = 1_700_000_000_000;
let serial = 0;
const requestId = () => {
  serial += 1;
  return `${AT}-00000000-0000-4000-8000-${`${serial}`.padStart(12, '0')}`;
};
const usage = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/** No staged fields here: a store that is never needed. */
const noBlobs = /** @type {any} */ ({
  resolveMany: async () => {},
  read: async () => {
    throw Error('no blobs in this test');
  },
});

const setup = async () => {
  /** @type {any[]} */
  const rounds = [];
  /** @type {any[]} */
  const leases = [];
  const endpoint = Far('Endpoint', {
    holdTurn: () => {
      const kit = makePromiseKit();
      leases.push(kit);
      return kit.promise;
    },
    releaseTurn: () => undefined,
    startRound: (/** @type {any} */ req) => {
      rounds.push(req);
    },
    cancelRound: () => undefined,
    armDeadline: () => undefined,
    disarm: () => undefined,
  });
  const publisher = Far('LivePublisher', { publish: () => undefined });
  const ports = harden({ endpoint, publisher, tools: [], since: AT - 1000 });
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => ports,
  });
  const host = Far('SessionHostFacet', { liveChannel: () => publisher });
  const { session } = makeSession({
    config: harden({
      key: 's1',
      title: 't',
      backendTitle: 'fake',
      modelId: 'm',
      preset: { label: 'chat-only' },
      createdAt: AT,
      userInitiated: true,
    }),
    services: harden({ backend, host }),
    rowReporter: Far('RowReporter', { changed: () => undefined }),
  });
  await drain();
  return { session, rounds, last: () => rounds[rounds.length - 1] };
};

/**
 * One turn: submit, dispatch, then end it as `how` says.
 * @param {any} s
 * @param {string} text
 * @param {'reply' | 'fail' | 'cancel'} how
 */
const turn = async (s, text, how) => {
  s.session.enqueueOnce(harden({ text }), requestId(), AT + serial);
  await drain();
  const req = s.last();
  req.sink.dispatching(0);
  if (how === 'reply') {
    req.sink.roundFinal(
      harden({
        round: 0,
        text: `re: ${text}`,
        toolCalls: [],
        usage,
        at: AT + serial,
        servedBy: { label: 'fake', modelId: 'm' },
      }),
    );
  } else if (how === 'fail') {
    req.sink.roundFailed(
      harden({ round: 0, reason: 'boom', at: AT, partial: `half ${text}` }),
    );
  } else {
    req.turn.cancel();
  }
  await drain();
};

test('every request carries the one ContextSource; base and append stay in step across turns', async t => {
  const s = await setup();
  const plan = /** @type {const} */ ([
    'reply',
    'fail',
    'reply',
    'cancel',
    'reply',
  ]);
  for (const [i, how] of plan.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await turn(s, `m${i}`, how);
  }
  const [first, ...rest] = s.rounds;
  t.truthy(first.context);
  t.is(first.base.count, 0);
  for (const req of rest) t.is(req.context, first.context);
  for (let i = 1; i < s.rounds.length; i += 1) {
    const prev = s.rounds[i - 1];
    t.is(
      s.rounds[i].base.count,
      prev.base.count + prev.append.length,
      `request ${i}`,
    );
  }
  // A later turn's round 0 carries what the turn before recorded after its
  // last request, then its own TurnStarted.
  t.deepEqual(
    s.rounds[1].append.map((/** @type {any} */ r) => r.kind),
    ['dispatched', 'round-settled', 'turn-settled', 'turn-started'],
  );
  // The source pages the whole log.
  const page = await E(first.context).page();
  t.is(page.from, 0);
  const last = s.last();
  // ... including dispatched, round-settled and turn-settled of the last
  // turn, recorded after its request.
  t.is(page.records.length, last.base.count + last.append.length + 3);
  await t.throwsAsync(() => E(first.context).page('h1'), {
    message: texts.badCursor,
  });
});

test('the real session through the adapter cache: incremental equals rebuild; a restart rebuilds the same context', async t => {
  const s = await setup();
  const cache = makeContextCache({ store: noBlobs });
  const session = Far('Session', {});
  /** @type {any[]} */
  const incremental = [];
  const hows = /** @type {const} */ ([
    'reply',
    'fail',
    'cancel',
    'reply',
    'reply',
  ]);
  for (const [i, how] of hows.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await turn(s, `q${i}`, how);
    const req = s.rounds[s.rounds.length - 1];
    // eslint-disable-next-line no-await-in-loop
    incremental.push(await cache.prepare(session, req));
  }
  t.is(cache.stats().rebuilds, 1);
  t.is(cache.stats().appends, hows.length - 1);
  t.is(cache.stats().gapPulls, 0, 'no page pull between turns');
  // A fresh cache (the adapter restarted) for the last request: the same.
  const fresh = makeContextCache({ store: noBlobs });
  const rebuilt = await fresh.prepare(session, s.last());
  t.deepEqual(rebuilt.transcript, incremental.at(-1).transcript);
  t.deepEqual(
    rebuilt.transcript.map((/** @type {any} */ r) => [r.role, r.content]),
    [
      ['user', 'q0'],
      ['assistant', 're: q0'],
      ['user', 'q1'],
      ['assistant', 'half q1'],
      ['user', 'q2'],
      ['user', 'q3'],
      ['assistant', 're: q3'],
      ['user', 'q4'],
    ],
  );
  t.is(rebuilt.input, 'q4');
});
