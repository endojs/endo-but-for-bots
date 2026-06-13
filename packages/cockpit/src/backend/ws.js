// @ts-check
//
// A minimal RFC 6455 websocket server over node:http upgrades. Dependency-free
// on purpose: the cockpit's frontend stack is a boring, no-build choice
// (designs/garden-cockpit.md § "Cockpit frontend"), and a localhost,
// single-user harness-host does not need a websocket library. Handles text
// frames, ping/pong, and close. Not for hostile networks.

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Encode a server→client text frame (unmasked). @param {string} str */
const encodeText = str => {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
};

/**
 * Parse as many complete frames as are buffered. Returns the events decoded
 * and the unconsumed tail.
 *
 * @param {Buffer} buf
 * @returns {{ frames: Array<{ opcode: number, payload: Buffer }>, rest: Buffer }}
 */
const parseFrames = buf => {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (pos + 2 > buf.length) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (pos + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (pos + maskLen + len > buf.length) break;
    let payload = buf.subarray(pos + maskLen, pos + maskLen + len);
    if (masked) {
      const mask = buf.subarray(pos, pos + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    frames.push({ opcode, payload });
    offset = pos + maskLen + len;
  }
  return { frames, rest: buf.subarray(offset) };
};

/**
 * Attach a websocket endpoint at `path` on an existing http server.
 *
 * @param {import('node:http').Server} httpServer
 * @param {object} options
 * @param {string} [options.path]
 * @param {(conn: {
 *   send: (str: string) => void,
 *   close: () => void,
 *   onMessage: (fn: (str: string) => void) => void,
 *   onClose: (fn: () => void) => void,
 * }) => void} options.onConnection
 */
export const attachWebSocketServer = (httpServer, { path = '/ws', onConnection }) => {
  httpServer.on('upgrade', (req, socket) => {
    if (new URL(req.url || '/', 'http://localhost').pathname !== path) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    /** @type {Array<(str: string) => void>} */
    const messageHandlers = [];
    /** @type {Array<() => void>} */
    const closeHandlers = [];
    let buffer = Buffer.alloc(0);
    let closed = false;

    const send = str => {
      if (!closed && socket.writable) socket.write(encodeText(str));
    };
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        socket.write(Buffer.from([0x88, 0x00]));
      } catch {
        // socket already gone
      }
      socket.end();
    };
    const fireClose = () => {
      if (closed) return;
      closed = true;
      for (const fn of closeHandlers) fn();
    };

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = parseFrames(buffer);
      buffer = rest;
      for (const { opcode, payload } of frames) {
        if (opcode === 0x8) {
          fireClose();
          close();
        } else if (opcode === 0x9) {
          // ping → pong
          if (socket.writable) socket.write(Buffer.from([0x8a, 0x00]));
        } else if (opcode === 0x1) {
          const str = payload.toString('utf8');
          for (const fn of messageHandlers) fn(str);
        }
      }
    });
    socket.on('close', fireClose);
    socket.on('error', fireClose);

    onConnection({
      send,
      close,
      destroy: () => socket.destroy(),
      onMessage: fn => messageHandlers.push(fn),
      onClose: fn => closeHandlers.push(fn),
    });
  });
};
