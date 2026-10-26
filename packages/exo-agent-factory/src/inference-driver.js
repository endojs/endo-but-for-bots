// @ts-check

/* eslint-disable no-await-in-loop, no-continue */

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { M } from '@endo/patterns';

const neverCancelled = new Promise(() => {});
const InferenceDriverInterface = M.interface('InferenceDriver', {});

/**
 * Ephemeral mail runner for the inference adapter. The durable turn ledger and
 * keyed reply publication are deliberately a later layer; this module owns no
 * credential and receives only the child-scoped inference capability.
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
    const [agent, inference, lifecycle] = await Promise.all([
      E(powers).lookup('agent'),
      E(powers).lookup('inference'),
      E(powers).lookup('agent-lifecycle'),
    ]);
    const messages = iterateReader(E(agent).followMessages());
    for (;;) {
      if (!(await E(lifecycle).isActive())) break;
      const { value, done } = await messages.next();
      if (done) break;
      const message =
        /** @type {{ type?: string, done?: boolean, strings: string[], number: bigint }} */ (
          value
        );
      if (message.type !== 'package' || message.done === false) continue;
      const prompt = message.strings.join('');
      const result = await E(inference).infer(
        harden({
          prompt,
          promptOrigin: 'guest-influenced',
          limits: harden({
            maxWallClockMs: Number(environment.MAX_WALL_CLOCK_MS ?? 300_000),
            maxOutputBytes: Number(environment.MAX_OUTPUT_BYTES ?? 1_000_000),
            maxTurns: Number(environment.MAX_TURNS ?? 32),
          }),
          cancelled: neverCancelled,
          ...(environment.MODEL ? { model: environment.MODEL } : {}),
        }),
      );
      const text =
        result.type === 'ok'
          ? result.text
          : `Inference did not complete (${result.type}).`;
      await E(agent).reply(message.number, [text], [], []);
      await E(agent).dismiss(message.number);
    }
  };
  start().catch(() => {});
  return makeExo('InferenceDriver', InferenceDriverInterface, {});
};
harden(make);
