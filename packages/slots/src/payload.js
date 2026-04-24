// @ts-check

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

import {
  makeWriter,
  writerToBytes,
  makeReader,
  writeArrayHeader,
  writeUint,
  writeByteString,
  writeNull,
  readArrayHeader,
  readUint,
  readByteString,
  readNullOrPeek,
  assertConsumed,
} from './cbor.js';
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
 * @param {import('./cbor.js').Writer} w
 * @param {Descriptor[]} ds
 */
const writeDescriptorArray = (w, ds) => {
  writeArrayHeader(w, ds.length);
  for (const d of ds) writeDescriptor(w, d);
};

/**
 * @param {import('./cbor.js').Reader} r
 * @returns {Descriptor[]}
 */
const readDescriptorArray = r => {
  const n = readArrayHeader(r);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(readDescriptor(r));
  return out;
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
  const w = makeWriter();
  writeArrayHeader(w, 5);
  writeDescriptor(w, p.target);
  writeByteString(w, p.body);
  writeDescriptorArray(w, p.targets);
  writeDescriptorArray(w, p.promises);
  if (p.reply) writeDescriptor(w, p.reply);
  else writeNull(w);
  return writerToBytes(w);
};
harden(encodeDeliverPayload);

/**
 * @param {Uint8Array} bytes
 * @returns {DeliverPayload}
 */
export const decodeDeliverPayload = bytes => {
  const r = makeReader(bytes);
  const n = readArrayHeader(r);
  if (n !== 5) {
    throw makeError(X`deliver payload must be 5-element array, got ${q(n)}`);
  }
  const target = readDescriptor(r);
  const body = readByteString(r);
  const targets = readDescriptorArray(r);
  const promises = readDescriptorArray(r);
  const reply = readNullOrPeek(r) ? null : readDescriptor(r);
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
  const w = makeWriter();
  writeArrayHeader(w, 5);
  writeDescriptor(w, p.target);
  writeUint(w, p.isReject ? 1 : 0);
  writeByteString(w, p.body);
  writeDescriptorArray(w, p.targets);
  writeDescriptorArray(w, p.promises);
  return writerToBytes(w);
};
harden(encodeResolvePayload);

/**
 * @param {Uint8Array} bytes
 * @returns {ResolvePayload}
 */
export const decodeResolvePayload = bytes => {
  const r = makeReader(bytes);
  const n = readArrayHeader(r);
  if (n !== 5) {
    throw makeError(X`resolve payload must be 5-element array, got ${q(n)}`);
  }
  const target = readDescriptor(r);
  const flag = readUint(r);
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
  const w = makeWriter();
  writeArrayHeader(w, deltas.length);
  for (const d of deltas) {
    writeArrayHeader(w, 4);
    writeDescriptor(w, d.target);
    writeUint(w, d.ram);
    writeUint(w, d.clist);
    writeUint(w, d.export);
  }
  return writerToBytes(w);
};
harden(encodeDropPayload);

/**
 * @param {Uint8Array} bytes
 * @returns {DropDelta[]}
 */
export const decodeDropPayload = bytes => {
  const r = makeReader(bytes);
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
    const ram = readUint(r);
    const clist = readUint(r);
    const exportPillar = readUint(r);
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
  const w = makeWriter();
  writeByteString(w, textEncoder.encode(reason));
  return writerToBytes(w);
};
harden(encodeAbortPayload);

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const decodeAbortPayload = bytes => {
  const r = makeReader(bytes);
  const raw = readByteString(r);
  assertConsumed(r);
  try {
    return textDecoder.decode(raw);
  } catch (e) {
    throw makeError(X`abort reason not valid utf-8: ${q(String(e))}`);
  }
};
harden(decodeAbortPayload);
