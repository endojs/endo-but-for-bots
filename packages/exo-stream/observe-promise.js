// @ts-check

const promiseThen = Promise.prototype.then;

/**
 * Observe an internally owned stream promise that the consumer may abandon.
 * Preserve its rejection for callers that do await it, and use native promise
 * adoption even when a promise carries an own then method.
 *
 * @template T
 * @param {PromiseLike<T>} value
 */
export const observePromise = value => {
  const promise = Promise.resolve(value);
  Reflect.apply(promiseThen, promise, [undefined, () => undefined]);
  return promise;
};
harden(observePromise);
