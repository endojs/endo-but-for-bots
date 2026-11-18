// @ts-check
/**
 * What the Secrets panel checks before it sends a value (m4-interfaces.md
 * 9.1 item 3, D-M4-7; W4.7). Pure functions: the panel and its tests call
 * them alike.
 *
 * - Size: the gateway's WebSocket message bound less the CapTP envelope,
 *   `m4Limits.browserSecretBytes`, measured on the value as the CapTP JSON
 *   carries it (`JSON.stringify(value)` as UTF-8, quotes and escapes
 *   included). Over it the page refuses with `m4Texts.secretTooLargeForBrowser`
 *   and sends nothing.
 * - Files: a value read from a file must be UTF-8 text; any other file is
 *   refused with `m4Texts.secretNotText`.
 *
 * The value itself is never kept, logged or rendered here.
 */
/* eslint-disable import/no-relative-packages */
import { m4Limits } from '../../../guest/lib/limits-m4.js';
import { m4Texts } from '../../../guest/lib/texts-m4.js';

/**
 * The bytes of `value` as the gateway frame carries it.
 *
 * @param {string} value
 */
export const browserValueBytes = value =>
  new globalThis.TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Why `value` cannot be sent from the page, or undefined when it can.
 *
 * @param {string} value
 * @returns {string | undefined}
 */
export const refuseBrowserValue = value =>
  browserValueBytes(value) > m4Limits.browserSecretBytes
    ? m4Texts.secretTooLargeForBrowser
    : undefined;

/**
 * A file's bytes as text, or the refusal: `{ value }` or `{ error }`.
 *
 * @param {Uint8Array} bytes
 * @returns {{ value: string } | { error: string }}
 */
export const textOfFileBytes = bytes => {
  try {
    const value = new globalThis.TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return { value };
  } catch {
    return { error: m4Texts.secretNotText };
  }
};

/**
 * Read a chosen `File` (anything with `arrayBuffer()`) as a secret value.
 *
 * @param {{ arrayBuffer: () => Promise<ArrayBuffer> }} file
 * @returns {Promise<{ value: string } | { error: string }>}
 */
export const readSecretFile = async file => {
  const buffer = await file.arrayBuffer();
  return textOfFileBytes(new Uint8Array(buffer));
};
