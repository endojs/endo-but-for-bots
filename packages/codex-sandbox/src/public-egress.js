// @ts-check

import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { lookup as lookupAddress } from 'node:dns/promises';
import { BlockList, createConnection, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/** @import { LookupAddress } from 'node:dns' */
/** @import { Socket } from 'node:net' */

const blocked = new BlockList();
/** @type {readonly (readonly [string, number])[]} */
const blockedV4 = harden([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
]);
for (const [address, prefix] of blockedV4)
  blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
/** @type {readonly (readonly [string, number])[]} */
const blockedV6 = harden([
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
]);
for (const [address, prefix] of blockedV6)
  blocked.addSubnet(address, prefix, 'ipv6');

/**
 * Conservative global-unicast classification. Mapped IPv4, NAT64, Teredo,
 * 6to4, documentation, multicast and other special-use space fail closed.
 * Some IANA global exceptions are intentionally excluded by this profile.
 * @param {string} address
 */
export const isPublicEgressAddress = address => {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return (
    family === 6 &&
    globalV6.check(address, 'ipv6') &&
    !blocked.check(address, 'ipv6')
  );
};
harden(isPublicEgressAddress);

const CHUNK_BYTES = 48 * 1024;
const CHUNK_TEXT = 64 * 1024;
const { atob, btoa } = globalThis;

/**
 * Host-only public TCP authority, intentionally usable for uploads as well as
 * downloads after operator approval. Only ports 80/443 are exposed. The
 * namespace proxy holds this capability, never credentials or a host socket.
 * DNS answers are all checked, then an approved literal IP is dialed without
 * another lookup. Revocation destroys live connections. Timed-out resolver
 * work retains its admission slot until it settles, avoiding unbounded work.
 * The injected powers are trusted test/operator inputs, never session input.
 * @param {object} options
 * @param {'off'|'public-internet'} options.policy
 * @param {(hostname:string, options:{all:true,verbatim:true})=>Promise<LookupAddress[]>} [options.lookup]
 * @param {(options:{host:string,family:number,port:number,highWaterMark:number})=>Socket} [options.connect]
 * @param {readonly string[]} [options.localAddresses]
 * @param {()=>readonly string[]} [options.getLocalAddresses] Live host addresses; previously observed addresses remain denied.
 * @param {number} [options.maxConnections] At most 64 simultaneous sockets/resolutions.
 * @param {number} [options.maxRequests] At most 65536 connections per generation.
 * @param {bigint} [options.maxBytes] Aggregate bidirectional payload quota.
 * @param {number} [options.timeoutMs] Absolute lifetime, at most ten minutes.
 * @param {number} [options.dnsTimeoutMs] Resolver response deadline, at most thirty seconds.
 */
export const makePublicEgress = ({
  policy,
  lookup = lookupAddress,
  connect = createConnection,
  localAddresses = [],
  getLocalAddresses = () =>
    Object.values(networkInterfaces()).flatMap(items =>
      (items || []).map(item => item.address),
    ),
  maxConnections = 8,
  maxRequests = 1024,
  maxBytes = 2n * 1024n ** 3n,
  timeoutMs = 600_000,
  dnsTimeoutMs = 5000,
}) => {
  ['off', 'public-internet'].includes(policy) || Fail`Invalid egress policy`;
  (Number.isInteger(maxConnections) &&
    maxConnections > 0 &&
    maxConnections <= 64 &&
    Number.isInteger(maxRequests) &&
    maxRequests > 0 &&
    maxRequests <= 65_536 &&
    typeof maxBytes === 'bigint' &&
    maxBytes > 0n &&
    Number.isInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= 600_000 &&
    Number.isInteger(dnsTimeoutMs) &&
    dnsTimeoutMs > 0 &&
    dnsTimeoutMs <= 30_000) ||
    Fail`Invalid public egress limits`;
  const local = new BlockList();
  const observedLocal = new Set();
  let localHistoryExhausted = false;
  const rememberLocal = addresses => {
    !localHistoryExhausted || Fail`Host address history exhausted`;
    for (const address of addresses) {
      const family = isIP(address);
      if (family && !observedLocal.has(address)) {
        if (observedLocal.size >= 4096) {
          localHistoryExhausted = true;
          Fail`Host address history exhausted`;
        }
        observedLocal.add(address);
        local.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
      }
    }
  };
  const refreshLocal = () => rememberLocal(getLocalAddresses());
  rememberLocal(localAddresses);
  refreshLocal();
  const publicTarget = address =>
    isPublicEgressAddress(address) &&
    !local.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  /** @param {string} hostname */
  const assertHostname = hostname =>
    (hostname.length > 0 &&
      hostname.length <= 253 &&
      /^[A-Za-z0-9.:-]+$/.test(hostname) &&
      !hostname.includes('%')) ||
    Fail`Invalid public egress host`;
  const assertAnswers = answers => {
    refreshLocal();
    (Array.isArray(answers) &&
      answers.length > 0 &&
      answers.length <= 32 &&
      answers.every(
        answer =>
          isIP(answer.address) === answer.family &&
          publicTarget(answer.address),
      )) ||
      Fail`Public egress destination is not public`;
    return answers;
  };
  const resolveAddresses = async hostname => {
    const family = isIP(hostname);
    return assertAnswers(
      family
        ? [{ address: hostname, family }]
        : await lookup(hostname, { all: true, verbatim: true }),
    );
  };
  /** @type {Set<() => void>} */
  const active = new Set();
  let disposed = false;
  let requests = 0;
  let bytes = 0n;
  const dispose = () => {
    disposed = true;
    for (const close of active) close();
  };
  const account = count => {
    bytes += BigInt(count);
    if (bytes > maxBytes) {
      dispose();
      Fail`Public egress byte quota exhausted`;
    }
  };
  const endpoint = makeExo(
    'PublicEgress',
    M.interface('PublicEgress', {
      open: M.call(M.string(), M.number()).returns(M.promise()),
      resolvePublic: M.call(M.string()).returns(M.promise()),
    }),
    {
      async resolvePublic(hostname) {
        (!disposed && policy === 'public-internet') ||
          Fail`Public egress is disabled`;
        assertHostname(hostname);
        (active.size < maxConnections && requests < maxRequests) ||
          Fail`Public egress connection quota exhausted`;
        requests += 1;
        let stopped = false;
        let rejectStopped;
        const stoppedP = new Promise((_resolve, reject) => {
          rejectStopped = reject;
        });
        const close = () => {
          stopped = true;
          rejectStopped(Error('Public resolution stopped'));
        };
        active.add(close);
        const timer = globalThis.setTimeout(
          close,
          Math.min(timeoutMs, dnsTimeoutMs),
        );
        const resolution = Promise.resolve()
          .then(() => resolveAddresses(hostname))
          .then(addresses => {
            (!stopped && !disposed) || Fail`Public resolution stopped`;
            return harden({
              addresses: addresses.map(({ address, family }) => ({
                address,
                family,
              })),
              ttlSeconds: 60,
            });
          })
          .finally(() => {
            globalThis.clearTimeout(timer);
            active.delete(close);
          });
        try {
          return await Promise.race([resolution, stoppedP]);
        } catch (_error) {
          throw Error('Public resolution denied or unavailable');
        }
      },
      async open(hostname, port) {
        (!disposed && policy === 'public-internet') ||
          Fail`Public egress is disabled`;
        port === 80 ||
          port === 443 ||
          Fail`Only public HTTP and HTTPS ports are supported`;
        assertHostname(hostname);
        (active.size < maxConnections && requests < maxRequests) ||
          Fail`Public egress connection quota exhausted`;
        requests += 1;
        /** @type {Socket | undefined} */
        let socket;
        let closed = false;
        let ended = false;
        let resolving = true;
        let aborted = false;
        let timer;
        /** @type {Set<() => void>} */
        const stopWaiters = new Set();
        const signalStopped = () => {
          for (const stop of [...stopWaiters]) stop();
        };
        /** @type {Set<() => void>} */
        const wakeups = new Set();
        const wake = () => {
          for (const ready of [...wakeups]) ready();
        };
        const close = () => {
          closed = true;
          aborted = true;
          globalThis.clearTimeout(timer);
          socket?.destroy();
          signalStopped();
          wake();
          if (!resolving && !socket) active.delete(close);
        };
        const untilStopped = operation =>
          new Promise((resolve, reject) => {
            const stop = () => {
              stopWaiters.delete(stop);
              reject(Error('Public egress operation stopped'));
            };
            stopWaiters.add(stop);
            Promise.resolve(operation).then(
              value => {
                stopWaiters.delete(stop);
                resolve(value);
              },
              error => {
                stopWaiters.delete(stop);
                reject(error);
              },
            );
            if (closed || disposed) stop();
          });
        active.add(close);
        timer = globalThis.setTimeout(close, timeoutMs);
        try {
          const dnsTimer = globalThis.setTimeout(
            close,
            Math.min(timeoutMs, dnsTimeoutMs),
          );
          const lookupResult = Promise.resolve()
            .then(() => resolveAddresses(hostname))
            .finally(() => {
              globalThis.clearTimeout(dnsTimer);
              resolving = false;
              if (closed && !socket) active.delete(close);
            });
          const answers = await untilStopped(lookupResult);
          (!closed && !disposed) || Fail`Public egress expired`;
          const target = answers[0];
          assertAnswers([target]);
          // An IP literal suppresses net.connect's resolver entirely.
          socket = connect({
            host: target.address,
            family: target.family,
            port,
            highWaterMark: CHUNK_BYTES,
          });
          const connection = socket;
          connection.on('error', close);
          connection.once('end', () => {
            ended = true;
            wake();
          });
          connection.once('close', () => {
            closed = true;
            globalThis.clearTimeout(timer);
            signalStopped();
            wake();
            active.delete(close);
          });
          await untilStopped(
            new Promise((resolve, reject) =>
              connection.once('connect', () => {
                try {
                  // Address assignment can change while connect is pending.
                  // Never expose a tunnel (or write payload) before rechecking.
                  assertAnswers([target]);
                  resolve(undefined);
                } catch (error) {
                  close();
                  reject(error);
                }
              }),
            ),
          );
          let reading = false;
          let writing = false;
          let writeEnded = false;
          return makeExo(
            'PublicEgressTunnel',
            M.interface('PublicEgressTunnel', {
              read: M.call().returns(M.promise()),
              write: M.call(M.string()).returns(M.promise()),
              end: M.call().returns(M.undefined()),
              close: M.call().returns(M.undefined()),
            }),
            {
              async read() {
                !reading || Fail`Concurrent public egress reads denied`;
                reading = true;
                try {
                  for (;;) {
                    (!aborted && !disposed) ||
                      Fail`Public egress tunnel closed`;
                    const available = Math.min(
                      CHUNK_BYTES,
                      connection.readableLength,
                    );
                    const chunk = available ? connection.read(available) : null;
                    if (chunk) {
                      account(chunk.byteLength);
                      return btoa(String.fromCharCode(...chunk));
                    }
                    if (ended) return null;
                    !closed ||
                      Fail`Public egress connection closed without EOF`;
                    // Ask Node to refill its bounded read buffer.
                    connection.read(0);
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise(resolve => {
                      const ready = () => {
                        connection.off('readable', ready);
                        wakeups.delete(ready);
                        resolve(undefined);
                      };
                      wakeups.add(ready);
                      connection.once('readable', ready);
                    });
                  }
                } finally {
                  reading = false;
                }
              },
              async write(/** @type {string} */ text) {
                (!closed && !disposed && !writeEnded && !writing) ||
                  Fail`Public egress write denied`;
                (text.length > 0 &&
                  text.length <= CHUNK_TEXT &&
                  text.length % 4 === 0 &&
                  /^[A-Za-z0-9+/=]+$/.test(text)) ||
                  Fail`Invalid public egress chunk`;
                const raw = atob(text);
                btoa(raw) === text || Fail`Noncanonical public egress chunk`;
                const decoded = Uint8Array.from(raw, char =>
                  char.charCodeAt(0),
                );
                account(decoded.byteLength);
                writing = true;
                try {
                  await untilStopped(
                    new Promise((resolve, reject) => {
                      connection.write(decoded, error =>
                        error
                          ? reject(Error('Public egress write failed'))
                          : resolve(undefined),
                      );
                    }),
                  );
                } finally {
                  writing = false;
                }
              },
              end() {
                writeEnded = true;
                connection.end();
              },
              close,
            },
          );
        } catch (_error) {
          close();
          throw Error('Public egress connection denied or unavailable');
        }
      },
    },
  );
  return harden({ endpoint, dispose });
};
harden(makePublicEgress);
