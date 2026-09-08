// @ts-check
import harden from '@endo/harden';

import { makeDurableNetLayer } from '../src/durable-netlayer.js';

const decoder = new TextDecoder();

/** @param {Uint8Array} bytes */
export const headerOf = bytes =>
  JSON.parse(decoder.decode(bytes.subarray(0, bytes.indexOf(10))));

harden(headerOf);

/** A manually pumped network: no wall-clock connection or retransmission races. */
export const makeNetwork = () => {
  /** @type {Map<string, any>} */
  const endpoints = new Map();
  /** @type {Array<{to: any, physical: any, bytes: Uint8Array, after?: () => void}>} */
  const queue = [];
  /** @type {Set<() => void>} */
  const breaks = new Set();
  let rejectDials = false;
  return {
    queue,
    endpoints,
    disconnect: () => {
      queue.length = 0;
      for (const breakLink of breaks) breakLink();
      breaks.clear();
    },
    setRejectDials: (/** @type {boolean} */ reject) => {
      rejectDials = reject;
    },
    makeBase: (/** @type {string} */ name, /** @type {any} */ handlers) => {
      const endpoint = { handlers };
      endpoints.set(name, endpoint);
      return {
        location: { name },
        locationId: name,
        connect: (/** @type {{name: string}} */ location) => {
          if (rejectDials) throw Error('dial unavailable');
          const peer = endpoints.get(location.name);
          if (!peer) throw Error('peer unavailable');
          /** @type {any} */
          let local;
          /** @type {any} */
          let remote;
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            // Stream close notifications follow already-written data. In
            // particular, a final retirement response must arrive first.
            for (const [physical, owner] of [
              [local, endpoint],
              [remote, peer],
            ]) {
              const pending = queue.findLast(
                entry => entry.physical === physical,
              );
              const notify = () =>
                owner.handlers.handleConnectionClose(physical);
              if (pending) pending.after = notify;
              else notify();
            }
          };
          local = handlers.makeConnection({}, true, {
            write: (/** @type {Uint8Array} */ bytes) =>
              queue.push({ to: peer, physical: remote, bytes }),
            end: close,
          });
          remote = peer.handlers.makeConnection({}, false, {
            write: (/** @type {Uint8Array} */ bytes) =>
              queue.push({ to: endpoint, physical: local, bytes }),
            end: close,
          });
          breaks.add(() => {
            closed = true;
            endpoint.handlers.handleConnectionClose(local);
            peer.handlers.handleConnectionClose(remote);
          });
          return local;
        },
        shutdown: () => {},
      };
    },
    pumpOne: (/** @type {string | undefined} */ type = undefined) => {
      const index =
        type === undefined
          ? 0
          : queue.findIndex(entry => headerOf(entry.bytes).t === type);
      if (index < 0 || queue.length === 0)
        throw Error(`no queued ${type ?? 'message'}`);
      const [entry] = queue.splice(index, 1);
      entry.to.handlers.handleMessageData(entry.physical, entry.bytes);
      entry.after?.();
      return entry;
    },
  };
};

harden(makeNetwork);

/** Durable state belongs to the node, independently of each layer incarnation. */
export const makeState = () => ({
  /** @type {Map<string, any>} */
  records: new Map(),
  /** @type {Array<{n: bigint, bytes: number[]}>} */
  delivered: [],
});

harden(makeState);

/**
 * @param {ReturnType<typeof makeNetwork>} network
 * @param {string} name
 * @param {ReturnType<typeof makeState>} state
 * @param {{ receive?: () => void, failInbound?: boolean, durable?: boolean }} [options]
 */
export const makeNode = async (network, name, state, options = {}) => {
  /** @type {any[]} */
  const connections = [];
  const layer = await makeDurableNetLayer({
    reconnectDelayMs: 1_000_000,
    maxReconnectDelayMs: 1_000_000,
    logger: { info() {}, error() {} },
    handlers: {
      makeConnection: (
        /** @type {any} */ netlayer,
        /** @type {boolean} */ isOutgoing,
        /** @type {any} */ operations,
      ) => {
        const connection = { netlayer, isOutgoing, ...operations };
        connections.push(connection);
        return connection;
      },
      handleMessageData: (
        /** @type {any} */ connection,
        /** @type {Uint8Array} */ bytes,
        /** @type {bigint} */ n,
      ) => {
        options.receive?.();
        state.delivered.push({ n, bytes: [...bytes] });
      },
      handleConnectionClose() {},
    },
    makeBaseNetlayer: ({ handlers }) => network.makeBase(name, handlers),
    resumption:
      options.durable === false
        ? undefined
        : {
            isDurableToken: token => !state.records.get(token)?.retired,
            isRetired: token => state.records.get(token)?.retired === true,
            recordRetirementConfirmed: token => {
              state.records.set(token, {
                ...state.records.get(token),
                retirementConfirmed: true,
              });
            },
            recordPeerDurability: (token, peerDurability) => {
              state.records.set(token, {
                ...state.records.get(token),
                peerDurability,
              });
            },
            onHello: (token, location) => {
              if (state.records.has(token)) throw Error('duplicate creation');
              state.records.set(token, {
                recvSeq: '0',
                sendSeq: '0',
                ackSeq: '0',
                hubDelivery: '0',
                frames: [],
                inbox: [],
                isOriginator: location !== undefined,
                location,
              });
            },
            listSessions: () =>
              [...state.records.keys()].filter(token => {
                const record = state.records.get(token);
                return (
                  !record.retired ||
                  (record.isOriginator && !record.retirementConfirmed)
                );
              }),
            loadForResume: token => {
              const record = state.records.get(token);
              // Loading cannot share mutable protocol buffers with persisted state.
              return (
                record && {
                  ...record,
                  frames: record.frames.map((/** @type {any} */ entry) => ({
                    ...entry,
                    bytes: entry.bytes.slice(),
                  })),
                  inbox: record.inbox.map((/** @type {any} */ entry) => ({
                    ...entry,
                    bytes: entry.bytes.slice(),
                  })),
                }
              );
            },
            restoreSession() {},
            recordOutbound: (token, n, bytes, hubSequence) => {
              const record = state.records.get(token);
              state.records.set(token, {
                ...record,
                sendSeq: String(n),
                hubDelivery: hubSequence ?? record.hubDelivery,
                frames: [
                  ...record.frames,
                  { n: String(n), bytes: bytes.slice() },
                ],
              });
            },
            recordAck: (token, n) => {
              const record = state.records.get(token);
              state.records.set(token, {
                ...record,
                ackSeq: String(n),
                frames: record.frames.filter(
                  (/** @type {any} */ entry) => BigInt(entry.n) > n,
                ),
              });
            },
            recordInbound: (token, n, bytes) => {
              if (options.failInbound) throw Error('inbox commit failed');
              const record = state.records.get(token);
              state.records.set(token, {
                ...record,
                recvSeq: String(n),
                inbox: [
                  ...record.inbox,
                  { n: String(n), bytes: bytes.slice() },
                ],
              });
            },
            recordProcessed: (token, n) => {
              const record = state.records.get(token);
              state.records.set(token, {
                ...record,
                inbox: record.inbox.filter(
                  (/** @type {any} */ entry) => BigInt(entry.n) > n,
                ),
              });
            },
            onEnd: token => {
              state.records.set(token, {
                ...state.records.get(token),
                retired: true,
                frames: [],
                inbox: [],
              });
            },
          },
  });
  return { layer, connections };
};

harden(makeNode);

/** @param {ReturnType<typeof makeNetwork>} network */
export const greet = network => {
  network.pumpOne('hello');
  network.pumpOne('welcome');
};

harden(greet);

/** @param {ReturnType<typeof makeState>} state */
export const onlyRecord = state => [...state.records.values()][0];

harden(onlyRecord);
