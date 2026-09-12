// @ts-check
/* eslint-disable no-bitwise -- DNS fields are bounded 16-bit wire values. */

import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';

/** @import { RemoteInfo } from 'node:dgram' */

/** Parse one uncompressed IN question. No arbitrary DNS packets cross the
 * host pipe: the endpoint receives only the validated hostname.
 * @param {Uint8Array} packet
 */
const question = packet => {
  (packet.length >= 17 && packet.length <= 512) || Fail`Invalid DNS size`;
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  // Accept a standard query with optional recursion-desired only. No answers,
  // authority records, or additional records (including EDNS) are supported.
  ([0, 0x100].includes(view.getUint16(2)) &&
    view.getUint16(4) === 1 &&
    view.getUint16(6) === 0 &&
    view.getUint16(8) === 0 &&
    view.getUint16(10) === 0) ||
    Fail`Unsupported DNS query`;
  let cursor = 12;
  const labels = [];
  while (cursor < packet.length && packet[cursor] !== 0) {
    const size = packet[cursor];
    cursor += 1;
    (size <= 63 && cursor + size < packet.length) || Fail`Invalid DNS label`;
    const label = new TextDecoder('utf-8', { fatal: true }).decode(
      packet.subarray(cursor, cursor + size),
    );
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label) ||
      Fail`Invalid DNS hostname`;
    labels.push(label);
    cursor += size;
  }
  (labels.length > 0 && cursor + 5 === packet.length) ||
    Fail`Invalid DNS question`;
  const hostname = labels.join('.').toLowerCase();
  hostname.length <= 253 || Fail`DNS hostname too long`;
  cursor += 1;
  const type = view.getUint16(cursor);
  view.getUint16(cursor + 2) === 1 || Fail`Unsupported DNS class`;
  return { hostname, type };
};

/**
 * @param {string} address
 * @param {number} family
 */
const addressBytes = (address, family) => {
  isIP(address) === family || Fail`Invalid resolver address`;
  if (family === 4) return Uint8Array.from(address.split('.').map(Number));
  // Host resolver excludes mapped and scoped IPv6. Expand ordinary hexadecimal
  // global-unicast forms without adding another DNS lookup.
  (!address.includes('.') && !address.includes('%')) ||
    Fail`Unsupported IPv6 form`;
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left;
  groups.length === 8 || Fail`Invalid IPv6 address`;
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  groups.forEach((group, index) =>
    view.setUint16(index * 2, parseInt(group, 16)),
  );
  return bytes;
};

/** Minimal bounded A/AAAA response, no recursive packet forwarding or cache.
 * Unsupported query types return NODATA. Malformed/extended queries return
 * FORMERR, allowing resolvers to retry without extensions.
 * @param {Uint8Array} packet
 * @param {any} endpoint Host-only public resolver capability.
 */
export const answerPublicDns = async (packet, endpoint) => {
  const header = new Uint8Array(12);
  header.set(packet.subarray(0, 2));
  const headerView = new DataView(header.buffer);
  headerView.setUint16(2, 0x8080 | (((packet[2] || 0) & 1) * 256));
  let parsed;
  try {
    parsed = question(packet);
  } catch {
    headerView.setUint16(2, headerView.getUint16(2) | 1);
    return header;
  }
  const { hostname, type } = parsed;
  const query = packet.subarray(12);
  headerView.setUint16(4, 1);
  /** @type {Uint8Array[]} */
  const answers = [];
  if (type === 1 || type === 28) {
    try {
      const result = await E(endpoint).resolvePublic(hostname);
      Array.isArray(result?.addresses) || Fail`Invalid resolver result`;
      /** @type {{address:string,family:number}[]} */
      const resolved = result.addresses;
      resolved.length <= 32 || Fail`Invalid resolver result`;
      const family = type === 1 ? 4 : 6;
      const addresses = resolved
        .filter(item => item.family === family)
        .slice(0, 8);
      for (const item of addresses) {
        const bytes = addressBytes(item.address, family);
        const answer = new Uint8Array(12 + bytes.length);
        const view = new DataView(answer.buffer);
        view.setUint16(0, 0xc00c); // Question name, never external compression.
        view.setUint16(2, type);
        view.setUint16(4, 1);
        view.setUint32(6, 0); // Do not cache authorization decisions.
        view.setUint16(10, bytes.length);
        answer.set(bytes, 12);
        answers.push(answer);
      }
    } catch {
      answers.length = 0;
      headerView.setUint16(2, headerView.getUint16(2) | 5); // REFUSED
    }
  }
  headerView.setUint16(6, answers.length);
  const size =
    12 + query.length + answers.reduce((sum, bytes) => sum + bytes.length, 0);
  size <= 512 || Fail`DNS response limit`;
  const response = new Uint8Array(size);
  response.set(header);
  response.set(query, 12);
  let cursor = 12 + query.length;
  for (const answer of answers) {
    response.set(answer, cursor);
    cursor += answer.length;
  }
  return response;
};
harden(answerPublicDns);

/** Credential-free UDP DNS adapter inside the isolated listener namespace.
 * The trusted bootstrap supplies its address in read-only resolv.conf. Tools
 * have a separate network namespace and cannot contact this socket directly.
 * @param {{endpoint:any,host?:string,port?:number,maxPending?:number}} options
 */
export const makePublicDnsListener = async ({
  endpoint,
  host = '127.0.0.53',
  port = 53,
  maxPending = 16,
}) => {
  (isIP(host) === 4 &&
    Number.isInteger(port) &&
    port >= 0 &&
    port <= 65_535 &&
    Number.isInteger(maxPending) &&
    maxPending > 0 &&
    maxPending <= 64) ||
    Fail`Invalid DNS listener options`;
  const socket = createSocket('udp4');
  let closed = false;
  /** @type {Promise<void> | undefined} */
  let closing;
  const dispose = () => {
    closed = true;
    if (!closing) {
      closing = new Promise(resolve => {
        try {
          socket.close(() => resolve());
        } catch {
          // Binding can fail before the socket enters the running state.
          resolve();
        }
      });
    }
    return closing;
  };
  let pending = 0;
  /**
   * @param {Uint8Array} packet
   * @param {RemoteInfo} remote
   */
  const receive = async (packet, remote) => {
    if (
      closed ||
      packet.length < 12 ||
      packet.length > 512 ||
      pending >= maxPending
    )
      return;
    pending += 1;
    try {
      const response = await answerPublicDns(packet, endpoint);
      if (!closed) socket.send(response, remote.port, remote.address, () => {});
    } catch {
      // A bounded failed query does not take down other listeners.
    } finally {
      pending -= 1;
    }
  };
  socket.on('message', receive);
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, host, () => {
        socket.removeListener('error', reject);
        resolve(undefined);
      });
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  // Shutdown on an unexpected socket failure, never reopen with broader policy.
  socket.on('error', () => {
    void dispose();
  });
  const bound = socket.address();
  return harden({
    host: bound.address,
    port: bound.port,
    dispose,
  });
};
harden(makePublicDnsListener);
