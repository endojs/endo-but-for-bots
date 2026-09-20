// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';

import {
  chooseResetCredit,
  makeResetCreditAdmin,
} from '../src/reset-credit-admin.js';

const KEY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A journal that survives "restarts": share it between two admins. */
const makeJournal = () => {
  /** @type {any[]} */
  const written = [];
  let failing = false;
  return {
    written,
    failWrites: (/** @type {boolean} */ on) => {
      failing = on;
    },
    read: async () => written[written.length - 1],
    write: async (/** @type {any} */ record) => {
      if (failing) throw Error('store is down');
      written.push(record);
    },
  };
};

/**
 * @param {object} [options]
 * @param {ReturnType<typeof makeJournal>} [options.journal]
 * @param {any} [options.reading]
 */
const makeHarness = ({ journal = makeJournal(), reading } = {}) => {
  /** @type {Array<{ idempotencyKey: string, creditId?: string }>} */
  const calls = [];
  /** @type {Array<(request: any) => any>} */
  const answers = [];
  const keys = [KEY_A, KEY_B];
  let clock = Date.parse('2026-09-20T00:00:00Z');
  const state = {
    reading:
      reading === undefined
        ? {
            rateLimits: {
              resetCredits: {
                availableCount: 2,
                credits: [
                  {
                    id: 'late',
                    status: 'available',
                    expiresAt: '2026-12-01T00:00:00.000Z',
                  },
                  {
                    id: 'soon',
                    status: 'available',
                    expiresAt: '2026-10-01T00:00:00.000Z',
                  },
                ],
              },
            },
          }
        : reading,
    refreshes: 0,
    unreachable: false,
    onRefresh: () => {},
  };
  const admin = makeResetCreditAdmin({
    provideRedeem: async () => {
      if (state.unreachable) throw Error('no redeemer bound');
      return async request => {
        calls.push(request);
        const answer = answers.shift();
        if (answer === undefined) throw Error('no scripted answer');
        return answer(request);
      };
    },
    observe: async () => state.reading,
    refreshReading: async () => {
      state.refreshes += 1;
      state.onRefresh();
    },
    journal,
    makeKey: () => /** @type {string} */ (keys.shift()),
    now: () => {
      clock += 1000;
      return new Date(clock).toISOString();
    },
  });
  return { admin, calls, answers, journal, state };
};

test('the soonest credit to expire is chosen, and spent ones are not', t => {
  const now = '2026-09-20T00:00:00.000Z';
  t.is(chooseResetCredit(undefined, now), null);
  t.is(chooseResetCredit({ credits: null }, now), null);
  t.is(
    chooseResetCredit(
      {
        credits: [
          {
            id: 'spent',
            status: 'redeemed',
            expiresAt: '2026-09-21T00:00:00.000Z',
          },
          {
            id: 'gone',
            status: 'available',
            expiresAt: '2026-09-01T00:00:00.000Z',
          },
          {
            id: 'b',
            status: 'available',
            expiresAt: '2026-11-01T00:00:00.000Z',
          },
          {
            id: 'a',
            status: 'available',
            expiresAt: '2026-10-01T00:00:00.000Z',
          },
          { id: 'undated', status: 'available', expiresAt: '' },
        ],
      },
      now,
    ),
    'a',
  );
  t.is(
    chooseResetCredit(
      { credits: [{ id: 'undated', status: 'available', expiresAt: '' }] },
      now,
    ),
    'undated',
  );
});

test('the intent is stored before the provider is called, and cleared by its answer', async t => {
  const { admin, calls, answers, journal } = makeHarness();
  answers.push(() => {
    // At the moment of the call the key is already durable.
    t.is(journal.written.length, 1);
    t.is(journal.written[0].intent.idempotencyKey, KEY_A);
    t.is(journal.written[0].intent.creditId, 'soon');
    return { outcome: 'reset' };
  });
  const result = await E(admin).consumeResetCredit();
  t.deepEqual(result, {
    outcome: 'reset',
    creditId: 'soon',
    replayed: false,
    pending: false,
  });
  t.deepEqual(calls, [{ idempotencyKey: KEY_A, creditId: 'soon' }]);
  const state = await E(admin).getResetState();
  t.is(state.pending, null);
  t.is(state.last.outcome, 'reset');
  t.is(journal.written[journal.written.length - 1].intent, null);
  // The key is not part of what a view is told.
  t.false(JSON.stringify(state).includes(KEY_A));
});

test('a store that cannot be written means no provider call', async t => {
  const { admin, calls, journal } = makeHarness();
  journal.failWrites(true);
  await t.throwsAsync(() => E(admin).consumeResetCredit(), {
    message: /store is down/,
  });
  t.deepEqual(calls, []);
});

test('a lost answer leaves the intent; a restart replays nothing; asking again uses the same key', async t => {
  const journal = makeJournal();
  const first = makeHarness({ journal });
  first.answers.push(() => {
    throw Error('Codex reset redeem got no answer');
  });
  await t.throwsAsync(() => E(first.admin).consumeResetCredit(), {
    message: /unconfirmed.*got no answer/,
  });

  // The daemon restarts: a new admin over the same store.
  const second = makeHarness({ journal });
  const revived = await E(second.admin).getResetState();
  t.is(revived.pending.creditId, 'soon');
  t.is(revived.pending.attempts, 1);
  await E(second.admin).refresh();
  t.deepEqual(
    second.calls,
    [],
    'neither revival nor a refresh calls the provider to redeem',
  );
  t.is(second.state.refreshes, 1);
  t.truthy((await E(second.admin).getResetState()).pending);

  // Another credit cannot be started beside it.
  await t.throwsAsync(
    () => E(second.admin).consumeResetCredit({ creditId: 'late' }),
    {
      message: /unconfirmed/,
    },
  );
  t.deepEqual(second.calls, []);

  // Nor a redeem that names none: a redeem is never taken for asking again.
  await t.throwsAsync(() => E(second.admin).consumeResetCredit(), {
    message: /unconfirmed/,
  });
  t.deepEqual(second.calls, []);

  second.answers.push(() => ({ outcome: 'alreadyRedeemed' }));
  const result = await E(second.admin).consumeResetCredit({ replay: true });
  t.deepEqual(result, {
    outcome: 'alreadyRedeemed',
    creditId: 'soon',
    replayed: true,
    pending: false,
  });
  // The stored key, not a fresh one.
  t.deepEqual(second.calls, [{ idempotencyKey: KEY_A, creditId: 'soon' }]);
  t.is((await E(second.admin).getResetState()).pending, null);
});

test('a refresh settles a pending redeem only when the credit reads redeemed', async t => {
  const journal = makeJournal();
  const { admin, answers, state, calls } = makeHarness({ journal });
  answers.push(() => {
    throw Error('HTTP 502');
  });
  await t.throwsAsync(() => E(admin).consumeResetCredit({ creditId: 'late' }));
  // Still available: a call may be on its way. Not settled.
  await E(admin).refresh();
  t.truthy((await E(admin).getResetState()).pending);
  state.reading = {
    rateLimits: {
      resetCredits: {
        availableCount: 1,
        credits: [
          { id: 'late', status: 'redeemed', expiresAt: '' },
          { id: 'soon', status: 'available', expiresAt: '' },
        ],
      },
    },
  };
  const settled = await E(admin).getResetState();
  t.is(settled.pending, null);
  t.deepEqual(
    { outcome: settled.last.outcome, creditId: settled.last.creditId },
    { outcome: 'redeemed', creditId: 'late' },
  );
  t.is(calls.length, 1);
});

test('a refusal spends nothing and clears the intent', async t => {
  const { admin, answers } = makeHarness();
  answers.push(() => ({ outcome: 'refused' }));
  const result = await E(admin).consumeResetCredit();
  t.is(result.outcome, 'refused');
  const state = await E(admin).getResetState();
  t.is(state.pending, null);
  t.is(state.last.outcome, 'refused');
});

test('with no credit left nothing is asked; with nothing known the account is read once first', async t => {
  const none = makeHarness({
    reading: {
      rateLimits: { resetCredits: { availableCount: 0, credits: [] } },
    },
  });
  await t.throwsAsync(() => E(none.admin).consumeResetCredit(), {
    message: /No reset credit is available/,
  });
  t.deepEqual(none.calls, []);
  t.is(none.journal.written.length, 0);

  const unknown = makeHarness({ reading: {} });
  unknown.state.onRefresh = () => {
    unknown.state.reading = {
      rateLimits: { resetCredits: { availableCount: 1, credits: null } },
    };
  };
  unknown.answers.push(() => ({ outcome: 'reset' }));
  const result = await E(unknown.admin).consumeResetCredit();
  // The reading lists no credits, so the provider is left to choose.
  t.like(result, { outcome: 'reset', creditId: null, replayed: false });
  t.deepEqual(unknown.calls, [{ idempotencyKey: KEY_A }]);
});

test('a second redeem while the first is unconfirmed is refused and calls nobody', async t => {
  const { admin, answers, calls } = makeHarness();
  answers.push(() => {
    throw Error('lost');
  });
  const [a, b] = await Promise.allSettled([
    E(admin).consumeResetCredit(),
    E(admin).consumeResetCredit(),
  ]);
  t.is(a.status, 'rejected');
  t.is(b.status, 'rejected');
  t.regex(
    /** @type {PromiseRejectedResult} */ (b).reason.message,
    /unconfirmed/,
  );
  t.deepEqual(
    calls.map(call => call.idempotencyKey),
    [KEY_A],
  );
});

test('asking again about a redeem that was settled meanwhile answers how, and spends nothing', async t => {
  const { admin, answers, calls, state } = makeHarness();
  answers.push(() => {
    throw Error('lost');
  });
  await t.throwsAsync(() => E(admin).consumeResetCredit());
  t.is(calls.length, 1);
  // The view still shows "Ask again"; a reading arrives in which the credit
  // is redeemed; then the person presses. `late` is still available.
  state.reading = {
    rateLimits: {
      resetCredits: {
        availableCount: 1,
        credits: [
          { id: 'soon', status: 'redeemed', expiresAt: '' },
          {
            id: 'late',
            status: 'available',
            expiresAt: '2026-12-01T00:00:00.000Z',
          },
        ],
      },
    },
  };
  t.deepEqual(await E(admin).consumeResetCredit({ replay: true }), {
    outcome: 'redeemed',
    creditId: 'soon',
    replayed: true,
    pending: false,
  });
  t.is(calls.length, 1, 'no second call, and never the other credit');
  // With nothing unconfirmed, asking again is an error, not a redeem.
  await t.throwsAsync(() => E(admin).consumeResetCredit({ replay: true }), {
    message: /No redeem is unconfirmed/,
  });
  t.is(calls.length, 1);
});

test('a later ask that is refused leaves the redeem unconfirmed', async t => {
  const { admin, answers, calls } = makeHarness();
  answers.push(() => {
    throw Error('timed out');
  });
  await t.throwsAsync(() => E(admin).consumeResetCredit());
  // The first may have been accepted; an edge challenge refuses the second.
  answers.push(() => ({ outcome: 'refused' }));
  t.deepEqual(await E(admin).consumeResetCredit({ replay: true }), {
    outcome: 'refused',
    creditId: 'soon',
    replayed: true,
    pending: true,
  });
  const state = await E(admin).getResetState();
  t.is(state.pending.lastAnswer, 'refused');
  t.is(state.pending.attempts, 2);
  t.is(state.last, null);
  await t.throwsAsync(() => E(admin).consumeResetCredit(), {
    message: /unconfirmed/,
  });
  t.is(calls.length, 2);
});

test('an ask that was never sent leaves nothing pending, unless an earlier one was', async t => {
  const { admin, answers } = makeHarness();
  answers.push(() => ({ outcome: 'notSent' }));
  await t.throwsAsync(() => E(admin).consumeResetCredit(), {
    message: /could not be sent; nothing was spent/,
  });
  t.is((await E(admin).getResetState()).pending, null);

  answers.push(() => {
    throw Error('lost');
  });
  await t.throwsAsync(() => E(admin).consumeResetCredit());
  answers.push(() => ({ outcome: 'notSent' }));
  await t.throwsAsync(() => E(admin).consumeResetCredit({ replay: true }), {
    message: /earlier ask is still unconfirmed/,
  });
  t.truthy((await E(admin).getResetState()).pending);
});

test('an unconfirmed redeem the provider will never settle can be given up', async t => {
  const journal = makeJournal();
  const { admin, answers, calls } = makeHarness({
    journal,
    reading: {
      rateLimits: { resetCredits: { availableCount: 2, credits: null } },
    },
  });
  answers.push(() => ({ outcome: 'words of tomorrow' }));
  await t.throwsAsync(() => E(admin).consumeResetCredit());
  // No credit id, so no status can ever settle it.
  t.is((await E(admin).getResetState()).pending.creditId, null);
  const state = await E(admin).abandonResetIntent();
  t.is(state.pending, null);
  t.is(state.last.outcome, 'abandoned');
  t.is(journal.written[journal.written.length - 1].intent, null);
  // Giving up calls nobody; a redeem afterwards is a new one, with a new key.
  t.is(calls.length, 1);
  answers.push(() => ({ outcome: 'reset' }));
  await E(admin).consumeResetCredit();
  t.deepEqual(
    calls.map(call => call.idempotencyKey),
    [KEY_A, KEY_B],
  );
  // With nothing pending it is a no-op.
  t.is((await E(admin).abandonResetIntent()).last.outcome, 'reset');
});

test('the state is answered from memory while the provider is being asked', async t => {
  const { admin, answers } = makeHarness();
  /** @type {(value: any) => void} */
  let answer = () => {};
  answers.push(
    () =>
      new Promise(resolve => {
        answer = resolve;
      }),
  );
  const redeeming = E(admin).consumeResetCredit();
  // Wait until the call is out.
  for (let i = 0; i < 50 && answer.length === 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const during = await E(admin).getResetState();
  t.is(during.pending.creditId, 'soon');
  answer({ outcome: 'reset' });
  await redeeming;
  t.is((await E(admin).getResetState()).pending, null);
});

test('an answer in unknown words is an error and the intent stands', async t => {
  const { admin, answers } = makeHarness();
  answers.push(() => ({ outcome: 'surprise' }));
  await t.throwsAsync(() => E(admin).consumeResetCredit());
  t.truthy((await E(admin).getResetState()).pending);
});

test('a bad credit id is refused before anything is stored', async t => {
  const { admin, calls, journal } = makeHarness();
  await t.throwsAsync(() => E(admin).consumeResetCredit({ creditId: 'a b' }), {
    message: /Invalid reset credit id/,
  });
  t.deepEqual(calls, []);
  t.is(journal.written.length, 0);
});

test('a redeemer that cannot be reached fails the redeem with nothing pending', async t => {
  const { admin, state, journal } = makeHarness();
  state.unreachable = true;
  await t.throwsAsync(() => E(admin).consumeResetCredit(), {
    message: /no redeemer bound/,
  });
  t.is(journal.written.length, 0);
  t.is((await E(admin).getResetState()).pending, null);
});
