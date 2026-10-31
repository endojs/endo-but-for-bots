// @ts-check

import { bytesFromText } from '@endo/bytes/from-string.js';
import { bytesToText } from '@endo/bytes/to-string.js';
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';

import {
  OID_BYTE_LENGTH,
  assertHashAlgorithm,
  oidBytesToHex,
  oidHexToBytes,
} from './hash.js';

/** @import { GitHashAlgorithm, GitTreeEntry } from './types.js' */

/**
 * Tree modes that denote a directory (git sorts these with a trailing `/`).
 *
 * @param {string} mode
 * @returns {boolean}
 */
export const isTreeMode = mode => mode === '40000' || mode === '040000';
harden(isTreeMode);

/**
 * Normalize a mode to the form git writes in tree objects (no leading zero
 * on `40000`).
 *
 * @param {string} mode
 * @returns {string}
 */
const normalizeMode = mode => (mode === '040000' ? '40000' : mode);

/**
 * Sort key git uses for tree entries: name, with `/` appended for trees.
 *
 * @param {GitTreeEntry} entry
 * @returns {string}
 */
export const treeSortKey = entry =>
  entry.isTree || isTreeMode(entry.mode) ? `${entry.name}/` : entry.name;
harden(treeSortKey);

/**
 * Compare tree names by their UTF-8 bytes, as native Git does.
 * JavaScript UTF-16 ordering differs for some astral code points.
 *
 * @param {GitTreeEntry} a
 * @param {GitTreeEntry} b
 * @returns {number}
 */
const compareTreeEntries = (a, b) => {
  const aBytes = bytesFromText(treeSortKey(a));
  const bBytes = bytesFromText(treeSortKey(b));
  const length = Math.min(aBytes.byteLength, bBytes.byteLength);
  for (let i = 0; i < length; i += 1) {
    if (aBytes[i] !== bBytes[i]) {
      return aBytes[i] - bBytes[i];
    }
  }
  return aBytes.byteLength - bBytes.byteLength;
};

/**
 * Parse a git tree object content.
 *
 * @param {Uint8Array} content
 * @param {GitHashAlgorithm} algorithm
 * @returns {GitTreeEntry[]}
 */
export const parseTree = (content, algorithm) => {
  assertHashAlgorithm(algorithm);
  const oidLen = OID_BYTE_LENGTH[algorithm];
  /** @type {GitTreeEntry[]} */
  const entries = [];
  let i = 0;
  while (i < content.byteLength) {
    // mode
    const modeStart = i;
    while (i < content.byteLength && content[i] !== 0x20) {
      i += 1;
    }
    i < content.byteLength || Fail`truncated tree: missing mode SP`;
    const mode = normalizeMode(bytesToText(content.subarray(modeStart, i)));
    i += 1; // SP

    // name
    const nameStart = i;
    while (i < content.byteLength && content[i] !== 0x00) {
      i += 1;
    }
    i < content.byteLength || Fail`truncated tree: missing name NUL`;
    const name = bytesToText(content.subarray(nameStart, i), { fatal: true });
    i += 1; // NUL

    i + oidLen <= content.byteLength ||
      Fail`truncated tree: short oid for entry ${q(name)}`;
    const oidBytes = content.subarray(i, i + oidLen);
    i += oidLen;
    const oid = oidBytesToHex(algorithm, oidBytes);
    entries.push(
      harden({
        mode,
        name,
        oid,
        isTree: isTreeMode(mode),
      }),
    );
  }
  return harden(entries);
};
harden(parseTree);

/**
 * Serialize tree entries to git tree object content.
 * Entries are sorted with git's tree sort before encoding.
 *
 * @param {Array<{ mode: string, name: string, oid: string }>} entries
 * @param {GitHashAlgorithm} algorithm
 * @returns {Uint8Array}
 */
export const serializeTree = (entries, algorithm) => {
  assertHashAlgorithm(algorithm);
  const prepared = entries.map(entry => {
    const mode = normalizeMode(entry.mode);
    (typeof entry.name === 'string' &&
      entry.name.length > 0 &&
      !entry.name.includes('\0') &&
      !entry.name.includes('/')) ||
      Fail`invalid tree entry name ${q(entry.name)}`;
    return harden({
      mode,
      name: entry.name,
      oid: entry.oid,
      isTree: isTreeMode(mode),
    });
  });
  prepared.sort((a, b) => {
    return compareTreeEntries(a, b);
  });

  /** @type {Uint8Array[]} */
  const parts = [];
  let total = 0;
  for (const entry of prepared) {
    const head = bytesFromText(`${entry.mode} ${entry.name}\0`);
    const oidBytes = oidHexToBytes(algorithm, entry.oid);
    parts.push(head, oidBytes);
    total += head.byteLength + oidBytes.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};
harden(serializeTree);
