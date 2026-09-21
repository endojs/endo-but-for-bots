// @ts-check
export const makePromiseKit = () => {
  let resolve = _value => {};
  let reject = _reason => {};
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
