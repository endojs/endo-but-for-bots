// @ts-check

import { makeFixedWorker } from '@endo/daemon/fixed-worker.js';
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

/**
 * One authenticated activation of an existing controller composition module.
 * Only this attenuated bootstrap is sent over CapTP, never the worker loader.
 * Token verification uses the root-owned verifier; the token is not persisted.
 * Closure fences local calls and drains controller work. It is NOT native stop
 * proof: the host-private root adapter must still stop/reconcile the exact unit.
 *
 * @param {object} options
 * @param {string} options.compositionModule Root-selected installed file URL.
 * @param {Record<string,string>} options.env Root-selected non-secret settings.
 * @param {(token: string) => Promise<boolean>} options.verifyToken
 * @param {typeof makeFixedWorker} [options.makeWorker]
 */
export const makeNativeProducerWorker = ({
  compositionModule,
  env,
  verifyToken,
  makeWorker = makeFixedWorker,
}) => {
  let stopped = false;
  let attempted = false;
  /** @type {any} */
  let controller;
  /** @type {string | undefined} */
  let plan;
  /** @type {any} */
  let resolver;
  /** @type {Promise<unknown> | undefined} */
  let activation;
  /** @type {Promise<void> | undefined} */
  let closing;
  /** @type {Set<Promise<unknown>>} */
  const pending = new Set();
  const cancellation = makePromiseKit();
  void cancellation.promise.catch(() => undefined);
  const cancel = reason => {
    stopped = true;
    cancellation.reject(reason);
  };
  const worker = makeWorker({ specifier: compositionModule, cancel });
  const context = makeExo('NativeProducerContext', M.interface('NativeProducerContext', {
    whenCancelled: M.call().returns(M.promise()),
  }), { whenCancelled: () => cancellation.promise });
  const assertOpen = () => { !stopped || Fail`Native producer is closed`; };
  /** @param {string} method @param {unknown[]} args */
  const call = (method, args) => {
    assertOpen();
    controller !== undefined || Fail`Native producer is not active`;
    const operation = E(controller)[method](...args).then(result => {
      assertOpen();
      return result;
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => undefined);
    return operation;
  };
  const close = () => {
    cancel(Error('Native producer closed'));
    closing ??= (async () => {
      await activation?.catch(() => undefined);
      if (controller && plan !== undefined) await E(controller).terminate(plan, resolver);
      await Promise.allSettled([...pending]);
    })().catch(error => { closing = undefined; throw error; });
    return closing;
  };
  const client = makeExo('NativeProducerSession', M.interface('NativeProducerSession', {
    send: M.call(M.string()).optional(M.record()).returns(M.promise()),
    interrupt: M.call().returns(M.promise()),
    models: M.call().returns(M.promise()),
    acknowledge: M.call(M.string()).returns(M.promise()),
    status: M.call().returns(M.promise()),
    closeController: M.call().returns(M.promise()),
  }), {
    send: (prompt, options = {}) => call('send', [prompt, options]),
    interrupt: () => call('interrupt', []),
    models: () => call('models', []),
    acknowledge: checkpoint => call('acknowledge', [checkpoint]),
    status: () => call('status', []),
    closeController: close,
  });
  const bootstrap = makeExo('NativeProducerBootstrap', M.interface('NativeProducerBootstrap', {
    activate: M.call(M.string(), M.string(), M.remotable()).returns(M.promise()),
  }), {
    activate: async (token, planText, dependencies) => {
      assertOpen();
      (token.length === 64 && /^[a-f0-9]+$/u.test(token)) || Fail`Native producer authentication refused`;
      const verified = await verifyToken(token);
      assertOpen();
      verified || Fail`Native producer authentication refused`;
      !attempted || Fail`Native producer activation already attempted`;
      attempted = true;
      plan = planText;
      resolver = dependencies;
      activation = (async () => {
        controller = await worker.instantiate(null, context, harden({ ...env }));
        assertOpen();
        await E(controller).activate(planText, dependencies);
        assertOpen();
      })();
      await activation;
      return client;
    },
  });
  return harden({ bootstrap, close });
};
harden(makeNativeProducerWorker);
