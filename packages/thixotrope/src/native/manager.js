// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * Evaluated only in the dedicated manager vat. Keep even a failed synchronous
 * factory attempt so retrying an interrupted installation never executes it twice.
 * @param {() => any} load module evaluation is deferred until the first attempt
 * @param {any} makeKeeper
 * @param {any} adapters
 */
export const makeNativeManager = (load, makeKeeper, adapters) => {
  try {
    const namespace = load();
    if (typeof namespace.make !== 'function')
      throw Error('Native durable module must export make(powers)');
    const kit = namespace.make(harden({ E, Far, makeKeeper, adapters }));
    if (
      !kit ||
      kit.registration?.[Symbol.for('passStyle')] !== 'remotable' ||
      kit.lifecycle?.[Symbol.for('passStyle')] !== 'remotable'
    ) {
      throw Error(
        'Native durable module must return registration and lifecycle facets synchronously',
      );
    }
    return harden({
      kit: harden({ registration: kit.registration, lifecycle: kit.lifecycle }),
    });
  } catch (error) {
    // Store a printable failure as well as the failed attempt, not a rejected
    // promise or a foreign value that could itself fail to marshal.
    return harden({ error: String(error) });
  }
};
harden(makeNativeManager);
