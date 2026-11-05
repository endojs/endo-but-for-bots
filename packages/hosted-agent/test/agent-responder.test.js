// @ts-check
/* eslint-disable no-await-in-loop, @endo/restrict-comparison-operands */
import '@endo/init/debug.js';

import test from 'ava';
import { makeError, q, X } from '@endo/errors';

import {
  classifyTurnFailure,
  formulaIdOfLocator,
  makeAgentResponder,
} from '../src/agent-responder.js';

const NODE = 'a'.repeat(64);
const SELF = `endo://${NODE}/${'1'.repeat(64)}?type=guest`;
const PEER = `endo://${NODE}/${'2'.repeat(64)}?type=guest`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.parse('2026-11-04T12:00:00.000Z');

/** @param {string} code */
const refusal = code =>
  makeError(X`Inference provider operation failed: ${q(code)}`);

/**
 * A mailbox, clock, and journal that outlive any one responder, so restarting
 * is making a new responder over them.
 */
const makeWorld = () => {
  const world = {
    nowMs: START,
    /** @type {any[]} */
    mail: [],
    /** @type {any} */
    snapshot: undefined,
    /** @type {string[]} */
    prompts: [],
    /** @type {any[]} */
    replies: [],
    /** @type {any[]} */
    timers: [],
    /** @type {string[]} */
    dismissed: [],
    next: 1n,
    /** @type {(prompt: string, signal: AbortSignal) => Promise<any>} */
    turn: async () => harden({ text: 'answer' }),
    failNextReplyRecord: false,
  };
  const guest = harden({
    listMessages: async () => harden([...world.mail]),
    reply: async (number, strings) => {
      const inbound = world.mail.find(message => message.number === number);
      world.replies.push(strings[0]);
      world.next += 1n;
      world.mail.push(
        harden({
          number: world.next,
          type: 'package',
          from: SELF,
          replyTo: inbound.messageId,
          strings,
        }),
      );
    },
    dismiss: async number => {
      world.dismissed.push(String(number));
      world.mail = world.mail.filter(message => message.number !== number);
    },
  });
  const journal = harden({
    read: async () => world.snapshot,
    write: async value => {
      if (world.failNextReplyRecord && value.effects[1]?.state === 'replied') {
        world.failNextReplyRecord = false;
        throw Error('crash before recording the reply');
      }
      world.snapshot = value;
    },
  });
  /**
   * @param {string} text @param {object} [extra]
   * @param extra
   */
  const deliver = (text, extra = {}) => {
    const number = world.next;
    world.next += 1n;
    world.mail.push(
      harden({
        number,
        messageId: `id-${number}`,
        type: 'package',
        from: PEER,
        strings: [text],
        ...extra,
      }),
    );
    return String(number);
  };
  const start = async (overrides = {}) =>
    makeAgentResponder({
      guest,
      selfId: /** @type {string} */ (formulaIdOfLocator(SELF)),
      journal,
      nowMillis: () => world.nowMs,
      schedule: (delayMs, callback) => {
        const timer = { at: world.nowMs + delayMs, callback, live: true };
        world.timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
      runTurn: async ({ prompt }, signal) => {
        world.prompts.push(prompt);
        return world.turn(prompt, signal);
      },
      logError: () => {},
      ...overrides,
    });
  return { world, deliver, start };
};

/** Let the responder's single-flight pass run to quiescence. */
const settled = async () => {
  for (let turn = 0; turn < 200; turn += 1) {
    await null;
  }
};

/**
 * @param {any} world
 * @param {number} ms
 */
const advance = async (world, ms) => {
  const until = world.nowMs + ms;
  for (;;) {
    const due = world.timers
      .filter(timer => timer.live && timer.at <= until)
      .sort((left, right) => left.at - right.at)[0];
    if (due === undefined) break;
    due.live = false;
    world.nowMs = Math.max(world.nowMs, due.at);
    due.callback();

    await settled();
  }
  world.nowMs = until;
};

test('wake runs one turn, sends the reply, and only then dismisses', async t => {
  const { world, deliver, start } = makeWorld();
  const order = [];
  const responder = await start();
  deliver('hello');
  world.turn = async () => {
    order.push(`turn dismissed:${world.dismissed.length}`);
    return harden({ text: 'hi there' });
  };
  await responder.setPaused(false);
  await settled();
  t.deepEqual(order, ['turn dismissed:0']);
  t.deepEqual(world.replies, ['hi there']);
  t.true(world.dismissed.includes('1'));
  t.deepEqual(world.mail, [], 'the reply copy is not left as unread mail');
  t.deepEqual(world.snapshot.effects, {}, 'a finished record is not retained');
  t.is(world.snapshot.cursor, '1');
});

test('paused, the responder starts no turn; startAfter skips confirmed mail', async t => {
  const { world, deliver, start } = makeWorld();
  const responder = await start();
  deliver('skipped');
  responder.notify();
  await settled();
  t.deepEqual(world.prompts, [], 'a pinned responder starts paused');
  const later = deliver('processed');
  await responder.setPaused(false, '1');
  await settled();
  t.deepEqual(world.prompts, ['processed']);
  t.is(world.snapshot.cursor, later);
  t.is(world.mail.length, 1, 'skipped mail stays for the owner');
  t.is((await responder.describe()).cursor, later);
});

test('a replayed delivery does not run the message again', async t => {
  const { world, deliver, start } = makeWorld();
  const responder = await start();
  deliver('once');
  await responder.setPaused(false);
  responder.notify();
  responder.notify();
  await settled();
  responder.notify();
  await settled();
  t.deepEqual(world.prompts, ['once']);
  t.is(world.replies.length, 1);
});

test('a crash after the reply and before its record sends no second reply', async t => {
  const { world, deliver, start } = makeWorld();
  world.failNextReplyRecord = true;
  const responder = await start();
  deliver('once');
  await responder.setPaused(false);
  await settled();
  t.is(world.replies.length, 1);
  t.is(world.snapshot.effects[1].state, 'replying');
  responder.stop();

  const revived = await start();
  await revived.setPaused(false);
  await settled();
  t.is(world.replies.length, 1, 'the outgoing copy is found');
  t.deepEqual(world.prompts, ['once'], 'the effect record prevents a new turn');
  t.deepEqual(world.mail, []);
});

test('a crash during a turn runs it again on restart', async t => {
  const { world, deliver, start } = makeWorld();
  world.turn = () => new Promise(() => {});
  const responder = await start();
  deliver('interrupted');
  await responder.setPaused(false);
  await settled();
  responder.stop();
  world.turn = async () => harden({ text: 'done' });
  const revived = await start();
  await revived.setPaused(false);
  await settled();
  t.deepEqual(world.replies, ['done']);
});

test('a harness that replied and dismissed by its own tools is not answered again', async t => {
  const { world, deliver, start } = makeWorld();
  const responder = await start();
  deliver('by tool');
  world.turn = async () => {
    await null;
    world.mail = [];
    return harden({ text: 'prose after the tool call' });
  };
  await responder.setPaused(false);
  await settled();
  t.deepEqual(world.replies, []);
  t.deepEqual(world.snapshot.effects, {});
});

test('messages that are not inbound requests stay in the mailbox', async t => {
  const { world, deliver, start } = makeWorld();
  const responder = await start();
  deliver('own', { from: SELF });
  deliver('reply', { replyTo: 'id-0' });
  deliver('form', { type: 'form' });
  deliver('anonymous', { from: 'not a locator' });
  deliver('partial', { done: false });
  deliver('   ');
  await responder.setPaused(false);
  await settled();
  t.deepEqual(world.prompts, []);
  t.is(world.mail.length, 6);
});

test('a concurrency or rate refusal backs off, doubling from a minute to an hour', async t => {
  const { world, deliver, start } = makeWorld();
  let refuse = true;
  world.turn = async () => {
    if (refuse) throw refusal('agent-rate-limited');
    return harden({ text: 'late' });
  };
  const responder = await start({ maximumAttempts: 100 });
  const number = deliver('busy');
  await responder.setPaused(false);
  await settled();
  const waits = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { deferred } = await responder.describe();
    waits.push(Date.parse(deferred[0].retryAt) - world.nowMs);
    await advance(world, waits[attempt]);
  }
  t.deepEqual(waits, [
    MINUTE,
    2 * MINUTE,
    4 * MINUTE,
    8 * MINUTE,
    16 * MINUTE,
    32 * MINUTE,
    HOUR,
    HOUR,
  ]);
  t.is(world.replies.length, 0);
  t.true(world.mail.some(message => String(message.number) === number));
  refuse = false;
  await advance(world, HOUR);
  t.deepEqual(world.replies, ['late'], 'a later retry processes the message');
  t.deepEqual((await responder.describe()).deferred, []);
});

test('a budget refusal waits for the UTC day to reset, and sends the sender nothing', async t => {
  const { world, deliver, start } = makeWorld();
  world.turn = async () => {
    throw refusal('owner-budget-exhausted');
  };
  const responder = await start();
  deliver('expensive');
  await responder.setPaused(false);
  await settled();
  t.like((await responder.describe()).deferred[0], {
    code: 'owner-budget-exhausted',
    retryAt: '2026-11-05T00:00:00.000Z',
  });
  const before = world.prompts.length;
  await advance(world, 11 * HOUR);
  t.is(world.prompts.length, before, 'not retried early');
  world.turn = async () => harden({ text: 'after reset' });
  await advance(world, HOUR);
  t.deepEqual(world.replies, ['after reset']);
});

for (const code of [
  'provider-retired',
  'grant-revoked',
  'inference-request-refused',
  'unpriced-model',
]) {
  test(`a terminal refusal ${code} is marked refused and never retried`, async t => {
    const { world, deliver, start } = makeWorld();
    world.turn = async () => {
      throw refusal(code);
    };
    const responder = await start();
    deliver('doomed');
    await responder.setPaused(false);
    await settled();
    t.deepEqual((await responder.describe()).refused, [
      harden({ number: '1', code }),
    ]);
    await advance(world, 100 * HOUR);
    responder.notify();
    await settled();
    t.is(world.prompts.length, 1);
    t.is(world.replies.length, 0);
    t.is(world.mail.length, 1, 'it stays unread');
  });
}

test('the eighth transient refusal marks the message retry-exhausted', async t => {
  const { world, deliver, start } = makeWorld();
  world.turn = async () => {
    throw refusal('agent-concurrency-exhausted');
  };
  const responder = await start();
  deliver('never');
  await responder.setPaused(false);
  await settled();
  for (let attempt = 1; attempt < 8; attempt += 1) {
    const { deferred } = await responder.describe();
    t.is(deferred[0].attempts, attempt);
    await advance(world, Date.parse(deferred[0].retryAt) - world.nowMs);
  }
  t.is(world.prompts.length, 8);
  t.deepEqual((await responder.describe()).deferred, []);
  t.deepEqual((await responder.describe()).refused, [
    harden({ number: '1', code: 'retry-exhausted' }),
  ]);
  await advance(world, 100 * HOUR);
  t.is(world.prompts.length, 8);
});

test('72 hours after the first refusal, a deferred message is retry-exhausted', async t => {
  const { world, deliver, start } = makeWorld();
  world.turn = async () => {
    throw refusal('agent-budget-exhausted');
  };
  const responder = await start();
  deliver('stale');
  await responder.setPaused(false);
  await settled();
  // Days, not attempts, run out: one refusal per reset, and the deadline falls
  // between resets.
  await advance(world, 71 * HOUR);
  t.is((await responder.describe()).deferred.length, 1);
  await advance(world, HOUR);
  t.is(world.prompts.length, 4);
  t.is((await responder.describe()).refused[0].code, 'retry-exhausted');
});

test('deferred messages retry oldest first, before new mail', async t => {
  const { world, deliver, start } = makeWorld();
  let refuse = true;
  world.turn = async () => {
    if (refuse) throw refusal('agent-rate-limited');
    return harden({ text: 'ok' });
  };
  const responder = await start();
  deliver('first');
  deliver('second');
  await responder.setPaused(false);
  await settled();
  t.is((await responder.describe()).deferred.length, 2);
  world.prompts.length = 0;
  refuse = false;
  deliver('third');
  await advance(world, MINUTE);
  t.deepEqual(world.prompts.slice(0, 2), ['first', 'second']);
  t.is(world.prompts[2], 'third');
});

test('the deferred queue survives a restart', async t => {
  const { world, deliver, start } = makeWorld();
  world.turn = async () => {
    throw refusal('agent-rate-limited');
  };
  const responder = await start();
  deliver('queued');
  await responder.setPaused(false);
  await settled();
  responder.stop();
  world.turn = async () => harden({ text: 'revived' });
  const revived = await start();
  t.is((await revived.describe()).deferred[0].attempts, 1);
  // The persisted paused flag is not cleared by a restart; the factory's sweep
  // reapplies desired state. Nothing runs until the retry time either way.
  await revived.setPaused(false);
  await settled();
  t.is(world.replies.length, 0, 'the retry time still applies');
  await advance(world, MINUTE);
  t.deepEqual(world.replies, ['revived']);
});

test('with wake off, no retry runs', async t => {
  const { world, deliver, start } = makeWorld();
  world.turn = async () => {
    throw refusal('agent-rate-limited');
  };
  const responder = await start();
  deliver('queued');
  await responder.setPaused(false);
  await settled();
  await responder.setPaused(true);
  const before = world.prompts.length;
  await advance(world, 10 * HOUR);
  await responder.retry('1');
  await settled();
  t.is(world.prompts.length, before);
  world.turn = async () => harden({ text: 'woken' });
  await responder.setPaused(false);
  await settled();
  t.deepEqual(world.replies, ['woken']);
});

test('Retry now is one fresh admission that resets the attempt count', async t => {
  const { world, deliver, start } = makeWorld();
  world.turn = async () => {
    throw refusal('agent-concurrency-exhausted');
  };
  const responder = await start();
  deliver('stuck');
  await responder.setPaused(false);
  await settled();
  await advance(world, MINUTE);
  t.is((await responder.describe()).deferred[0].attempts, 2);
  await responder.retry('1');
  await settled();
  t.is((await responder.describe()).deferred[0].attempts, 1);

  world.turn = async () => {
    throw refusal('provider-retired');
  };
  await responder.retry('1');
  await settled();
  t.is((await responder.describe()).refused[0].code, 'provider-retired');
  world.turn = async () => harden({ text: 'reattached' });
  await responder.retry('1');
  await settled();
  t.deepEqual(world.replies, ['reattached']);
  await t.throwsAsync(responder.retry('1'), {
    message: /message-not-retryable/,
  });
});

test('mail the owner dismissed is skipped and its record pruned', async t => {
  const { world, deliver, start } = makeWorld();
  world.turn = async () => {
    throw refusal('agent-rate-limited');
  };
  const responder = await start();
  deliver('dismiss me');
  await responder.setPaused(false);
  await settled();
  world.mail = [];
  t.deepEqual((await responder.describe()).deferred, []);
  const prompts = world.prompts.length;
  await advance(world, HOUR);
  t.is(world.prompts.length, prompts);
  t.deepEqual(world.snapshot.effects, {});
});

test('stopping cancels the turn in flight and records nothing', async t => {
  const { world, deliver, start } = makeWorld();
  let aborted = false;
  world.turn = (_prompt, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      });
    });
  const responder = await start();
  deliver('long');
  await responder.setPaused(false);
  await settled();
  responder.stop();
  await settled();
  t.true(aborted);
  t.deepEqual(world.snapshot.effects, {});
  t.is(world.replies.length, 0);
});

test('a turn past its wall clock is aborted and deferred', async t => {
  const { world, deliver, start } = makeWorld();
  world.turn = (_prompt, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  const responder = await start({ turnTimeoutMs: 5 * MINUTE });
  deliver('slow');
  await responder.setPaused(false);
  await settled();
  await advance(world, 5 * MINUTE);
  t.is((await responder.describe()).deferred[0].code, 'turn-failed');
});

test('a turn with no text dismisses the message and sends no reply', async t => {
  const { world, deliver, start } = makeWorld();
  world.turn = async () => harden({});
  const responder = await start();
  deliver('nothing to say');
  await responder.setPaused(false);
  await settled();
  t.deepEqual(world.replies, []);
  t.deepEqual(world.dismissed, ['1']);
  t.deepEqual(world.snapshot.effects, {});
});

test('a turn that ignores the abort and finishes after stopping records nothing', async t => {
  const { world, deliver, start } = makeWorld();
  /** @type {(value: any) => void} */
  let finishTurn = () => {};
  world.turn = () =>
    new Promise(resolve => {
      finishTurn = resolve;
    });
  const responder = await start();
  deliver('long');
  await responder.setPaused(false);
  await settled();
  responder.stop();
  finishTurn(harden({ text: 'too late' }));
  await settled();
  t.deepEqual(world.snapshot.effects, {});
  t.deepEqual(world.replies, []);
  t.deepEqual(world.dismissed, []);
});

test('mail arriving after stopping starts no turn', async t => {
  const { world, deliver, start } = makeWorld();
  const responder = await start();
  await responder.setPaused(false);
  responder.stop();
  deliver('after stop');
  responder.notify();
  await settled();
  t.deepEqual(world.prompts, []);
});

test('a failed pass is logged and resumes after the initial backoff', async t => {
  const { world, deliver, start } = makeWorld();
  /** @type {string[]} */
  const logged = [];
  world.failNextReplyRecord = true;
  const responder = await start({
    logError: message => logged.push(message),
  });
  deliver('hello');
  await responder.setPaused(false);
  await settled();
  t.deepEqual(logged, ['Agent responder pass failed']);
  t.deepEqual(world.replies, ['answer']);
  t.deepEqual(world.dismissed, [], 'the pass stopped before dismissing');
  await advance(world, MINUTE - 1);
  t.deepEqual(world.dismissed, [], 'the retry waits out the backoff');
  await advance(world, 1);
  t.deepEqual(
    world.replies,
    ['answer'],
    'the resumed pass does not reply again',
  );
  t.true(world.dismissed.includes('1'));
  t.deepEqual(world.snapshot.effects, {});
});

test('a locator names its formula with or without connection hints', t => {
  const bare = formulaIdOfLocator(PEER);
  t.is(bare, `${'2'.repeat(64)}:${NODE}`);
  t.is(formulaIdOfLocator(`${PEER}&at=tcp%3A%2F%2F127.0.0.1%3A8920`), bare);
  t.not(formulaIdOfLocator(SELF), bare);
  t.is(formulaIdOfLocator(undefined), undefined);
  t.is(formulaIdOfLocator('not a locator'), undefined);
  t.is(formulaIdOfLocator(`endo://${NODE}/?type=guest`), undefined);
});

test('failure classification follows the fixed codes', t => {
  t.is(
    classifyTurnFailure(refusal('provider-budget-exhausted')).disposition,
    'budget',
  );
  t.is(
    classifyTurnFailure(refusal('owner-rate-limited')).disposition,
    'backoff',
  );
  t.is(classifyTurnFailure(refusal('provider-retired')).disposition, 'refused');
  t.like(classifyTurnFailure(Error('Anthropic rate limit reached')), {
    disposition: 'backoff',
    code: 'upstream-rate-limited',
  });
  t.like(classifyTurnFailure(Error('socket hang up')), {
    disposition: 'backoff',
    code: 'turn-failed',
  });
});
