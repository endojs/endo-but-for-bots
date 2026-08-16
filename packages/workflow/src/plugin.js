// @ts-check

/**
 * The unconfined daemon plugin entry, in the `@endo/reminder` mold:
 * `make(powers, context, { env })` resolves everything it needs by name
 * through the agent-shaped `powers` granted at provisioning, builds the
 * delivery seam over daemon mail verbs, and returns the workflow
 * service.
 *
 * Provisioning expectations:
 *
 * - `E(powers).lookup('workflow-store')` -> a writable virtual-file-
 *   system directory backing the engine store.
 * - Participants are the capabilities the caller passes to `start`
 *   (typically looked up from the provisioning agent's namespace).
 * - Pin the service into `@pins` so `revivePins()` wakes it on daemon
 *   restart and recovery runs (see the reminder README's "@pins
 *   recipe").
 *
 * The delivery seam speaks to participants directly:
 *
 * - `request` targets an agent-shaped capability: it prefers a
 *   `request(description, attachments)` method and falls back to
 *   `notify(payload)`.
 * - `form` prefers a `form(description, fields)` method; hosts without
 *   one receive the form as a request whose settlement is the values
 *   record.
 * - `call` is a plain eventual send, with the idempotency options bag
 *   appended only for targets that declared `idempotent: true`.
 *
 * Timers use the unconfined worker's ambient `setTimeout` until
 * `@endo/reminder` absorbs scheduling (see the design's endo-reminder
 * dependency note).
 */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';

import { makeWorkflowEngine } from './engine.js';

/**
 * @param {any} powers agent-shaped powers with `lookup(name)`
 * @param {any} _context cancellation context (unused so far)
 * @param {{ env?: Record<string, string> }} [_options]
 */
export const make = async (powers, _context, _options = {}) => {
  const storeRoot = await E(powers).lookup('workflow-store');

  let idCounter = 0;
  const makeId = () => {
    idCounter += 1;
    return `${Date.now().toString(16)}-${idCounter}`;
  };

  const deliver = harden({
    /**
     * @param {any} target
     * @param {{ description?: string, attachments?: Record<string, unknown>, idempotencyKey: string }} payload
     */
    request: async (target, payload) => {
      // eslint-disable-next-line no-underscore-dangle -- CapTP introspection convention
      const methods = await E(target)
        .__getMethodNames__()
        .catch(() => []);
      if (methods.includes('request')) {
        return E(target).request(
          payload.description ?? '',
          payload.attachments ?? {},
        );
      }
      return E(target).notify(harden(payload));
    },
    /**
     * @param {any} target
     * @param {{ description?: string, fields?: unknown[], idempotencyKey: string }} payload
     */
    form: async (target, payload) => {
      // eslint-disable-next-line no-underscore-dangle -- CapTP introspection convention
      const methods = await E(target)
        .__getMethodNames__()
        .catch(() => []);
      if (methods.includes('form')) {
        return E(target).form(payload.description ?? '', payload.fields ?? []);
      }
      return E(target).request(payload.description ?? '', {
        fields: payload.fields ?? [],
      });
    },
    /**
     * @param {any} target
     * @param {string} method
     * @param {unknown[]} args
     * @param {{ idempotencyKey: string, idempotent?: boolean }} options
     */
    call: (target, method, args, options) => {
      const callArgs = options.idempotent
        ? [...args, harden({ idempotencyKey: options.idempotencyKey })]
        : args;
      return E(target)[method](...callArgs);
    },
    /**
     * @param {any} target
     * @param {string} method
     */
    attenuate: (target, method) => E(target)[method](),
  });

  const engine = await makeWorkflowEngine({
    storeRoot,
    deliver,
    now: () => Date.now(),
    makeId,
    makeTimer: (ms, fire) => {
      const handle = globalThis.setTimeout(fire, ms);
      return () => globalThis.clearTimeout(handle);
    },
  });

  return engine.service;
};
harden(make);
