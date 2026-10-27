// @ts-check

import { E } from '@endo/eventual-send';
import harden from '@endo/harden';

/**
 * Persist before sending. Failed/unknown acknowledgements retain the same key.
 * @param {{getItem: (key: string) => string | null, setItem: (key: string, value: string) => void, removeItem: (key: string) => void}} storage
 * @param {() => string} makeId
 * @param {{request: <T>(key: string, work: () => T) => Promise<T>} | undefined} [locks]
 */
export const makeSubmissionClient = (
  storage,
  makeId,
  locks = globalThis.navigator?.locks,
) => {
  /** @type {Map<string, {text: string, promise: Promise<any>, state: {acknowledged: boolean, callbacks: (() => void)[]}}>} */
  const active = new Map();
  return harden({
    /** @param {string} key */
    draft(key) {
      const saved = storage.getItem(key);
      if (!saved) return '';
      const value = JSON.parse(saved);
      return typeof value.text === 'string' ? value.text : '';
    },
    /**
     * Only after the user has inspected the remote conversation.
     * @param {string} key
     */
    async forget(key) {
      if (active.has(key))
        throw Error('Submission still awaiting acknowledgement');
      if (!locks) throw Error('Clearing saved submissions requires Web Locks');
      const observed = storage.getItem(key);
      await locks.request(key, () => {
        if (active.has(key) || storage.getItem(key) !== observed)
          throw Error('Submission changed in another view; inspect it again');
        storage.removeItem(key);
      });
    },
    /**
     * @param {any} session
     * @param {string} key
     * @param {string} text
     * @param {() => void} [onAcknowledged] Synchronous cleanup before the retry ID is removed.
     */
    submit(session, key, text, onAcknowledged = () => {}) {
      const current = active.get(key);
      if (current && !current.state.acknowledged) {
        if (current.text !== text)
          return Promise.reject(
            Error('Wait for the current submission acknowledgement'),
          );
        current.state.callbacks.push(onAcknowledged);
        return current.promise;
      }
      const state = { acknowledged: false, callbacks: [onAcknowledged] };
      const promise = (async () => {
        if (!locks)
          throw Error(
            'Safe submissions need browser Web Locks. Update this browser or Android System WebView before sending.',
          );
        // Reserve before introspection: another view may finish its complete
        // send while this view's discovery call is still pending.
        const { request, firstClaimant } = await locks.request(key, () => {
          const saved = storage.getItem(key);
          const claimed = saved
            ? JSON.parse(saved)
            : { text, id: makeId(), phase: 'reserved' };
          if (saved && claimed.legacy)
            throw Error(
              'This older Floot host cannot safely retry an unconfirmed send. Inspect its conversation before clearing the saved draft.',
            );
          if (claimed.text !== text)
            throw Error(
              'An earlier submission is unconfirmed. Retry its original text before sending a different message.',
            );
          if (typeof claimed.id !== 'string')
            throw Error('Invalid saved submission');
          storage.setItem(key, JSON.stringify(claimed));
          return { request: claimed, firstClaimant: !saved };
        });
        // No lock is held over a remote await. An unknown reservation can be
        // recovered using receipts, but only its first claimant may use enqueue.
        // eslint-disable-next-line no-underscore-dangle
        const methods = await E(session).__getMethodNames__();
        const supportsReceipts = methods.includes('enqueueOnce');
        await locks.request(key, () => {
          const saved = storage.getItem(key);
          const latest = saved ? JSON.parse(saved) : null;
          if (!latest || latest.id !== request.id) {
            const error = Error(
              'Submission was resolved or changed in another view; inspect the conversation',
            );
            error.name = 'SubmissionChangedError';
            throw error;
          }
          if (latest.legacy || (!supportsReceipts && !firstClaimant))
            throw Error(
              'This older Floot host cannot safely retry an unconfirmed send. Inspect its conversation before clearing the saved draft.',
            );
          if (
            !supportsReceipts &&
            (latest.phase === 'receipts' || latest.legacy === false)
          )
            throw Error('This Floot host no longer supports safe retries');
          storage.setItem(
            key,
            JSON.stringify({
              ...latest,
              phase: supportsReceipts ? 'receipts' : 'legacy',
              legacy: !supportsReceipts,
            }),
          );
        });
        const result = supportsReceipts
          ? await E(session).enqueueOnce(text, request.id)
          : await E(session).enqueue(text);
        // Another view may already have acknowledged this request and sent
        // the next one. Its durable retry ID must survive our delayed ACK.
        await locks.request(key, () => {
          const latest = storage.getItem(key);
          // If draft cleanup fails, keep the receipt so a remount can retry
          // with the same request ID instead of submitting accepted work again.
          for (const callback of state.callbacks) callback();
          if (latest && JSON.parse(latest).id === request.id)
            storage.removeItem(key);
          state.acknowledged = true;
        });
        return result;
      })();
      const entry = { text, promise, state };
      active.set(key, entry);
      void promise
        .finally(() => {
          if (active.get(key) === entry) active.delete(key);
        })
        .catch(() => {});
      return promise;
    },
  });
};
harden(makeSubmissionClient);

/**
 * Keep restored and edited drafts attached to the session they belong to.
 * Reopening the same session must not overwrite typing with a stored retry.
 * @param {(key: string) => string} readSaved
 * @param {{getItem: (key: string) => string | null, setItem: (key: string, value: string) => void, removeItem: (key: string) => void}} storage
 */
export const makeSessionDrafts = (readSaved, storage) => {
  /** @type {string | null} */
  let selected = null;
  const read = (/** @type {string} */ key) => {
    const raw = storage.getItem(`floot-draft:${key}`);
    if (!raw) return '';
    const record = JSON.parse(raw);
    if (typeof record.text !== 'string' || typeof record.revision !== 'string')
      throw Error('Invalid saved draft');
    return record.text;
  };
  const write = (/** @type {string} */ key, /** @type {string} */ text) => {
    const value = JSON.stringify({ text, revision: crypto.randomUUID() });
    if (text) storage.setItem(`floot-draft:${key}`, value);
    else storage.removeItem(`floot-draft:${key}`);
    return harden({ key, value });
  };
  const save = (/** @type {string} */ text) => {
    return selected !== null ? write(selected, text) : null;
  };
  return harden({
    save,
    /**
     * Only clear the sent draft, never text typed while its ACK was pending.
     * @param {{key: string, value: string} | null} snapshot
     */
    acknowledge(snapshot) {
      if (
        snapshot &&
        storage.getItem(`floot-draft:${snapshot.key}`) === snapshot.value
      )
        storage.removeItem(`floot-draft:${snapshot.key}`);
    },
    /**
     * Restore an unacknowledged send without changing another session's box.
     * @param {string} key
     * @param {string} text
     * @param {string} current
     */
    restore(key, text, current) {
      if (!storage.getItem(`floot-draft:${key}`)) write(key, text);
      return selected === key && !current ? text : current;
    },
    /**
     * @param {string | null} key
     * @param {string} current
     */
    select(key, current) {
      if (key === selected) return current;
      try {
        // Emptying the composer for a send is not acknowledgement. The durable
        // draft stays until its retry reservation and eventual ACK have landed.
        if (selected !== null && current && read(selected) !== current)
          write(selected, current);
      } finally {
        // A storage/read error must not leave later edits attached to the old
        // session after the component has already selected the new session.
        selected = key;
      }
      // An uncertain submission takes precedence over an ordinary unsent draft.
      const next = key === null ? '' : readSaved(key) || read(key);
      return next;
    },
  });
};
harden(makeSessionDrafts);
