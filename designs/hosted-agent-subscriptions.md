# Hosted Agent Subscriptions: Status, Pools, Draining, and Delegated Shares

| | |
|---|---|
| **Created** | 2026-09-20 |
| **Updated** | 2026-09-20 |
| **Author** | kumavis (prompted) |
| **Status** | In Progress |

## Status

**Phase 1, usage and context, is implemented.** Not deployed; the OpenCode
bridge lives in the slice image, so its part takes effect when that image is
rebuilt (the host accepts an older bridge's two-count lines meanwhile).

- `packages/hosted-agent/src/token-usage.js` — the five disjoint counts, the
  context reading, and the arithmetic every adapter and Floot share.
- Adapters: `codex-sandbox/src/codex-protocol.js`
  (`usageEventFromTokenUsage`), `claude-sandbox/src/claude-hosted-events.js`,
  `opencode-sandbox/src/opencode-bridge.mjs` and `opencode-protocol.js`.
- Provider path: `lal/providers/openrouter.js`, `lal/providers/anthropic.js`,
  `floot/providers/anthropic-streaming.js`.
- Floot: `agent.js` (totals, turn fold, `getUsage()`), `src/hosted-turn.js`,
  `src/turn-journal.js`, `src/stream.js`, `src/session-turn.js`,
  `src/account-tool.js` (cached input is now priced at the cached rate).
- Views: `chat/floot-component.js`, `space-floot/src/usage-label.js`; the
  header shows traffic and `ctx N%`, the settings panel the detail.

Where the implementation differs from the design below:

- **`getInfo()` does not carry the context.** It reads the registry entry
  only, and totals live with the session's agent. The context is in
  `getUsage()`, the reply stream's `usage` event and the session watch's
  `usage` event. The watch publishes usage at turn boundaries, so occupancy
  does not move during a turn.
- **Readings merge field by field, not plain last-wins** (`mergeContext`). A
  0 never replaces a known figure: Claude learns the window only at the end of
  a turn, and a failed turn can report the window and no request. The cost: a
  session whose model changes to one that never reports a size keeps showing
  the previous model's.
- **Claude** reads each request from the stream's `message_start` and
  `message_delta` (the CLI runs with partial messages), falling back to the
  complete `assistant` event, and emits mid-turn `usage` events that carry
  only `context`. The CLI's `<synthetic>` placeholder messages are not
  requests. The window is the main model's entry in `modelUsage`, matched
  through a variant suffix such as `[1m]`, else the largest listed.
- **Codex and OpenCode** take `usedTokens` from the provider's own total
  (`totalTokens`, `tokens.total`) when there is one. OpenCode's counts were
  confirmed disjoint in the fork's `getUsage`.
- **OpenRouter** reads the public model catalog once, beside the first
  request and with no credential; a reply waits at most two seconds for it; a
  failed read is retried after five minutes. A routing id (`openrouter/free`)
  has no window of its own, so an unlisted served model reads 0.
  **Anthropic's API does not report a window**, so both Anthropic providers
  report 0.

**Phases 2 and 3, readings and subscribing, are implemented.** Not deployed.
A deployed broker is a retained formula; it starts reading headers when the
daemon restarts onto this code, with no retirement.

- `hosted-agent/src/rate-limit-headers.js` — the header projection and
  `isSubscriptionExhausted`; `provider-transport.js` calls `onReading`
  synchronously before its served check, and throws the bare classification
  `Provider subscription exhausted` (`isSubscriptionExhaustion`). The grant
  still collapses it to `Provider request failed` for the slice; nothing uses
  it until the pool does (phase 6).
- `account-source.js` — the broker's read-only account source (`observe`,
  `watch`, `refresh`), reached as `accountSource()` on the scopes service;
  `latest-topic.js` — the coalescing stream every watcher here is served by.
- `account.js` — windows carry `usedPercent` and `windowSeconds`; rate limits
  carry `limitReached`, `credits` and `resetCredits`, each with the time it
  was read. `account-oracle.js` — the push path, journalling on material
  change, `watch()`, one order for builds and pushes.
- `account-oracle-module.js` and `account-source-module.js` — the retained
  entrypoints; `hosted-setup.js` `publishAccountOracle`, called by the three
  adapters' `setup-hosted.js`, binds `<backend id>-account` into Floot.
- Active reads, run only by `refresh()`: `codex-sandbox/src/codex-account-read.js`
  (`/wham/usage`) and `hosted-agent/src/openrouter-account-read.js`.
- Floot: `src/account-watch.js`, `watchAccounts()`, `refreshAccounts()`. Page:
  `chat/floot-component.js`. View: `space-floot/src/account-label.js`; a chip
  beside the token count for the account of the session on screen, and a
  Subscriptions section with a Refresh button in the settings panel.

Where phases 2 and 3 differ from the design below:

- **The stream is the whole list, coalesced**: `{ type: 'accounts', accounts }`
  now and on every change, not a snapshot followed by per-account events. A
  reader that is slow or away gets the newest list and cannot miss an event.
  Readers are bounded at 64 per topic; past that the oldest is closed and
  subscribes again.
- **An account is keyed by `backendId`**, with the backend's title. The
  `providerId`, `subscriptionId` and `label` of the design arrive with the
  pool (phase 5). `servedLast` is not recorded yet.
- **The oracle's namespace holds only the broker's account source**, as a
  formula of its own whose powers are the broker service. It is minted again
  on every setup run and the oracle's `account-source` name re-pointed, so the
  oracle keeps its identity and journal across a re-minted broker. Until the
  next setup run the source formula keeps a retired broker formula from being
  collected; it is never opened, so it holds no listener and no lock.
- **Active reads are not purely numeric.** A Codex plan is one of the pinned
  CLI's enumerated plan types or `unknown`; a reset credit's id must have the
  shape of an identifier; the backend's description text is dropped. A body
  is read up to a byte bound and its text never reaches an error.
- **`limitReached` ages in the view**: a full window blocks until it resets;
  the provider's word with no full window stands until every window the
  reading named has reset; with no window at all it is believed for an hour.
  The pool will need the same rule (phase 5).
- **A refresh's build still journals whenever it observed anything**; only
  pushed readings use the material-change test. The test looks at blocked
  state, reset times, plan, credits (whole units), banked resets and
  five-point steps of each window, and not at list prices.
- **Floot's own provider path has no active read yet.** Its key is read inside
  Floot and no formula holds it as a source. The OpenCode broker has one.
- **`claude setup-token` and `/api/oauth/usage` remain untested**, so Claude
  has no active read; its headers are the whole of its status.

**Phase 4, the bytes response stream, is implemented.** Not deployed, and it
reaches a deployment in two steps: the broker's half arrives with the daemon,
the listener's half with the operator's next listener image.

- `provider-broker.js` — `requestByteStream` on the grant beside
  `requestStream`: the screened text reader as a bytes exo-stream, in chunks of
  at most 32 KiB (`RESPONSE_CHUNK_BYTES`). `provider-http.js` — the listener
  asks the endpoint once what it offers, reads a bytes stream with
  `iterateBytesReader(reader, { buffer: 64 })`, and falls back to the text
  reader for a broker from before it.
- `provider-pipe.js` runs CapTP with `gcImports`. Without it each side kept
  every answer it gave for the life of the pipe, which for a response stream
  is every chunk: measured, the broker's heap grew by what it streamed and a
  256 MB listener died after a few hundred megabytes. It takes both ends, so
  the listener's half also waits for the next image.

Where phase 4 differs from the design below:

- **The old text reader stays.** The listener is an image the operator pins,
  so an older listener has to keep working with a newer broker.
- **The producer does not cap read-ahead at 64, and cannot.** In exo-stream
  the consumer grants credit, and one that grants a great deal and reads
  nothing makes the producer drain the upstream at once; the producer cannot
  tell reading from not reading. What bounds it is the response byte limit:
  at most `maxResponseBytes`, a third more in base64, per open response, and
  `maxConcurrentRequests` of those per grant. Over the private pipe the
  pipe's queue bound (32 MiB) trips first and closes that consumer's pipe
  alone. An honest listener holds 64 chunks of 32 KiB per response. **A peer
  connection has no such bound yet**; the delegated phases need one.
- **A revoked grant stops the bytes stream at the next piece**, including
  pieces already cut from a chunk the screen had passed.
- `usage` on the endpoint, which the design lists for phase 5, is not here
  yet.

**Phases 5 and 6, the pool and the handover, are implemented for Codex.**
Not deployed, and not exercised against two real accounts: that, and whether
encrypted reasoning items replay under another account, are still open below.
Claude and OpenCode brokers still hold one credential each.

- `subscription-pool.js` — the rule and nothing else: `standingOf` (where one
  subscription stands, from its last reading, at an instant),
  `selectMembers`, `makeRefusalMarks`, `normalizeSubscriptionSet`, and
  `makeSubscriptionPool`, which applies them per session and offers its state
  for keeping when it changes.
- `provider-broker.js` — a grant takes a `pool` in place of one credential.
  A request is tried on the members the pool names, in order, **built afresh
  for each**: its credential, its adapter's headers, its transport. A member
  that refuses it as exhausted is reported and the request goes to the next;
  any other failure is the request's own. The echo screen accumulates across
  members. One admission slot per request, whatever the number of attempts.
- `provider-grant-issuer.js` — a transport per member per grant, so what a
  response says of an account is read as that member's. The scope spec
  carries `subscription` (`auto`, or an id); a single-credential issuer
  refuses anything but `auto`.
- `provider-broker-service.js` — `makePooledBrokerServiceKit`, driven by
  `subscriptions: { readSet, secretOf, credentialOf?, adaptRequestOf?,
  activeReadOf?, readState?, writeState? }`. The scopes service answers
  `subscriptions()` and `accountSource(id)`.

Where they differ from the design below:

- **Only local members exist.** There is no wrapped member (another
  `Subscription`), no `hops`, and no `openEndpoint`: the issuer still starts
  the listener. Those belong to delegation.
- **A grant takes the set as it is when it is issued.** A member added later
  serves the sessions opened after it; a live grant is never handed a member
  it does not hold. The design said a change is seen at once.
- **A session's choice is fixed for the life of its scope**, since it is part
  of the scope's specification.
- **A reading ages by what it named.** The provider's word that the limit is
  reached, beside a full window, is about that window and lifts when it
  resets: a five-hour limit does not block a member for the week. With no
  window full it stands until every window named has reset. A window that
  gives no reset time is believed for an hour from the reading, and with no
  time on the reading not at all; the refusal marks' backoff covers it.
- **Refusal marks**: requests in flight when a member drains are one refusal,
  not several in a row; a refusal just after a mark lapsed doubles the pause
  (one minute to an hour); any later one starts over; a time the provider
  names always wins.
- **A member that cannot be used is skipped too**: a secret that will not
  read, a key the upstream rejects, an OAuth credential rejected after its
  refresh. The failed request is not tried elsewhere (that failure says
  nothing about the request); the next one goes elsewhere.
- **An OAuth set names every member's account**, and no two members may share
  an account or a secret.
- **The all-blocked error is not distinct anywhere it could be seen.** The
  grant collapses it, like a pool's own errors, to `Provider request failed`,
  because what the pool says (a pinned id) is the operator's; the listener
  answers a bare 502 either way. It is audited as `subscriptions-exhausted`.
  A view learns that every subscription is blocked from `watchAccounts()`.
- **`served` is recorded when a streamed response starts**, so a stream that
  outlasts the cache lifetime ends "cold".
- **The pool does not journal readings**; the oracles do. After a restart
  every member is unknown to the pool and only the refusal marks and the
  sessions' last members survive, which is what stops a drained account being
  retried.
- **No `serving` turn event, no handover notice, no `watchServing()`.** A
  handover is recorded in the broker's audit trail only.
- `weight` is declared, not defaulted from a plan, and the attestation still
  names the pool's label and not its set.

The other half of phase 5, from the broker to the picker:

- `hosted-backend.js` — a descriptor may carry `providerId` and
  `subscriptions` (`[{ id, label }]`). `hosted-setup.js` provides an oracle
  per subscription, bound into Floot as `<backend id>-account-<id>`.
- `provider-broker-service.js` — the owned service's pool mode
  (`config.pool`): its powers are a namespace holding the stored set, each
  member's secret, and the pool's journalled state. A member's secret is
  looked up on every use, so a lookup that failed once is not the member's
  secret for the life of the broker.
- `codex-sandbox` — `ENDO_CODEX_SUBSCRIPTIONS`
  (`HOSTED-SUBSCRIPTION.md`, "Several subscriptions"); `subscription` in the
  session plan and the scope spec; the factory declares the broker's set and
  validates a pin.
- Floot — `createSession({ subscription })`, kept in the registry entry when
  pinned and sent to the backend only then; `subscription` in `getInfo()` and
  `listSessions()`; one account per subscription in `watchAccounts()`, keyed
  `backendId:subscriptionId`. The picker offers the choice when a backend has
  more than one; a session's chip shows the account it is pinned to, or each
  of its backend's.

Where that differs from the design below:

- **The operator's setting is the source of truth for the set.** Setup
  derives the stored value from `ENDO_CODEX_SUBSCRIPTIONS` at every start, so
  an edit of the stored value itself does not survive a restart. Adding a
  member is still a write and a secret, with no retirement.
- **A pooled broker's account, in its configuration, its grants' attestation
  and its sessions' plans, is the label `pool`.** Moving a deployment from one
  subscription to several is therefore a retirement that its existing
  sessions do not survive; setup refuses it before minting anything.
- **An account change under an existing id is refused by setup**; removed
  members are not reaped.
- **A pin cannot be changed**, and a session pinned to a subscription that has
  since been removed runs on the backend's choice, with a line in the log,
  rather than never running again. Sub-agents inherit their parent's pin.
- **An `auto` session shows every account of its backend**, since nothing
  tells Floot which member served (no `serving` event).
- **The backend asks its broker what it declares at most every half minute,
  for at most five seconds**, and "could not ask" is not "none": the last
  answer stands, a descriptor with no answer yet says nothing of
  subscriptions, and a pin is then refused as unlistable, not as unknown.
- An account view carries `key`, `subscriptionId` and `label`, and no
  `providerId`.

**Phase 7, Codex reset credits, is implemented.** Not deployed, and the
consume call has never been made against the service (see the gates below).

- `packages/hosted-agent/src/reset-credit-admin.js` — the operator's admin of
  one subscription: `consumeResetCredit({ creditId?, replay? })`,
  `abandonResetIntent()`, `getResetState()`, `refresh()`. The idempotency key
  is written to the formula's own journal (`reset-intent-v1-*`) before the
  provider is called, and a failed write means no call.
- `subscription-admin-module.js` — the retained `make-unconfined` formula. Its
  namespace holds `reset-redeemer` and `account-source` (both formulas of
  their own, re-minted over the broker that exists now on every setup run)
  and the intent; never the broker service. `hosted-setup.js`
  (`provideSubscriptionAdmin`, the `resetCredits` option of
  `publishAccountOracle`) provides one per subscription and binds it into
  Floot's profile as `<backend>-admin` or `<backend>-admin-<id>`.
- `reset-redeemer.js`, `reset-redeemer-module.js` and
  `provider-scopes.js`/`provider-broker-service.js` — the broker service's
  `resetRedeemer(id?)`, per member in a pool.
- `codex-sandbox/src/codex-reset-credit.js` — the one call.
- Floot: `redeemAccountReset(key, { creditId?, replay? })`,
  `abandonAccountReset(key)`, and `reset: { pending, last } | null` on each
  account of `watchAccounts()`. The view's Subscriptions section has "Redeem a
  reset", and "Ask again" and "Give up" while one is unconfirmed; the host
  page asks the person to confirm each.

Where it differs from the design below, or settles what it left open:

- **The caller says whether it is redeeming or asking again.** The design had
  the consume call "replayed, with the stored key, only when the operator
  redeems again". A redeem that doubles as a replay can spend two credits: the
  credit reads `redeemed` between the view drawing "Ask again" and the press,
  the intent is settled, and the same press would start a redeem of the next
  credit. So `replay: true` never starts a redeem (it answers how the intent
  was settled, and calls nobody), and a redeem is refused while one is
  unconfirmed.
- **A refusal ends an intent only when it answers the first ask.** HTTP 400,
  401, 403, 404, 405 and 422 mean this ask spent nothing. After an earlier ask
  whose answer was lost, that says nothing of the earlier one, so the intent
  stands, marked `lastAnswer: refused`. A conflict, a timeout, a throttle and
  every 5xx are not answers.
- **`abandonResetIntent()` is new.** An intent with no credit id (the reading
  listed none) can never be settled by a status, and an answer in words this
  does not know fails every replay. Giving up is the way out, and costs the
  protection: the view says so before it asks.
- **An ask that could not have been sent leaves nothing pending**: no
  redeemer bound (checked before the intent is stored), or a credential that
  could not be had (`notSent`). After an earlier ask, the intent stands.
- **The redeem authority is a facet of the broker service**, because the
  credential lives in that formula's worker and a second credential over one
  renewable secret would race its rotation. The service is held by setup and
  the host-side backend; a scope, a grant, a slice and a share have no path to
  it. The admin's namespace holds the facet as a formula of its own, as the
  oracle holds the account source.
- **A `full-control` or `machine-admin` session can reach the admin**, since
  those presets hand the session Floot's own host, in whose profile the admin
  is bound. They are root-equivalent by design (they can mint unconfined
  code); nothing narrower was attempted. No other session can.
- **There is no `PoolAdmin.member(id)`**: each member has an admin formula of
  its own, found by pet name. `attenuate` is phase 8.
- **The reset state rides the accounts stream** instead of a status of the
  admin's own: Floot asks the admin where it stands (from memory, no provider
  call) on each reading and after each action.
- **The credit to spend**, when the operator names none, is the available one
  that expires soonest; with no list in the reading the provider chooses. With
  nothing known of the account, the admin reads it once first.
- **The wire format is a guess** from the pinned CLI's strings:
  `POST /wham/rate-limit-reset-credits/consume` with `redeem_request_id`,
  `credit_id` and `credit_type: usage_limit`; the outcome word is looked for
  in `outcome`, `result`, `status`, `code`, `state` and `redeem_status`, in
  both spellings. A wrong request is refused (nothing spent); a response this
  cannot read leaves the redeem unconfirmed, to be settled by the credit's
  status or given up.
- A subscription id may not be, or end in, `-powers` or `-handle`: setup names
  each member's formulas and their namespaces by id.

**Phase 8, shares, is implemented.** Not deployed, and nothing of it has run
against a real peer connection. A share that a peer holds is served by an
endpoint with no listener; the peer's runner starting a listener over such an
endpoint is phase 9.

- `provider-usage.js` — what a response cost, read from the provider's own
  stream as it passes (OpenAI Responses, Anthropic Messages, chat
  completions), numbers only. The broker settles it once per request as
  `{ usage, began, complete, responseBytes }`: on `request` as a record, on
  `requestByteStream` as a promise that always fulfils. The older
  `requestStream` carries none.
- `broker-subscription.js` and `subscription-module.js` — the broker as a
  `Subscription` (`describe`, `openEndpoint`, `getStatus`, `watchStatus`),
  reached by the service's `subscription()` and held by setup as
  `<dir>/subscription`. `provider-grant-issuer.js` `openEndpoint` is the same
  credentialed core a grant has (routes, models, byte bounds, the echo
  screen, the pool's selection), with no listener.
- `subscription-share.js`, `share-meter.js` — the share and its meter.
  `subscription-share-module.js` is the retained formula: a namespace of its
  own holding `subscription`, `share-limits` (a stored value, read for every
  request) and the state journal (`share-state-v1-*`: the revocation and the
  meter's ceiling). Its value is the grantor's kit; what is handed out is
  `subscription-share-facet-module.js`, whose value is only the kit's
  `share()`.
- `hosted-setup.js` — `provideBrokerSubscription`/`publishBrokerSubscription`
  (every adapter's setup; re-points each share at the broker that exists now)
  and `provideSubscriptionShare`.
- Wrapped members: `subscription-pool.js` admits `{ id, subscriptionName }`;
  the pooled broker follows the share's status and keeps it as a reading
  (`readingFromShareStatus`), so the pool ranks it and a view shows it; the
  grant serves it through an endpoint opened on first use. Codex setup takes
  `{ id, shareName }` in `ENDO_CODEX_SUBSCRIPTIONS`.

Where it differs from the design below, or settles what it left open:

- **`attenuate(limits)` is `provideSubscriptionShare`, a host-side
  provisioning step**, not a method of `SubscriptionAdmin`. A share is handed
  out by name and must revive with the daemon, so it has to be a formula, and
  a formula's guest namespace cannot mint one. There is no ops entry point or
  view for it yet beyond that function.
- **The meter's durable state is a ceiling written ahead**, not a count
  journalled every so many tokens. Nothing is admitted until `spent +
  reserved` fits under a ceiling already in the store, and a revival takes
  the whole ceiling as spent: the unrecorded step and every open reservation,
  as designed, without having to record reservations. The ceiling is written
  back down when a large reservation settles small, so a restart does not
  charge for what was reserved and never used. A step is a fiftieth of the
  budget.
- **A response cut short is never cheaper than its reservation.** The design
  kept the reservation as the charge for a stream with no usage event. A
  provider also names some usage in its first event, so a settlement says
  whether it is `complete`, and one that is not is charged the most of its
  reservation, what it had said so far, and what its size implies
  (`responseBytes / 4` on top of the request). The same floor applies to a
  response that never says what it cost, which for chat completions is what a
  holder who omits `stream_options.include_usage` gets; the request is not
  rewritten to add it.
- **A request the provider had its whole deadline for is not free.** The
  transport has a third bare classification, `Provider response lost` (the
  deadline passed, or a response broke off after it began). It is let out,
  with `Provider subscription exhausted`, only through an endpoint opened by
  `Subscription.openEndpoint`; a slice's listener still sees one word,
  `Provider request failed`.
- **A holder is told a fixed set of bare words.** Anything else (a store's
  error, whatever another daemon threw) reads `Provider share unavailable`
  and is logged where the share lives. One word covers revoked and expired:
  `Provider share revoked`.
- **`reserve` reads `remainingFraction`**, which the broker's status defines
  as what the best account that can serve has left of its long window, and
  null when no reading says. Unknown is not below the floor.
- **Session ids are namespaced `share-<id>-<session>`**, and where that would
  pass what is beneath accepts (128), the holder's part is replaced by a
  digest of it, so shares nest and a session keeps one name.
- **A share keeps at most 256 endpoints open**, closing the one used least
  recently. The raw `<dir>/subscription` has no such bound and is given to
  shares' namespaces only.
- **Wrapped endpoints are opened on first use, outside the issuer's queue,
  with a deadline.** Opening them while a grant was being made deadlocked a
  pool that (through anybody's shares) held a share of itself, before the hop
  limit could refuse; with lazy opening such a request goes round to the
  limit and is served at the bottom. Past the limit a wrapped member is left
  out of the core and the pool is not told, since how far a request has come
  is its caller's doing and not the member's.
- **A request is sent to a far share again only on its own word that the
  endpoint is gone** (`Inference endpoint revoked`: its daemon restarted, or
  it closed the one used least recently). Any other failure that is not
  about the request makes the member `unusable` to the pool for a while and
  the request goes to the next member, unsent a second time, since it may
  have arrived. An endpoint that stopped working is kept until the grant
  ends, because another request of the session may be streaming from it.
  When no member is left, an endpoint that reveals it says `Provider
  subscription exhausted`, whether they were used up or away, so a holder's
  pool moves on.
- **A share over another party's share trusts that party's settlement.** The
  innermost subscription reads the provider's stream; everyone above charges
  from what it reports. A far side that under-reports costs only the party
  directly above it, who chose to trust it. A settlement that claims to be
  complete and to have cost nothing is charged as one that did not say.
- **There is no deadline on a far request or on its settlement**, only on
  opening. A far daemon that hangs without disconnecting holds a slot and a
  reservation until the connection drops.
- **A wrapped member's stream is passed through, not re-screened**: no
  credential of this broker's was sent. Its settlement is projected to
  numbers. The older text reader is served by the operator's own accounts
  only.
- **Not built**: `watchServing()` and the `serving` event (a share would mask
  them anyway); a `percent of my window` estimate; `attenuate` for Claude's
  and OpenCode's brokers beyond the shared functions (they publish
  `<dir>/subscription`; nothing provisions a share for them); revoking a
  share from a view.

## What is the Problem Being Solved?

A hosted agent session spends a subscription: a ChatGPT plan through Codex, a
Claude plan through Claude Code, an OpenRouter key through OpenCode and through
Floot's own provider path.
Today Endo knows nothing about how much of each is left.
A subscription that runs out surfaces as a failed turn, a view cannot show a
balance or a reset time, and a deployment can hold exactly one account per
provider, pinned at setup and changed only by retiring the broker.

This design covers, as one piece of work because the parts constrain each
other:

1. Reading each subscription's balance and reset dates, and publishing that
   state so a view **subscribes** to it rather than polling.
2. Holding **several subscriptions per provider**, with a manual choice and a
   default that **drains** the subscription whose allowance expires soonest.
3. Moving a turn **smoothly** onto the next subscription when the current one
   drains part-way through.
4. Redeeming Codex's banked **rate-limit resets**, as an operator action.
5. Reporting **context occupancy** (what fraction of the model's window the
   conversation fills) from every backend.
6. **Delegating** to a remote peer: a capability that lets them spawn an agent
   for their own project, on this machine or theirs, against this operator's
   subscription or their own — with the operator's subscription exposed only
   through an attenuated share that enforces its own limits.
7. Making everything that should survive a daemon restart **durable** in the
   way Endo formulas already are.

## Findings

These were established on 2026-09-20 from the pinned binaries (Codex CLI
0.152.0: `codex app-server generate-json-schema` and the strings of the
binary; Claude Code 2.1.263: strings) and from vendor documentation.
Anything not verified is marked.

### What exists in Endo

- `@endo/hosted-agent` has an **account oracle**
  (`packages/hosted-agent/ACCOUNT-ORACLE.md`, `src/account.js`,
  `src/account-oracle.js`): a read-only `HostedAccount` with plan, rate-limit
  windows, a rate card, provenance (`observed`, `declared`, `remembered`,
  `unavailable`) and a journal.
  It has a seam for live readings, `account-source.observe()`.
  **No source is implemented**, and the Tokyo deployment sets no
  `FLOOT_ACCOUNT_PROFILE`, so `getAccount()` reports nothing.
- There is **one oracle per Floot factory**, not one per backend or account.
- A rate-limit window derives `usedFraction` only from `used` and `limit`
  counts. Subscription providers publish **percentages only**.
- The provider broker returns `{ status, body }` or `{ status, reader,
  contentType }` and **drops every upstream response header** (`src/provider-broker.js`: "No
  upstream headers ... escape through the grant").
  The host-side transport (`src/provider-transport.js`) is the only place the
  upstream `Response` and its headers are visible.
- The transport already classifies one upstream outcome for the broker: a 401
  becomes `Provider credential rejected`, a bare message with no detail.
  In `oauth` mode, which only Codex uses, the broker then refreshes and
  redispatches once (`isCredentialRejection`); the echo screen accumulates
  across the two attempts.
  Every other failure leaves the grant as `Provider request failed`.
  [hosted-agent-broker-oauth](hosted-agent-broker-oauth.md) decided that "one
  boolean's worth of information is enough" across that seam; this design
  revises that (Design Decision 13).
- The Claude and OpenCode brokers run in `api-key` mode, including Tokyo's
  Claude `oauthToken`. Their `accountRef` is a constant label (`anthropic`,
  `openrouter`) with no check behind it: only an OAuth credential document
  names an account, and only Codex's is checked against a pin.
- The broker passes request bodies through, checking only `model`, and for the
  Codex subscription route `store === false` and `stream === true`
  (`codex-sandbox/src/codex-subscription-profile.js`).
  Cache keys and cache markers therefore already survive the broker.
  The `chatgpt-account-id` header is supplied by that same host-side profile,
  not by the slice.
- Each adapter hardcodes its descriptor id (`id: 'codex'`), its pet names and
  its directory, keeps one retained broker with one pinned account, and Floot
  refuses two factories that describe the same id.
  Floot does accept further factory pet names through
  `FLOOT_BACKEND_FACTORIES` and binds each session to a `backendId`.
- `HostedBackendFactory.create(spec, toolSet)` takes a caller-chosen
  `sessionId`; `stop` and `destroy` act on any id.
  The factory is an operator capability and was never meant to be delegated.
- Grants cap each request's and each response's bytes and bound simultaneous
  requests. Nothing is cumulative, and tokens are not seen at all.
- A grant is issued with its listener: `provider-grant-issuer.js` starts the
  listener on the credential's host and attests that listener's network
  namespace. `ProviderGrant` is `{ attestation, sandboxEvidence, revoke }`;
  the inference endpoint (`request`, `requestStream`) is what the listener
  holds.
- `assertHostedBackendDescriptor` refuses unknown descriptor keys, and Floot
  runs it on every backend listing.
- The oracle reads its source only inside `refresh()` or a first read, journals
  on every refresh that observed something, and has no change notification.
- Floot's own provider path reads its `SecretBlob` directly in Floot, with no
  broker and no grant.

### What the providers publish

| Provider | Passive, on every inference response | Active query | Manual reset |
|---|---|---|---|
| Codex (ChatGPT plan) | `x-codex-primary-*` and `x-codex-secondary-*`: `used-percent`, `window-minutes`, `reset-at`; `x-codex-credits-has-credits`, `-unlimited`, `-balance`; `x-codex-rate-limit-reached-type`; `x-codex-active-limit` | `GET /wham/usage` on the ChatGPT backend; app-server `account/rateLimits/read` and the `account/rateLimits/updated` notification | yes, see below |
| Claude (Pro or Max plan) | `anthropic-ratelimit-unified-status`, `-reset`, `-5h-utilization`, `-5h-reset`, `-7d-utilization`, `-7d-reset`, `-representative-claim`, and the `-overage-*` family | `GET /api/oauth/usage` | none |
| OpenRouter | none | `GET /api/v1/key`: `usage`, `limit`, `limit_remaining`, `is_free_tier`, `free_model_daily_requests.{used,limit,remaining}`; `GET /api/v1/credits` | not applicable |

- The Codex usage read also returns `planType`, a multi-bucket
  `rateLimitsByLimitId`, a spend-control snapshot (`individualLimit`,
  `spendControlReached`) and `rateLimitResetCredits`.
- OpenRouter's free-model request count resets at midnight UTC; the ceiling is
  50 requests a day below ten purchased credits and 1000 above.
- *Unverified:* a token from `claude setup-token` (what Tokyo uses,
  `ENDO_CLAUDE_CREDS_KIND=oauthToken`) probably lacks the scope
  `/api/oauth/usage` requires.
  The headers arrive either way, so the design does not depend on it.
- Because the broker drops headers, neither CLI inside a slice sees its own
  rate-limit state today.

### Codex rate-limit reset credits

Codex 0.152.0 has banked resets.

- Listed by `GET /wham/rate-limit-reset-credits` and in the usage read:
  `availableCount`, and per credit `id`, `resetType` (`codexRateLimits`),
  `status` (`available`, `redeeming`, `redeemed`), `grantedAt`, `expiresAt`,
  `description`.
- Redeemed by `POST /wham/rate-limit-reset-credits/consume`; in the app-server,
  `account/rateLimitResetCredit/consume` with an optional `creditId` and a
  required `idempotencyKey`.
  Outcomes: `reset`, `nothingToReset`, `noCredit`, `alreadyRedeemed`.
- *From secondary sources, not OpenAI's own page:* credits last about thirty
  days, cannot be bought, and come from OpenAI grants or invitations.
  Which windows a reset clears is not documented in the schema beyond "the
  eligible rate-limit windows".

Endo already refuses this method to the model-facing client
(`SUBSCRIPTION-AUTH.md`). That stays: a reset spends something scarce.

### Prompt caches

| | Anthropic | OpenAI |
|---|---|---|
| Scope | per organization and workspace; never shared | never shared across organizations |
| Lookup | exact prefix: tools, then system, then messages | hash of the prompt's first tokens plus `prompt_cache_key` |
| Lifetime | 5 minutes or 1 hour, refreshed on every hit | 5 to 10 idle minutes, up to 1 hour; extended retention up to 24 hours |
| Cached read price | 0.1 times input | 0.1 times input |

- Codex sets `prompt_cache_key` per thread and a retention option; Claude Code
  uses both Anthropic lifetimes.
- Codex plan usage has been token-based since April 2026, with cached input
  counted at a tenth of fresh input (secondary sources; the rate card page
  could not be fetched).
  Anthropic does not publish how its subscription windows weigh cached tokens.
- **A cache never follows a conversation to another account.**
  The first request after a move re-reads the whole context uncached.
  After an idle gap longer than the cache lifetime the cache is gone on the
  current account too, so a move then costs nothing extra.
- `openrouter/free` routes each request to a different model and so never
  caches; Floot's provider path (`packages/lal`) sends no cache markers and
  records no cached tokens.

### Context size

No adapter carries it, and every backend exposes it.

- **Codex:** `thread/tokenUsage/updated` carries `modelContextWindow`, and
  `last` and `total` breakdowns with `inputTokens`, `cachedInputTokens`,
  `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`,
  `totalTokens`.
  `codex-client.js` keeps `last.inputTokens` and `last.outputTokens` only.
  The schema carries no field descriptions. By the Responses API convention,
  and by a `net_new_input_tokens` field elsewhere in the binary, cached input
  is a **subset** of `inputTokens` and reasoning a subset of `outputTokens`.
- **Claude:** `claude-hosted-events.js` reads `result.usage.input_tokens` and
  `output_tokens` only.
  `input_tokens` excludes `cache_read_input_tokens` and
  `cache_creation_input_tokens`, which are most of a long session, so
  **Claude usage in Floot is undercounted today**.
  `result.usage` aggregates the whole turn, so it cannot give the last
  request; each `assistant` event's `message.usage` can, and the adapter
  ignores it today.
  Anthropic's input kinds are **disjoint**.
  The window is `result.modelUsage[model].contextWindow`.
- **OpenCode:** each step's `tokens` has `input`, `output`, `reasoning` and
  `cache.{read,write}`; the bridge forwards `input` and `output`.
  The window is the model's `limit.context` in OpenCode's provider
  configuration.
- **Provider path:** `usage.prompt_tokens` of the last request, over the
  `context_length` OpenRouter lists for the model that served (`servedBy`).

## Design

### Four capabilities

The backend factory today bundles two authorities: running harnesses on a
machine, and spending a credential.
They separate into capabilities that compose freely.

```text
SecretBlob     the credential bytes             as today
Subscription   serve inference against one      new public form of what the
               credential; publish status       retained broker is inside
Pool           a Subscription made of member    new; one per provider
               Subscriptions, with a selection
               rule
Share          a Subscription attenuated by     new; delegable
               limits its grantor chose
Runner         spawn and stop harness           the HostedBackendFactory,
               sandboxes on a machine, and own  with the subscription made
               their listeners                  an argument
```

`Pool` and `Share` have the `Subscription` interface, so they nest: a peer can
put a share of someone else's subscription into their own pool beside their
own account.

```ts
interface Subscription {
  describe(): Promise<SubscriptionDescriptor>; // providerId, id, label, models
  openEndpoint(spec: EndpointSpec): Promise<InferenceEndpoint>; // per session
  getStatus(): Promise<SubscriptionStatus>;
  watchStatus(): Promise<Reader<StatusEvent>>; // snapshot, then changes
  help(methodName?: string): string;
}

interface InferenceEndpoint {
  request(message): Promise<{ status; body; usage }>;
  requestStream(message): Promise<{ status; reader; contentType; usage: Promise<Usage> }>;
  watchServing(): Promise<Reader<ServingEvent>>; // which member serves; moves
  attestation(): Promise<EndpointAttestation>; // provider origin, named set
  revoke(): Promise<void>;
}

interface SubscriptionAdmin {
  attenuate(limits: ShareLimits): Promise<{ share: Subscription; admin: ShareAdmin }>;
  refresh(): Promise<void>; // one active status read; redeems nothing
  consumeResetCredit(options: { creditId?: string }): Promise<ResetOutcome>; // Codex
}

interface PoolAdmin extends SubscriptionAdmin {
  member(subscriptionId: string): Promise<SubscriptionAdmin>; // resets are per member
}
```

- Setup endows Floot with each provider's pool and its admin by pet name, as
  it endows the backend factories. That is how `watchAccounts()` reaches
  `watchStatus()` and how the view's redeem button reaches a member's admin.
  A delegated runner endows neither.

- `EndpointSpec` is `{ sessionId, subscription: 'auto' | id, models, hops }`.
  A share accepts only `'auto'`, so a holder cannot name or pin the grantor's
  members. `hops` counts the subscriptions a request has passed through; each
  pool or share adds one and refuses past a small limit (4), which bounds
  nesting and stops a cycle of two parties' shares in each other's pools.
  The spec carries no `accountRef`: which account serves is the subscription's
  business, where today the issuer requires the caller to name its one
  account.
- **The runner owns the listener.** Today the grant issuer starts the listener
  and attests its network namespace, which only works when the credential and
  the sandbox share a host.
  `openEndpoint` returns the inference endpoint alone; the runner starts the
  listener beside the slice it made, hands it the endpoint, and produces the
  sandbox evidence.
  On one machine this is today's arrangement with the seam moved.
- An endpoint never yields the credential. It is nonetheless raw, metered
  inference: a holder who is not a runner can call it from any client.
  The grantor of a share gets no attestation of what sits on the other end,
  and the design does not pretend otherwise (see "What each party sees").
- `usage` settles when the producer has read the end of the stream. Each layer
  that needs to charge a meter awaits it; nobody re-pumps the stream to count.
- `SubscriptionAdmin` is the operator's facet and is never delegated.
  A holder who wants to narrow a share further wraps it in a share formula on
  their own daemon; attenuation needs no help from the grantor.

### Status readings

**Header tap.** `provider-transport.js` projects an allowlist of rate-limit
headers from every upstream response, served or refused, into a plain record
and hands it to the subscription through a host-only callback of the kind
`onDiagnostic` already is.
The tap runs synchronously before the transport decides whether the response
was served, as `onDiagnostic` does, because a refusal is where the reset time
of a drained subscription arrives and the pool must have that reading before
it handles the refusal; otherwise the member would get the backoff block
instead of its reset time.
Nothing else about the response changes: no header crosses an endpoint.
The projection is per provider, numeric or enumerated, and refuses anything
that does not parse, so a header cannot carry text out of the upstream.

**Active reads** are for what headers cannot give: OpenRouter, and a Codex
subscription that has not been used since the daemon started.
They run only on `SubscriptionAdmin.refresh()`, which a view's refresh
reaches, and never at boot (see "Dormant after restart").

**Shape.** `account.js` gains, all optional:

- on a window: `usedPercent` as published, and `windowSeconds`; `usedFraction`
  is derived from `usedPercent` when no counts are present;
- on the snapshot: `credits: { balance, hasCredits, unlimited }`,
  `resetCredits: { availableCount, credits[] }`, `limitReached`,
  `servedLast` (when this subscription last served a request).

**One oracle per subscription**, not per Floot, and the oracle changes from
pull to push:

- `account-source.observe()` returns the last tapped reading and **never
  touches the network**, so a first `getAccount()` after boot stays dormant.
- The oracle gains `push(reading)`: it replaces the current snapshot and
  notifies watchers on any change, and **journals only on a material change**
  from the last journalled reading: blocked state, a reset time, plan,
  credits, reset credits, or a window's percent crossing a five-point step.
  `servedLast` changes on every response and is never a reason to journal.
  Today the oracle journals on every refresh and notifies nobody.
- Provenance is unchanged.

**Subscribing.** Floot's factory gains `watchAccounts()`, shaped like
`watchSessions()` (`packages/floot/src/session-watch.js`): `{ type:
'snapshot', accounts }`, then `{ type: 'account', account }` per change.
Each account carries `providerId`, `subscriptionId`, `label`, plan, windows,
credits, reset credits, provenance and `observedAt`.
A view counts down to `resetsAt` locally; a window whose reset time has passed
is known to be empty without asking anyone.
`getAccount()` stays for one-shot callers.

### Provider and subscription in Floot

A backend descriptor gains `providerId` (the adapter, `codex`) and may list
`subscriptions` (`{ id, label }`).
Both are optional, like `promptEnvironment`.
`assertHostedBackendDescriptor` refuses unknown keys, so the validator has to
learn the fields **before** any adapter sends them, and a peer's runner in
front of an older Floot will fail that Floot's backend listing; the phases
order this, and a delegated runner's descriptor omits `subscriptions`.

The model picker groups by provider; a subscription selector appears only
when a provider has more than one.
`createSession` takes `subscription: 'auto' | <subscriptionId>`; the default
is `'auto'`.
The registry entry stores the choice, as it stores `promptContext`, and the
choice travels in the endpoint spec; the pool applies it.

There is **one backend and one pool per provider**, with several subscriptions
beneath the pool, rather than a second backend instance per account.
A move between subscriptions then changes only which member serves the next
request: the thread, the CLI home and the workspace are untouched, and no
thread rotation is needed.

**Floot's own provider path** has no broker, so the tap, the pool, handover
and shares do not apply to it.
It gets the usage and context changes and OpenRouter's active read.
Moving it onto `Subscription` is a later step, not part of this design's
phases.

### Selection: drain the soonest to expire

What is lost at a reset is the unused part of the window, so the default
spends from the subscription whose allowance expires first.

1. **Pinned.** A session pinned to a subscription uses it and no other.
   If that member has been removed from the set the request fails with a
   distinct error naming it; it does not fall through.
2. **Stay while warm.** Otherwise, if the session's last request was served by
   member S less than the provider's declared cache lifetime ago, S is still
   in the set, and S is not blocked, use S.
3. **Otherwise, nearest reset.** Rank the members that are not blocked:
   1. members with a long window running, by that window's reset time,
      soonest first, then by least remaining;
   2. members whose reading is unknown;
   3. members with no window running;
   and within a rank, the order the set declares.

Definitions:

- The *long window* is the longest window the provider reports: weekly for
  Codex and Claude. For OpenRouter the only window is the free-model daily
  count; a paid key has none and ranks by declared order.
- A member is *blocked* while any window is exhausted or it reported its limit
  reached, until that window's recorded reset time.
  A refusal that carries no readable reset time blocks the member for a
  bounded backoff (one minute, doubling to one hour) instead.
- A remembered reading whose reset time has passed counts as "no window
  running"; an unknown reading has no reset time and is shown as assumed.
- A turn usually stays put because its requests are seconds apart, but **a
  long tool call can outlast the cache lifetime**, and then rule 3 re-chooses
  in the middle of a turn. That is intended: the cache is cold either way.

Accepted consequences:

- A member blocked on its short window is skipped even when its long window
  resets soonest, so some of its allowance can expire unused.
- A warm session does not drain another member that is about to reset.

`weight` per member is operator-declared, defaulting from the published plan
multipliers where the provider reports a plan type (ChatGPT Pro at 5 or 20
times Plus; Claude Max at 5 or 20 times Pro).
It is used to show comparable remaining capacity, not to rank: the drain rule
ranks on time.

**Any move between accounts**, by rule 3 or by handover, carries the Codex
caveat below.

### Handover when a subscription drains mid-turn

A drained subscription refuses at admission, before any response byte: Codex
with a 429, an error type `usage_limit_reached` and
`x-codex-rate-limit-reached-type`; Claude, *expected but not yet captured*,
with a 429 and `anthropic-ratelimit-unified-status`.
The transport does not parse refused bodies, so exhaustion is told from
ordinary throttling **by header**.

**A pool has two kinds of member.**
A *local member* is a credential on this daemon: a secret, its refresh state,
its account pin and its adapter headers, reached through a facet the pool
holds and `Subscription` does not expose.
A *wrapped member* is any other `Subscription`, typically a share from
another daemon, reached only through `openEndpoint`.

**For local members the pool is the endpoint's credential resolver, not a
wrapper around member endpoints.**
Today one `perform` closes over one secret, one credential, one `accountRef`
and one `adaptRequest`, and the Codex adapter writes `chatgpt-account-id` into
the upstream request; the held upstream request therefore belongs to one
account and cannot be replayed under another.
So:

- One `perform` holds the **canonical** request: body, path and the forwarded
  headers, which are member-independent.
- Each attempt resolves a member, then that member's credential and adapter
  headers, and builds its upstream request from the canonical one.
- The transport reports `Provider subscription exhausted` as a bare
  classification, like `Provider credential rejected`; the reset time arrives
  through the tap's reading of the same 429, not through the error.
- On that classification the pool marks the member blocked and makes the next
  attempt. **At most one attempt per member per request**, plus the existing
  single refresh retry within a member.
- The echo screen accumulates every local credential the request has carried,
  across local members as it already does across a refresh.
- A wrapped member is one attempt: the pool calls its endpoint with the
  canonical request. That member resolves and screens its own credential on
  its own daemon, and its stream is passed on without re-pumping. No local
  credential was ever sent to that member's upstream, so there is nothing
  local for its stream to echo.
- Classified refusals, `Provider share exhausted` and `Provider subscription
  exhausted`, cross the `Subscription` seam intact, which is what lets a pool
  hand over from a wrapped member. They collapse to `Provider request failed`
  only at the listener-facing edge, as now.
- A wrapped member may itself be a pool and try its own members; `hops`
  bounds the depth.

Effects:

- Nothing reached the slice, so the CLI sees one successful response.
  The thread, the container and the turn continue.
- The cost is one full-context uncached read on the new member.
- The endpoint's `watchServing()` reports the member that serves and each
  move. There is no path from a listener into Floot's turn today, so the
  adapter's session client subscribes and forwards a `serving` turn event;
  `floot/src/hosted-turn.js` records it on the turn beside `servedBy` and
  writes the notice ("moved to B; A is used up until ...").
- When every member is blocked the request fails with a distinct limit error.
  The earliest reset time is read from status, and the view offers a Codex
  reset credit when one is available.
- A pinned session does not move; it fails with the same error, and the time
  shown is its own member's reset.

*Unverified, needs two accounts:* Codex request bodies carry encrypted
reasoning items produced under the first account.
If another account refuses them, the Codex profile drops those items when it
builds a request for a member other than the one that produced them; the
conversation is kept and some hidden reasoning is lost.
Anthropic documents thinking signatures as portable across platforms.

**What an attestation can claim.** An endpoint over a pool attests the pool's
named set.
For Codex each member keeps its account pin, checked on every credential read
as now.
For Claude and OpenRouter a member's name is an operator label; nothing checks
that the secret behind it is the account the label says.
Phase 5 either binds the label at first observation (OpenRouter's key hash
from `/api/v1/key`; an Anthropic organization id if a response exposes one) or
records that these labels are assertions.

### Codex reset credits

`SubscriptionAdmin.consumeResetCredit` is an operator action, offered by the
view, never taken automatically, and never exposed to a share or a slice.
The idempotency key is generated and stored before the call (see Durability).
Expiry of each credit is shown, since a credit is also lost if unused.

### Context occupancy

The shared `usage` turn event gains optional fields:

```js
harden({
  type: 'usage',
  inputTokens, // uncached input
  outputTokens, // output that is not reasoning
  cachedInputTokens, // new
  cacheWriteInputTokens, // new
  reasoningOutputTokens, // new
  context: { usedTokens, windowTokens }, // new: the last request, and the window
});
```

**The five counts are disjoint**, so their sum is the traffic and nothing is
counted twice.
Each adapter converts:

| Adapter | Conversion |
|---|---|
| Codex | `inputTokens = last.inputTokens - last.cachedInputTokens`, less `last.cacheWriteInputTokens` if a live turn shows cache writes are inside `inputTokens`; `outputTokens = last.outputTokens - last.reasoningOutputTokens`; each clamped at zero; `windowTokens = modelContextWindow`. The subset reading is to be confirmed on a live turn. |
| Claude | counts from `result.usage`, all four kinds, which are already disjoint and cover the whole turn; `context` from the **last** `assistant` event's `message.usage`; `windowTokens` from `result.modelUsage` |
| OpenCode | from each step's `tokens`; `windowTokens` from the model's `limit.context`, which the bridge has to read |
| provider path | `prompt_tokens` and `completion_tokens`, with `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens` split out when present; `windowTokens` from the `context_length` of the `servedBy` model |

`usedTokens` means the same everywhere: every input kind of the **last
request** plus that request's output, since the output joins the conversation.

`context` is **last wins**, not summed; the counts are summed as now.
Extra fields are not refused today, they are silently dropped, in each of
these, which all change:

- `opencode-sandbox/src/opencode-protocol.js` (projects exactly three keys)
  and `opencode-bridge.mjs`;
- `claude-sandbox/src/claude-hosted-events.js`;
- `codex-sandbox/src/codex-client.js`;
- `floot/src/hosted-turn.js` (sums two fields), `floot/src/turn-journal.js`
  (a fixed list of finish-record keys), `floot/src/stream.js` (truncates to
  two fields), and `floot/agent.js` (the usage totals, the turn fold, the
  journal aggregate, and the `getInfo()` help text);
- `floot/src/session-watch.js` passes usage through whole and needs only the
  new `context` payload.

Floot derives the percent, stores the last `context` on the turn's finish
record, includes it in `getInfo()` and in the session watch stream, so a view
shows it after a restart without a turn.
The raw window is reported; each CLI compacts by its own rule before the
window is full, and Floot does not guess thresholds.
The Claude undercount is fixed by the same change and stands alone.

### Delegation

**Share.** `attenuate(limits)` yields a `Subscription` whose requests pass
the share's checks before they reach the underlying subscription:

- `reserve`: refuse while the underlying subscription's remaining fraction of
  a window is below a floor. It is enforced from readings, which arrive after
  responses, so between readings it is advisory: concurrent requests can take
  the subscription somewhat below the floor.
- `budget: { tokens, periodSeconds }`: rate-card-weighted tokens (cached input
  at a tenth) per fixed period, anchored at the share's creation.
  It is deliberately not tied to a provider window: a pool has several, and
  OpenRouter has none.
  A "percent of my window" figure can be shown as an estimate; providers
  publish no token size for a window, so it cannot be enforced.
- `models`, `maxConcurrentRequests`, `expiresAt`, and revocation through
  `ShareAdmin`. Revoking cancels the share's in-flight streams.

**Metering.** Only the innermost subscription sees the provider's stream; it
parses the final usage event and settles `usage`.
Every share in the chain charges its own meter from that promise, on
whichever daemon it lives.

- **Reserve, then settle.** At admission a share reserves an estimate (the
  request's size in tokens plus the model's maximum output) and refuses if
  the reservation does not fit. At the end of the stream it replaces the
  reservation with the actual charge.
  Worst-case overshoot is therefore one estimate's error per concurrent
  request, not one whole request each.
- The meter counts what the producer read from the provider, not what the
  consumer took.
- A request refused before its first response byte, by exhaustion or any
  other failure, settles `usage` at zero and releases the reservation.
- A stream that **began** and ends without a usage event (cancelled,
  abandoned, timed out) keeps its reservation as the charge, so a cancelled
  request is not free.

A refusal by a share is its own classification, `Provider share exhausted`,
so the holder sees a limit and not a fault, and the holder's pool hands over
to its next member by the same rule as above.

**What a share reveals.** Its own id and budget status, and of what is beneath
it only whether it is available and until when it is blocked.
It masks the serving member: `watchServing()` through a share names the share.
Even so, a holder can infer the grantor's reset anchors from blocked-until
times, and a threshold on the grantor's usage from `reserve` refusals.
It never exposes the credential, account administration, reset credits, other
shares or the grantor's sessions.

These are budgets a grantor chooses for a capability it hands out.
They are not built-in lifetime caps on the operator's own use, which this
codebase has removed.

**Runner.** `create(spec, toolSet)` accepts `spec.subscription`; an
operator's runner defaults to its endowed pool.
A delegated runner is an attenuation that:

- namespaces session ids and acts only on its own, so a delegate cannot stop
  another party's sessions;
- has its own slot allowance and its own storage root;
- has a network-policy allowlist, defaulting to no network, since the harness
  would otherwise reach the internet from the operator's address;
- requires a storage bound per session before it is handed to anyone.
  Session directories have no disk quota today.

The workspace may be a directory capability from the delegate's own daemon,
mounted over 9P as workspaces already are.
The `toolSet` is already the caller's own capability, so a harness on the
operator's machine calls tools on the delegate's daemon.

**Three cases.**

| The operator hands over | The peer gets |
|---|---|
| a runner and a share | a harness on the operator's machine, against the operator's subscription |
| a runner only | a harness on the operator's machine, against the peer's own subscription |
| a share only | a harness on the peer's machine, against the operator's subscription |

In the second case the peer's subscription stays on the peer's daemon: the
runner's listener calls the peer's endpoint over the peer connection, and the
peer's credential never enters the operator's Secrets.

A runner is a `HostedBackendFactory`, so a peer adds it to their own Floot by
pet name through `FLOOT_BACKEND_FACTORIES`.
Their Floot, its registry and its transcript store stay on their machine.

**What each party sees.** Keeping a store on one's own machine is not
confidentiality from the party one borrows from.

| Case | The operator can read |
|---|---|
| share only | every request body, which is the whole conversation, and every completion, since the subscription serves and meters them |
| runner only | the same, in the listener, plus the workspace as mounted, the tool calls and results, and everything the harness does on the host |
| runner and share | all of the above |

A peer who lends only a subscription to someone else's runner sees that
runner's conversations in the same way.

**The request path, peer against the operator's subscription.**

```text
peer harness --HTTP--> peer listener --CapTP--> Share --> Pool/Subscription --HTTPS--> provider
                                       network    check,    resolve member,
                                                  reserve   add credential
             <--bytes stream, buffer 64-----------+<--------+<-- stream + rate-limit headers
                                        settle meter    record reading, publish status
```

| Hop | Transport |
|---|---|
| harness to its listener, inside the slice's network namespace | plain HTTP in the provider's own API shape |
| listener to the endpoint | CapTP over inherited pipes, as today |
| endpoint, share, pool, subscription | CapTP capability calls in one daemon |
| peer's machine to the operator's | CapTP over Endo's peer connection |
| subscription's transport to the provider | HTTPS |

### Streaming

The provider response crosses the endpoint today as a hand-rolled reader with
`next()` and `return()`, one call per chunk, yielding decoded strings.
It becomes a bytes exo-stream:

```js
// producer, in the subscription
const reader = bytesReaderFromIterator(screenedUpstreamChunks());
// every consumer: the listener, and a peer's listener across the network
for await (const chunk of iterateBytesReader(reader, { buffer: 64 })) {
  write(chunk);
}
```

- The echo screen works on decoded text and holds back a possible credential
  prefix, cutting on surrogate boundaries. It stays on the producer side; its
  output is encoded to bytes again before it is wrapped.
- **The producer caps read-ahead.** In exo-stream the consumer grants credit,
  and the responder's only limit is `MAX_CREDIT` of 65,536, so a remote
  holder could ask for far more than 64. The subscription serves through a
  pump that honours at most 64 outstanding chunks whatever the consumer
  grants.
- The transport caps a chunk's size, so 64 chunks have a known ceiling beside
  the existing response byte limit, and `iterateBytesReader`'s
  `stringLengthLimit` is set from that cap. Base64 adds a third; the cap
  accounts for it. This bounds retained state; it is not a lifetime limit.
- The upstream fetch body is a pull source, so backpressure still reaches the
  provider connection.
- **An abandoned reader.** A consumer that stays connected and stops pulling
  holds an admission slot and an upstream connection until the request
  deadline (`requestTimeoutMs`, 120 s by default, 600 s at most).
  Closing the pump, revoking the endpoint and revoking a share all cancel the
  upstream request and release the slot, and the reservation stands as the
  charge.
- A share does not re-pump: it returns the subscription's reader, and charges
  from `usage`. One pump and one buffer per response.
- The request direction stays a single call. The pipe link caps a frame at
  8 MiB; the peer connection's limit has to be checked against long-context
  request bodies.

### Durability

| State | Where it lives | Pattern already in the code |
|---|---|---|
| each member's credential | Secrets (`SecretBlob`) | as today |
| a pool's set: members, labels, weights, account pins, declared cache lifetime, declared order | a stored **value** in the pool formula's namespace | the oracle's `account-profile` |
| latest reading per member, including blocked-until | append-only journal, a unique name per version, old versions pruned by `keep` | the oracle's snapshot journal, with write-on-change added |
| a session's choice, `auto` or pinned | Floot's session registry entry | `promptContext` |
| which member a session last used, with a coarse time | pool record, written on change; **removed when the session is destroyed or the member leaves the set** | new |
| a share's limits, `expiresAt` and **revocation** | stored value in the share formula's namespace | `account-profile` |
| a share's meter, including open reservations | journalled in steps | new; conservative on revival |
| a delegated runner's id namespace, slot and storage allowances | stored value in the runner attenuation's namespace | `account-profile` |
| Codex reset redemption | an intent record holding the idempotency key, written before the call | the OAuth refresh intent, with differences below |
| serving member and context occupancy | the turn journal's finish record, which has a fixed key list and gains two keys | `servedBy` |
| handover notices | a turn journal event of their own kind, replayed into the transcript | new record kind |
| pool, subscription, share, oracle, runner identity | `make-unconfined` formulas, revived by their pins | as today |

- **The set is a value, not environment.** Codex's setup refuses a retained
  service whose environment changed and demands retirement, which stops every
  session; Claude's refuses a changed credential kind or image pin and
  OpenCode's a changed image pin, and both otherwise keep the retained
  configuration silently.
  Neither is a way to add an account.
  Adding a member is a write of a value and a secret.
  Changing the account pin of an existing member stays refused: add a member.
- **Readings are written on change**, through the oracle's new `push`. Only
  live readings are written.
- **A share's meter cannot be refilled by a restart.** It is journalled every
  so many tokens; on revival the unrecorded step and every open reservation
  are assumed spent.
- **Revocation survives.** A revoked or expired share revives revoked.
- **The reset intent is surfaced, then replayed on request.**
  The consume call accepts the same idempotency key again and answers
  `alreadyRedeemed`, so, unlike an OAuth refresh, replay is safe.
  But a replay is a provider call and may be the call that redeems, so it
  happens neither at boot nor on a refresh: an unresolved intent shows as
  "redeeming, unconfirmed"; a refresh resolves it only by reading the
  credit's `status` from the usage read; and the consume call is replayed,
  with the stored key, only when the operator redeems again.
  The intent lives in the subscription formula's own store and has a single
  writer, so it does not need the generation-checked write the OAuth intent
  gets from the secret record.
- **Not durable, on purpose:** watchers, in-flight requests, cache-warmth
  timers. A viewer resubscribes and receives a snapshot first.

### Dormant after restart

Nothing here calls a provider at boot: not a status read, not an intent
replay, and `observe()` never touches the network.
Readings show as `remembered` until the first request or a view's refresh.
A member remembered as blocked stays skipped until its recorded reset time,
so a restart cannot make the pool retry a drained account.

## Dependencies

| Design | Relationship |
|---|---|
| [hosted-agent-broker-oauth](hosted-agent-broker-oauth.md) | The credential, its refresh and the 401 retry seam this design extends. Revises its decision that one boolean crosses the transport seam: a second classification and a numeric header projection now do. |
| [hosted-agent-sandbox-unification](hosted-agent-sandbox-unification.md) | Shared session owner, revocable grants and the listener runtime; this design moves listener ownership from the grant issuer to the runner. |
| [daemon-secret-manager](daemon-secret-manager.md) | Storage of each member's credential. |
| [buffered-channel-exo-stream-consolidation](buffered-channel-exo-stream-consolidation.md) | The stream primitives the response path moves onto. |

## Phased Implementation

1. **Usage and context.** Extend the `usage` event through every file listed
   under "Context occupancy"; fix the Claude undercount; show occupancy in the
   session watch stream.
2. **Readings.** Header tap in the transport, run before the served check;
   percent-only windows, credits and reset credits in `account.js`; the
   oracle's `push` and write-on-change; one oracle per subscription;
   OpenRouter's active source.
3. **Subscribing.** `watchAccounts()` and the view's status display.
4. **Bytes exo-stream** for the provider response, with the producer-side cap
   and `buffer: 64`.
5. **Pool.** The descriptor validator learns `providerId` and `subscriptions`
   first. Then `Subscription` as a public capability with `openEndpoint`,
   `usage` and `watchServing()` on the endpoint, and the `serving` turn event;
   listener ownership moves to the runner; the pool as credential resolver;
   the set as a stored value; the selection rule; `subscription` in
   `createSession` and the picker; label binding for Claude and OpenRouter.
6. **Handover.** The exhausted classification and per-member attempts;
   notices as a journal record kind; the two-account test for encrypted
   reasoning items.
7. **Codex reset credits**, with the stored intent.
8. **Shares.** `attenuate`; wrapped members and `hops`; reserve-then-settle; the
   journalled meter; durable revocation; the share-exhausted classification.
9. **Delegated runner.** Id namespacing, slot and storage allowances, network
   default, the storage bound; remote workspace over 9P; acceptance over a
   real peer connection.

Phases 1 to 4 are useful with the single subscriptions a deployment has now.

## Design Decisions

1. **Headers over polling.** Both subscription providers report usage on every
   inference response, so status costs no extra requests and needs no extra
   scope. Active reads are the exception, not the mechanism.
2. **Selection lives in the pool, per request.** A turn is many requests; only
   something in the request path can hand over mid-turn, and the pool already
   holds every credential.
3. **Drain by nearest reset, not by most or least remaining.** Unused
   allowance is what expires. Least remaining only breaks ties.
4. **Stay while warm.** A move costs a full-context uncached read, and a cold
   move costs nothing, so the rule re-chooses only when the cache is already
   gone or the member refuses.
5. **One backend and one pool per provider.** A second backend instance per
   account would make every move a thread rotation.
6. **For local members the pool resolves credentials inside one request.** A
   member's held upstream request carries its account's headers, so it cannot
   be replayed under another. Wrapped members are handed over between, which
   works because classified refusals cross the `Subscription` seam.
7. **The subscription set is a stored value.** No adapter's setup offers a way
   to add an account to a retained service.
8. **Share and pool are subscriptions.** One interface lets a peer nest a
   share in their own pool, and makes handover work across the boundary.
9. **Two capabilities for delegation, and the runner owns the listener.**
   Runner and subscription combine to cover a harness on either machine
   against either party's account, and a peer's credential never has to enter
   the operator's Secrets. A subscription that started listeners could only
   serve its own host.
10. **Budgets in weighted tokens over a fixed period; reserve in percent.**
    Tokens are what Endo can meter exactly and a fixed period is defined for
    every kind of subscription; percent is what the provider publishes and is
    enough for a floor.
11. **The subscription settles usage; nobody re-pumps.** One pump and one
    buffer per response, and every layer can still charge.
12. **Reset credits are an operator action.** They are scarce and expire; the
    view shows them and a person redeems them.
13. **More than one boolean crosses the transport seam.** A second bare
    classification and a parsed, numeric projection of named headers. Text
    from the upstream still never crosses.
14. **Nothing calls a provider at boot**, matching agents that stay dormant
    after a restart until a message arrives.

## Known Gaps and TODOs

- [ ] Capture Claude's response to an exhausted subscription and confirm the
      header that tells exhaustion from throttling. Gates phase 6 for Claude.
- [ ] Test with two ChatGPT accounts whether encrypted reasoning items replay
      under another account. Gates phases 5 and 6 for Codex.
- [ ] Confirm on a live Codex turn that cached input is a subset of
      `inputTokens` and reasoning a subset of `outputTokens`, and whether
      cache-write tokens are inside `inputTokens`. Gates part of phase 1.
- [ ] Check whether Claude Code emits several `assistant` events for one API
      message; only the last one's usage is read.
- [ ] Confirm whether a `claude setup-token` credential can read
      `/api/oauth/usage`.
- [ ] Establish from OpenAI's own documentation which windows a reset credit
      clears, and credit expiry. Gates phase 7.
- [ ] Make one live redeem of a Codex reset credit, to confirm the consume
      call's request fields and the name of the response field that carries
      the outcome (`codex-reset-credit.js`, "TO CONFIRM ON A LIVE REDEEM"),
      and whether a redeemed credit stays listed as `redeemed`. It spends a
      real credit, so it is the operator's to choose when. Gates use of
      phase 7.
- [ ] Find an account identity to bind a Claude member's label to. Phase 5.
- [ ] Measure a streamed response over a real peer connection, and find that
      connection's frame limit. Gates remote use of phase 4, and phases 8
      and 9.
- [ ] Hand a share to a second daemon over a real peer connection and serve a
      request through it: that the bytes reader, the `usage` promise and the
      endpoint survive the hop, and what a lost connection does to a
      reservation. Gates use of phase 8.
- [ ] Confirm the three response shapes `provider-usage.js` reads against live
      streams, in particular whether Codex's `response.completed` always
      carries `usage` for a ChatGPT subscription. Gates a share's budget
      meaning what it says.
- [ ] Find what CPU and memory limits slices have before delegating a runner.
      Gates phase 9.
- [ ] Decide the per-session storage bound a delegated runner requires.
      Gates phase 9.
- [ ] Hosted sessions do not get the `accountStatus` tool
      (`ACCOUNT-ORACLE.md`); unchanged by this design.
- [ ] `openrouter/free` changes model per request, so its context window and
      cache behaviour are unstable until routing is constrained.
- [ ] Move Floot's own provider path onto `Subscription`.

## Prompt

The operator's prompts, in order, over one session on 2026-09-20:

> next i want to look at subscription balance query mechanisms, subscription
> reset dates, available manual subscription resets (codex), support for
> multiple subscriptions

> we'll want the sub status state to be subscribeable for ui render.
> for multiple subs, eg 2 codex subs, we'll want to be able to manually select
> which subscription but have a smart default that picks that largest sub
> (most remaining) for the selected provider

> [on when selection applies] we should probably make this decision informed
> by the model provider APIs caching design

> a correction on the subscription routing, we actually want to pick the one
> with the least remaining or perhaps the nearest reset date, so that we drain
> a subscription before it expires. we'll want to smoothly transition off a
> subscription that is drained during a turn

> when building the implementation we want to make sure everything that should
> survive a daemon restart is durable in accordance with the endo formula
> coding patterns. we'll also want context size information (what percent
> occupied of the limit) from the backend

> an additional design requirement is being able to pass a capability to a
> remote that allows them to spawn an agent and work on their own project.
> this might mean passing a reference to the multi subscription provider, or
> passing a backend runner so they can spawn harnesses that run on tokyo
> against my subscription or their subscription. when passing my subscription
> to someone, i may want to only expose an attenuated version that enforces
> its own usage limits

> when implementing we'll want to use exo-stream configured with a non-zero
> buffer (eg 64) to reduce roundtrips

> there is a binary stream implementation, bytesWriterFromIterator and friends
>
> ok lets commit all of this to a design doc
