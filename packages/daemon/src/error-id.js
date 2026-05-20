// @ts-check

/**
 * Helpers for correlating a locally-caught `Error` with the wire-level
 * `errorId` minted by `@endo/marshal`'s smallcaps error encoding.
 *
 * Two CapTP-speaking surfaces (the CLI and the chat client) and the
 * daemon itself all need the same primitive: given a decoded `Error`,
 * recover the `errorId` so the trace facility can look up the
 * originating worker's record. `@endo/marshal` does not expose the
 * errorId as an enumerable property on the decoded error (only as part
 * of the SES error tag, which is not addressable from JavaScript), so
 * the consumer installs `recordInboundErrorId` as a `marshalLoadError`
 * hook to capture the pair at decode time and stores it in a
 * per-consumer side-table. `extractErrorId` consults that table, with
 * a fallback that scrapes the SES error tag exposed by `err.name` for
 * environments where the hook is unavailable.
 *
 * The daemon's own `extractInboundErrorId` (called from the daemon's
 * outbound marshalSaveError hook to recognize re-forwarded inbound
 * errors) shares the SES-tag fallback path via this module; the daemon
 * does not install a marshalLoadError hook on its inbound surface (it
 * has access to the underlying record directly via the trace
 * aggregator), so it uses the property-and-tag fallback shape.
 */

/**
 * Regex matching the parenthesized SES error tag inserted by
 * `@endo/marshal`'s `decodeErrorCommon` (`(error:<id>)`). Exported as
 * the single source of truth so downstream callers cannot drift on the
 * exact shape.
 */
export const ERROR_ID_PATTERN = /\(error:[^)]+\)/;

/**
 * Construct a side-table-backed pair of `recordInboundErrorId` /
 * `extractErrorId` for one consumer. Each consumer (CLI, chat client,
 * etc.) gets its own `WeakMap` so the table cannot leak across CapTP
 * sessions in test environments that share a process.
 *
 * @returns {{
 *   recordInboundErrorId: (err: unknown, errorId: string | undefined) => void,
 *   extractErrorId: (err: unknown) => string | undefined,
 * }}
 */
export const makeInboundErrorIdRegistry = () => {
  /** @type {WeakMap<object, string>} */
  const inboundErrorIds = new WeakMap();

  /**
   * Hook installed on a consumer's CapTP marshal. Stores the
   * wire-level errorId associated with a decoded Error so the matching
   * `extractErrorId` can find it later.
   *
   * @param {unknown} err
   * @param {string | undefined} errorId
   */
  const recordInboundErrorId = (err, errorId) => {
    if (
      err !== null &&
      typeof err === 'object' &&
      typeof errorId === 'string' &&
      errorId.length > 0
    ) {
      inboundErrorIds.set(/** @type {object} */ (err), errorId);
    }
  };
  harden(recordInboundErrorId);

  /**
   * Extract the wire-level errorId from an Error decoded by
   * `@endo/marshal`. Prefers the side-table populated by
   * `recordInboundErrorId` (set when the marshal layer decoded the
   * error). Falls back to scraping the SES error tag exposed by
   * `err.name` for environments where the marshalLoadError hook is
   * unavailable.
   *
   * @param {unknown} err
   * @returns {string | undefined}
   */
  const extractErrorId = err => {
    if (err === null || typeof err !== 'object') return undefined;
    const recorded = inboundErrorIds.get(/** @type {object} */ (err));
    if (typeof recorded === 'string') return recorded;
    return extractErrorIdFromTag(err);
  };
  harden(extractErrorId);

  return harden({ recordInboundErrorId, extractErrorId });
};
harden(makeInboundErrorIdRegistry);

/**
 * Scrape the wire-level errorId from the SES error tag (the
 * parenthesized form of `err.name`). Returns `undefined` when the
 * pattern does not match. Exposed for callers (notably the daemon's
 * outbound `marshalSaveError` hook) that lack a `marshalLoadError`
 * side-table and only have the decoded error to inspect.
 *
 * @param {unknown} err
 * @returns {string | undefined}
 */
export const extractErrorIdFromTag = err => {
  if (err === null || typeof err !== 'object') return undefined;
  const errorIdProp = /** @type {{ errorId?: unknown }} */ (err).errorId;
  if (typeof errorIdProp === 'string' && errorIdProp.length > 0) {
    return errorIdProp;
  }
  const name = /** @type {{ name?: unknown }} */ (err).name;
  if (typeof name !== 'string') return undefined;
  const match = ERROR_ID_PATTERN.exec(name);
  if (match === null) return undefined;
  return match[0].slice(1, -1);
};
harden(extractErrorIdFromTag);
