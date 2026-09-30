// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * @typedef {'application' | 'native'} InstallationKind
 *
 * @typedef {object} Installation
 * @property {InstallationKind} kind
 * @property {string} digest identifies the exact code installed
 * @property {string} signature the canonical grant mapping
 * @property {Array<[string, string]>} grants
 * @property {string} allocationKey the host's idempotent vat allocation key
 * @property {Record<string, unknown>} powers the granted capabilities,
 *   resolved once when the name was reserved
 * @property {string | undefined} workerId
 * @property {any} worker the vat's facade, held until the installation is
 *   complete so an unfinished one stays rooted; dropped once its public
 *   value is in the inventory, which then retains the vat the ordinary way
 * @property {'pending' | 'ready' | 'failed'} status
 * @property {string | undefined} error
 * @property {any} acquiring the host answer for the vat's evaluator while
 *   an application's factory call is being sent; cleared once sent or broken
 * @property {any} result an application's factory result, a guest-to-guest
 *   promise so that a factory still pending across a host restart settles
 *   afterwards
 * @property {any} value the public value the inventory holds for the name
 * @property {boolean} complete
 */

/**
 * The workspace's record of everything installed into it, of every kind:
 * applications, whose factory runs in a fresh vat with the capabilities they
 * were granted, and native resources, whose manager runs in a fresh vat with
 * an adapter launcher. One name, one code digest, one grant mapping, one
 * allocation key, one vat, one outcome.
 *
 * The host drives the phases, and each is durable in this heap, so an
 * interrupted installation resumes on an explicit retry with the same
 * identity: `prepare` reserves the name and resolves its grants, `attach`
 * records the vat the host allocated, then `start` (an application: run the
 * factory, guest to guest) or `finish` (a native resource: the host hands
 * over the registration facet) puts the public value into the inventory.
 * `fail` records a factory that threw; the failure stays until the name is
 * removed. Removal is the host's too, since the vat must be retired first:
 * `lookup` names it, and `remove` forgets the name once the vat is gone,
 * taking the value out of the inventory only if the inventory still holds it.
 *
 * Self-contained: this factory's source is evaluated in the workspace vat,
 * where only E, Far and harden are in scope.
 *
 * @param {any} inventory
 */
export const makeInstallations = inventory => {
  /** @type {Map<string, Installation>} */
  const installed = new Map();

  /** @param {unknown} name */
  const assertName = name => {
    if (typeof name !== 'string' || !name.length)
      throw Error('Expected an inventory name');
  };
  // Remote-controlled text: bound it here as well as at display.
  /** @param {unknown} reason */
  const describeError = reason => String(reason).slice(0, 512);
  /**
   * @param {string} name
   * @param {string} digest
   */
  const entryFor = (name, digest) => {
    const entry = installed.get(name);
    if (!entry || entry.digest !== digest)
      throw Error('Installation name has a different installation');
    return entry;
  };
  /**
   * @param {unknown} grants
   * @returns {Array<[string, string]>}
   */
  const canonicalGrants = grants => {
    if (!Array.isArray(grants)) throw Error('Expected a grant list');
    const names = new Set();
    for (const grant of grants) {
      if (
        !Array.isArray(grant) ||
        grant.length !== 2 ||
        grant.some(part => typeof part !== 'string')
      )
        throw Error('Expected [power name, inventory key] grants');
      const [power] = grant;
      if (names.has(power)) throw Error('Duplicate power name');
      names.add(power);
    }
    return harden(
      [...grants]
        .map(([power, key]) => /** @type {[string, string]} */ ([power, key]))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  };
  /**
   * Admit only remotable capabilities, not potentially large copy data; the
   * wire marshaller validates the complete pass style when they travel.
   * @param {Array<[string, string]>} grants
   */
  const resolvePowers = grants => {
    /** @type {Record<string, unknown>} */
    const powers = {};
    for (const [power, key] of grants) {
      if (!inventory.has(key)) throw Error('Unknown inventory grant');
      const value = inventory.get(key);
      if (
        value === null ||
        (typeof value !== 'object' && typeof value !== 'function') ||
        value[Symbol.for('passStyle')] !== 'remotable'
      )
        throw Error('Installation grants must be remotable capabilities');
      Object.defineProperty(powers, power, { value, enumerable: true });
    }
    return harden(powers);
  };
  /**
   * The public value takes the name only if nothing else took it meanwhile;
   * a concurrent inventory edit wins, and the installation reports it.
   * @param {string} name
   * @param {Installation} entry
   * @param {unknown} value
   */
  const publish = (name, entry, value) => {
    if (inventory.has(name))
      throw Error('Inventory name became occupied during installation');
    inventory.set(name, value);
    entry.value = value;
    entry.status = 'ready';
    entry.error = undefined;
    entry.worker = undefined;
    entry.complete = true;
  };

  return Far('Installations', {
    help: () =>
      'The workspace record of installed applications and native resources: prepare(name, kind, digest, allocationKey, grants), attach(name, digest, workerId, worker), start(name, digest), finish(name, digest, value), fail(name, digest, error), lookup(name), remove(name), list(). Installed values live in the inventory under their names.',
    /**
     * Reserve a name for one installation, or find the reservation a retry
     * is resuming: the same kind, code and grants, else refused.
     * @param {string} name
     * @param {InstallationKind} kind
     * @param {string} digest
     * @param {string} allocationKey
     * @param {Array<[string, string]>} [grants]
     */
    prepare: (name, kind, digest, allocationKey, grants = []) => {
      assertName(name);
      if (kind !== 'application' && kind !== 'native')
        throw Error('Unknown installation kind');
      if (typeof digest !== 'string' || typeof allocationKey !== 'string')
        throw Error('Expected a code digest and an allocation key');
      const canonical = canonicalGrants(grants);
      const signature = JSON.stringify(canonical);
      let entry = installed.get(name);
      if (entry) {
        if (
          entry.kind !== kind ||
          entry.digest !== digest ||
          entry.signature !== signature
        )
          throw Error('Installation name has a different installation');
      } else {
        if (inventory.has(name))
          throw Error('Inventory name is already occupied');
        entry = {
          kind,
          digest,
          signature,
          grants: canonical,
          allocationKey,
          powers: resolvePowers(canonical),
          workerId: undefined,
          worker: undefined,
          status: 'pending',
          error: undefined,
          acquiring: undefined,
          result: undefined,
          value: undefined,
          complete: false,
        };
        installed.set(name, entry);
      }
      return harden({
        allocationKey: entry.allocationKey,
        workerId: entry.workerId,
        complete: entry.complete,
      });
    },
    /**
     * Record the vat the host allocated for the name.
     * @param {string} name
     * @param {string} digest
     * @param {string} workerId
     * @param {any} worker the vat's facade
     */
    attach: (name, digest, workerId, worker) => {
      const entry = entryFor(name, digest);
      if (entry.workerId !== undefined && entry.workerId !== workerId)
        throw Error('Installation allocation changed');
      entry.workerId = workerId;
      if (!entry.complete) entry.worker = worker;
    },
    /**
     * Run an application's factory in its vat, once. The evaluator is a host
     * answer, so acquiring it can be broken by a host restart and is retried
     * by the next `start`; the factory call is then sent to the acquired
     * evaluator directly, guest to guest, so a factory still pending when the
     * host restarts settles afterwards. The send and the record of it are one
     * crank, and the vat memoises the call as well, so no retry runs the
     * factory twice. The factory's settlement is memoised, failure included;
     * putting the root into the inventory is attempted when it settles and
     * again by any later `start`, so a name that was occupied at the time is
     * taken once it is free. Resolves to the application's root.
     * @param {string} name
     * @param {string} digest
     */
    start: (name, digest) => {
      const entry = entryFor(name, digest);
      if (entry.kind !== 'application')
        throw Error('Only an application is started');
      if (entry.workerId === undefined)
        throw Error('Installation has not been allocated');
      /** @param {unknown} root */
      const published = root => {
        // A name removed while its factory ran is not written to: the vat is
        // retired before the name is forgotten, so this is unreachable in
        // practice, but the record says so itself.
        if (installed.get(name) === entry && !entry.complete) {
          try {
            publish(name, entry, root);
          } catch (error) {
            entry.status = 'failed';
            entry.error = describeError(error);
            throw error;
          }
        }
        return root;
      };
      if (entry.result !== undefined) return entry.result.then(published);
      if (entry.acquiring === undefined) {
        entry.acquiring = E(entry.worker)
          .getEvaluator()
          .then(
            evaluator => {
              entry.acquiring = undefined;
              if (entry.result === undefined) {
                // A failure recorded by an earlier attempt's staging is
                // superseded: the factory is running now.
                entry.status = 'pending';
                entry.error = undefined;
                entry.result = E(evaluator)
                  .evaluate(
                    '(globalThis.installed ??= installation.namespace.make(powers))',
                    { powers: entry.powers },
                  )
                  .catch(error => {
                    entry.status = 'failed';
                    entry.error = describeError(error);
                    throw error;
                  });
                // The first publication rides the settlement itself, so it
                // needs no further host call; a discarded result must not
                // become an unhandled rejection.
                void entry.result.then(published).catch(() => {});
              }
              return entry.result.then(published);
            },
            error => {
              entry.acquiring = undefined;
              throw error;
            },
          );
      }
      return entry.acquiring;
    },
    /**
     * Put a native resource's registration facet into the inventory.
     * @param {string} name
     * @param {string} digest
     * @param {any} value
     */
    finish: (name, digest, value) => {
      const entry = entryFor(name, digest);
      if (entry.kind !== 'native')
        throw Error('Only a native resource is finished');
      if (entry.complete) return;
      if (entry.workerId === undefined)
        throw Error('Installation has not been allocated');
      publish(name, entry, value);
    },
    /**
     * Record that the code's factory threw. The name stays taken, and the
     * failure inspectable, until the installation is removed.
     * @param {string} name
     * @param {string} digest
     * @param {string} error
     */
    fail: (name, digest, error) => {
      const entry = entryFor(name, digest);
      if (entry.complete || entry.result !== undefined) return;
      entry.status = 'failed';
      entry.error = describeError(error);
    },
    /**
     * The vat behind a name, for the host to retire; undefined for a name
     * this registry does not hold.
     * @param {string} name
     */
    lookup: name => {
      const entry = installed.get(name);
      if (!entry) return undefined;
      return harden({
        kind: entry.kind,
        workerId: entry.workerId,
        complete: entry.complete,
      });
    },
    /**
     * Forget a name whose vat the host has retired. The inventory entry goes
     * only if it is still this installation's value; a value the user put
     * there since is theirs. Returns whether the name was held.
     * @param {string} name
     */
    remove: name => {
      const entry = installed.get(name);
      if (!entry) return false;
      installed.delete(name);
      if (entry.complete && inventory.get(name) === entry.value)
        inventory.delete(name);
      return true;
    },
    list: () =>
      harden(
        [...installed].map(([name, { kind, digest, grants, status, error }]) =>
          harden({ name, kind, digest, grants, status, error }),
        ),
      ),
  });
};
harden(makeInstallations);
