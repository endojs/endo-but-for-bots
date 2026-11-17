// @ts-check
// Staged text fields (W1b.1; m1b-interfaces.md 4, 5, 11): a field is an
// inline string or a StagedText { blob, preview, bytes }. The vat never
// reads a blob; it copies StagedTexts where they arrive. Node imports this too.
import { previewText, utf8Bytes } from '../lib/bounded.js';

/** @param {unknown} value */
export const isStaged = value =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'blob' in value &&
  'preview' in value &&
  'bytes' in value;
harden(isStaged);

/** @param {any} field */
export const fieldBytes = field =>
  isStaged(field) ? field.bytes : utf8Bytes(field);
harden(fieldBytes);

/**
 * @param {any} field
 * @param {number} units
 */
export const previewOf = (field, units) =>
  previewText(isStaged(field) ? field.preview : field, units);
harden(previewOf);

/** The submission's text field: its string, or the StagedText itself. @param {any} s */
export const submissionField = s => (isStaged(s) ? s : s.text);
harden(submissionField);

/**
 * Same submission (contract 3.3, 17.2): equal strings; staged, equal digests
 * (the SHA-256 the adapter computed, J-9363) and bytes. A staged text
 * without a digest (staged before digests) compares by bytes and preview,
 * as before; with a digest on one side only, they differ.
 * @param {any} a
 * @param {any} b
 */
export const sameSubmission = (a, b) => {
  const x = submissionField(a);
  const y = submissionField(b);
  if (isStaged(x) !== isStaged(y)) return false;
  if (!isStaged(x)) return x === y;
  if (x.bytes !== y.bytes) return false;
  const hasX = typeof x.digest === 'string';
  const hasY = typeof y.digest === 'string';
  if (hasX || hasY) return hasX && hasY && x.digest === y.digest;
  return x.preview === y.preview;
};
harden(sameSubmission);

/** @param {any} value @param {any[]} out */
const collect = (value, out) => {
  if (typeof value !== 'object' || value === null) return;
  if (isStaged(value)) {
    out.push(value.blob);
    return;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collect(item, out);
  }
};

/**
 * Every blob in a record (M2 blobPage, W1b.2).
 * @param {any} record
 * @returns {any[]}
 */
export const blobsOf = record => {
  /** @type {any[]} */
  const out = [];
  collect(record, out);
  return out;
};
harden(blobsOf);
