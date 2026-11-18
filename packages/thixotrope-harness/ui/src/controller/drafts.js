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
      return { sessionKey, text: parsed.text, requestId: parsed.requestId };
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
 * A request id: 32 lowercase hex digits from the platform's random source.
 *
 * @param {any} [crypto] `globalThis.crypto` or a fake with `getRandomValues`
 */
export const newRequestId = (crypto = globalThis.crypto) => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};
