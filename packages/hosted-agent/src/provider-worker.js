// @ts-check
import '@endo/init';

import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { makeProviderHttpListener } from './provider-http.js';
import { makeProviderPipe } from './provider-pipe.js';

/**
 * Start the credential-free worker on private pipes supplied by the host.
 * Node child-process tests invoke this directly; the pinned OCI image invokes
 * provider-worker-entry.js. No SecretBlob or upstream transport crosses here.
 * @param {object} options
 * @param {import('node:stream').Readable} options.input
 * @param {import('node:stream').Writable} options.output
 */
export const startProviderListenerWorker = async ({ input, output }) => {
  let listener;
  let stopped = false;
  let ready;
  const bootstrap = makeExo(
    'ProviderListenerControl',
    M.interface('ProviderListenerControl', {
      ready: M.call().returns(M.promise()),
      stop: M.call().returns(M.promise()),
    }),
    {
      async ready() {
        return ready;
      },
      async stop() {
        stopped = true;
        await ready?.catch(() => {});
        if (listener) await listener.dispose();
      },
    },
  );
  const pipe = makeProviderPipe({ input, output, bootstrap });
  ready = (async () => {
    const configuration = await pipe.getBootstrap();
    const allowed = ['endpoint', 'limits'];
    (Object.keys(configuration).length === allowed.length &&
      allowed.every(key => Object.hasOwn(configuration, key))) ||
      Fail`Invalid provider worker bootstrap`;
    listener = await makeProviderHttpListener({
      endpoint: configuration.endpoint,
      ...configuration.limits,
    });
    if (stopped) {
      await listener.dispose();
      throw Error('Provider worker stopped');
    }
    return harden({ endpoint: listener.url, protocol: 'ProviderListenerV1' });
  })();
  void ready.catch(() => pipe.close());
  void pipe.closed.then(async () => {
    stopped = true;
    try {
      if (listener) await listener.dispose();
    } catch (_error) {
      /* No secret-bearing diagnostics leave the worker. */
    }
  });
  return harden({ closed: pipe.closed, close: pipe.close });
};
harden(startProviderListenerWorker);
