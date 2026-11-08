// @ts-check
export const makePromiseKit = () => {
  /** @type {(value?: any) => void} */
  let resolve = _value => {};
  /** @type {(reason?: any) => void} */
  let reject = _reason => {};
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
