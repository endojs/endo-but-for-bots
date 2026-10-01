// @ts-check
import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';

/**
 * Evaluated only in the dedicated manager vat, so it may import only what the
 * guest prelude provides. Keep even a failed synchronous factory attempt so
 * retrying an interrupted installation never executes it twice.
 * @param {() => any} load module evaluation is deferred until the first attempt
 * @param {any} makeKeeper
 * @param {any} makeManagerKit the manager kit factory, bound here to this
 *   installation's launcher and keeper
 * @param {any} adapters
 * @param {Record<string, unknown>} [powers] what the installation was
 *   granted and provided, by name, beside the kit's own
 */
export const makeNativeManager = (
  load,
  makeKeeper,
  makeManagerKit,
  adapters,
  powers = harden({}),
) => {
  // A module's facets are checked, not marshalled: a value that is not even
  // passable is refused with the contract's message, not the marshaller's.
  /** @param {unknown} value */
  const isRemotable = value => {
    try {
      return passStyleOf(value) === 'remotable';
    } catch (_error) {
      return false;
    }
  };
  try {
    const namespace = load();
    if (typeof namespace.make !== 'function')
      throw Error('Native durable module must export make(powers)');
    for (const name of ['adapters', 'makeKeeper', 'makeManager']) {
      if (name in powers)
        throw Error(`A native module's power cannot be named ${name}`);
    }
    const kit = namespace.make(
      harden({
        ...powers,
        makeKeeper,
        adapters,
        /** @param {any} options */
        makeManager: options =>
          makeManagerKit({ adapters, makeKeeper }, options),
      }),
    );
    if (!kit || !isRemotable(kit.facet) || !isRemotable(kit.lifecycle)) {
      throw Error(
        'Native durable module must return its facet and lifecycle synchronously',
      );
    }
    if (
      typeof kit.lifecycle.started !== 'function' ||
      typeof kit.lifecycle.exited !== 'function'
    ) {
      throw Error(
        'Native durable module lifecycle must have started() and exited()',
      );
    }
    return harden({
      kit: harden({ facet: kit.facet, lifecycle: kit.lifecycle }),
    });
  } catch (error) {
    // Store a printable failure as well as the failed attempt, not a rejected
    // promise or a foreign value that could itself fail to marshal.
    return harden({ error: String(error) });
  }
};
harden(makeNativeManager);
