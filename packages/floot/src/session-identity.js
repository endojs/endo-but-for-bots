// @ts-check
import { Fail } from '@endo/errors';

/**
 * Explicit durable runtime/model identity. Empty provider modelId follows the
 * configured default; hosted sessions always pin a model. No legacy inference.
 * @param {any} entry
 */
export const assertSessionIdentity = entry => {
  (entry &&
    typeof entry.backendId === 'string' &&
    entry.backendId.trim() !== '' &&
    typeof entry.modelId === 'string' &&
    (entry.modelId.trim() !== '' ||
      (entry.backendId === 'provider' && entry.modelId === '')) &&
    !Object.hasOwn(entry, 'model')) ||
    Fail`Floot session lacks explicit backend/model identity; retire legacy sessions with the previous release`;
};
harden(assertSessionIdentity);

/** @param {{ backendId: string } | undefined} entry */
export const isHostedSession = entry =>
  entry !== undefined && entry.backendId !== 'provider';
harden(isHostedSession);
