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
import { writeDescriptor, readDescriptor } from './descriptor.js';

/** @import { Descriptor } from './descriptor.js' */

// ---- verb constants ----

export const VERB_DELIVER = 'deliver';
harden(VERB_DELIVER);
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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * @param {string} reason
 * @returns {Uint8Array}
 */
export const encodeAbortPayload = reason => {
  const w = makeCborWriter();
  writeByteString(w, textEncoder.encode(reason));
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
    return textDecoder.decode(raw);
  } catch (e) {
    throw makeError(X`abort reason not valid utf-8: ${q(String(e))}`);
  }
};
harden(decodeAbortPayload);
