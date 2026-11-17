// @ts-check
// The one description of the Codex native-context wire shape that the
// in-image helpers (`context-command.mjs`, `context-io.mjs`,
// `native-context.mjs`) and the host transport
// (`src/native-context-transport.js`) all agree on. It runs inside the sandbox
// image as well as in the daemon, so it depends on nothing but the language.
// Native transcript data is not authority: the host bounds what it accepts by
// this same limit instead of trusting the helper's output.

/**
 * Bytes: the serialized-wire bound of one capture or restoration envelope,
 * JSON escaping included. It does not promise transport of every native
 * payload of this same raw size.
 */
export const NATIVE_CONTEXT_LIMIT = 16 * 1024 * 1024;

/**
 * The pinned CLI's lowercase hyphenated session and turn identity.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export const isUuid = value =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
