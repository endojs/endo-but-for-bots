// @ts-check
import { E } from '@endo/far';
import harden from '@endo/harden';

import { makeSerialQueue } from './serial-queue.js';

/**
 * A durable manager's hold on one disposable incarnation.
 * Creation and restoration are supplied by the manager; the keeper knows
 * neither the resource kind nor the process implementation.
 * All probes and replacements share a queue, including concurrent failures.
 * @param {object} options
 * @param {() => Promise<{adapter: any, retire: () => Promise<unknown>}>} options.create
 * @param {(adapter: any) => Promise<unknown>} [options.restore]
 */
export const makeAdapterKeeper = ({ create, restore = async () => {} }) => {
  /** @type {{adapter: any, retire: () => Promise<unknown>} | undefined} */
  let current;
  const enqueue = makeSerialQueue();
  return harden({
    provide: () =>
      enqueue(async () => {
        await null;
        if (current) {
          try {
            // eslint-disable-next-line no-underscore-dangle
            await E(current.adapter).__getMethodNames__();
            return current.adapter;
          } catch (_error) {
            // Retirement completes before a successor can acquire its resources.
            await current.retire().catch(() => {});
            current = undefined;
          }
        }
        const next = await create();
        try {
          await restore(next.adapter);
        } catch (error) {
          await next.retire();
          throw error;
        }
        current = next;
        return next.adapter;
      }),
    retire: () =>
      enqueue(async () => {
        const dying = current;
        current = undefined;
        if (!dying) return false;
        await dying.retire();
        return true;
      }),
    /**
     * The incarnation this keeper holds right now, or undefined when there is
     * none. Neither probes nor builds: for an operation that only has to undo
     * something in a live adapter, an absent adapter means nothing to undo.
     */
    current: () => current?.adapter,
  });
};
harden(makeAdapterKeeper);
