// @ts-check
/**
 * The subscription, account and full Secrets bounds (M4's contract
 * settings, W4.0; `designs/m4-interfaces.md` section 1.3; `limits-m4.js`
 * `m4Limits` until the fold, F2): the bounds of everything M4 added that
 * crosses into or out of a vat. Node-side
 * settings (stickiness, backoff, retry delays, timeouts) are in
 * `config/subscription-defaults.js` (W4.1); where a name is in both, the values must
 * be equal (`test/unit/m4-interfaces.test.js`, W4.1).
 *
 * Kept out of `limits.js` on purpose: `limits.js` is in every vat bundle, and
 * the session program has about 13 KB left of its 200 KB budget for M3, M4
 * and M5 together (m4-interfaces 1.4). Only M4's own modules import this one
 * (the manager vat's subscriptions part, the factory's effort resolver, the
 * adapter); the session program never does.
 *
 * Units as `limits.js`: `...Bytes` UTF-8 bytes, `...Units` UTF-16 code
 * units, `...Ms` milliseconds. Plain data only (vats and Node).
 */
export const subscriptionLimits = harden({
  // ---- pools (R4-24, R4-90, R4-103, R8-13) ----
  /** Members of one pool; also the most a `PoolState` or mark list holds. */
  maxPoolMembers: 16,
  /** Pools the manager keeps (each is also a factory backend, <= maxBackends 16). */
  maxPools: 8,
  /** Members the manager keeps in all (retired members are dropped). */
  maxMembers: 64,
  /** Last-served records per pool (R4-103: 256), least recently served dropped. */
  servedRecords: 256,
  /** Served records in one `PoolChange` (coalesced by the adapter). */
  poolChangeServed: 32,
  /** A provider name of a member (`claude` or `codex`). */
  providerUnits: 16,
  /** A member weight (relative plan size, R8-13; display and ties only). */
  maxWeight: 1000,
  /** Pool and member pages (`listMembers`, `listPools`). */
  poolPageEntries: 64,

  // ---- secrets, full (R7-22..R7-26, R7-63) ----
  /** Entries in one `SecretsAdmin.catalog` page (as `secretPageEntries`). */
  catalogPageEntries: 64,
  /** Keys in one `CredentialOps.describeSecrets` call. */
  describeBatch: 64,
  /** Audit events one `AuditReader.page` answers (R7-63: default 100, at most 1,000). */
  auditReaderMax: 1000,
  /** Audit events a page answers when no limit is given (R7-63). */
  auditReaderDefault: 100,
  /** A subscription credential value read by a provider (R7-25: 8,192 bytes). */
  credentialBytes: 8192,

  // ---- accounts (R4-84, R4-85, R6-54) ----
  /** Rate-limit windows in one reading (primary, secondary, and spares). */
  maxWindows: 4,
  /**
   * Observed quota samples kept per member and window (the newest; a read
   * that repeats the last sample extends it instead of adding one). Bounds
   * the readings file and the `Accounts.history` pages.
   */
  historySamples: 48,
  /**
   * Members in one `Accounts.history` page (4 x 4 windows x 48 samples,
   * about 100 KB at most); `next` names the following page.
   */
  historyPageMembers: 4,
  /** A plan or credit label shown to a person. */
  planUnits: 128,
  /** An ISO 8601 time as text (`2026-11-18T02:11:49.000Z` is 24). */
  timeUnits: 32,
  /** Banked reset credits listed per member (R4-86; display only, decision 8). */
  maxBankedCredits: 16,
  /** Members' account readings in one `AccountsBatch` event (adapter channel). */
  accountsBatchMembers: 64,
  /** `accountStatus` tool text into the model (the tool output limit, R4-100). */
  accountTextUnits: 32_768,
  /**
   * An accounts-channel subscriber with no `next()` waiting for this long is
   * idle: evicted when idle this long, and the oldest idle one is evicted
   * first when a new `watch` meets the subscriber cap (M2's
   * `channelLimits.subscribersPerSession`, 32). A page that went away
   * without `close()` therefore never fills the channel.
   */
  accountsIdleMs: 60_000,
  /**
   * A `next()` that has waited this long with no change answers the current
   * view again (same `rev`), so a live page always calls `next()` again
   * within `accountsIdleMs` and an abandoned one stops calling and turns
   * idle (a pending `next()` of a closed page would otherwise wait forever).
   */
  accountsKeepaliveMs: 30_000,

  // ---- browser (M3's gateway; m4-interfaces 9.1) ----
  /**
   * The largest secret value the Secrets panel sends: the gateway's
   * `wsMessageBytes` (1,048,576) less 8 KiB for the CapTP JSON envelope.
   * Measured on the JSON-escaped value (`JSON.stringify(value)` as UTF-8)
   * before sending; larger values go through the CLI's sealed-box write
   * (`scripts/subscription-login.mjs --value-file`, `subscriptionTexts.secretTooLargeForBrowser`).
   */
  browserSecretBytes: 1_040_384,
});
