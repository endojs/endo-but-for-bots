// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { makeTurnLedgerDriver } from '../turn-ledger.js';

/** @import { StampedMessage } from '../turn-ledger.js' */

const neverCancelled = new Promise(() => {});
const InferenceDriverInterface = M.interface('InferenceDriver', {});

/**
 * Name under which the inference maker stores a child's instructions in the
 * driver guest, when the child has any.
 */
export const INSTRUCTIONS_NAME = 'instructions';
harden(INSTRUCTIONS_NAME);

/**
 * Name under which the inference maker stores itself in the driver guest. A
 * runner incarnation asks it for the child-scoped inference grant.
 */
export const INFERENCE_SOURCE_NAME = 'inference-source';
harden(INFERENCE_SOURCE_NAME);

/**
 * Accept only complete mail packages. Requests, evaluation proposals, and
 * partial packages are not turns.
 *
 * @param {StampedMessage} message
 */
const isCompletePackage = message =>
  message.type === 'package' && message.done !== false;

/**
 * Wait until the child is committed. The coordinator formulates the runner
 * before it commits the child, so a new runner usually starts inactive. A
 * runner revived during a removal never activates and never opens its
 * mailbox follower.
 *
 * @param {any} lifecycle
 * @returns {Promise<boolean>}
 */
const untilActive = async lifecycle => {
  await null;
  if (await E(lifecycle).isActive()) return true;
  const changes = E(lifecycle).followActive();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await E(changes).next();
    if (done) return false;
    if (value) return true;
  }
};

/**
 * Durable mail runner for the inference adapter. Its powers are the child's
 * driver guest, which doubles as the private turn ledger: each answered
 * message is journaled by number, a recorded result is republished without
 * calling inference again, and the reply carries the answered message's
 * number as `replyTo`. The runner owns no credential: it asks the maker
 * retained in its powers for the child-scoped inference capability.
 *
 * @param {any} powers
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (
  powers,
  _context,
  { env: environment = {} } = {},
) => {
  const start = async () => {
    const [agent, source, lifecycle, instructions] = await Promise.all([
      E(powers).lookup('agent'),
      E(powers).lookup(INFERENCE_SOURCE_NAME),
      E(powers).lookup('agent-lifecycle'),
      E(powers)
        .has(INSTRUCTIONS_NAME)
        .then(present =>
          present ? E(powers).lookup(INSTRUCTIONS_NAME) : undefined,
        ),
    ]);
    if (!(await untilActive(lifecycle))) return;
    const inference = await E(source).childInference(agent);
    const driver = makeTurnLedgerDriver({
      agent,
      ledger: powers,
      lifecycle,
      inferenceBackend: inference,
      limits: harden({
        maxWallClockMs: Number(environment.MAX_WALL_CLOCK_MS ?? 300_000),
        maxOutputBytes: Number(environment.MAX_OUTPUT_BYTES ?? 1_000_000),
        maxTurns: Number(environment.MAX_TURNS ?? 32),
      }),
      cancelled: neverCancelled,
      ...(typeof instructions === 'string' ? { instructions } : {}),
      ...(environment.MODEL ? { model: environment.MODEL } : {}),
      accepts: isCompletePackage,
      afterPublished: key => E(agent).dismiss(key),
    });
    await driver.run();
  };
  start().catch(() => {});
  return makeExo('InferenceDriver', InferenceDriverInterface, {});
};
harden(make);
