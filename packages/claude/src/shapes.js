// @ts-check

/**
 * The pinned response-shape table (gate 3). A stream event maps to a
 * non-`ok` result only through an entry recorded against a CLI version by a
 * live capture; anything else stays `undefined` and the turn ends as
 * `unavailable`, never as `needs-auth`.
 *
 * Captured 2026-09-29 by the #1357 evidence probe:
 * - 2.1.280 (garden host) and 2.1.278 (minion.town): an invalid
 *   `ANTHROPIC_AUTH_TOKEN` under `--bare` yields `system/api_retry` events
 *   with `error_status: 401, error: "authentication_failed"`, retried up to
 *   `max_retries: 10` with exponential backoff (over two minutes), and no
 *   `result` event before that. The backend ends the turn on the first such
 *   event rather than paying for the retries.
 */
const TABLE = harden({
  '2.1.278': { authRetry: { status: 401, error: 'authentication_failed' } },
  '2.1.280': { authRetry: { status: 401, error: 'authentication_failed' } },
});

export const pinnedShapeVersions = harden(Object.keys(TABLE));

/**
 * @param {string | undefined} version
 * @param {any} event
 * @returns {import('@endo/inference/src/types.js').InferResult | undefined}
 */
export const classifyStreamEvent = (version, event) => {
  const entry = version === undefined ? undefined : TABLE[version];
  if (entry === undefined) return undefined;
  if (
    event?.type === 'system' &&
    event.subtype === 'api_retry' &&
    event.error_status === entry.authRetry.status &&
    event.error === entry.authRetry.error
  ) {
    return harden({ type: 'needs-auth' });
  }
  // gap: see PR body, Gap 7. No usage-exhausted or rate-limited shape has
  // been captured on any version, so none is classified.
  return undefined;
};
harden(classifyStreamEvent);
