// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * Self-contained factory evaluated in the persistent workspace compartment.
 * @param {any} controller
 * @param {any} inventory
 */
export const makeApplicationRegistry = (controller, inventory) => {
  /** @type {Map<string, any>} */
  const applications = new Map();
  return Far('Applications', {
    help: () =>
      'install(name, bundle, digest, grants), get(name), list(), remove(name). Installation captures its module and powers once.',
    /** @param {string} name @param {string} bundle @param {string} digest @param {Array<[string, string]>} grants */
    install: (name, bundle, digest, grants) => {
      if (
        typeof name !== 'string' ||
        !name.length ||
        typeof bundle !== 'string' ||
        typeof digest !== 'string' ||
        !Array.isArray(grants)
      )
        throw Error('Invalid application installation');
      const names = new Set();
      const powers = {};
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
        // Resolve grants only for a new installation below.
      }
      const canonicalGrants = [...grants].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const signature = JSON.stringify(canonicalGrants);
      const previous = applications.get(name);
      if (previous) {
        if (previous.digest !== digest || previous.signature !== signature)
          throw Error('Application name already has a different installation');
        return previous.result;
      }
      for (const [power, key] of grants) {
        if (!inventory.has(key)) throw Error('Unknown inventory grant');
        const value = inventory.get(key);
        // Admit only remotable capabilities, not potentially large copy data.
        // The wire marshaller subsequently validates the complete pass style.
        if (
          value === null ||
          (typeof value !== 'object' && typeof value !== 'function') ||
          value[Symbol.for('passStyle')] !== 'remotable'
        )
          throw Error('Application grants must be remotable capabilities');
        Object.defineProperty(powers, power, { value, enumerable: true });
      }
      /** @type {{ name: string, digest: string, signature: string, grants: Array<[string, string]>, status: string, error: string | undefined, result: any }} */
      const entry = {
        name,
        digest,
        signature,
        grants: harden(canonicalGrants),
        status: 'pending',
        error: undefined,
        result: undefined,
      };
      applications.set(name, entry);
      entry.result = E(controller)
        .createWorker(`app:${name}`)
        .then(worker => E(worker).getEvaluator())
        .then(evaluator =>
          E(evaluator).evaluate(
            `(() => { const namespace = (\n${bundle}\n); if (typeof namespace.make !== 'function') throw Error('Application module must export make(powers)'); return namespace.make(powers); })()`,
            harden({ powers: harden(powers) }),
          ),
        )
        .then(
          root => {
            entry.status = 'ready';
            return root;
          },
          error => {
            entry.status = 'failed';
            entry.error = String(error);
            throw error;
          },
        );
      return entry.result;
    },
    /** @param {string} name */
    get: name => {
      const entry = applications.get(name);
      if (!entry) throw Error('Unknown application');
      return entry.result;
    },
    list: () =>
      harden(
        [...applications.values()].map(
          ({ name, digest, grants, status, error }) =>
            harden({ name, digest, grants, status, error }),
        ),
      ),
    // Release this registry's root. Other ordinary references may still retain it.
    /** @param {string} name */
    remove: name => applications.delete(name),
  });
};
harden(makeApplicationRegistry);
