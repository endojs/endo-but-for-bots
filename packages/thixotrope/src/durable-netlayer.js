// @ts-check
/* global setTimeout, clearTimeout, crypto */
import { Fail } from '@endo/errors';
import harden from '@endo/harden';

/**
 * Version 2 transfers message responsibility independently of sockets.
 * Every envelope is a JSON header, newline, and optional OCapN payload.
 * Sequence numbers are canonical decimal strings, scoped to token/direction.
 * hello/resume/welcome advertise durable acceptance, not execution progress.
 * ack releases the sender's copy only after inbox acceptance. A nonpersistent
 * embedder explicitly provides only process-lifetime acceptance.
 *
 * Resume tokens are bearer capabilities. Production base transports must
 * protect their confidentiality and authenticate the endpoint; tcp-testing
 * is intentionally unsuitable for an untrusted network. Possession of a
 * token never permits resetting its session or reusing a retired identity.
 */

/** @typedef {{ n: bigint, bytes: Uint8Array }} Frame */
/** @typedef {{ recvSeq: string, sendSeq: string, ackSeq: string, hubDelivery?: string, frames: Array<{n: string, bytes: Uint8Array}>, inbox: Array<{n: string, bytes: Uint8Array}>, isOriginator: boolean, location?: any, peerDurability?: 'restart' | 'process', retired?: boolean, retirementConfirmed?: boolean }} SessionRecord */
/**
 * All mutating methods persist synchronously before returning. Failure must
 * prevent acknowledgement or release of the previous owner's copy.
 * @typedef {object} SessionResumptionPower
 * @property {(token: string) => void} recordRetirementConfirmed
 * @property {(token: string) => boolean} isRetired
 * @property {(token: string, scope: 'restart' | 'process') => void} recordPeerDurability
 * @property {(token: string) => boolean} isDurableToken
 * @property {(token: string, location?: any) => void} onHello
 * @property {() => string[]} listSessions
 * @property {(token: string) => SessionRecord | undefined} loadForResume
 * @property {(handlers: any, connection: any, token: string) => void} restoreSession
 * @property {(token: string, n: bigint, bytes: Uint8Array, hubSequence?: string) => void} recordOutbound
 * @property {(token: string, n: bigint) => void} recordAck
 * @property {(token: string, n: bigint, bytes: Uint8Array) => void} recordInbound
 * @property {(token: string, n: bigint) => void} recordProcessed
 * @property {(token: string) => void} onEnd
 */
/**
 * @typedef {object} LogicalConnection
 * @property {string} token
 * @property {boolean} isOriginator
 * @property {any} location
 * @property {any} connection
 * @property {any} transport
 * @property {boolean} flowing
 * @property {boolean} destroyed
 * @property {boolean} retirementConfirmed
 * @property {boolean} durable
 * @property {'restart' | 'process' | undefined} peerDurability
 * @property {boolean} draining
 * @property {bigint} sendSeq
 * @property {bigint} recvSeq
 * @property {bigint} ackSeq
 * @property {bigint} hubDelivery
 * @property {Frame[]} outbox
 * @property {Frame[]} inbox
 * @property {ReturnType<typeof setTimeout> | undefined} timer
 * @property {number} delay
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const version = 2;
/** @param {unknown} value */
const sequence = value => {
  (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) ||
    Fail`Invalid delivery sequence`;
  return BigInt(/** @type {string} */ (value));
};
/** @param {Record<string, unknown>} header @param {Uint8Array} [payload] */
const encode = (header, payload = new Uint8Array()) => {
  const head = encoder.encode(`${JSON.stringify({ v: version, ...header })}\n`);
  const bytes = new Uint8Array(head.length + payload.length);
  bytes.set(head);
  bytes.set(payload, head.length);
  return bytes;
};
const makeToken = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * @param {object} options
 * @param {any} options.handlers
 * @param {any} options.logger
 * @param {(powers: {handlers: any, logger: any}) => any} options.makeBaseNetlayer
 * @param {SessionResumptionPower} [options.resumption]
 * @param {number} [options.reconnectDelayMs]
 * @param {number} [options.maxReconnectDelayMs]
 */
export const makeDurableNetLayer = async ({
  handlers,
  logger,
  makeBaseNetlayer,
  resumption,
  reconnectDelayMs = 50,
  maxReconnectDelayMs = 1000,
}) => {
  /** @type {Map<string, LogicalConnection>} */
  const sessions = new Map();
  /** @type {Map<any, LogicalConnection>} */
  const physicals = new Map();
  /** @type {Map<any, LogicalConnection>} */
  const connections = new Map();
  /** @type {Map<string, LogicalConnection>} */
  const outgoing = new Map();
  // Nonpersistent peers also must never resurrect a retired token in-process.
  const retired = new Set();
  let stopped = false;
  let started = false;
  /** @type {any} */
  let base;
  /** @type {any} */
  let netlayer;

  /** @param {LogicalConnection} logical @param {Record<string, unknown>} header @param {Uint8Array} [payload] */
  const writeWire = (logical, header, payload) => {
    if (!logical.transport || logical.transport.isDestroyed) return;
    try {
      logical.transport.write(encode(header, payload));
    } catch (error) {
      logger.info('delivery transport write failed', error);
      logical.transport.end();
    }
  };

  /** @param {LogicalConnection} logical */
  const drain = logical => {
    if (logical.draining || stopped || logical.destroyed) return;
    logical.draining = true;
    try {
      while (logical.inbox.length && !logical.destroyed && !stopped) {
        const entry = logical.inbox[0];
        handlers.handleMessageData(logical.connection, entry.bytes, entry.n);
        if (logical.destroyed) break;
        if (logical.durable)
          resumption?.recordProcessed(logical.token, entry.n);
        logical.inbox.shift();
      }
    } finally {
      logical.draining = false;
    }
  };

  /** @param {LogicalConnection} logical @param {unknown} scope */
  const acceptPeerProfile = (logical, scope) => {
    if (scope !== 'restart' && scope !== 'process')
      throw Fail`Invalid acceptance durability`;
    logical.peerDurability === undefined ||
      logical.peerDurability === scope ||
      Fail`Peer changed acceptance durability`;
    if (logical.durable) resumption?.recordPeerDurability(logical.token, scope);
    logical.peerDurability = scope;
  };

  /** @param {LogicalConnection} logical @param {bigint} n */
  const acknowledge = (logical, n) => {
    n <= logical.sendSeq || Fail`Acknowledgement exceeds issued sequence`;
    // Reordered old receipts do not regress the durable acceptance watermark.
    if (n <= logical.ackSeq) return;
    if (logical.durable) resumption?.recordAck(logical.token, n);
    logical.ackSeq = n;
    logical.outbox = logical.outbox.filter(entry => entry.n > n);
  };

  /** @param {LogicalConnection} logical @param {bigint} n */
  const openFlow = (logical, n) => {
    n >= logical.ackSeq || Fail`Peer lost previously accepted deliveries`;
    acknowledge(logical, n);
    logical.flowing = true;
    for (const entry of [...logical.outbox]) {
      writeWire(logical, { t: 'f', n: String(entry.n) }, entry.bytes);
    }
    drain(logical);
  };

  /** @param {LogicalConnection} logical */
  const schedule = logical => {
    if (
      stopped ||
      (logical.destroyed && logical.retirementConfirmed) ||
      !logical.isOriginator ||
      logical.timer ||
      logical.transport
    )
      return;
    const delay = logical.delay;
    logical.delay = Math.min(delay * 2, maxReconnectDelayMs);
    logical.timer = setTimeout(() => {
      logical.timer = undefined;
      // eslint-disable-next-line no-use-before-define
      dial(logical);
    }, delay);
    if (typeof logical.timer === 'object') logical.timer.unref?.();
  };

  /** @param {LogicalConnection} logical */
  const dial = logical => {
    if (
      stopped ||
      (logical.destroyed && logical.retirementConfirmed) ||
      logical.transport
    )
      return;
    try {
      const physical = base.connect(logical.location);
      logical.transport = physical;
      physicals.set(physical, logical);
      // hello is idempotent, including a lost first hello or welcome. It
      // never clears an existing durable record or a retirement tombstone.
      writeWire(logical, {
        t: logical.destroyed ? 'retire' : 'hello',
        tok: logical.token,
        durability: logical.durable ? 'restart' : 'process',
        rcv: String(logical.recvSeq),
      });
    } catch (error) {
      logger.info('delivery connection attempt failed', error);
      schedule(logical);
    }
  };

  /** @param {LogicalConnection} logical @param {boolean} [confirmed] */
  const retire = (logical, confirmed = false) => {
    const wasDestroyed = logical.destroyed;
    if (!wasDestroyed && logical.durable) resumption?.onEnd(logical.token);
    if (confirmed && logical.durable)
      resumption?.recordRetirementConfirmed(logical.token);
    retired.add(logical.token);
    logical.destroyed = true;
    logical.retirementConfirmed ||= confirmed;
    if (logical.timer) clearTimeout(logical.timer);
    logical.timer = undefined;
    if (!confirmed && logical.flowing) writeWire(logical, { t: 'bye' });
    const physical = logical.transport;
    logical.transport = undefined;
    logical.flowing = false;
    physicals.delete(physical);
    physical?.end();
    connections.delete(logical.connection);
    if (logical.isOriginator) outgoing.delete(JSON.stringify(logical.location));
    if (!wasDestroyed) handlers.handleConnectionClose(logical.connection);
    // An originator owns a retryable terminal notice until the peer confirms
    // its tombstone. An acceptor repeats retirement on subsequent greetings.
    schedule(logical);
  };

  /** @param {string} token @param {boolean} isOriginator @param {any} location @param {SessionRecord} [record] */
  const makeLogical = (token, isOriginator, location, record) => {
    /** @type {LogicalConnection} */
    const logical = {
      token,
      isOriginator,
      location,
      connection: undefined,
      transport: undefined,
      flowing: false,
      destroyed: record?.retired ?? false,
      retirementConfirmed: record?.retirementConfirmed ?? false,
      durable: !!resumption,
      draining: false,
      peerDurability: record?.peerDurability,
      sendSeq: sequence(record?.sendSeq ?? '0'),
      recvSeq: sequence(record?.recvSeq ?? '0'),
      ackSeq: sequence(record?.ackSeq ?? '0'),
      hubDelivery: sequence(record?.hubDelivery ?? '0'),
      outbox:
        record?.frames.map(({ n, bytes }) => ({ n: sequence(n), bytes })) ?? [],
      inbox:
        record?.inbox.map(({ n, bytes }) => ({ n: sequence(n), bytes })) ?? [],
      timer: undefined,
      delay: reconnectDelayMs,
    };
    const ops = harden({
      /** @param {Uint8Array} bytes @param {string} [hubSequence] */
      write: (bytes, hubSequence) => {
        if (stopped || logical.destroyed) return false;
        if (
          hubSequence !== undefined &&
          sequence(hubSequence) <= logical.hubDelivery
        )
          return true;
        const entry = { n: logical.sendSeq + 1n, bytes: bytes.slice() };
        if (logical.durable)
          resumption?.recordOutbound(token, entry.n, entry.bytes, hubSequence);
        logical.sendSeq = entry.n;
        logical.outbox.push(entry);
        if (hubSequence !== undefined)
          logical.hubDelivery = sequence(hubSequence);
        if (logical.flowing)
          writeWire(logical, { t: 'f', n: String(entry.n) }, entry.bytes);
        return true;
      },
      end: () => retire(logical),
    });
    logical.connection = handlers.makeConnection(netlayer, isOriginator, ops);
    sessions.set(token, logical);
    connections.set(logical.connection, logical);
    if (isOriginator && !logical.destroyed)
      outgoing.set(JSON.stringify(location), logical);
    return logical;
  };

  /** @param {string} token */
  const restore = token => {
    const existing = sessions.get(token);
    if (existing) return existing;
    const record = resumption?.loadForResume(token);
    if (!record) return undefined;
    const logical = makeLogical(
      token,
      record.isOriginator,
      record.location,
      record,
    );
    try {
      if (!logical.destroyed)
        resumption?.restoreSession(handlers, logical.connection, token);
    } catch (error) {
      sessions.delete(token);
      connections.delete(logical.connection);
      if (logical.isOriginator)
        outgoing.delete(JSON.stringify(logical.location));
      throw error;
    }
    return logical;
  };

  const subHandlers = harden({
    /** @param {any} layer @param {boolean} isOutgoing @param {any} socket */
    makeConnection: (layer, isOutgoing, socket) => {
      let destroyed = false;
      return harden({
        netlayer: layer,
        isOutgoing,
        get isDestroyed() {
          return destroyed;
        },
        /** @param {Uint8Array} bytes */
        write: bytes => socket.write(bytes),
        end: () => {
          if (destroyed) return;
          destroyed = true;
          socket.end();
        },
      });
    },
    /** @param {any} physical @param {Uint8Array} bytes */
    handleMessageData: (physical, bytes) => {
      if (stopped || physical.isDestroyed) return;
      try {
        const newline = bytes.indexOf(10);
        newline >= 0 || Fail`Missing envelope header`;
        const header = JSON.parse(decoder.decode(bytes.subarray(0, newline)));
        header?.v === version || Fail`Unsupported delivery protocol version`;
        const bound = physicals.get(physical);
        switch (header.t) {
          case 'retire': {
            (!bound && !physical.isOutgoing) ||
              Fail`Unexpected retirement greeting`;
            (typeof header.tok === 'string' &&
              /^[0-9a-f]{32}$/.test(header.tok)) ||
              Fail`Invalid session token`;
            const logical = restore(header.tok);
            if (logical) {
              !logical.isOriginator || Fail`Cannot reverse session direction`;
              retire(logical, true);
            } else if (
              !retired.has(header.tok) &&
              !resumption?.isRetired(header.tok)
            ) {
              resumption?.onHello(header.tok);
              resumption?.onEnd(header.tok);
              resumption?.recordRetirementConfirmed(header.tok);
              retired.add(header.tok);
            }
            physical.write(encode({ t: 'retired' }));
            physical.end();
            break;
          }
          case 'hello':
          case 'resume': {
            (!bound && !physical.isOutgoing) ||
              Fail`Unexpected session greeting`;
            (typeof header.tok === 'string' &&
              /^[0-9a-f]{32}$/.test(header.tok)) ||
              Fail`Invalid session token`;
            if (retired.has(header.tok) || resumption?.isRetired(header.tok)) {
              physical.write(encode({ t: 'retired' }));
              physical.end();
              return;
            }
            let logical = restore(header.tok);
            if (!logical) {
              if (resumption) {
                resumption.isDurableToken(header.tok) ||
                  Fail`Invalid durable token`;
                resumption.onHello(header.tok);
              }
              logical = makeLogical(header.tok, false, undefined);
            }
            !logical.isOriginator || Fail`Cannot reverse session direction`;
            acceptPeerProfile(logical, header.durability);
            const rcv = sequence(header.rcv);
            (rcv >= logical.ackSeq && rcv <= logical.sendSeq) ||
              Fail`Invalid resumed acceptance`;
            if (logical.transport) {
              physicals.delete(logical.transport);
              logical.transport.end();
            }
            logical.transport = physical;
            logical.flowing = false;
            physicals.set(physical, logical);
            writeWire(logical, {
              t: 'welcome',
              durability: logical.durable ? 'restart' : 'process',
              rcv: String(logical.recvSeq),
            });
            openFlow(logical, rcv);
            break;
          }
          case 'welcome': {
            if (!bound) throw Fail`Unexpected welcome`;
            (bound.isOriginator && !bound.flowing) || Fail`Unexpected welcome`;
            acceptPeerProfile(bound, header.durability);
            openFlow(bound, sequence(header.rcv));
            bound.delay = reconnectDelayMs;
            break;
          }
          case 'f': {
            if (!bound) throw Fail`Frame before session acceptance`;
            bound.flowing || Fail`Frame before session acceptance`;
            const n = sequence(header.n);
            n > 0n || Fail`Invalid frame sequence`;
            if (n <= bound.recvSeq) {
              writeWire(bound, { t: 'ack', n: String(bound.recvSeq) });
              drain(bound);
              break;
            }
            n === bound.recvSeq + 1n || Fail`Delivery sequence gap`;
            const payload = bytes.slice(newline + 1);
            if (bound.durable)
              resumption?.recordInbound(bound.token, n, payload);
            bound.inbox.push({ n, bytes: payload });
            bound.recvSeq = n;
            writeWire(bound, { t: 'ack', n: String(n) });
            drain(bound);
            break;
          }
          case 'ack': {
            if (!bound) throw Fail`Acknowledgement before session acceptance`;
            bound.flowing || Fail`Acknowledgement before session acceptance`;
            acknowledge(bound, sequence(header.n));
            break;
          }
          case 'retired': {
            if (!bound) throw Fail`Retirement without a session`;
            (bound.isOriginator && !bound.flowing) ||
              Fail`Unexpected retirement`;
            retire(bound, true);
            break;
          }
          case 'bye': {
            if (!bound) throw Fail`Close before session acceptance`;
            retire(bound, true);
            break;
          }
          default:
            Fail`Unknown delivery envelope`;
        }
      } catch (error) {
        // Retain accepted inbox work on handler/storage failure. Never retire
        // the logical session just because this physical attempt failed.
        logger.error('delivery attempt failed', error);
        physical.end();
      }
    },
    /** @param {any} physical */
    handleConnectionClose: physical => {
      const logical = physicals.get(physical);
      physicals.delete(physical);
      if (!logical || logical.transport !== physical) return;
      logical.transport = undefined;
      logical.flowing = false;
      schedule(logical);
    },
  });
  base = await makeBaseNetlayer({ handlers: subHandlers, logger });
  netlayer = harden({
    location: base.location,
    locationId: base.locationId,
    /** @param {any} location */
    connect: location => {
      !stopped || Fail`Delivery transport stopped`;
      const existing = outgoing.get(JSON.stringify(location));
      if (existing) return existing.connection;
      const token = makeToken();
      resumption?.onHello(token, location);
      const logical = makeLogical(token, true, location);
      dial(logical);
      return logical.connection;
    },
    // The daemon calls this after installing the netlayer reference used by
    // its handshake handlers. Recovery also drains inboxes while peers sleep.
    start: () => {
      if (started || stopped) return;
      started = true;
      for (const token of resumption?.listSessions() ?? []) restore(token);
      for (const logical of sessions.values()) {
        drain(logical);
        if (logical.isOriginator) dial(logical);
      }
    },
    shutdown: () => {
      if (stopped) return;
      stopped = true;
      for (const logical of sessions.values()) {
        if (logical.timer) clearTimeout(logical.timer);
        if (logical.durable) logical.transport?.end();
        else retire(logical);
      }
      base.shutdown();
    },
    /** @param {any} connection */
    getPeerDurability: connection =>
      connections.get(connection)?.peerDurability,
    /** @param {any} connection */
    getResumeToken: connection => {
      const logical = connections.get(connection);
      return logical?.durable ? logical.token : undefined;
    },
  });
  return netlayer;
};
harden(makeDurableNetLayer);
