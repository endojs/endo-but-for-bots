// @ts-check

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const AGENT_RESPONDER_DEFAULTS = harden({
  initialBackoffMs: MINUTE,
  maximumBackoffMs: HOUR,
  maximumAttempts: 8,
  maximumDeferralMs: 72 * HOUR,
  turnTimeoutMs: HOUR,
});

/**
 * @param {number} nowMs
 */
const nextUtcMidnight = nowMs => {
  const date = new Date(nowMs);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
};

/**
 * Sort a failed turn into the design's dispositions. Admission refusals carry
 * a fixed code. A failure without one (a dropped connection, a harness fault)
 * is treated as transient, so it is bounded and visible rather than silent.
 *
 * @param {any} error
 * @returns {{ disposition: 'backoff' | 'budget' | 'refused', code: string }}
 */
export const classifyTurnFailure = error => {
  const message = String(error?.message);
  const code = /operation failed: "([a-z-]+)"/.exec(message)?.[1];
  if (code === undefined) {
    return /rate limit/i.test(message)
      ? harden({ disposition: 'backoff', code: 'upstream-rate-limited' })
      : harden({ disposition: 'backoff', code: 'turn-failed' });
  }
  if (code.endsWith('-budget-exhausted')) {
    return harden({ disposition: 'budget', code });
  }
  if (code.endsWith('-concurrency-exhausted') || code.endsWith('-rate-limited')) {
    return harden({ disposition: 'backoff', code });
  }
  return harden({ disposition: 'refused', code });
};
harden(classifyTurnFailure);

const emptyState = () =>
  harden({ version: 1, paused: true, cursor: undefined, effects: {} });

/**
 * @param {string} left
 * @param {string} right
 */
const compareNumbers = (left, right) => {
  const difference = BigInt(left) - BigInt(right);
  if (difference === 0n) return 0;
  return difference < 0n ? -1 : 1;
};

/**
 * @param {string | undefined} left
 * @param {string | undefined} right
 */
const laterOf = (left, right) => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return compareNumbers(left, right) < 0 ? right : left;
};

/** @param {any} message */
const textOf = message => (message.strings ?? []).join('').trim();

/**
 * The formula a locator names. Locators for one formula differ by optional
 * connection hints: `locate` adds network addresses, while the `from` on mail
 * carries none.
 *
 * @param {string | undefined} locator
 */
export const formulaIdOfLocator = locator => {
  if (typeof locator !== 'string' || !URL.canParse(locator)) return undefined;
  const url = new URL(locator);
  const number = decodeURIComponent(
    url.pathname.replace(/^\//, '').split('@')[0] ?? '',
  );
  return number === '' ? undefined : `${number}:${url.host}`;
};
harden(formulaIdOfLocator);

/**
 * Answers one guest's mail, one bounded turn at a time. Its durable state is a
 * cursor plus one effect record per message still in flight, in a single
 * snapshot, so a disposition and the cursor move past its message commit
 * together. A record lasts until its message has left the mailbox, which is
 * what makes a replayed delivery harmless.
 *
 * The mailbox subscription only signals: every pass rereads `listMessages`, so
 * mail dismissed by the owner is skipped and a resumed responder needs no
 * replay of what it ignored while paused.
 *
 * Delivery is at-least-once: a crash during a turn runs that turn again, and
 * the agent's limits bound the cost.
 *
 * @param {object} options
 * @param {any} options.guest The agent's own guest.
 * @param {string} options.selfId The guest's formula id.
 * @param {{ read(): Promise<any>, write(value: any): Promise<void> }} options.journal
 * @param {(message: { number: string, prompt: string }, signal: AbortSignal) => Promise<{ text?: string }>} options.runTurn
 * @param {() => number} [options.nowMillis]
 * @param {(delayMs: number, callback: () => void) => () => void} options.schedule
 * @param {number} [options.initialBackoffMs]
 * @param {number} [options.maximumBackoffMs]
 * @param {number} [options.maximumAttempts]
 * @param {number} [options.maximumDeferralMs]
 * @param {number} [options.turnTimeoutMs]
 * @param {(...details: any[]) => void} [options.logError]
 */
export const makeAgentResponder = async ({
  guest,
  selfId,
  journal,
  runTurn,
  nowMillis = () => Date.now(),
  schedule,
  initialBackoffMs = AGENT_RESPONDER_DEFAULTS.initialBackoffMs,
  maximumBackoffMs = AGENT_RESPONDER_DEFAULTS.maximumBackoffMs,
  maximumAttempts = AGENT_RESPONDER_DEFAULTS.maximumAttempts,
  maximumDeferralMs = AGENT_RESPONDER_DEFAULTS.maximumDeferralMs,
  turnTimeoutMs = AGENT_RESPONDER_DEFAULTS.turnTimeoutMs,
  logError = console.error,
}) => {
  await null;
  let state = (await journal.read()) || emptyState();
  let stopped = false;
  let pumping = false;
  let pumpAgain = false;
  /** @type {undefined | (() => void)} */
  let cancelTimer;
  /** @type {undefined | AbortController} */
  let inFlight;
  /** @type {Promise<unknown>} */
  let writeTail = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} action
   * @returns {Promise<T>}
   */
  const inOrder = action => {
    const result = writeTail.then(action);
    writeTail = result.catch(() => {});
    return result;
  };

  /** @param {(prior: any) => any} change */
  const commit = change =>
    inOrder(async () => {
      const next = harden(change(state));
      await journal.write(next);
      state = next;
    });

  /**
   * @param {string} number
   * @param {any} record
   */
  const withEffect = (number, record) => prior => ({
    ...prior,
    cursor: laterOf(prior.cursor, number),
    effects: { ...prior.effects, [number]: record },
  });

  /** @param {string[]} numbers */
  const withoutEffects = numbers => prior => {
    const effects = { ...prior.effects };
    for (const number of numbers) delete effects[number];
    return { ...prior, effects };
  };

  /** @param {any} message */
  const isInbound = message => {
    const senderId = formulaIdOfLocator(message.from);
    return (
      message.type === 'package' &&
      message.replyTo === undefined &&
      message.done !== false &&
      senderId !== undefined &&
      senderId !== selfId &&
      textOf(message) !== ''
    );
  };

  /**
   * @param {any} prior
   * @param {any} failure
   */
  const dispositionOf = (prior, { disposition, code }) => {
    if (disposition === 'refused') return harden({ state: 'refused', code });
    const nowMs = nowMillis();
    const attempts = (prior?.attempts ?? 0) + 1;
    const firstRefusedAtMs = prior?.firstRefusedAtMs ?? nowMs;
    // eslint-disable-next-line @endo/restrict-comparison-operands
    if (attempts >= maximumAttempts) {
      return harden({ state: 'refused', code: 'retry-exhausted', lastCode: code });
    }
    const retryAtMs =
      disposition === 'budget'
        ? nextUtcMidnight(nowMs)
        : nowMs +
          Math.min(initialBackoffMs * 2 ** (attempts - 1), maximumBackoffMs);
    return harden({
      state: 'deferred',
      code,
      attempts,
      firstRefusedAtMs,
      retryAtMs,
    });
  };

  /** @param {any} message */
  const answer = async message => {
    const number = String(message.number);
    const controller = new AbortController();
    inFlight = controller;
    const cancelTimeout = schedule(turnTimeoutMs, () =>
      controller.abort(Error('Agent turn reached its wall clock')),
    );
    await null;
    try {
      const { text } = await runTurn(
        harden({ number, prompt: textOf(message) }),
        controller.signal,
      );
      if (stopped) return;
      await commit(
        withEffect(number, harden({ state: 'replying', text: text ?? '' })),
      );
    } catch (error) {
      // Deletion cancelled this turn; the mailbox goes with the guest.
      if (stopped) return;
      await commit(
        withEffect(
          number,
          dispositionOf(state.effects[number], classifyTurnFailure(error)),
        ),
      );
    } finally {
      inFlight = undefined;
      cancelTimeout();
    }
  };

  /**
   * The reply precedes the record that says it was sent, so a crash between
   * them finds the reply's outgoing copy instead of sending another.
   *
   * @param {any} message
   * @param {any} record
   * @param {any[]} mail
   */
  const finish = async (message, record, mail) => {
    const number = String(message.number);
    const isOurReply = candidate =>
      candidate.replyTo === message.messageId &&
      formulaIdOfLocator(candidate.from) === selfId;
    await null;
    if (record.state === 'replying') {
      if (!mail.some(isOurReply) && record.text !== '') {
        await E(guest).reply(message.number, harden([record.text]), [], []);
      }
      await commit(withEffect(number, harden({ state: 'replied' })));
    }
    const after = await E(guest).listMessages();
    for (const copy of after.filter(isOurReply)) {
      // eslint-disable-next-line no-await-in-loop
      await E(guest).dismiss(copy.number);
    }
    await E(guest).dismiss(message.number);
    await commit(withoutEffects([number]));
  };

  /** @returns {Promise<boolean>} Whether another pass may find more work. */
  const step = async () => {
    await null;
    if (stopped || state.paused) return false;
    const mail = await E(guest).listMessages();
    const byNumber = new Map(mail.map(message => [String(message.number), message]));
    const gone = Object.keys(state.effects).filter(
      number => !byNumber.has(number),
    );
    if (gone.length > 0) await commit(withoutEffects(gone));

    const records = Object.entries(state.effects).sort(([left], [right]) =>
      compareNumbers(left, right),
    );
    for (const [number, record] of records) {
      if (record.state === 'replying' || record.state === 'replied') {
        // eslint-disable-next-line no-await-in-loop
        await finish(byNumber.get(number), record, mail);
        return true;
      }
    }

    const nowMs = nowMillis();
    const deadlineOf = ({ firstRefusedAtMs }) =>
      firstRefusedAtMs === undefined
        ? Number.POSITIVE_INFINITY
        : firstRefusedAtMs + maximumDeferralMs;
    const expired = records.filter(
      ([_number, record]) =>
        // eslint-disable-next-line @endo/restrict-comparison-operands
        record.state === 'deferred' && deadlineOf(record) <= nowMs,
    );
    if (expired.length > 0) {
      await commit(prior => {
        const effects = { ...prior.effects };
        for (const [number, { code }] of expired) {
          effects[number] = harden({
            state: 'refused',
            code: 'retry-exhausted',
            lastCode: code,
          });
        }
        return { ...prior, effects };
      });
      return true;
    }
    const deferred = records.filter(
      ([_number, { state: kind }]) => kind === 'deferred',
    );
    // eslint-disable-next-line @endo/restrict-comparison-operands
    const due = deferred.find(([_number, { retryAtMs }]) => retryAtMs <= nowMs);
    if (due !== undefined) {
      await answer(byNumber.get(due[0]));
      return true;
    }

    const next = mail
      .filter(
        message =>
          isInbound(message) &&
          state.effects[String(message.number)] === undefined &&
          (state.cursor === undefined ||
            compareNumbers(String(message.number), state.cursor) > 0),
      )
      .sort((left, right) =>
        compareNumbers(String(left.number), String(right.number)),
      )[0];
    if (next !== undefined) {
      await answer(next);
      return true;
    }

    if (deferred.length > 0) {
      const earliest = Math.min(
        ...deferred.map(([_number, record]) =>
          Math.min(record.retryAtMs, deadlineOf(record)),
        ),
      );
      cancelTimer?.();
       
      cancelTimer = schedule(Math.min(earliest - nowMs, HOUR), pump);
    }
    return false;
  };

  /** Mail, timers, and owner actions all wake this one single-flight loop. */
  const pump = () => {
    if (stopped) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    const run = async () => {
      await null;
      try {
        do {
          pumpAgain = false;
          // eslint-disable-next-line no-await-in-loop
          while (await step());
        } while (pumpAgain);
      } catch (error) {
        logError('Agent responder pass failed', error);
        cancelTimer?.();
        cancelTimer = schedule(initialBackoffMs, pump);
      } finally {
        pumping = false;
      }
    };
    void run();
  };

  return harden({
    /** Call on any mailbox activity. A paused responder ignores it. */
    notify: pump,
    /**
     * @param {boolean} paused
     * @param {string} [startAfter] Mail at or below this was confirmed skipped.
     */
    setPaused: async (paused, startAfter) => {
      if (
        state.paused !== paused ||
        laterOf(state.cursor, startAfter) !== state.cursor
      ) {
        await commit(prior => ({
          ...prior,
          paused,
          cursor: laterOf(prior.cursor, startAfter),
        }));
      }
      if (!paused) pump();
    },
    /**
     * The owner's view. Mail already dismissed is not listed, even before the
     * next pass prunes its record.
     */
    describe: async () => {
      const mail = await E(guest).listMessages();
      const present = new Set(mail.map(message => String(message.number)));
      const listed = kind =>
        harden(
          Object.entries(state.effects)
            .filter(
              ([number, record]) =>
                record.state === kind && present.has(number),
            )
            .sort(([left], [right]) => compareNumbers(left, right)),
        );
      return harden({
        paused: state.paused,
        ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
        deferred: listed('deferred').map(([number, record]) =>
          harden({
            number,
            code: record.code,
            attempts: record.attempts,
            retryAt: new Date(record.retryAtMs).toISOString(),
          }),
        ),
        refused: listed('refused').map(([number, record]) =>
          harden({ number, code: record.code }),
        ),
      });
    },
    /**
     * One fresh admission, resetting the attempt count. With wake off it is
     * recorded and waits, because no retry runs while paused.
     *
     * @param {string} number
     */
    retry: async number => {
      const record = state.effects[number];
      if (record?.state !== 'deferred' && record?.state !== 'refused') {
        throw makeError(
          X`Agent operation failed: ${q('message-not-retryable')}`,
        );
      }
      await commit(
        withEffect(
          number,
          harden({
            state: 'deferred',
            code: record.code,
            attempts: 0,
            retryAtMs: nowMillis(),
          }),
        ),
      );
      pump();
    },
    /** Stop, cancelling a turn in flight. */
    stop: () => {
      stopped = true;
      cancelTimer?.();
      inFlight?.abort(Error('Agent responder stopped'));
    },
  });
};
harden(makeAgentResponder);
