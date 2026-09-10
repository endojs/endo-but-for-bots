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
 * @param {(configuration: any) => Promise<any>} [options.makeNetworkListeners] Trusted image-selected implementation.
 */
export const startProviderListenerWorker = async ({
  input,
  output,
  makeNetworkListeners,
}) => {
  let listener;
  let networkListeners;
  let networkConfiguration;
  let networkFlight;
  let stopped = false;
  let ready;
  const bootstrap = makeExo(
    'ProviderListenerControl',
    M.interface('ProviderListenerControl', {
      ready: M.call().returns(M.promise()),
      stop: M.call().returns(M.promise()),
      activateNetwork: M.call().returns(M.promise()),
    }),
    {
      async ready() {
        return ready;
      },
      async activateNetwork() {
        await ready;
        (!stopped && networkConfiguration) ||
          Fail`Provider worker network unavailable`;
        if (!makeNetworkListeners)
          throw Error('Provider worker network unavailable');
        networkFlight ??= makeNetworkListeners(networkConfiguration).then(
          async result => {
            networkListeners = result;
            if (stopped) {
              await result.dispose();
              throw Error('Provider worker stopped');
            }
            return result.evidence;
          },
        );
        return networkFlight;
      },
      async stop() {
        stopped = true;
        await ready?.catch(() => {});
        await networkFlight?.catch(() => {});
        if (networkListeners) await networkListeners.dispose();
        if (listener) await listener.dispose();
      },
    },
  );
  const pipe = makeProviderPipe({ input, output, bootstrap });
  ready = (async () => {
    const configuration = await pipe.getBootstrap();
    const allowed = [
      'endpoint',
      'limits',
      ...(Object.hasOwn(configuration, 'network') ? ['network'] : []),
    ];
    (Object.keys(configuration).length === allowed.length &&
      allowed.every(key => Object.hasOwn(configuration, key))) ||
      Fail`Invalid provider worker bootstrap`;
    if (configuration.network !== undefined) {
      makeNetworkListeners || Fail`Provider worker does not support networking`;
      networkConfiguration = configuration.network;
    }
    let diagnosticCount = 0;
    listener = await makeProviderHttpListener({
      endpoint: configuration.endpoint,
      ...configuration.limits,
      onDiagnostic: diagnostic => {
        if (configuration.limits.diagnostics !== true || diagnosticCount >= 4)
          return;
        diagnosticCount += 1;
        // Project only fixed, locally generated stages and header-check bits.
        // Four bounded lines fit within the runtime's 4096-byte stderr budget.
        const { stage, checks } = diagnostic;
        const line = JSON.stringify({
          stage,
          ...(checks
            ? {
                checks: {
                  method: checks.method,
                  path: checks.path,
                  host: checks.host,
                  origin: checks.origin,
                  cookie: checks.cookie,
                  authorization: checks.authorization,
                  encoding: checks.encoding,
                  contentType: checks.contentType,
                },
              }
            : {}),
        });
        if (line.length <= 768)
          console.error(`Provider HTTP diagnostic: ${line}`);
      },
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
      await networkFlight?.catch(() => {});
      if (networkListeners) await networkListeners.dispose();
      if (listener) await listener.dispose();
    } catch (_error) {
      /* No secret-bearing diagnostics leave the worker. */
    }
  });
  return harden({ closed: pipe.closed, close: pipe.close });
};
harden(startProviderListenerWorker);
