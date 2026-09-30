// @ts-check
import { Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * What a native adapter process has to do that is not about its resource:
 * serialize its operations, keep what it has bound under each key, answer a
 * repeated bind for the same registration without rebinding, replace a
 * registration the manager may replace and refuse one it may not, release a
 * binding on unbind, and restore a set of registrations one at a time,
 * reporting each failure without giving up on the rest. This factory writes
 * all of that once. A resource author supplies the identity of a
 * registration and the two verbs.
 *
 * The adapter and its manager, built with `makeManager`, speak one protocol:
 * `bind(key, spec)`, `unbind(key)`, `restore([[key, spec], ...])` and
 * `keys()`, where `spec` is whatever passable record the manager registers
 * under a key.
 *
 * @template Spec
 * @template Binding
 * @param {object} options
 * @param {string} options.label what a key names, for messages
 * @param {(existing: Spec, wanted: Spec) => boolean} options.same
 *   whether a registration already bound is the one wanted, so that binding
 *   it again changes nothing. A record crosses the wire as a fresh copy each
 *   time, so identity would only ever be right for a primitive or remotable
 *   spec; the author says what sameness is.
 * @param {(existing: Spec, wanted: Spec) => boolean} [options.replaces]
 *   whether a differing registration may take the place of the existing one
 *   under the same key, in which case the existing binding is released
 *   before the new one is made; never by default, so the key is refused as
 *   already registered
 * @param {(key: unknown, spec: Spec) => Promise<Binding> | Binding} options.bind
 *   acquire the resource for a registration
 * @param {(binding: Binding, key: unknown) => Promise<unknown> | unknown} options.unbind
 *   release it
 */
export const makeAdapter = ({
  label,
  same,
  replaces = () => false,
  bind,
  unbind,
}) => {
  if (typeof label !== 'string') throw Error('makeAdapter needs a label');
  if (typeof same !== 'function') throw Error('makeAdapter needs same()');
  if (typeof bind !== 'function' || typeof unbind !== 'function')
    throw Error('makeAdapter needs bind() and unbind()');
  /** @type {Map<unknown, {spec: Spec, binding: Binding}>} */
  const bound = new Map();
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
  /**
   * @param {unknown} key
   * @param {Spec} spec
   */
  const bindOne = async (key, spec) => {
    const standing = bound.get(key);
    if (standing !== undefined) {
      if (same(standing.spec, spec)) return key;
      if (!replaces(standing.spec, spec))
        throw Error(`${label} is already registered`);
      // The binding closes over its registration, so it is replaced rather
      // than edited: released first, so the new one can take its place, and
      // forgotten only once released, so a release that fails leaves the
      // binding where a later unbind retries it and reports the failure.
      await unbind(standing.binding, key);
      bound.delete(key);
    }
    const binding = await bind(key, spec);
    bound.set(key, { spec, binding });
    return key;
  };
  return Far('Adapter', {
    /**
     * @param {unknown} key
     * @param {Spec} spec
     */
    bind: (key, spec) => enqueue(() => bindOne(key, spec)),
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
     * its key and the rest are still attempted.
     * @param {Array<[unknown, Spec]>} entries
     */
    restore: entries =>
      enqueue(async () => {
        const results = [];
        for (const [key, spec] of entries) {
          // eslint-disable-next-line no-await-in-loop
          const result = await bindOne(key, spec).then(
            () => harden({ key }),
            error =>
              harden({
                key,
                error: String(
                  /** @type {Error} */ (error)?.message ?? error,
                ).slice(0, 512),
              }),
          );
          results.push(result);
        }
        return harden(results);
      }),
    keys: () => harden([...bound.keys()]),
  });
};
harden(makeAdapter);
