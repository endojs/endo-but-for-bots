// @ts-check
// Test helpers for W1b.2 (context cache): a simulated session record log
// with the real record log and ContextSource (guest code under the Node
// prelude), producing RoundRequests the way turn.js does (append = every
// record since the previous request; `append: []` when told to fall back).
// Import after the guest prelude.
/* eslint-disable import/no-relative-packages */
import { makeRecordLog, inCallOrder } from '../../guest/session/records.js';
import { makeContextSource } from '../../guest/session/context-source.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

/**
 * Small seeded PRNG (Park-Miller; products stay below 2 ** 53).
 * @param {number} seed
 */
export const makeRandom = seed => {
  let a = (Math.abs(Math.floor(seed)) % 2_147_483_646) + 1;
  const next = () => {
    a = (a * 16_807) % 2_147_483_647;
    return (a - 1) / 2_147_483_646;
  };
  return {
    next,
    /** @param {number} p */
    chance: p => next() < p,
    /** @param {number} n */
    int: n => Math.floor(next() * n),
  };
};

export const USAGE = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/**
 * @typedef {object} SimOptions
 * @property {number} [seed]
 * @property {any} [store] a BlobStore; without one nothing is staged
 * @property {number} [stagedChance] probability that a text field is staged
 * @property {number} [interruptedChance] turn settled without Dispatched
 * @property {number} [cancelChance] a round ends with a Partial, turn cancelled
 * @property {number} [unknownChance] turn ends outcome-unknown after tools
 * @property {number} [toolChance] a round has tool calls
 * @property {number} [maxCalls]
 * @property {number} [nativeChance] a settled round has a native context
 * @property {number} [textUnits] typical text size
 */

/** @param {SimOptions} [options] */
export const makeSessionSim = ({
  seed = 1,
  store,
  stagedChance = 0.2,
  interruptedChance = 0.08,
  cancelChance = 0.08,
  unknownChance = 0.05,
  toolChance = 0.5,
  maxCalls = 5,
  nativeChance = 0.3,
  textUnits = 40,
} = {}) => {
  const random = makeRandom(seed);
  const records = makeRecordLog();
  const source = makeContextSource({ records });
  const session = Far('Session', {});
  let sent = 0;
  let turns = 0;
  let at = 1_700_000_000_000;

  /** @param {string} prefix */
  const words = prefix => {
    const units = 1 + random.int(textUnits);
    return `${prefix} ${'abcdefghij'.repeat(Math.ceil(units / 10)).slice(0, units)} é😀`;
  };
  /**
   * @param {string} text
   * @param {number} previewUnits
   * @param {boolean} [always]
   */
  const field = async (text, previewUnits, always = false) =>
    store !== undefined && (always || random.chance(stagedChance))
      ? store.stage(text, { previewUnits })
      : text;

  /**
   * A RoundRequest's cache-relevant part, as turn.js builds it.
   * @param {string} turnId
   * @param {number} round
   * @param {boolean} [fallback] send `append: []` (records did not fit)
   */
  const request = (turnId, round, fallback = false) => {
    const from = sent;
    const to = records.count();
    sent = to;
    if (fallback) {
      return harden({
        turnId,
        round,
        base: { count: to, epoch: 0 },
        append: [],
        context: source,
      });
    }
    return harden({
      turnId,
      round,
      base: { count: from, epoch: 0 },
      append: inCallOrder(records.since(from)),
      context: source,
    });
  };

  /**
   * One turn; calls `onRequest` (awaited) at each point turn.js would send
   * a RoundRequest, in order.
   * @param {(req: any) => Promise<void>} onRequest
   * @param {{ fallbackChance?: number }} [options]
   */
  /* eslint-disable no-await-in-loop -- one record after another, in order */
  const turn = async (onRequest, { fallbackChance = 0.05 } = {}) => {
    turns += 1;
    const turnId = `t${turns}`;
    at += 1000;
    const send = async (/** @type {number} */ round) =>
      onRequest(request(turnId, round, random.chance(fallbackChance)));
    records.append({
      kind: 'turn-started',
      turnId,
      input: await field(words(`input ${turnId}`), 1024),
      at,
    });
    await send(0);
    if (random.chance(interruptedChance)) {
      records.append({
        kind: 'turn-settled',
        turnId,
        status: 'interrupted',
        at,
      });
      return;
    }
    records.append({ kind: 'dispatched', turnId, round: 0 });
    for (let round = 0; round < 4; round += 1) {
      if (random.chance(cancelChance)) {
        records.append({
          kind: 'partial',
          turnId,
          round,
          text: await field(words(`partial ${turnId}/${round}`), 1024),
        });
        records.append({
          kind: 'turn-settled',
          turnId,
          status: 'cancelled',
          at,
        });
        return;
      }
      const calls = random.chance(toolChance) ? 1 + random.int(maxCalls) : 0;
      /** @type {Record<string, any>} */
      const settled = {
        kind: 'round-settled',
        turnId,
        round,
        text: random.chance(0.2)
          ? ''
          : await field(words(`reply ${turnId}/${round}`), 1024),
        callCount: calls,
        usage: USAGE,
        at,
      };
      // A native context is always staged: only with a store.
      if (store !== undefined && random.chance(nativeChance)) {
        settled.nativeContext = await field(
          words(`native ${turnId}/${round}`),
          0,
          true,
        );
      }
      records.append(settled);
      if (calls === 0) {
        records.append({
          kind: 'turn-settled',
          turnId,
          status: 'completed',
          at,
        });
        return;
      }
      /** @type {any[]} */
      const intents = [];
      for (let i = 0; i < calls; i += 1) {
        intents.push(
          harden({
            opId: `${turnId}/${round}/${i}`,
            callId: '',
            name: 'echo',
            args: await field(
              JSON.stringify({ text: words(`args ${i}`) }),
              256,
            ),
          }),
        );
      }
      records.append({ kind: 'tool-intents', turnId, round, intents });
      const unknown = random.chance(unknownChance);
      // Results arrive in any order.
      const order = intents.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = random.int(i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
      const settledCount = unknown ? random.int(calls) : calls;
      for (const i of order.slice(0, settledCount)) {
        const failed = random.chance(0.1);
        records.append({
          kind: 'tool-result',
          turnId,
          opId: intents[i].opId,
          name: 'echo',
          result: await field(words(`result ${i}`), 256),
          failed,
        });
      }
      if (unknown) {
        for (const i of order.slice(settledCount)) {
          records.append({
            kind: 'tool-result',
            turnId,
            opId: intents[i].opId,
            name: 'echo',
            result: 'Tool outcome unknown; do not automatically retry.',
            failed: true,
            outcome: 'unknown',
          });
        }
        records.append({
          kind: 'turn-settled',
          turnId,
          status: 'outcome-unknown',
          at,
        });
        return;
      }
      await send(round + 1);
    }
    records.append({ kind: 'turn-settled', turnId, status: 'failed', at });
  };
  /* eslint-enable no-await-in-loop */

  return harden({
    records,
    source,
    session,
    turn,
    request,
    /** the next request's `from` (records sent so far) */
    sent: () => sent,
  });
};
