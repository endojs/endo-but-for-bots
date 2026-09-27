import {
  apply,
  construct,
  defineProperties,
  getOwnPropertyDescriptor,
  globalThis,
} from './commons.js';

/**
 * Tame the host `URL` constructor, if the host provides one.
 *
 * `URL.createObjectURL` and `URL.revokeObjectURL` mint and revoke handles in
 * the host's blob registry, which is ambient authority shared by every realm
 * that can reach it. Following the `Date` precedent, the start compartment
 * receives `%InitialURL%`, which keeps those methods, and every compartment
 * constructed after lockdown receives `%SharedURL%`, which omits them. Both
 * share the host's `URL.prototype`, so an instance made on either side is
 * `instanceof URL` on the other.
 *
 * With `urlBlobMethods: 'remove'`, the start compartment also receives
 * `%SharedURL%`, so there is a single `URL` everywhere and neither blob
 * method is reachable.
 *
 * Hosts without `URL` (XS) contribute no intrinsics.
 *
 * @param {'keepOnInitialGlobal' | 'remove'} [urlBlobMethods]
 */
export default function tameURLConstructor(
  urlBlobMethods = 'keepOnInitialGlobal',
) {
  const OriginalURL = globalThis.URL;
  if (typeof OriginalURL !== 'function') {
    return {};
  }
  const URLPrototype = OriginalURL.prototype;

  // Node.js defines the blob methods as `function` functions, each with its
  // own mutable `prototype` object. Forward through concise methods, which
  // have no `prototype`, rather than exposing the host functions.
  const { createObjectURL, revokeObjectURL } = OriginalURL;
  const blobMethods = {
    createObjectURL(...rest) {
      return apply(createObjectURL, OriginalURL, rest);
    },
    revokeObjectURL(...rest) {
      return apply(revokeObjectURL, OriginalURL, rest);
    },
  };

  /**
   * @param {boolean} withBlobMethods
   */
  const makeURLConstructor = withBlobMethods => {
    /**
     * @param {any[]} rest
     */
    // eslint-disable-next-line no-shadow
    const ResultURL = function URL(...rest) {
      if (new.target === undefined) {
        // Let the host produce its own error for a call without `new`.
        return apply(OriginalURL, undefined, rest);
      }
      return construct(OriginalURL, rest, new.target);
    };

    defineProperties(ResultURL, {
      length: { value: OriginalURL.length },
      prototype: {
        value: URLPrototype,
        writable: false,
        enumerable: false,
        configurable: false,
      },
    });
    for (const name of ['parse', 'canParse']) {
      const desc = getOwnPropertyDescriptor(OriginalURL, name);
      if (desc) {
        defineProperties(ResultURL, { [name]: desc });
      }
    }
    if (withBlobMethods) {
      for (const name of ['createObjectURL', 'revokeObjectURL']) {
        if (typeof OriginalURL[name] === 'function') {
          defineProperties(ResultURL, {
            [name]: {
              value: blobMethods[name],
              writable: true,
              enumerable: false,
              configurable: true,
            },
          });
        }
      }
    }
    return ResultURL;
  };

  const SharedURL = makeURLConstructor(false);
  const InitialURL =
    urlBlobMethods === 'remove' ? SharedURL : makeURLConstructor(true);

  defineProperties(URLPrototype, {
    constructor: { value: SharedURL },
  });

  return {
    '%InitialURL%': InitialURL,
    '%SharedURL%': SharedURL,
  };
}
