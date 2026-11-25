// @ts-check
/**
 * Saved drafts for exactly-once sending (m3-interfaces.md 9.2; R6-41,
 * R6-42). Before a message is sent, `{ sessionKey, text, requestId }` is
 * written to `localStorage` under the session's key (F.2 d: the page finds
 * its own draft again by the row key it was given); it is removed when a
 * receipt arrives. Storage that throws (private mode, quota) is treated as
 * empty: the send still goes, without the reload guarantee.
 */

/** The storage key prefix of a session's draft. */
export const DRAFT_PREFIX = 'familiar.draft:';
/** The Web Lock name prefix of a session's sends. */
export const LOCK_PREFIX = 'familiar.send:';

/**
 * @typedef {object} Draft
 * @property {string} sessionKey
 * @property {string} text
 * @property {string} requestId
 * @property {true} [spoken] M11: sent from spoken mode (m11-interfaces.md 9.1)
 */

/**
 * @typedef {object} DraftStorage `localStorage` or a fake with its methods
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 * @property {(index: number) => string | null} key
 * @property {number} length
 */

/**
 * @param {DraftStorage | undefined} storage
 * @param {string} sessionKey
 * @returns {Draft | undefined}
 */
export const readDraft = (storage, sessionKey) => {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(`${DRAFT_PREFIX}${sessionKey}`);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.text === 'string' &&
      typeof parsed.requestId === 'string' &&
      parsed.sessionKey === sessionKey
    ) {
      return {
        sessionKey,
        text: parsed.text,
        requestId: parsed.requestId,
        ...(parsed.spoken === true ? { spoken: true } : {}),
      };
    }
  } catch {
    // unreadable: treated as none
  }
  return undefined;
};

/**
 * @param {DraftStorage | undefined} storage
 * @param {Draft} draft
 */
export const writeDraft = (storage, draft) => {
  if (!storage) return;
  try {
    storage.setItem(
      `${DRAFT_PREFIX}${draft.sessionKey}`,
      JSON.stringify({
        sessionKey: draft.sessionKey,
        text: draft.text,
        requestId: draft.requestId,
        ...(draft.spoken === true ? { spoken: true } : {}),
      }),
    );
  } catch {
    // quota or blocked storage: the send goes on without the guarantee
  }
};

/**
 * Remove a session's draft, only if it is still the one with `requestId`
 * (a newer send's draft is kept).
 *
 * @param {DraftStorage | undefined} storage
 * @param {string} sessionKey
 * @param {string} requestId
 */
export const clearDraft = (storage, sessionKey, requestId) => {
  if (!storage) return;
  const draft = readDraft(storage, sessionKey);
  if (draft && draft.requestId !== requestId) return;
  try {
    storage.removeItem(`${DRAFT_PREFIX}${sessionKey}`);
  } catch {
    // blocked storage
  }
};

/**
 * The session keys that have a saved draft.
 *
 * @param {DraftStorage | undefined} storage
 * @returns {string[]}
 */
export const draftSessionKeys = storage => {
  if (!storage) return [];
  const keys = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(DRAFT_PREFIX)) {
        keys.push(key.slice(DRAFT_PREFIX.length));
      }
    }
  } catch {
    return [];
  }
  return keys;
};

/**
 * A request id in M2's A.4 format, the only one `Composer.submit` accepts
 * (`guest/lib/pending-queue.js` `REQUEST_ID`): 13 digits of milliseconds, a
 * dash, and a version-4 UUID from the platform's random source. (The M3
 * contract's 9.2 said 32 hex digits; the session refuses those with
 * "Invalid submission request ID", J-9604.)
 *
 * @param {any} [crypto] `globalThis.crypto` or a fake with `getRandomValues`
 * @param {number} [now] milliseconds
 */
export const newRequestId = (crypto = globalThis.crypto, now = Date.now()) => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Version 4 and the RFC 4122 variant, without bitwise operators.
  bytes[6] = 0x40 + (bytes[6] % 16);
  bytes[8] = 0x80 + (bytes[8] % 64);
  const hex = Array.from(bytes, byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return `${String(Math.floor(now)).padStart(13, '0')}-${uuid}`;
};
