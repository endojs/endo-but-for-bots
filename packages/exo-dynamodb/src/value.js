// @ts-check

import { encodeHex } from '@endo/hex';
import { getCopySetKeys, isCopySet } from '@endo/patterns';
import { sha256 } from '@endo/sha256';
import { encodeUtf8 } from '@endo/utf8';

/** @param {unknown} value */
export const isNumeric = value =>
  (typeof value === 'number' && Number.isFinite(value)) ||
  typeof value === 'bigint';
harden(isNumeric);

/**
 * @param {unknown} value
 * @returns {value is string | Uint8Array}
 */
export const isBytesLike = value =>
  typeof value === 'string' || value instanceof Uint8Array;
harden(isBytesLike);

/**
 * DynamoDB orders strings by their UTF-8 bytes and binary values by bytes.
 *
 * @param {string | Uint8Array} value
 */
export const toBytes = value =>
  typeof value === 'string' ? encodeUtf8(value) : value;
harden(toBytes);

/**
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 */
export const compareBytes = (left, right) => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
};
harden(compareBytes);

/**
 * Compare two numbers that may be a mix of finite numbers and bigints.
 *
 * @param {number | bigint} left
 * @param {number | bigint} right
 */
export const compareNumbers = (left, right) => {
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  // Mixed: compare exactly by splitting the number into its integer part.
  const [big, num, sign] =
    typeof left === 'bigint'
      ? [left, /** @type {number} */ (right), 1]
      : [/** @type {bigint} */ (right), /** @type {number} */ (left), -1];
  const floor = Math.floor(num);
  const floorBig = BigInt(floor);
  if (big < floorBig) return -sign;
  if (big > floorBig) return sign;
  return floor === num ? 0 : -sign;
};
harden(compareNumbers);

/**
 * Order two key or comparison scalars of the same DynamoDB type, or return
 * undefined when they are not comparable.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number | undefined}
 */
export const compareScalars = (left, right) => {
  if (isNumeric(left) && isNumeric(right)) {
    return compareNumbers(
      /** @type {number | bigint} */ (left),
      /** @type {number | bigint} */ (right),
    );
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return compareBytes(toBytes(left), toBytes(right));
  }
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return compareBytes(left, right);
  }
  return undefined;
};
harden(compareScalars);

/**
 * @param {string | Uint8Array} value
 * @param {string | Uint8Array} prefix
 */
export const startsWith = (value, prefix) => {
  if (typeof value !== typeof prefix) return false;
  if (typeof value === 'string') {
    return value.startsWith(/** @type {string} */ (prefix));
  }
  const bytes = /** @type {Uint8Array} */ (value);
  const head = /** @type {Uint8Array} */ (prefix);
  return (
    bytes.length >= head.length &&
    head.every((byte, index) => bytes[index] === byte)
  );
};
harden(startsWith);

/**
 * @param {unknown} value
 * @returns {string}
 */
const stableStringify = value => {
  if (typeof value === 'bigint') return JSON.stringify({ bigint: `${value}` });
  if (value instanceof Uint8Array) return JSON.stringify({ bytes: [...value] });
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (Object.isFrozen(value) && isCopySet(value)) {
    const keys = getCopySetKeys(/** @type {any} */ (value)).map(
      stableStringify,
    );
    return `{"set":[${keys.sort().join(',')}]}`;
  }
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record)
      .sort()
      .filter(key => record[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

/** @param {unknown} value */
export const digest = value =>
  encodeHex(sha256(encodeUtf8(stableStringify(value))));
harden(digest);

/**
 * Value equality in the DynamoDB document domain. Numbers compare by value
 * across number and bigint.
 *
 * @param {unknown} left
 * @param {unknown} right
 */
export const sameValue = (left, right) => {
  if (isNumeric(left) && isNumeric(right)) {
    return (
      compareNumbers(
        /** @type {number | bigint} */ (left),
        /** @type {number | bigint} */ (right),
      ) === 0
    );
  }
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return compareBytes(left, right) === 0;
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object'
  ) {
    return stableStringify(left) === stableStringify(right);
  }
  return Object.is(left, right);
};
harden(sameValue);
