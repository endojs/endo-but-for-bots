// @ts-check

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

/**
 * @import { PrivateHost } from './coordinator.js'
 */

/**
 * The port's formula-type vocabulary for the daemon formula types the
 * coordinator proves. Any other type passes through unchanged, so it can
 * never match an expected `guest` or `unconfined`.
 *
 * @type {Record<string, string>}
 */
const portTypes = harden({
  guest: 'guest',
  'make-unconfined': 'unconfined',
  eval: 'eval',
});

/**
 * Adapt the coordinator's own powers, the dedicated `agent-factory` child
 * host, to the `PrivateHost` port.
 *
 * Formula type and powers are read from the host's diagnostics facet, which
 * reports a formula's construction record without reviving it. That is how a
 * replay proves an unconfined caplet at a derived name was formulated over
 * the recorded driver guest.
 *
 * @param {any} powers - The coordinator's `EndoHost`.
 * @returns {PrivateHost}
 */
export const makeDaemonPrivateHost = powers => {
  const diagnostics = E(powers).diagnostics();

  /** @param {string[]} path */
  const recordAt = async path => {
    const id = await E(powers).identify(...path);
    if (id === undefined) return undefined;
    return E(diagnostics).getFormula(id);
  };

  return Far('PrivateHost', {
    /** @param {string[]} path */
    has: (...path) => E(powers).has(...path),
    /** @param {string[]} path */
    lookup: (...path) => E(powers).lookup(path),
    /** @param {string[]} path */
    list: (...path) => E(powers).list(...path),
    /** @param {string[]} path */
    identify: (...path) => E(powers).identify(...path),
    /** @param {string[]} path */
    async formulaType(...path) {
      const record = await recordAt(path);
      if (record === undefined) return undefined;
      return portTypes[record.type] ?? record.type;
    },
    /** @param {string[]} path */
    async powersOf(...path) {
      const record = await recordAt(path);
      const property = record?.properties.powers;
      return property?.kind === 'reference' ? property.identifier : undefined;
    },
    /**
     * @param {any} value
     * @param {string | string[]} path
     */
    storeValue: (value, path) => E(powers).storeValue(value, path),
    /**
     * @param {string[]} from
     * @param {string[]} to
     */
    copy: (from, to) => E(powers).copy(from, to),
    /** @param {string[]} path */
    remove: (...path) => E(powers).remove(...path),
    /** @param {string[]} path */
    cancel: (...path) => E(powers).cancel(path),
    // Only the agent is named. Naming its handle too would be a second write
    // that a crash could separate from the first, and `provideGuest` adopts
    // whatever a handle name already holds.
    /** @param {string} name */
    provideGuest: name =>
      E(powers).provideGuest(undefined, { agentName: name }),
    /**
     * @param {string} specifier
     * @param {{ powersName: string, resultName: string,
     *   env?: Record<string, string> }} options
     */
    makeUnconfined: (specifier, { powersName, resultName, env }) =>
      E(powers).makeUnconfined(undefined, specifier, {
        powersName,
        resultName,
        ...(env ? { env } : {}),
      }),
  });
};
harden(makeDaemonPrivateHost);
