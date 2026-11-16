// @ts-check
/* global setTimeout, clearTimeout */
import { makeCapTP } from '@endo/captp';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';

import { makeBrowserEndo } from './index.js';

/**
 * Read explicit endowments from a fragment, never the HTTP query string.
 * @param {string} fragment
 */
export const parseApplicationConfig = fragment => {
  if (fragment.startsWith('?'))
    throw new Error(
      'Application endowments must be configured in the fragment',
    );
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const relay = params.get('relay');
  const relayDomain = params.get('relayDomain');
  /** @type {Record<string, string>} */
  const endowments = {};
  for (const [key, value] of params) {
    if (key.startsWith('cap.')) {
      const name = key.slice(4);
      if (
        !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) ||
        Object.hasOwn(endowments, name)
      )
        throw new Error('Invalid or duplicate endowment name');
      endowments[name] = value;
    }
  }
  if (Object.keys(endowments).length) {
    if (!relay || !relayDomain)
      throw new Error('Peer endowments require relay and relayDomain');
    return harden({ relay, relayDomain, endowments });
  }
  const gateway = params.get('gateway');
  const agent = params.get('agent');
  if (gateway && agent) return harden({ gateway, endowments: { agent } });
  throw new Error('Application endowments are not configured');
};
harden(parseApplicationConfig);

/**
 * Shared application connector: peer endowments or existing gateway links.
 * Gateway compatibility is useful for local dev, Electron and old Android links.
 * It grants exactly the listed fetch tokens, with no Chat-specific bootstrap.
 * @param {{relay?: string, relayDomain?: string, gateway?: string, endowments: Record<string, string>}} config
 * @param {{WebSocket?: typeof WebSocket, crypto?: Crypto, secure?: boolean, timeoutMs?: number, capTpOptions?: import('@endo/captp').CapTPOptions}} [options]
 */
export const connectApplication = (config, options = {}) => {
  if (config.relay) {
    const runtime = makeBrowserEndo({
      ...options,
      relay: config.relay,
      relayDomain: config.relayDomain || '',
    });
    const endowments = Promise.all(
      Object.entries(config.endowments).map(async ([name, locator]) => {
        const capability = await runtime.import(locator);
        runtime.whenDisconnected(locator).then(runtime.close);
        return [name, capability];
      }),
    ).then(entries => harden(Object.fromEntries(entries)));
    endowments.catch(() => runtime.close());
    return harden({
      endowments,
      close: runtime.close,
      closed: runtime.closed,
      runtime,
    });
  }
  const powers = makePromiseKit();
  const closed = makePromiseKit();
  powers.promise.catch(() => {});
  const {
    WebSocket: Socket = globalThis.WebSocket,
    timeoutMs = 15_000,
    secure = globalThis.location?.protocol === 'https:',
  } = options;
  let stopped = false;
  let captp;
  let socket;
  const timer = setTimeout(
    () => close(new Error('Gateway connection timed out')),
    timeoutMs,
  );
  const close = (reason = new Error('Application connection closed')) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    powers.reject(reason);
    captp?.abort(reason);
    socket?.close();
    closed.resolve(undefined);
  };
  try {
    // Existing hosted bookmarks may include a trailing root slash. Normalize
    // it without accepting paths, credentials, queries, or fragments.
    const gateway = config.gateway?.replace(/\/+$/, '');
    if (!gateway || /[/?#@\\\s]/.test(gateway))
      throw new Error('Invalid gateway address');
    socket = new Socket(`${secure ? 'wss' : 'ws'}://${gateway}/`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (stopped) {
        socket.close();
        return;
      }
      captp = makeCapTP(
        'Browser Application',
        message => {
          if (stopped || socket.readyState !== 1)
            throw new Error('Gateway connection is closed');
          socket.send(new TextEncoder().encode(JSON.stringify(message)));
        },
        Far('Application Bootstrap', {
          ping() {},
          reject(message) {
            close(new Error(message));
          },
        }),
        options.capTpOptions,
      );
      Promise.all(
        Object.entries(config.endowments).map(async ([name, token]) => [
          name,
          await E(captp.getBootstrap()).fetch(token),
        ]),
      ).then(entries => {
        if (stopped) return;
        clearTimeout(timer);
        powers.resolve(harden(Object.fromEntries(entries)));
      }, close);
    };
    socket.onmessage = event => {
      if (stopped) return;
      try {
        captp.dispatch(
          JSON.parse(new TextDecoder().decode(new Uint8Array(event.data))),
        );
      } catch (error) {
        close(error instanceof Error ? error : new Error(String(error)));
      }
    };
    socket.onerror = () => close(new Error('Gateway connection failed'));
    socket.onclose = () => close(new Error('Gateway connection lost'));
  } catch (error) {
    close(error instanceof Error ? error : new Error(String(error)));
  }
  return harden({
    endowments: powers.promise,
    close,
    closed: closed.promise,
    runtime: undefined,
  });
};
harden(connectApplication);
