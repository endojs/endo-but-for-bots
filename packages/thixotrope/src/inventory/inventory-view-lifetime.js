// @ts-check
/** @import { NodePowers } from '../platform/node-powers.js' */
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * Keep pending guest operations in a scope that never contains a socket.
 * Merely omitting socket references from a nested callback is insufficient:
 * V8 shares captured bindings between closures created in the same scope.
 * @param {Pick<NodePowers, 'timers'>} powers
 * @param {any} inventory
 * @param {number} [cleanupGraceMs] local timer delay
 */
export const makeInventoryViewLifetime = (
  powers,
  inventory,
  cleanupGraceMs = 1000,
) => {
  const { setTimeout, clearTimeout } = powers.timers;
  let closed = false;
  let watching = false;
  /** @type {any} */
  let observer;
  /** @type {any} */
  let subscription;
  /** @type {((error: Error) => void) | undefined} */
  let rejectDelivery;
  let subscribing = Promise.resolve();
  /** @type {Promise<void> | undefined} */
  let disconnecting;
  const bridge = Far('EphemeralInventoryObserver', {
    /** @param {any} update */
    changed: update => {
      if (closed) throw Error('Inventory view disconnected');
      return new Promise((accept, reject) => {
        rejectDelivery = reject;
        void E(observer)
          .changed(update)
          .then(
            value => {
              rejectDelivery = undefined;
              accept(value);
            },
            error => {
              rejectDelivery = undefined;
              reject(error);
            },
          );
      });
    },
  });
  const subscribe = async () => {
    subscription = await E(inventory).subscribe(bridge, true);
  };
  const cancelSubscription = async () => {
    await subscribing.catch(() => {});
    if (subscription) {
      const previous = subscription;
      subscription = undefined;
      await E(previous).unsubscribe();
    }
  };
  return harden({
    /** @param {any} listener */
    watch: listener => {
      if (closed) throw Error('Connection is closing');
      if (watching)
        throw Error('This connection already has an inventory view');
      watching = true;
      observer = listener;
      subscribing = subscribe();
      return subscribing;
    },
    disconnect: () => {
      if (!disconnecting) {
        closed = true;
        observer = undefined;
        rejectDelivery?.(Error('Inventory view disconnected'));
        rejectDelivery = undefined;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        disconnecting = Promise.race([
          cancelSubscription(),
          new Promise(resolve => {
            timer = setTimeout(() => resolve(undefined), cleanupGraceMs);
          }),
        ]).finally(() => clearTimeout(timer));
      }
      return disconnecting;
    },
  });
};
harden(makeInventoryViewLifetime);
