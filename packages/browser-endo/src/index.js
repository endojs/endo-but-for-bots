// @ts-check
/* global setTimeout, clearTimeout */
import { formatLocatorWithHints } from '@endo/daemon/locator.js';
import { makeRemoteControlProvider } from '@endo/daemon/remote-control.js';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { Far } from '@endo/far';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';
import { toHex } from '@endo/relay-server/protocol.js';

import { makeQueue } from './queue.js';
import { connectRelay } from './relay.js';
import { routeLocator } from './route.js';

export { E } from '@endo/eventual-send';
export { makeExo } from '@endo/exo';
export { M } from '@endo/patterns';
export { iterateReader } from '@endo/exo-stream/iterate-reader.js';
export { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

/**
 * A live browser peer. Imported references and exported objects last until close.
 * Reconnect by making a new runtime and importing fresh references. Mutations
 * are never replayed. Applications receive only explicitly supplied locators.
 * @param {object} options
 * @param {string} options.relay
 * @param {string} options.relayDomain
 * @param {Crypto} [options.crypto]
 * @param {typeof WebSocket} [options.WebSocket]
 * @param {number} [options.timeoutMs]
 * @param {import('@endo/captp').CapTPOptions} [options.capTpOptions]
 */
export const makeBrowserEndo = ({
  crypto = globalThis.crypto,
  WebSocket = globalThis.WebSocket,
  ...options
}) => {
  /** @type {Map<string, unknown>} */
  const exports = new Map();
  /** @type {Map<string, Set<string>>} */
  const retained = new Map();
  /** @type {Set<{ node: string, queue: ReturnType<typeof makeQueue> }>} */
  const followers = new Set();
  /** @type {Map<string, Promise<void>>} */
  const peerClosures = new Map();
  /** @type {Map<string, Set<() => void>>} */
  const inboundWaiters = new Map();
  let stopped = false;
  let remoteControls;
  const checkLive = () => {
    if (stopped) throw new Error('Browser runtime is closed');
  };
  const makeGateway = (peerNode, peerCancelled) =>
    makeExo(
      'Browser Gateway',
      M.interface('Browser Gateway', {
        provide: M.call(M.string()).returns(M.any()),
        followRetentionSet: M.call(M.string()).returns(M.any()),
      }),
      {
        async provide(id) {
          checkLive();
          const [number, node] = id.split(':');
          if (
            node !== relay.getNodeId() ||
            !exports.has(number) ||
            id !== `${number}:${node}`
          )
            throw new Error('No such exported object');
          return exports.get(number);
        },
        async followRetentionSet(node) {
          checkLive();
          if (node !== peerNode)
            throw new Error(
              'Retention queries must name the authenticated peer',
            );
          const queue = makeQueue();
          // The first event is a full snapshot, including the empty set.
          queue.push(
            harden({ add: [...(retained.get(node) || [])], remove: [] }),
          );
          const follower = { node, queue };
          followers.add(follower);
          const finish = () => {
            followers.delete(follower);
            queue.close();
          };
          peerCancelled.catch(finish);
          const iterator = harden({
            ...queue.iterator,
            async return() {
              finish();
              return { done: true, value: undefined };
            },
          });
          return readerFromIterator(iterator, { cancelPending: finish });
        },
      },
    );
  const relay = connectRelay({
    ...options,
    crypto,
    WebSocket,
    bootstrap: (authenticatedNode, channel) =>
      Far('Browser Greeter', {
        hello(node, peerGateway, cancelPeer, peerCancelled) {
          checkLive();
          if (node !== authenticatedNode)
            throw new Error(
              'Peer greeting identity does not match relay sender',
            );
          const connectionCancelled = Promise.race([
            channel.cancelled,
            peerCancelled,
          ]);
          connectionCancelled.catch(() => {});
          remoteControls(node).accept(
            peerGateway,
            reason => {
              channel.close(reason);
              E(cancelPeer)(reason).catch(() => {});
            },
            connectionCancelled,
          );
          if (remoteControls(node).getStateName() === 'accepted') {
            for (const resolve of inboundWaiters.get(node) || []) resolve();
            inboundWaiters.delete(node);
          }
          return makeGateway(authenticatedNode, channel.cancelled);
        },
      }),
  });
  const ready = relay.ready.then(() => {
    remoteControls = makeRemoteControlProvider(relay.getNodeId());
  });
  ready.catch(() => {});
  const close = () => {
    if (stopped) return;
    stopped = true;
    for (const { queue } of followers) queue.close();
    followers.clear();
    retained.clear();
    inboundWaiters.clear();
    exports.clear();
    relay.close();
  };
  relay.closed.then(close);
  const retain = (node, number) => {
    let set = retained.get(node);
    if (!set) {
      set = new Set();
      retained.set(node, set);
    }
    if (set.has(number)) return;
    set.add(number);
    for (const { node: followerNode, queue } of followers) {
      if (node === followerNode)
        queue.push(harden({ add: [number], remove: [] }));
    }
  };
  return harden({
    ready,
    closed: relay.closed,
    close,
    getNodeId: relay.getNodeId,
    /**
     * Resolve when the currently imported peer connection is lost.
     * @param {string} locator
     */
    whenDisconnected(locator) {
      const { peerNode } = routeLocator(locator, options.relay);
      if (peerNode === relay.getNodeId()) return relay.closed;
      const closed = peerClosures.get(peerNode);
      if (!closed)
        throw new Error('Import the endowment before watching its peer');
      return Promise.race([closed, relay.closed]);
    },
    /** @param {string} locator */
    async import(locator) {
      const { node, number, peerNode } = routeLocator(locator, options.relay);
      await ready;
      checkLive();
      if (node === relay.getNodeId()) {
        if (!exports.has(number)) throw new Error('No such exported object');
        return exports.get(number);
      }
      retain(peerNode, number);
      const incoming = makePromiseKit();
      const onAccepted = () => incoming.resolve(undefined);
      let waiters = inboundWaiters.get(peerNode);
      if (!waiters) {
        waiters = new Set();
        inboundWaiters.set(peerNode, waiters);
      }
      waiters.add(onAccepted);
      const acquire = async retry => {
        const lifetime = makePromiseKit();
        peerClosures.set(
          peerNode,
          lifetime.promise.catch(() => {}),
        );
        let channel;
        const cancel = reason => {
          lifetime.reject(reason);
          channel?.close(reason);
        };
        const peerGateway = remoteControls(peerNode).connect(
          async () => {
            try {
              channel = await relay.connect(peerNode);
              channel.cancelled.catch(cancel);
              if (!channel.captp)
                throw new Error('Peer channel has no CapTP connection');
              const greeter = channel.captp.getBootstrap();
              return await E(greeter).hello(
                relay.getNodeId(),
                makeGateway(peerNode, channel.cancelled),
                Far('Browser Canceller', cancel),
                lifetime.promise,
              );
            } catch (error) {
              cancel(error);
              throw error;
            }
          },
          cancel,
          lifetime.promise,
        );
        try {
          return await peerGateway;
        } catch (error) {
          // The losing dial can close BEFORE the surviving inbound hello
          // arrives. Only the lower node favors inbound; wait for its accepted
          // gateway under the same import deadline, never replay provide/calls.
          if (retry && relay.getNodeId() < peerNode) {
            if (remoteControls(peerNode).getStateName() !== 'accepted') {
              await Promise.race([incoming.promise, relay.cancelled]);
            }
            return acquire(false);
          }
          throw error;
        }
      };
      const timeout = makePromiseKit();
      const timer = setTimeout(() => {
        const error = new Error('Importing peer capability timed out');
        timeout.reject(error);
        relay.close(error);
      }, options.timeoutMs || 15_000);
      try {
        return await Promise.race([
          E(acquire(true)).provide(`${number}:${node}`),
          timeout.promise,
        ]);
      } finally {
        clearTimeout(timer);
        waiters.delete(onAccepted);
        if (waiters.size === 0 && inboundWaiters.get(peerNode) === waiters) {
          inboundWaiters.delete(peerNode);
        }
      }
    },
    /**
     * Export an explicit object. Possession of its locator grants access.
     * @param {unknown} capability
     */
    async export(capability) {
      await ready;
      checkLive();
      const number = toHex(crypto.getRandomValues(new Uint8Array(32)));
      exports.set(number, capability);
      const id = `${number}:${relay.getNodeId()}`;
      const hint = `ws-relay+captp0://${relay.getNodeId()}?relay=${encodeURIComponent(options.relay)}`;
      return formatLocatorWithHints(
        /** @type {any} */ (id),
        'remote',
        /** @type {any} */ ([hint]),
      );
    },
  });
};
harden(makeBrowserEndo);
