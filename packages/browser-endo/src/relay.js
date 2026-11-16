// @ts-check
/* global setTimeout, clearTimeout */
import { makeNetstringCapTP } from '@endo/daemon/connection.js';
import { makePromiseKit } from '@endo/promise-kit';
import * as wire from '@endo/relay-server/protocol.js';

import { makeQueue } from './queue.js';

/**
 * One authenticated relay socket. No automatic replay or reconnect.
 * @param {object} options
 * @param {string} options.relay
 * @param {string} options.relayDomain
 * @param {Crypto} options.crypto
 * @param {typeof WebSocket} options.WebSocket
 * @param {(node: string, channel: any) => unknown} options.bootstrap
 * @param {import('@endo/captp').CapTPOptions} [options.capTpOptions]
 * @param {number} [options.timeoutMs]
 */
export const connectRelay = ({
  relay,
  relayDomain,
  crypto,
  WebSocket: Socket,
  bootstrap,
  capTpOptions,
  timeoutMs = 15_000,
}) => {
  const url = new URL(relay);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'wss:' &&
      !(
        url.protocol === 'ws:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  ) {
    throw new Error('Relay must use wss (or loopback ws for development)');
  }
  if (!relayDomain) throw new Error('Relay signing domain is required');
  const ready = makePromiseKit();
  const closed = makePromiseKit();
  const cancelled = makePromiseKit();
  cancelled.promise.catch(() => {});
  ready.promise.catch(() => {});
  let stopped = false;
  let authenticated = false;
  let challenged = false;
  /** @type {WebSocket | undefined} */
  let socket;
  let nodeId = '';
  /** @type {Map<number, any>} */
  const channels = new Map();
  /** @type {Map<number, { kit: ReturnType<typeof makePromiseKit>, timer: ReturnType<typeof setTimeout> }>} */
  const opens = new Map();
  // Channel identifiers are uint32 on the relay wire.
  let nextChannel = 0x7fff_ffff;
  const timer = setTimeout(
    () => close(new Error('Relay authentication timed out')),
    timeoutMs,
  );
  /** @param {Uint8Array} frame */
  const send = frame => {
    if (stopped || socket?.readyState !== 1)
      throw new Error('Relay connection is closed');
    socket.send(new Uint8Array(frame));
  };
  /** @param {Error} [reason] */
  const close = (reason = new Error('Browser runtime closed')) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    ready.reject(reason);
    cancelled.reject(reason);
    for (const { kit, timer: openTimer } of opens.values()) {
      clearTimeout(openTimer);
      kit.reject(reason);
    }
    opens.clear();
    for (const channel of [...channels.values()]) channel.close(reason);
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      // A native connecting WebSocket accepts close(); Node's ws adapter
      // emits an error when closed here, which tests deliberately consume.
      socket.close();
    }
    closed.resolve(undefined);
  };
  const makeChannel = (id, peerNode, incoming) => {
    const bytes = makeQueue();
    const lifetime = makePromiseKit();
    lifetime.promise.catch(() => {});
    let ended = false;
    const end = (reason = new Error('Peer channel closed')) => {
      if (ended) return;
      ended = true;
      channels.delete(id);
      lifetime.reject(reason);
      bytes.close();
      if (!stopped && socket?.readyState === 1) send(wire.encodeClose(id));
    };
    const writer = harden({
      async next(chunk) {
        if (ended) throw new Error('Peer channel is closed');
        send(wire.encodeData(id, chunk));
        return { done: false, value: undefined };
      },
      async return() {
        end();
        return { done: true, value: undefined };
      },
      async throw(error) {
        end(error);
        throw error;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    });
    /** @type {{close: typeof end, cancelled: Promise<any>, push: typeof bytes.push, captp?: ReturnType<typeof makeNetstringCapTP>}} */
    const channel = {
      close: end,
      cancelled: lifetime.promise,
      push: bytes.push,
      captp: undefined,
    };
    channels.set(id, channel);
    const localBootstrap = incoming ? bootstrap(peerNode, channel) : undefined;
    channel.captp = makeNetstringCapTP(
      'Browser Endo',
      writer,
      bytes.iterator,
      lifetime.promise,
      localBootstrap,
      capTpOptions,
    );
    channel.captp.closed.then(
      () => end(),
      error => end(error),
    );
    return channel;
  };
  // Identity belongs to this runtime, never to a hosting origin's shared storage.
  const initialize = async () => {
    const keys = /** @type {CryptoKeyPair} */ (
      await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
    );
    if (stopped) return;
    const publicKey = new Uint8Array(
      await crypto.subtle.exportKey('raw', keys.publicKey),
    );
    if (stopped) return;
    nodeId = wire.toHex(publicKey);
    socket = new Socket(url.href);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (stopped) {
        socket?.close();
        return;
      }
      send(wire.encodeHello(publicKey));
    };
    socket.onclose = () => close(new Error('Relay connection lost'));
    socket.onerror = () => close(new Error('Relay connection failed'));
    const receive = async event => {
      if (stopped) return;
      if (!(event.data instanceof ArrayBuffer))
        throw new Error('Expected a binary relay frame');
      const { type, payload } = wire.decodeFrame(new Uint8Array(event.data));
      if (!authenticated) {
        if (
          type === wire.MSG_CHALLENGE &&
          !challenged &&
          payload.length === 32
        ) {
          challenged = true;
          const domain = new TextEncoder().encode(relayDomain);
          const challenge = new Uint8Array(domain.length + payload.length);
          challenge.set(domain);
          challenge.set(payload, domain.length);
          const signature = await crypto.subtle.sign(
            'Ed25519',
            keys.privateKey,
            challenge,
          );
          if (!stopped) send(wire.encodeResponse(new Uint8Array(signature)));
        } else if (type === wire.MSG_AUTH_OK && challenged) {
          authenticated = true;
          clearTimeout(timer);
          ready.resolve(undefined);
        } else throw new Error('Relay authentication failed');
        return;
      }
      if (payload.length < 4) throw new Error('Truncated relay channel frame');
      const id = wire.decodeChannelId(payload);
      if (type === wire.MSG_INCOMING) {
        if (payload.length !== 36 || channels.has(id))
          throw new Error('Invalid incoming channel');
        makeChannel(id, wire.toHex(payload.subarray(4)), true);
      } else if (type === wire.MSG_OPENED || type === wire.MSG_OPEN_FAILED) {
        const pending = opens.get(id);
        if (!pending) {
          if (type === wire.MSG_OPENED) send(wire.encodeClose(id));
          return;
        }
        clearTimeout(pending.timer);
        opens.delete(id);
        if (type === wire.MSG_OPENED) pending.kit.resolve(undefined);
        else pending.kit.reject(new Error('Peer is unavailable'));
      } else if (type === wire.MSG_DATA) {
        channels.get(id)?.push(payload.subarray(4));
      } else if (type === wire.MSG_CLOSE || type === wire.MSG_PEER_GONE) {
        channels.get(id)?.close(new Error('Peer disconnected'));
      } else throw new Error('Unexpected relay frame');
    };
    socket.onmessage = event => {
      receive(event).catch(close);
    };
  };
  initialize().catch(close);
  return harden({
    ready: ready.promise,
    closed: closed.promise,
    cancelled: cancelled.promise,
    close,
    getNodeId: () => nodeId,
    async connect(peerNode) {
      await ready.promise;
      if (stopped) throw new Error('Relay connection is closed');
      if (!/^[0-9a-f]{64}$/.test(peerNode))
        throw new Error('Invalid peer identity');
      if (nextChannel === 0xffff_ffff)
        throw new Error('Relay channel identifiers exhausted');
      nextChannel += 1;
      const id = nextChannel;
      const kit = makePromiseKit();
      const openTimer = setTimeout(() => {
        opens.delete(id);
        kit.reject(new Error('Opening peer channel timed out'));
        if (!stopped) send(wire.encodeClose(id));
      }, timeoutMs);
      opens.set(id, { kit, timer: openTimer });
      try {
        send(wire.encodeOpen(id, wire.fromHex(peerNode)));
        await kit.promise;
      } catch (error) {
        clearTimeout(openTimer);
        opens.delete(id);
        throw error;
      }
      if (stopped) throw new Error('Relay connection is closed');
      return makeChannel(id, peerNode, false);
    },
  });
};
harden(connectRelay);
