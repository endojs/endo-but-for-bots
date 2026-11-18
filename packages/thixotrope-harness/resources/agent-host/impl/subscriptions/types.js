// @ts-check
/**
 * Types of the M4 adapter modules (W4.0; `designs/m4-interfaces.md`
 * sections 3-7 and 12). Type declarations only: every module of
 * `AH/subscriptions/` and the M4 parts of `AH/secrets/` implement these
 * shapes and export the entry points section 12 names. Values that cross
 * into or out of a vat are guarded by `guest/lib/interfaces-m4.js`; the
 * types below are the adapter's in-process view of the same data (times as
 * numbers in ms, not ISO text).
 *
 * Keys: a member is known by its `PoolMember` presence (an object), a
 * session by its `Session` presence, a pool by its `Backend` presence; Maps
 * and WeakMaps are keyed by those presences within one adapter incarnation.
 * The credential's store key (`k<n>`) is used only to read and write the
 * Secrets store and to name the account-readings entry on disk (it never
 * leaves the manager-adapter pair).
 *
 * Node only.
 */

/**
 * @typedef {'claude' | 'codex'} Provider
 * @typedef {'claude-pool' | 'codex-pool'} PoolKind
 */

/**
 * One member as `AgentHostSink.poolState` describes it (`MemberState`).
 * @typedef {object} MemberEntry
 * @property {any} member the PoolMember presence
 * @property {string} label operator label (F.2 a)
 * @property {Provider} provider
 * @property {number} weight
 * @property {string} key the credential's store key
 * @property {'active' | 'retired'} state
 * @property {Mark} [mark]
 * @property {any} [declared] `DeclaredProfile`
 */

/**
 * A refusal mark (hosted-agent `subscription-pool.js`).
 * @typedef {object} Mark
 * @property {number} untilMs
 * @property {number} strikes
 * @property {number} sinceMs
 * @property {boolean} dated
 */

/**
 * A rate-limit or usage reading of one member's account
 * (hosted-agent `account.js` `normalizeRateLimits`, times in ms).
 * @typedef {object} Reading
 * @property {number} at when it was read (ms)
 * @property {'observed' | 'remembered'} source `observed` in this
 *   incarnation, `remembered` when loaded from the readings file
 * @property {ReadingWindow[]} windows
 * @property {boolean} limitReached
 * @property {string} [plan]
 * @property {string} [credits]
 * @property {{ expiresAtMs?: number, label?: string }[]} [banked]
 *
 * @typedef {object} ReadingWindow
 * @property {'primary' | 'secondary' | 'other'} name
 * @property {number} usedPercent 0..100
 * @property {number} [resetsAtMs]
 * @property {number} [windowMinutes]
 */

/**
 * W4.2 `pool.js`: the selection rule with object keys (hosted-agent
 * `subscription-pool.js` `makeSubscriptionPool`, `selectMembers`,
 * `standingOf`, `makeRefusalMarks`, adapted: no member ids, no pinning).
 * @typedef {object} PoolCore
 * @property {(session: any) => PoolTicket} forSession
 * @property {() => Map<any, Mark>} marks current marks by member
 * @property {(member: any, reading: Reading) => void} observed a newer open
 *   reading may lift a dated mark (R4-25)
 *
 * @typedef {object} PoolTicket
 * @property {() => MemberEntry[]} select members in the order to try
 *   (R4-24: sticky while within the cache lifetime, else the soonest long
 *   window reset, ties by used fraction, then declaration order; marked and
 *   retired members left out)
 * @property {(member: any) => void} served
 * @property {(member: any) => void} unusable undated mark, doubling backoff
 * @property {(member: any, untilMs: number | null) => void} exhausted
 *
 * @typedef {object} PoolChange
 * @property {{ member: any, mark?: Mark }[]} [marks]
 * @property {{ session: any, member: any, at: number }[]} [served]
 */

/**
 * W4.2 `pool-state.js`: the manager bridge of one pool.
 * @typedef {object} PoolStateBridge
 * @property {() => Promise<{ state: 'active' | 'retired', members: MemberEntry[], served: { session: any, member: any, at: number }[] }>} load
 *   one `E(sink).poolState(backend)` per incarnation (cached; a retired break
 *   from the sink rejects and the next call loads again)
 * @property {(change: PoolChange) => void} record marks are sent at once
 *   (`E.sendOnly(sink).poolChanged`), served stamps coalesced (section 5.1)
 * @property {() => Promise<void>} flush tests and shutdown
 * @property {() => void} invalidate the manager retired a pool or a member
 *   (`CredentialOps.poolsChanged`): the next `load` asks again
 */

/**
 * W4.4 `credentials.js`: a member's credential, parsed. Never logged.
 * @typedef {object} Credential
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {number} expiresAtMs
 * @property {string} [accountId] the provider's account id inside the
 *   credential (bound at sign-in; a renewal answering another is refused)
 * @property {{ startedAtMs: number }} [pendingRefresh] the write-ahead mark
 *
 * W4.4 `renewal.js`: one per member and incarnation (W-5: it holds the
 * accessor of one store key and nothing else).
 * @typedef {object} MemberCredential
 * @property {() => Promise<{ credential: Credential, generation: number }>} current
 *   read (audited), renew when within the refresh skew of expiry
 *   (single-flight), fail with a fixed code (`subscriptionCodes`)
 * @property {(rejected: Credential) => Promise<Credential>} renewAfterRejection
 *   one renewal after a 401 for that exact credential (R4-25's one
 *   credential-refresh retry)
 *
 * W4.4 `AH/secrets/credential-access.js`: the store accessor of one key.
 * @typedef {object} CredentialAccess
 * @property {() => Promise<{ value: string, generation: number }>} read audited
 * @property {(value: string, expectedGeneration: number) => Promise<number>} replace
 *   fails `GENERATION_CONFLICT` when the generation moved
 */

/**
 * W4.3 `messages.js` / `responses.js`: one streamed attempt on one member.
 * Yields `runProviderRound` events (M2 `round.js`); throws a
 * `ProviderFailure` with a fixed text and `details`:
 * `{ status?, exhausted?: { untilMs: number | null }, rejected?: true,
 * overloaded?: true, delivered, retryAfterMs? }`. `onReading(reading)` is
 * called with the rate-limit headers of every answer, 2xx or not.
 * `request.system` is plain text: `provider.js` (W4.6) resolves
 * `RoundRequest.system` once per round with M2's `systemTextOf(req.system,
 * blobs, owner)` (m4-interfaces 5.2); a wire client never reads a staged
 * reference or a blob.
 * @typedef {(options: {
 *   member: MemberEntry,
 *   credential: Credential,
 *   projection: any,
 *   request: { modelId: string, reasoningEffort?: string, maxOutputTokens?: number, system?: string, tools: readonly any[] },
 *   spec: any,
 *   signal: AbortSignal,
 *   fetch?: typeof globalThis.fetch,
 *   onReading: (reading: Reading) => void,
 * }) => AsyncIterable<any>} WireAttempt
 */

/**
 * W4.5 `accounts.js`: the account oracle of every pool (adapter-local).
 * @typedef {object} AccountsCore
 * @property {any} accounts the `Accounts` exo (m4Interfaces.Accounts)
 * @property {(backend: any, member: MemberEntry, reading: Reading) => void} observe
 * @property {(backend: any, member: MemberEntry, state: 'ok' | 'marked' | 'unusable' | 'retired', code?: string, markedUntilMs?: number) => void} memberState
 * @property {(backend: any, session: any) => void} sessionOpened
 * @property {(backend: any, usage: any) => string} statusText the
 *   `accountStatus` text (Fae `session/account-tool.js` rendering)
 * @property {() => Promise<void>} flush the readings file
 *
 * The accounts channel behind `accounts.watch()` answers a waiting `next()`
 * again after `subscriptionLimits.accountsKeepaliveMs` with no change, evicts a
 * subscriber with no `next()` call for `subscriptionLimits.accountsIdleMs`, and at
 * the subscriber cap evicts the oldest idle one before refusing
 * (m4-interfaces 6).
 */

/**
 * W4.6 `AH/subscriptions/index.js`: one incarnation's subscriptions.
 * @typedef {object} Subscriptions
 * @property {(spec: any) => boolean} handles true for a `PoolSpec`
 * @property {{ listModels: (request: any) => Promise<any>, resolveModel: (request: any) => Promise<any> }} catalog
 *   the pool catalogue (W4.3), same request shape as M2's `makeCatalog`
 * @property {any} credentialOps the `CredentialOps` exo (`ops.credentials()`)
 * @property {AccountsCore} accounts
 * @property {(backend: any, spec: any) => Promise<PoolStateBridge>} poolOf
 */

export {};
