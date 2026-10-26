// @ts-check

// Durable turn publication shared by provider adapters.

/* eslint-disable no-await-in-loop */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { Fail, q } from '@endo/errors';
import { InferResultShape } from '@endo/inference/guards.js';
import { mustMatch } from '@endo/patterns';

/**
 * @import {
 *   GuestToolProjection,
 *   InferLimits,
 *   InferRequest,
 *   InferResult,
 *   InferenceBackend,
 * } from '@endo/inference/types.js'
 */

/**
 * @typedef {object} TurnLedgerPort
 * @property {(...path: string[]) => Promise<boolean>} has
 * @property {(...path: string[]) => Promise<any>} lookup
 * @property {(value: any, path: string | string[]) => Promise<void>} storeValue
 */

/**
 * @typedef {object} MailboxPort
 * @property {(...path: string[]) => Promise<string | undefined>} locate
 * @property {() => Promise<any>} followMessages
 * @property {(messageNumber: bigint, strings: string[], edgeNames: string[],
 *   petNames: string[]) => Promise<void>} reply
 */

/**
 * @typedef {object} AgentLifecycle
 * @property {() => boolean | Promise<boolean>} isActive
 */

/**
 * @typedef {object} StampedMessage
 * @property {bigint} number
 * @property {string} from
 * @property {string[]} [strings]
 */

/** @param {bigint} key */
const turnNames = key => {
  key >= 0n || Fail`Turn key must be a natural message number, got ${key}`;
  const stem = `turn-${key}`;
  return harden({
    started: `${stem}-started`,
    result: `${stem}-result`,
    published: `${stem}-published`,
  });
};

/**
 * Render an inference result without consulting live provider state. A replay
 * applies this same total function to the recorded result, so a duplicate
 * publication is byte-identical to the first one.
 *
 * @param {InferResult} result
 * @returns {string[]}
 */
export const stringsForInferResult = result => {
  switch (result.type) {
    case 'ok':
      return harden([result.text]);
    case 'needs-auth':
      return harden(['Inference needs authentication.']);
    case 'usage-exhausted':
      return harden(['Inference usage is exhausted.']);
    case 'rate-limited':
      return harden(['Inference is rate limited.']);
    case 'budget-exhausted':
      return harden(['Inference budget is exhausted.']);
    case 'limit-exceeded':
      return harden([`Inference limit exceeded: ${result.which}.`]);
    case 'cancelled':
      return harden(['Inference was cancelled.']);
    case 'needs-containment':
      return harden(['Inference needs containment.']);
    case 'unavailable':
      return harden([`Inference unavailable: ${result.detail}`]);
    default:
      throw Fail`Unknown inference result type ${q(/** @type {any} */ (result).type)}`;
  }
};
harden(stringsForInferResult);

/**
 * Make the durable part of an agent driver's mailbox loop.
 *
 * `ledger` is normally the driver guest: the coordinator gives no other
 * component access to that directory. Each answered daemon message number is
 * its own key. The three records are append-only; `turn-cursor` is only a
 * convenience for adapters that want the greatest completed key.
 *
 * Publication uses the daemon's reply operation, which sends to the original
 * sender and writes the answered message's durable id into the wire
 * `replyTo` field. This avoids inventing correlation metadata or requiring the
 * sender to have a pet name in the child.
 *
 * @param {object} options
 * @param {MailboxPort} options.agent - The child's attenuated mailbox facet.
 * @param {TurnLedgerPort} options.ledger - The driver's private directory.
 * @param {AgentLifecycle} options.lifecycle
 * @param {InferenceBackend} options.inferenceBackend
 * @param {GuestToolProjection} options.guest
 * @param {InferLimits} options.limits
 * @param {PromiseLike<unknown>} options.cancelled
 * @param {string} [options.instructions]
 * @param {string} [options.model]
 */
export const makeTurnLedgerDriver = ({
  agent,
  ledger,
  lifecycle,
  inferenceBackend,
  guest,
  limits,
  cancelled,
  instructions = '',
  model,
}) => {
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /** @param {bigint} key */
  const advanceCursor = async key => {
    await null;
    if (await E(ledger).has('turn-cursor')) {
      const cursor = /** @type {{ type: string, key: bigint }} */ (
        await E(ledger).lookup('turn-cursor')
      );
      (cursor.type === 'Cursor' && typeof cursor.key === 'bigint') ||
        Fail`Invalid turn cursor`;
      if (cursor.key >= key) return;
    }
    await E(ledger).storeValue(harden({ type: 'Cursor', key }), 'turn-cursor');
  };

  /** @param {StampedMessage} message */
  const processTurn = async message => {
    await null;
    const { number: key } = message;
    typeof key === 'bigint' || Fail`Message number must be a bigint`;
    const names = turnNames(key);

    if (await E(ledger).has(names.published)) {
      await advanceCursor(key);
      return false;
    }

    /** @type {InferResult} */
    let result;
    if (await E(ledger).has(names.result)) {
      const record = await E(ledger).lookup(names.result);
      (record.type === 'TurnResult' && record.key === key) ||
        Fail`Invalid result record for turn ${key}`;
      result = record.result;
    } else {
      if (!(await E(ledger).has(names.started))) {
        await E(ledger).storeValue(
          harden({ type: 'TurnStarted', key }),
          names.started,
        );
      }
      const text = (message.strings || []).join('');
      const prompt = instructions ? `${instructions}\n\n${text}` : text;
      /** @type {InferRequest} */
      const request = harden({
        prompt,
        promptOrigin: 'guest-influenced',
        guest,
        limits,
        cancelled,
        ...(model === undefined ? {} : { model }),
      });
      result = await E(inferenceBackend).infer(request);
      mustMatch(result, InferResultShape, 'inference result');
      await E(ledger).storeValue(
        harden({ type: 'TurnResult', key, result }),
        names.result,
      );
    }

    await E(agent).reply(key, stringsForInferResult(result), [], []);
    await E(ledger).storeValue(
      harden({ type: 'Published', key }),
      names.published,
    );
    await advanceCursor(key);
    return true;
  };

  /** @param {StampedMessage} message */
  const process = message => {
    const result = queue.then(() => processTurn(message));
    queue = result.catch(() => {});
    return result;
  };

  const run = async () => {
    await null;
    if (!(await E(lifecycle).isActive())) return;
    const self = await E(agent).locate('@self');
    const reader = await E(agent).followMessages();
    for (;;) {
      const iteration = await E(reader).next();
      if (iteration.done) return;
      if (!(await E(lifecycle).isActive())) return;
      const message = /** @type {StampedMessage} */ (iteration.value);
      if (message.from !== self) await process(message);
    }
  };

  return harden({ process, run });
};
harden(makeTurnLedgerDriver);
