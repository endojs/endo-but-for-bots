// @ts-check

/* eslint-disable no-bitwise, no-underscore-dangle */

/**
 * @file Minimal D-Bus message serialization.
 *
 * D-Bus wire format follows the D-Bus Specification v0.43, 2024-10-29.
 * https://dbus.freedesktop.org/doc/dbus-specification.html
 *
 * API shape (`DBusAddress`, `newMethodCall`) modeled after Jeepney v0.9.0,
 * 2025-02-27, by Thomas Kluyver.
 * https://jeepney.readthedocs.io/en/latest/
 */

/** D-Bus method call message type. */
export const MESSAGE_TYPE_METHOD_CALL = 1;

/** D-Bus method return message type. */
export const MESSAGE_TYPE_METHOD_RETURN = 2;

/** D-Bus signal message type. */
export const MESSAGE_TYPE_SIGNAL = 4;

/** @import { DBusAddress } from './types.js' */

/** Header field codes. */
export const FIELD_PATH = 1;
export const FIELD_INTERFACE = 2;
export const FIELD_MEMBER = 3;
export const FIELD_DESTINATION = 6;
export const FIELD_SIGNATURE = 8;

const { Fail } = assert;

/** Type alignment in bytes. */
const TYPE_ALIGN = harden({
  y: 1,
  b: 4,
  n: 2,
  q: 2,
  i: 4,
  u: 4,
  x: 8,
  t: 8,
  d: 8,
  s: 4,
  o: 4,
  g: 1,
  v: 1,
  h: 4,
});

/**
 * @param {number} offset
 * @param {number} a
 * @returns {number}
 */
const align = (offset, a) => (offset + a - 1) & ~(a - 1);
harden(align);

/**
 * @param {string} sig
 * @returns {number}
 */
const sigAlignment = sig => {
  if (sig.length === 0) return 1;
  const c = sig[0];
  if (c === 'a') {
    if (sig.length > 1 && sig[1] === '{') {
      const entryAlign = Math.max(
        sigAlignment(sig[2]),
        sigAlignment(sig.slice(3, -1)),
      );
      return Math.max(4, entryAlign);
    }
    return Math.max(4, sigAlignment(sig.slice(1)));
  }
  if (c === '(') {
    const inner = sig.slice(1, -1);
    if (inner.length === 0) return 1;
    return Math.max(...parseSignatures(inner).map(sigAlignment));
  }
  return TYPE_ALIGN[c] ?? 1;
};
harden(sigAlignment);

/**
 * @param {string} sig
 * @param {number} start
 * @returns {number}
 */
const scanSignatureEnd = (sig, start) => {
  const c = sig[start];
  if (c === undefined) {
    throw Fail`Unexpected end of D-Bus signature`;
  }
  if (c === 'a') {
    return scanSignatureEnd(sig, start + 1);
  }
  if (c === '(') {
    let i = start + 1;
    while (sig[i] !== ')') {
      i = scanSignatureEnd(sig, i) + 1;
      i <= sig.length || Fail`Unterminated D-Bus struct signature`;
    }
    return i;
  }
  if (c === '{') {
    const keyEnd = scanSignatureEnd(sig, start + 1);
    const valueEnd = scanSignatureEnd(sig, keyEnd + 1);
    sig[valueEnd + 1] === '}' || Fail`Unterminated D-Bus dict-entry signature`;
    return valueEnd + 1;
  }
  return start;
};
harden(scanSignatureEnd);

/**
 * @param {string} sig
 * @returns {string[]}
 */
const parseSignatures = sig => {
  const types = [];
  let i = 0;
  while (i < sig.length) {
    const end = scanSignatureEnd(sig, i);
    types.push(sig.slice(i, end + 1));
    i = end + 1;
  }
  return types;
};
harden(parseSignatures);

/**
 * @param {Uint8Array} bytes
 * @param {number} [offset]
 */
const makeReader = (bytes, offset = 0) => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    bytes,
    dv,
    offset,
    /** @param {number} alignment */
    padTo(alignment) {
      this.offset = align(this.offset, alignment);
    },
    /** @returns {number} */
    u8() {
      const value = this.bytes[this.offset];
      this.offset += 1;
      return value;
    },
    /** @returns {number} */
    u32() {
      this.padTo(4);
      const value = this.dv.getUint32(this.offset, true);
      this.offset += 4;
      return value;
    },
    /** @returns {number} */
    i32() {
      this.padTo(4);
      const value = this.dv.getInt32(this.offset, true);
      this.offset += 4;
      return value;
    },
    /** @returns {string} */
    string() {
      this.padTo(4);
      const len = this.dv.getUint32(this.offset, true);
      this.offset += 4;
      const textBytes = this.bytes.subarray(this.offset, this.offset + len);
      this.offset += len + 1;
      return new TextDecoder().decode(textBytes);
    },
    /** @returns {string} */
    signature() {
      const len = this.u8();
      const textBytes = this.bytes.subarray(this.offset, this.offset + len);
      this.offset += len + 1;
      return new TextDecoder().decode(textBytes);
    },
  };
};

/**
 * Parse a single complete D-Bus value.
 * @param {ReturnType<typeof makeReader>} reader
 * @param {string} sig
 * @returns {unknown}
 */
const parseValue = (reader, sig) => {
  const c = sig[0];
  if (c === 'y') {
    return reader.u8();
  }
  if (c === 'b') {
    return reader.u32() !== 0;
  }
  if (c === 'i') {
    return reader.i32();
  }
  if (c === 'u' || c === 'h') {
    return reader.u32();
  }
  if (c === 's' || c === 'o') {
    return reader.string();
  }
  if (c === 'g') {
    return reader.signature();
  }
  if (c === 'v') {
    const innerSig = reader.signature();
    reader.padTo(sigAlignment(innerSig));
    return [innerSig, parseValue(reader, innerSig)];
  }
  if (c === 'a') {
    reader.padTo(4);
    const byteLength = reader.u32();
    if (sig[1] === '{') {
      const keySig = sig[2];
      const valueSig = sig.slice(3, -1);
      reader.padTo(8);
      const end = reader.offset + byteLength;
      const entries = [];
      while (reader.offset < end) {
        reader.padTo(8);
        const key = parseValue(reader, keySig);
        const value = parseValue(reader, valueSig);
        entries.push([key, value]);
      }
      return Object.fromEntries(entries);
    }
    const elemSig = sig.slice(1);
    reader.padTo(sigAlignment(elemSig));
    const end = reader.offset + byteLength;
    const items = [];
    while (reader.offset < end) {
      items.push(parseValue(reader, elemSig));
    }
    return items;
  }
  if (c === '(') {
    const innerSigs = parseSignatures(sig.slice(1, -1));
    const items = [];
    for (const innerSig of innerSigs) {
      reader.padTo(sigAlignment(innerSig));
      items.push(parseValue(reader, innerSig));
    }
    return items;
  }
  throw Fail`Unsupported D-Bus type for parser: ${sig}`;
};
harden(parseValue);

/** Mutable byte buffer for building D-Bus messages. */
class Buf {
  constructor() {
    /** @type {number[]} */
    this.data = [];
  }

  /** @returns {Uint8Array} */
  get bytes() {
    return new Uint8Array(this.data);
  }

  /** @param {number} v */
  u8(v) {
    this.data.push(v & 0xff);
  }

  /** @param {number} a */
  padTo(a) {
    const off = this.data.length;
    const aligned = align(off, a);
    for (let i = off; i < aligned; i += 1) this.data.push(0);
  }

  /** @param {number} v */
  u32(v) {
    this.padTo(4);
    this.data.push(
      v & 0xff,
      (v >>> 8) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 24) & 0xff,
    );
  }

  /** @param {number} v */
  i32(v) {
    this.u32(v >>> 0);
  }

  /**
   * Patch a u32 at a previously written position.
   * @param {number} off
   * @param {number} v
   */
  patchU32(off, v) {
    this.data[off] = v & 0xff;
    this.data[off + 1] = (v >>> 8) & 0xff;
    this.data[off + 2] = (v >>> 16) & 0xff;
    this.data[off + 3] = (v >>> 24) & 0xff;
  }

  /** @param {string} s */
  string(s) {
    this.padTo(4);
    const encoded = new TextEncoder().encode(s);
    this.u32(encoded.length);
    for (const b of encoded) this.data.push(b);
    this.u8(0);
  }

  /** @param {string} sig */
  signature(sig) {
    const encoded = new TextEncoder().encode(sig);
    this.u8(encoded.length);
    for (const b of encoded) this.data.push(b);
    this.u8(0);
  }

  /**
   * Pack a typed value. `sig` is a single complete D-Bus type string.
   * @param {string} sig
   * @param {unknown} value
   */
  packValue(sig, value) {
    const c = sig[0];
    if (c === 'y') {
      this.u8(/** @type {number} */ (value));
    } else if (c === 'b') {
      this.u32(value ? 1 : 0);
    } else if (c === 'n') {
      this.padTo(2);
      const v = /** @type {number} */ (value);
      this.data.push(v & 0xff, (v >>> 8) & 0xff);
    } else if (c === 'q') {
      this.padTo(2);
      const v = /** @type {number} */ (value);
      this.data.push(v & 0xff, (v >>> 8) & 0xff);
    } else if (c === 'i') {
      this.i32(/** @type {number} */ (value));
    } else if (c === 'u') {
      this.u32(/** @type {number} */ (value));
    } else if (c === 'x') {
      this.padTo(8);
      const v = BigInt(/** @type {number} */ (value));
      for (let i = 0; i < 8; i += 1)
        this.data.push(Number((v >> BigInt(i * 8)) & 0xffn));
    } else if (c === 't') {
      this.padTo(8);
      const v = BigInt(/** @type {number} */ (value));
      for (let i = 0; i < 8; i += 1)
        this.data.push(Number((v >> BigInt(i * 8)) & 0xffn));
    } else if (c === 'd') {
      this.padTo(8);
      const buf = new ArrayBuffer(8);
      new DataView(buf).setFloat64(0, /** @type {number} */ (value), true);
      for (const b of new Uint8Array(buf)) this.data.push(b);
    } else if (c === 's' || c === 'o') {
      this.string(/** @type {string} */ (value));
    } else if (c === 'g') {
      this.signature(/** @type {string} */ (value));
    } else if (c === 'h') {
      this.u32(/** @type {number} */ (value));
    } else if (c === 'v') {
      const [innerSig, innerVal] = /** @type {[string, unknown]} */ (value);
      this.signature(innerSig);
      this.padTo(sigAlignment(innerSig));
      this.packValue(innerSig, innerVal);
    } else if (c === 'a') {
      const elemSig =
        sig.length > 1 && sig[1] === '{' ? sig.slice(2) : sig.slice(1);
      /** @type {readonly unknown[] | Record<string, unknown>} */
      const items =
        /** @type {readonly unknown[] | Record<string, unknown>} */ (value);
      this.padTo(4);
      const lenOff = this.data.length;
      this.u32(0);

      if (sig.length > 1 && sig[1] === '{') {
        const keySig = sig[2];
        const valSig = sig.slice(3, -1);
        const entries =
          typeof items === 'object' && !Array.isArray(items)
            ? Object.entries(/** @type {Record<string, unknown>} */ (items))
            : [];
        this.padTo(8);
        const dataStart = this.data.length;
        for (const [k, v] of entries) {
          this.padTo(8);
          this.packValue(keySig, k);
          if (valSig === 'v') {
            this.packValue('v', /** @type {[string, unknown]} */ (v));
          } else {
            this.packValue('v', [valSig, v]);
          }
        }
        this.patchU32(lenOff, this.data.length - dataStart);
      } else {
        const arrayItems = /** @type {readonly unknown[]} */ (items);
        this.padTo(sigAlignment(elemSig));
        const dataStart = this.data.length;
        for (const item of arrayItems) {
          this.packValue(elemSig, item);
        }
        this.patchU32(lenOff, this.data.length - dataStart);
      }
    } else if (c === '(') {
      const innerSigs = parseSignatures(sig.slice(1, -1));
      const vals = /** @type {readonly unknown[]} */ (value);
      for (let i = 0; i < innerSigs.length; i += 1) {
        this.padTo(sigAlignment(innerSigs[i]));
        this.packValue(innerSigs[i], vals[i]);
      }
    } else {
      throw Fail`Unknown D-Bus type: ${sig}`;
    }
  }
}

const FIELD_ORDER = [
  FIELD_PATH,
  FIELD_INTERFACE,
  FIELD_MEMBER,
  FIELD_DESTINATION,
  FIELD_SIGNATURE,
];

/** @type {Record<number, string>} */
const FIELD_TYPE = harden({
  [FIELD_PATH]: 'o',
  [FIELD_INTERFACE]: 's',
  [FIELD_MEMBER]: 's',
  [FIELD_DESTINATION]: 's',
  [FIELD_SIGNATURE]: 'g',
});

/**
 * Serialize a D-Bus message to wire format bytes.
 * @param {number} messageType
 * @param {number} serial
 * @param {ReadonlyMap<number, unknown>} headers
 * @param {string} bodySig
 * @param {readonly unknown[]} body
 * @returns {Uint8Array}
 */
export const serialise = (messageType, serial, headers, bodySig, body) => {
  const bodyBuf = new Buf();
  if (bodySig.length > 0) {
    bodyBuf.packValue(`(${bodySig})`, body);
  }

  const hdrBuf = new Buf();
  let first = true;
  for (const code of FIELD_ORDER) {
    if (headers.has(code)) {
      if (!first) hdrBuf.padTo(8);
      first = false;
      const sig = FIELD_TYPE[code];
      hdrBuf.u8(code);
      hdrBuf.signature(sig);
      hdrBuf.padTo(sigAlignment(sig));
      hdrBuf.packValue(sig, headers.get(code));
    }
  }

  const buf = new Buf();
  buf.u8(0x6c); // 'l' little-endian
  buf.u8(messageType);
  buf.u8(0); // flags
  buf.u8(1); // protocol version
  buf.u32(bodyBuf.data.length);
  buf.u32(serial);
  buf.u32(hdrBuf.data.length);
  for (const b of hdrBuf.data) buf.data.push(b);
  buf.padTo(8);
  for (const b of bodyBuf.data) buf.data.push(b);

  return buf.bytes;
};
harden(serialise);

/**
 * Create a method call message.
 * @param {DBusAddress} address
 * @param {string} method
 * @param {string} [signature]
 * @param {readonly unknown[]} [body]
 * @param {number} [serial]
 * @returns {Uint8Array}
 */
export const newMethodCall = (
  address,
  method,
  signature = undefined,
  body = undefined,
  serial = 0,
) => {
  const headers = new Map();
  headers.set(FIELD_PATH, address.objectPath);
  headers.set(FIELD_DESTINATION, address.busName);
  headers.set(FIELD_INTERFACE, address.interface);
  headers.set(FIELD_MEMBER, method);
  if (signature !== undefined) {
    headers.set(FIELD_SIGNATURE, signature);
  }
  return serialise(
    MESSAGE_TYPE_METHOD_CALL,
    serial,
    headers,
    signature ?? '',
    body ?? [],
  );
};
harden(newMethodCall);

/**
 * Copy a serialized D-Bus message and set its serial field.
 * @param {Uint8Array} payload
 * @param {number} serial
 * @returns {Uint8Array}
 */
export const withSerial = (payload, serial) => {
  const bytes = new Uint8Array(payload);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  dv.setUint32(8, serial, true);
  return bytes;
};
harden(withSerial);

/**
 * Build the org.freedesktop.DBus.Hello method call (serial 1).
 * @returns {Uint8Array}
 */
export const buildHelloPayload = () =>
  newMethodCall(
    {
      objectPath: '/org/freedesktop/DBus',
      busName: 'org.freedesktop.DBus',
      interface: 'org.freedesktop.DBus',
    },
    'Hello',
  );
harden(buildHelloPayload);

/**
 * Parse a serialized D-Bus message.
 * @param {Uint8Array} bytes
 * @returns {{
 *   messageType: number,
 *   serial: number,
 *   headers: Map<number, unknown>,
 *   body: unknown[],
 *   bodySignature: string,
 * }}
 */
export const parseMessage = bytes => {
  bytes.length >= 16 || Fail`D-Bus message too short`;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const messageType = bytes[1];
  const serial = dv.getUint32(8, true);
  const fieldsLen = dv.getUint32(12, true);
  const headerEnd = 16 + fieldsLen;
  headerEnd <= bytes.length || Fail`D-Bus header exceeds packet`;

  const headers = new Map();
  const reader = makeReader(bytes, 16);
  while (reader.offset < headerEnd) {
    reader.padTo(8);
    if (reader.offset >= headerEnd) {
      break;
    }
    const code = reader.u8();
    const sig = reader.signature();
    reader.padTo(sigAlignment(sig));
    headers.set(code, parseValue(reader, sig));
  }

  const bodySignature = /** @type {string | undefined} */ (
    headers.get(FIELD_SIGNATURE)
  );
  const body = [];
  if (bodySignature !== undefined && bodySignature.length > 0) {
    const bodyOffset = align(headerEnd, 8);
    const bodyReader = makeReader(bytes, bodyOffset);
    for (const sig of parseSignatures(bodySignature)) {
      bodyReader.padTo(sigAlignment(sig));
      body.push(parseValue(bodyReader, sig));
    }
  }

  return harden({
    messageType,
    serial,
    headers,
    body,
    bodySignature: bodySignature ?? '',
  });
};
harden(parseMessage);
