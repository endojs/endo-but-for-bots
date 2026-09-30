// @ts-check

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';
import {
  assertConsumed,
  cborWriterBytes,
  makeCborReader,
  makeCborWriter,
  writeArrayHeader,
  writeUint as writeCborUint,
  writeByteString,
  writeNull,
  readArrayHeader,
  readUint as readCborUint,
  readByteString,
  readOptionalNull,
} from '@endo/cbor';
import { bytesFromText } from '@endo/bytes/from-string.js';
import { bytesToText } from '@endo/bytes/to-string.js';
import { Kind, writeDescriptor, readDescriptor } from './descriptor.js';

/** @import { Descriptor } from './descriptor.js' */

// ---- verb constants ----

export const VERB_DELIVER = 'deliver';
harden(VERB_DELIVER);
export const VERB_GET = 'get';
harden(VERB_GET);
export const VERB_INDEX = 'index';
harden(VERB_INDEX);
export const VERB_UNTAG = 'untag';
harden(VERB_UNTAG);
export const VERB_RESOLVE = 'resolve';
harden(VERB_RESOLVE);
export const VERB_DROP = 'drop';
harden(VERB_DROP);
export const VERB_ABORT = 'abort';
harden(VERB_ABORT);

/**
 * @param {string} verb
 * @returns {boolean}
 */
export const isSlotVerb = verb =>
  verb === VERB_DELIVER ||
  verb === VERB_GET ||
  verb === VERB_INDEX ||
  verb === VERB_UNTAG ||
  verb === VERB_RESOLVE ||
  verb === VERB_DROP ||
  verb === VERB_ABORT;
harden(isSlotVerb);

// ---- helpers ----

/**
 * @param {ReturnType<typeof makeCborWriter>} writer
 * @param {Descriptor[]} ds
 */
const writeDescriptorArray = (writer, ds) => {
  writeArrayHeader(writer, ds.length);
  for (const d of ds) writeDescriptor(writer, d);
};

/**
 * @param {ReturnType<typeof makeCborReader>} reader
 * @returns {Descriptor[]}
 */
const readDescriptorArray = reader => {
  const n = readArrayHeader(reader);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(readDescriptor(reader));
  return out;
};

/** @param {ReturnType<typeof makeCborReader>} reader @returns {number} */
const readSlotUint = reader => {
  const value = readCborUint(reader);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw makeError(X`slot integer exceeds safe-integer range`);
  }
  return Number(value);
};

// ---- data-lane helpers (get / index / untag) ----

// A JavaScript array index is an integer in `0 <= index < 2**32 - 1`.
// This is the array-domain bound, not a safe-integer approximation of
// OCapN's integer domain.
export const INDEX_LIMIT = 2 ** 32 - 1;
harden(INDEX_LIMIT);

/**
 * A data operation observes the shape of data at a target that carries
 * no behavior selection: `Object`, `Promise`, or `Answer` (pipelining
 * is preserved).  A `Device` target is rejected — data operations do
 * not address devices.
 *
 * @param {Descriptor} target
 */
const assertDataTarget = target => {
  if (target.kind === Kind.Device) {
    throw makeError(X`data-operation target must not be a device`);
  }
};

/**
 * Every data operation produces an eventual result, so its reply
 * descriptor is required and must have kind `Promise`.
 *
 * @param {Descriptor} reply
 */
const assertDataReply = reply => {
  if (reply.kind !== Kind.Promise) {
    throw makeError(X`data-operation reply must be a promise descriptor`);
  }
};

/**
 * @param {Uint8Array} raw
 * @param {string} what
 * @returns {string}
 */
const decodeUtf8 = (raw, what) => {
  try {
    return bytesToText(raw, { fatal: true });
  } catch (e) {
    throw makeError(X`slot ${q(what)} not valid utf-8: ${q(String(e))}`);
  }
};

/**
 * @param {number} index
 * @returns {number}
 */
const assertIndexInRange = index => {
  if (!Number.isSafeInteger(index) || index < 0 || index >= INDEX_LIMIT) {
    throw makeError(X`slot index ${q(index)} out of array-index range`);
  }
  return index;
};

// ---- get ----

/**
 * `get` payload — string-named field access:
 *
 * ```text
 * [target: Descriptor, fieldName: UTF-8 bytes, reply: Descriptor]
 * ```
 *
 * @typedef {object} GetPayload
 * @property {Descriptor} target
 * @property {string} fieldName
 * @property {Descriptor} reply
 */

/**
 * @param {GetPayload} p
 * @returns {Uint8Array}
 */
export const encodeGetPayload = p => {
  assertDataTarget(p.target);
  assertDataReply(p.reply);
  const w = makeCborWriter();
  writeArrayHeader(w, 3);
  writeDescriptor(w, p.target);
  writeByteString(w, bytesFromText(p.fieldName));
  writeDescriptor(w, p.reply);
  return cborWriterBytes(w);
};
harden(encodeGetPayload);

/**
 * @param {Uint8Array} bytes
 * @returns {GetPayload}
 */
export const decodeGetPayload = bytes => {
  const r = makeCborReader(bytes, { name: 'slot get payload' });
  const n = readArrayHeader(r);
  if (n !== 3) {
    throw makeError(X`get payload must be 3-element array, got ${q(n)}`);
  }
  const target = readDescriptor(r);
  const fieldName = decodeUtf8(readByteString(r), 'get field name');
  const reply = readDescriptor(r);
  assertConsumed(r);
  assertDataTarget(target);
  assertDataReply(reply);
  return { target, fieldName, reply };
};
harden(decodeGetPayload);

// ---- index ----

/**
 * `index` payload — positional list access:
 *
 * ```text
 * [target: Descriptor, index: uint, reply: Descriptor]
 * ```
 *
 * @typedef {object} IndexPayload
 * @property {Descriptor} target
 * @property {number} index
 * @property {Descriptor} reply
 */

/**
 * @param {IndexPayload} p
 * @returns {Uint8Array}
 */
export const encodeIndexPayload = p => {
  assertDataTarget(p.target);
  assertDataReply(p.reply);
  assertIndexInRange(p.index);
  const w = makeCborWriter();
  writeArrayHeader(w, 3);
  writeDescriptor(w, p.target);
  writeCborUint(w, BigInt(p.index));
  writeDescriptor(w, p.reply);
  return cborWriterBytes(w);
};
harden(encodeIndexPayload);

/**
 * @param {Uint8Array} bytes
 * @returns {IndexPayload}
 */
export const decodeIndexPayload = bytes => {
  const r = makeCborReader(bytes, { name: 'slot index payload' });
  const n = readArrayHeader(r);
  if (n !== 3) {
    throw makeError(X`index payload must be 3-element array, got ${q(n)}`);
  }
  const target = readDescriptor(r);
  const indexBig = readCborUint(r);
  const reply = readDescriptor(r);
  assertConsumed(r);
  if (indexBig >= BigInt(INDEX_LIMIT)) {
    throw makeError(X`slot index ${q(indexBig)} out of array-index range`);
  }
  const index = assertIndexInRange(Number(indexBig));
  assertDataTarget(target);
  assertDataReply(reply);
  return { target, index, reply };
};
harden(decodeIndexPayload);

// ---- untag ----

/**
 * `untag` payload — tag-checked payload access:
 *
 * ```text
 * [target: Descriptor, tag: UTF-8 bytes, reply: Descriptor]
 * ```
 *
 * @typedef {object} UntagPayload
 * @property {Descriptor} target
 * @property {string} tag
 * @property {Descriptor} reply
 */

/**
 * @param {UntagPayload} p
 * @returns {Uint8Array}
 */
export const encodeUntagPayload = p => {
  assertDataTarget(p.target);
  assertDataReply(p.reply);
  const w = makeCborWriter();
  writeArrayHeader(w, 3);
  writeDescriptor(w, p.target);
  writeByteString(w, bytesFromText(p.tag));
  writeDescriptor(w, p.reply);
  return cborWriterBytes(w);
};
harden(encodeUntagPayload);

/**
 * @param {Uint8Array} bytes
 * @returns {UntagPayload}
 */
export const decodeUntagPayload = bytes => {
  const r = makeCborReader(bytes, { name: 'slot untag payload' });
  const n = readArrayHeader(r);
  if (n !== 3) {
    throw makeError(X`untag payload must be 3-element array, got ${q(n)}`);
  }
  const target = readDescriptor(r);
  const tag = decodeUtf8(readByteString(r), 'untag tag');
  const reply = readDescriptor(r);
  assertConsumed(r);
  assertDataTarget(target);
  assertDataReply(reply);
  return { target, tag, reply };
};
harden(decodeUntagPayload);

// ---- deliver ----

/**
 * @typedef {object} DeliverPayload
 * @property {Descriptor} target
 * @property {Uint8Array} body
 * @property {Descriptor[]} targets
 * @property {Descriptor[]} promises
 * @property {Descriptor | null} reply
 */

/**
 * @param {DeliverPayload} p
 * @returns {Uint8Array}
 */
export const encodeDeliverPayload = p => {
  const w = makeCborWriter();
  writeArrayHeader(w, 5);
  writeDescriptor(w, p.target);
  writeByteString(w, p.body);
  writeDescriptorArray(w, p.targets);
  writeDescriptorArray(w, p.promises);
  if (p.reply) writeDescriptor(w, p.reply);
  else writeNull(w);
  return cborWriterBytes(w);
};
harden(encodeDeliverPayload);

/**
 * @param {Uint8Array} bytes
 * @returns {DeliverPayload}
 */
export const decodeDeliverPayload = bytes => {
  const r = makeCborReader(bytes, { name: 'slot deliver payload' });
  const n = readArrayHeader(r);
  if (n !== 5) {
    throw makeError(X`deliver payload must be 5-element array, got ${q(n)}`);
  }
  const target = readDescriptor(r);
  const body = readByteString(r);
  const targets = readDescriptorArray(r);
  const promises = readDescriptorArray(r);
  const reply = readOptionalNull(r) ? null : readDescriptor(r);
  assertConsumed(r);
  return { target, body, targets, promises, reply };
};
harden(decodeDeliverPayload);

// ---- resolve ----

/**
 * @typedef {object} ResolvePayload
 * @property {Descriptor} target
 * @property {boolean} isReject
 * @property {Uint8Array} body
 * @property {Descriptor[]} targets
 * @property {Descriptor[]} promises
 */

/**
 * @param {ResolvePayload} p
 * @returns {Uint8Array}
 */
export const encodeResolvePayload = p => {
  const w = makeCborWriter();
  writeArrayHeader(w, 5);
  writeDescriptor(w, p.target);
  writeCborUint(w, BigInt(p.isReject ? 1 : 0));
  writeByteString(w, p.body);
  writeDescriptorArray(w, p.targets);
  writeDescriptorArray(w, p.promises);
  return cborWriterBytes(w);
};
harden(encodeResolvePayload);

/**
 * @param {Uint8Array} bytes
 * @returns {ResolvePayload}
 */
export const decodeResolvePayload = bytes => {
  const r = makeCborReader(bytes, { name: 'slot resolve payload' });
  const n = readArrayHeader(r);
  if (n !== 5) {
    throw makeError(X`resolve payload must be 5-element array, got ${q(n)}`);
  }
  const target = readDescriptor(r);
  const flag = readSlotUint(r);
  if (flag > 1) {
    throw makeError(X`resolve is_reject must be 0 or 1, got ${q(flag)}`);
  }
  const body = readByteString(r);
  const targets = readDescriptorArray(r);
  const promises = readDescriptorArray(r);
  assertConsumed(r);
  return { target, isReject: flag === 1, body, targets, promises };
};
harden(decodeResolvePayload);

// ---- drop ----

/**
 * @typedef {object} DropDelta
 * @property {Descriptor} target
 * @property {number} ram
 * @property {number} clist
 * @property {number} export
 */

/**
 * @param {DropDelta[]} deltas
 * @returns {Uint8Array}
 */
export const encodeDropPayload = deltas => {
  const w = makeCborWriter();
  writeArrayHeader(w, deltas.length);
  for (const d of deltas) {
    writeArrayHeader(w, 4);
    writeDescriptor(w, d.target);
    writeCborUint(w, BigInt(d.ram));
    writeCborUint(w, BigInt(d.clist));
    writeCborUint(w, BigInt(d.export));
  }
  return cborWriterBytes(w);
};
harden(encodeDropPayload);

/**
 * @param {Uint8Array} bytes
 * @returns {DropDelta[]}
 */
export const decodeDropPayload = bytes => {
  const r = makeCborReader(bytes, { name: 'slot drop payload' });
  const n = readArrayHeader(r);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const fieldsLen = readArrayHeader(r);
    if (fieldsLen !== 4) {
      throw makeError(
        X`drop entry must be 4-element array, got ${q(fieldsLen)}`,
      );
    }
    const target = readDescriptor(r);
    const ram = readSlotUint(r);
    const clist = readSlotUint(r);
    const exportPillar = readSlotUint(r);
    out.push({ target, ram, clist, export: exportPillar });
  }
  assertConsumed(r);
  return out;
};
harden(decodeDropPayload);

// ---- abort ----

/**
 * @param {string} reason
 * @returns {Uint8Array}
 */
export const encodeAbortPayload = reason => {
  const w = makeCborWriter();
  writeByteString(w, bytesFromText(reason));
  return cborWriterBytes(w);
};
harden(encodeAbortPayload);

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const decodeAbortPayload = bytes => {
  const r = makeCborReader(bytes, { name: 'slot abort payload' });
  const raw = readByteString(r);
  assertConsumed(r);
  try {
    return bytesToText(raw, { fatal: true });
  } catch (e) {
    throw makeError(X`abort reason not valid utf-8: ${q(String(e))}`);
  }
};
harden(decodeAbortPayload);
