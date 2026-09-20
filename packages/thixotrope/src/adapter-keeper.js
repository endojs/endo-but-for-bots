// @ts-check
import { E } from '@endo/far';
import harden from '@endo/harden';

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
  let incarnations = 0n;
  let building = false;
  let chain = Promise.resolve();
  /** @param {() => Promise<any>} operation */
  const enqueue = operation => {
    const result = chain.then(operation);
    chain = result.then(
      () => {},
      () => {},
    );
    return result;
  };
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
        building = true;
        try {
          const next = await create();
          try {
            await restore(next.adapter);
          } catch (error) {
            await next.retire();
            throw error;
          }
          current = next;
          incarnations += 1n;
          return next.adapter;
        } finally {
          building = false;
        }
      }),
    retire: () =>
      enqueue(async () => {
        const dying = current;
        current = undefined;
        if (!dying) return false;
        await dying.retire();
        return true;
      }),
    status: () =>
      harden({ incarnations, live: current !== undefined, building }),
  });
};
harden(makeAdapterKeeper);
