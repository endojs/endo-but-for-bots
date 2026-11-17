// @ts-check
import harden from '@endo/harden';

/** @returns {{id: string} | undefined} */
export const pendingAssistantInvocation = () => {
  const request = /** @type {any} */ (window).endoAssistantInvocation;
  return typeof request?.id === 'string' &&
    /^[a-zA-Z0-9-]{1,80}$/.test(request.id)
    ? request
    : undefined;
};
harden(pendingAssistantInvocation);

/**
 * @param {string} id
 * @param {string} [error]
 */
export const acknowledgeAssistantInvocation = (id, error = '') => {
  if (pendingAssistantInvocation()?.id === id)
    delete (/** @type {any} */ (window).endoAssistantInvocation);
  /** @type {any} */ (window).AndroidAssistant?.postMessage(
    JSON.stringify({ id, error }),
  );
};
harden(acknowledgeAssistantInvocation);

/**
 * A bounded durable claim prevents redelivery after Activity recreation from
 * silently creating another session. An ambiguous creation is not replayed.
 * @param {Storage} storage
 * @param {LockManager} locks
 * @param {string} id
 * @param {{isCurrent: () => boolean, start: () => void}} [admission]
 */
export const claimAssistantInvocation = (storage, locks, id, admission) =>
  locks.request('floot-assistant-launch', () => {
    if (admission && !admission.isCurrent()) return false;
    const key = 'floot-assistant-launch';
    const recent = JSON.parse(storage.getItem(key) || '[]');
    if (!Array.isArray(recent)) throw Error('Invalid assistant launch history');
    if (recent.includes(id)) return false;
    storage.setItem(key, JSON.stringify([...recent.slice(-31), id]));
    // Admission, durable claim, and dispatch share one synchronous lock turn.
    // A detached/backgrounded claimant cannot steal a queued invocation.
    admission?.start();
    return true;
  });
harden(claimAssistantInvocation);
