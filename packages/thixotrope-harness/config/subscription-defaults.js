// @ts-check
/**
 * M4 Node-side settings (W4.1; `designs/m4-interfaces.md` sections 5-7 and
 * 12): pool stickiness, refusal backoff, served-record coalescing, retry
 * schedules, renewal skew, the readings file's flush period and the
 * adapter-local bounds of credential reads and the audit reader. The bounds
 * that cross into or out of a vat are `guest/lib/subscription-limits.js` (`subscriptionLimits`);
 * where a name is in both, the values are equal
 * (`test/unit/m4-interfaces.test.js`).
 *
 * Guest code cannot import this module (guest bundles read only guest/).
 * Times are milliseconds.
 */
export const subscriptionDefaults = Object.freeze({
  /** R4-103: a session stays on the member that served it this long. */
  cacheLifetimeMs: 300_000,
  /** R4-103: last-served records kept per pool (least recently served dropped). */
  servedRecords: 256,
  /** 5.1: a kept served stamp is sent again when it is this old (reference `SERVED_STAMP_MS`). */
  servedStampMs: 60_000,
  /** 5.1: served stamps of one pool are sent at most this often. */
  servedFlushMs: 1000,
  /**
   * 3.1: a pool's `poolState` is asked again at its next use when older
   * than this. A safety net only (XB): the manager pushes
   * `CredentialOps.poolsChanged` when it retires a pool or a member, and the
   * next round asks again. Ten minutes, twice the default cache lifetime
   * (`cacheLifetimeMs`), so a used pool costs at most one manager crank per
   * 600 s for it (0.1 per 60 s, on top of the served stamps' one per
   * session per 60 s in `subscriptions.servedWrites`); 30 s (M4-FIX, before
   * the push) cost up to two per pool per 60 s.
   */
  poolStateRefreshMs: 600_000,
  /** R4-103: the first undated refusal pause, doubled while refusals come in a row. */
  backoffStartMs: 60_000,
  /** R4-103: the longest undated refusal pause. */
  backoffMaxMs: 3_600_000,
  /** R4-25: an undated "limit reached" reading blocks the member this long. */
  undatedBlockMs: 3_600_000,
  /** R4-93: a provider request's timeout when the pool spec sets none. */
  requestTimeoutMs: 3_600_000,
  /** R4-92: Claude's output limit when the pool spec sets none. */
  claudeMaxOutputTokens: 16_384,
  /** D-M4-5 (open decision 13): Claude's context window when the pool spec sets none. */
  claudeContextLength: 200_000,
  /** R4-75, R4-105: Codex `server_is_overloaded` retries before delivery. */
  codexOverloadDelaysMs: Object.freeze([5000, 10_000, 20_000, 40_000, 60_000]),
  /** D-M4-4 (open decision 12): Claude overload retries before delivery, Codex's schedule. */
  claudeOverloadDelaysMs: Object.freeze([5000, 10_000, 20_000, 40_000, 60_000]),
  /** Section 7: renew an access token this close to its expiry. */
  refreshSkewMs: 120_000,
  /** Section 6: the readings file is written at most this often. */
  readingsFlushMs: 5000,
  /** R7-25: a credential value read is refused over this many bytes. */
  credentialBytes: 8192,
  /** R7-63: the most audit events one `AuditReader.page` answers. */
  auditReaderMax: 1000,
  /** R7-63: audit events a page answers when no limit is given. */
  auditReaderDefault: 100,
});
