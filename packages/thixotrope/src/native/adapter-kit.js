// @ts-check
import { Far } from '@endo/far';
import harden from '@endo/harden';

import { describeError } from '../describe-error.js';
import { makeSerialQueue } from '../serial-queue.js';

/**
 * What a native adapter process has to do that is not about its resource:
 * serialize its operations, keep what it has bound under each key, answer a
 * repeated bind for the same registration without rebinding, replace a
 * registration the manager replaced, release a binding on unbind, and
 * restore a set of registrations one at a time, reporting each failure
 * without giving up on the rest. This factory writes all of that once. A
 * resource author supplies the two verbs.
 *
 * The adapter and its manager, built with `makeManager`, speak one protocol:
 * `bind(key, spec, epoch)`, `unbind(key)` and
 * `restore([[key, spec, epoch], ...])`, where `spec` is whatever passable
 * record the manager registers under a key and `epoch` names that
 * registration: the manager gives a new one to each registration it makes or
 * replaces, so the same epoch under a key is the registration already bound,
 * and another is one that takes its place. Which registrations may replace
 * which is the manager's to decide, alone. A bind answers what the
 * registration became when binding settled something the spec left open (a
 * delay becomes a deadline, a port of zero becomes the port the listener
 * got), or `undefined` when it is as sent; the manager keeps the resolved
 * form, so a restore sends it.
 *
 * @template Spec
 * @template Binding
 * @param {object} options
 * @param {string} options.label what a key names, for messages
 * @param {(key: unknown, spec: Spec) => Promise<Binding> | Binding} options.bind
 *   acquire the resource for a registration
 * @param {(binding: Binding, key: unknown) => Promise<unknown> | unknown} options.unbind
 *   release it
 * @param {(binding: Binding, spec: Spec) => Spec} [options.resolve]
 *   what the registration became once bound, when binding settles something
 *   the spec left open; the resolved spec is what the adapter keeps and
 *   answers a repeated bind with. By default a registration is as sent, and
 *   binds answer `undefined`. Two obligations come with it: the manager
 *   adopts the resolved spec and sends it back on every restore, so
 *   `resolve` must leave an already-resolved spec as it is; and the
 *   resolved spec lives on in the manager's durable heap, so it must be
 *   data and the manager's own remotables, never something of this
 *   process, which no later incarnation could use. A `resolve` that throws
 *   releases the binding and fails the bind.
 */
export const makeAdapter = ({ label, bind, unbind, resolve }) => {
  if (typeof label !== 'string') throw Error('makeAdapter needs a label');
  if (typeof bind !== 'function' || typeof unbind !== 'function')
    throw Error('makeAdapter needs bind() and unbind()');
  if (resolve !== undefined && typeof resolve !== 'function')
    throw Error('makeAdapter resolve must be a function');
  /** @type {Map<unknown, {spec: Spec, epoch: bigint, binding: Binding}>} */
  const bound = new Map();
  const enqueue = makeSerialQueue();
  /**
   * Bind a registration, or find it already bound. Answers the resolved
   * spec when the adapter resolves registrations, so the manager adopts the
   * standing form even for a bind it repeats; `undefined` otherwise.
   * @param {unknown} key
   * @param {Spec} spec
   * @param {bigint} epoch
   * @returns {Promise<Spec | undefined>}
   */
  const bindOne = async (key, spec, epoch) => {
    if (typeof epoch !== 'bigint')
      throw Error(`${label} registration needs an epoch`);
    const standing = bound.get(key);
    if (standing !== undefined) {
      if (standing.epoch === epoch)
        return resolve === undefined ? undefined : standing.spec;
      // The manager replaced the registration. The binding closes over its
      // registration, so it is replaced rather than edited: released first,
      // so the new one can take its place, and forgotten only once
      // released, so a release that fails leaves the binding where a later
      // unbind retries it and reports the failure.
      await unbind(standing.binding, key);
      bound.delete(key);
    }
    const binding = await bind(key, spec);
    if (resolve === undefined) {
      bound.set(key, { spec, epoch, binding });
      return undefined;
    }
    /** @type {Spec} */
    let resolved;
    try {
      resolved = harden(resolve(binding, spec));
    } catch (error) {
      // The resource was acquired; a registration that cannot say what it
      // became is released rather than kept where nothing can name it.
      try {
        await unbind(binding, key);
      } catch (_release) {
        // The failure to report is the bind's own.
      }
      throw error;
    }
    bound.set(key, { spec: resolved, epoch, binding });
    return resolved;
  };
  return Far('Adapter', {
    /**
     * @param {unknown} key
     * @param {Spec} spec
     * @param {bigint} epoch
     */
    bind: (key, spec, epoch) => enqueue(() => bindOne(key, spec, epoch)),
    /** @param {unknown} key */
    unbind: key =>
      enqueue(async () => {
        const standing = bound.get(key);
        if (standing === undefined) return false;
        await unbind(standing.binding, key);
        bound.delete(key);
        return true;
      }),
    /**
     * Bind a set of registrations, one at a time; a failure is reported for
     * its key and the rest are still attempted. A registration that resolved
     * is reported with its resolved spec.
     * @param {Array<[unknown, Spec, bigint]>} entries
     */
    restore: entries =>
      enqueue(async () => {
        /** @type {Array<{ key: unknown, spec?: Spec, error?: string }>} */
        const results = [];
        for (const [key, spec, epoch] of entries) {
          // eslint-disable-next-line no-await-in-loop
          const result = await bindOne(key, spec, epoch).then(
            resolved =>
              harden(
                resolved === undefined ? { key } : { key, spec: resolved },
              ),
            error =>
              harden({
                key,
                error: describeError(error),
              }),
          );
          results.push(result);
        }
        return harden(results);
      }),
  });
};
harden(makeAdapter);
