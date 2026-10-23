# API-key inference providers and pinned guest agents

| | |
|---|---|
| **Created** | 2026-10-23 |
| **Updated** | 2026-10-23 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |
| **Parent** | [Course correction after `claude --bare` rejected subscription credentials](claude-bare-course-correction.md) |
| **Grounded against** | `endojs/endo-but-for-bots` `llm` at `d5ac41980a`; `kriscendobot/minion.town` `main` at `68c3960bbe` |

## Summary

"Add agent" is a two-step workflow, even when presented as one short wizard:

1. import an API key and create a reusable **inference provider**; then
2. create a named **guest agent** attached to a selected provider and harness.

The key becomes a host-held `SecretBlob` behind a provider broker. The agent
holds neither the key nor the `SecretBlob`; it receives a per-agent inference
facet and its own attenuated guest powers. A daemon-pinned responder wakes the
agent on mail. Provider creation is driven by an explicit minion.town UI action,
not by an unsolicited form message. Every provider is owned by exactly one
principal, and a provider id means nothing outside its owner's directory.

## Existing substrate and harness choice

The existing Lal/Fae form design and implementation are useful but not the UI
contract. [`packages/fae/llm-provider-factory.js`](../packages/fae/llm-provider-factory.js)
calls the daemon secret manager and stores only `authSecretName` in provider
configuration. Its validation is narrow: it checks that an OpenRouter host has
an organization-qualified model and that a referenced secret exists, but it does
not validate provider name, host, or model in general. Its own comment also
records the defect this design must avoid: a daemon form submission is durable
before the factory processes it, so a typed raw token remains in the form
message. Reuse its `SecretBlob` binding, per-turn reread/rotation in
`packages/fae/src/provider-owner.js`, and tagged error behavior. The provider
registry adds the general field validation itself (phase 1): display-name
length and characters, kind from a closed set, base URL from the kind's
allowlist, and model from the kind's catalog. Do not reuse the unsolicited form
transport or persist the raw submission.

Harnesses present on `llm` are:

| Harness | Fit for this UI | First release |
|---|---|---|
| **Lal** (`packages/lal/`) | Pi-based agent with a static, capability-derived tool set and direct provider adapters. It has the smallest familiar-agent path. | **Yes; default.** |
| **Fae** (`packages/fae/`) | Dynamic capability tools, durable conversation tree, provider ownership, and `SecretBlob` integration already exist. | **Yes; advanced choice.** |
| **Floot** (`packages/floot/`) | Durable streaming sessions, UI turns, subagents, and provider/hosted backends. It is broader than a mailbox-pinned guest and currently carries voice/session policy. | Not initially; add only with a Floot-specific powers profile. |
| **Jaine** (`packages/jaine/`) | Channel-participation router/composer/executor, not a private mailbox bot. | No; expose later as a channel-agent product. |
| **Agentry** (`packages/agentry/`) | Shared harness construction and code-mode substrate, not a user-facing persona. | Reuse internally; do not list as a harness. |

`@endo/genie` is not an alternative: it was retired on `llm` by commit
`42bc7d5161`. The first UI therefore lists exactly `lal` and `fae`, recommends
Lal, and can grow from a server-supplied harness catalog later.

## User experience

The signed-in guest page adds one **Add agent** button. It opens a two-step
dialog; Back never resubmits a secret.

In plain terms, a user makes two choices: which paid API key pays for the
agent (the provider), and which agent program runs (the harness), plus the
agent's name and limits. The user does not choose what the agent is allowed
to do. Each harness comes with a fixed list of permitted actions, its *powers
profile*, such as reading and sending its own mail; § Confinement and
wake-on-message gives the full list. A setting that grants extra powers
(called *endowments* in the Chat wizard) therefore has nothing to offer here.

This dialog is the minion.town presentation of the same three layers as the
canonical Chat **Add agent** wizard in
[`chat-inventory-create-menu.md`](chat-inventory-create-menu.md) § Three-pane
wizard, not a competing workflow. Step 1 is that wizard's *inference source*
pane; step 2 combines its *harness* pane with the bot name, and the
*endowments* pane is fixed by the harness's powers profile (§ Confinement)
rather than chosen. Both surfaces submit to the same agent factory with the
same fields. When the Chat wizard adopts API-key providers, its inference-source
pane lists the owner's providers through the same directory facet; until then,
Chat's wizard does not offer them. The minion.town label stays **Add agent**
because it opens the same operation.

### Step 1: create or choose an inference provider

The page first lists the user's active providers by non-secret display name,
provider kind, default model, spend summary, and status. Before the first
agent is created, the step states that the key's owner pays the upstream
provider and that the caps below apply per provider, not per upstream
account (§ Cost and abuse controls). The user may select one
or choose **New provider**, which asks for:

- provider name;
- provider kind (`Anthropic` first; `OpenAI-compatible` only when its base URL
  allowlist and response adapter ship);
- API key in `<input type="password">`;
- default model; and
- base URL only for a supported non-default provider kind.

Submit performs one authenticated HTTPS `POST` with the key and a
client-generated idempotency key in the body. The client clears the field
synchronously before awaiting the response. The request
uses no query string, URL fragment, analytics capture, service-worker cache, or
client persistence. Server access logs record only route, status, duration, and
request size; application errors are fixed codes. The response contains the new
provider id and safe summary, never the key, a prefix, a hash, or secret-store
locator. This applies the non-echo rule from minion.town
[#195](https://github.com/kriscendobot/minion.town/pull/195) to credentials.

### Step 2: create the agent

After provider selection, the page asks for:

- bot name;
- harness: `lal` (recommended) or `fae`;
- model, chosen from the provider's safe catalog or its default;
- **Wake on messages**, on by default and changeable later (§ Agent
  management); and
- initial spend/rate limits, initialized from deployment defaults.

Submit is a separate authenticated operation containing only provider id,
harness, bot name, model, limits, and an idempotency key. The provider id is
resolved only through the signed-in owner's provider directory (§ Ownership and
cross-principal denial). Success adds the agent to the guest's inventory.
Retrying the same idempotency key returns the same provider or agent; it never
creates a second spend source or responder. The provider operation in
§ Creation and retirement operations and the agent operation in § Agent
creation, wake, and deletion operations specify how that holds across crashes
and lost responses.

### Agent management

Each agent's detail view, reached from the guest's inventory, shows its
provider, harness, model, limits, wake state, and unread mail count. Its
actions are **Wake on messages** (a toggle), **Edit limits**, **Reattach
provider**, and **Delete agent**.

- **Turning wake off** pauses the agent's responder. The responder stays pinned
  with its cursor and effect records, but stops following the mailbox and
  starts no turns. New mail is still delivered to the agent's guest and stays
  unread, listed in the detail view, and dismissable there by the owner.
- **Turning wake on** resumes the responder from its stored cursor. Mail that
  arrived while paused is processed oldest first, each message admitted under
  the agent's normal limits; mail the owner dismissed meanwhile is skipped.
  Processing queued mail spends the provider's budget, so when any unread mail
  is queued the toggle first opens a confirmation: "Wake *name*? It will
  process *N* queued messages, oldest first, using *provider*." It offers
  **Process queued mail**, **Skip queued mail** (marks those messages read and
  starts from new mail only), and **Cancel**, which leaves wake off. The count
  is taken when the dialog opens; the operation records the cursor position the
  owner confirmed, so mail arriving afterwards is treated as new mail. With no
  queued mail the toggle applies immediately.
- An agent **created with wake off** has no responder until wake is first
  turned on; its mail accumulates the same way, and the first enable shows the
  same confirmation.
- **Delete agent** is irreversible and always asks for confirmation naming what
  is lost: "Delete *name*? Its *N* unread messages and its conversation
  transcript will be deleted. Usage history is kept." Deleting releases the
  agent's guest, so unread mail, the responder cursor, and the harness
  transcript are discarded with it; usage and audit rows stay in the usage
  ledger (§ Agent creation, wake, and deletion operations). The confirm button
  is labelled **Delete agent**, and focus starts on **Cancel**.

Each toggle is an idempotent agent operation (§ Agent creation, wake, and
deletion operations), so a repeated or interrupted toggle converges on the
requested state.

### Keyboard and assistive technology

The dialog follows the interaction contract of the Chat wizard in
[`chat-inventory-create-menu.md`](chat-inventory-create-menu.md) § Three-pane
wizard: `Tab` / `Shift-Tab` between fields, arrow keys within a choice list,
`Enter` on the next or submit button advances, and `Escape` cancels (with a
confirmation once any field has input). Specifically:

- **Semantics.** The dialog is a modal `<dialog>` labelled by its current step
  heading. The provider list and the harness choice are native radio groups
  with visible labels; provider kind and model are native `<select>`
  elements; every input has a `<label>`. Step position is announced as part of
  the heading ("Step 1 of 2: Inference provider").
- **Focus.** Opening the dialog moves focus to the selected provider, or to
  the first field of **New provider** when the owner has none. Advancing or
  going Back moves focus to the new step's heading. Closing, cancelling, or
  succeeding returns focus to the **Add agent** button (or to the new agent's
  inventory entry on success).
- **Validation and progress.** A field error sets `aria-invalid` and is tied to
  its field through `aria-describedby`; on submit, focus moves to the first
  invalid field. Server errors render their fixed-code message in a
  `role="alert"` region at the top of the step. While a submit is pending the
  submit button is disabled, the step is `aria-busy`, and a polite live region
  announces "Creating provider" or "Creating agent".

The Providers page and the agent detail view use the same rules for their
confirmations and limit forms.

### Provider management

A **Providers** page, linked from the guest page beside **Add agent** and from
each agent's detail view, is the standing management surface. For each of the
owner's providers, active and retired, it shows display name, kind, default
model, state, attached agents, and per-agent usage and refusals for the current
and previous budget periods. Its actions are:

- **Edit limits**: lower or raise provider caps within deployment ceilings;
  agent caps are clamped to the new provider caps on the next admission.
- **Replace key**: a guided migration, not an in-place rotation. It opens the
  same password form and creates a superseding provider. It then shows every
  agent still attached to the old provider, all preselected, and reattaches
  the selected ones (each an idempotent reattach operation). The old provider
  stays usable by any agent left unselected, and the page shows "*N* agents
  still use the old key" until none do. When none remain, it offers **Disable
  old key in Endo**, below. The label avoids "rotate" because the old provider
  is never silently changed to designate the new key.
- **Disable key in Endo**: one confirmation naming the affected agents, then
  retirement (§ "Indelible" and retirement). This stops Endo from using the
  key: every attached agent fails its next call. It does **not** revoke the key
  at Anthropic or the OpenAI-compatible service, so anyone else holding a
  leaked copy can still use it and charge the owner's account. The
  confirmation and the completed state therefore both say so and show the
  upstream step: "Also revoke this key in the provider's console", with a link
  to that kind's key-management page from the provider catalog. The provider
  row shows **Disabled in Endo; upstream revocation not confirmed** until the
  owner checks **I revoked it upstream**, which is recorded as an owner
  assertion, not verified. Endo does not call an upstream revocation API in
  the first release, because that would need provider-specific administrative
  credentials the user is not asked to supply. This is the leaked-key path; it
  does not
  require creating a replacement first.

Every action goes through the owner's `InferenceProviderAdmin` facet; none
displays or re-requests key bytes except **Replace key**'s new key.

The Lal demo's field validation, provider config, model resolution, and
manager/worker separation are reusable. Its "server sends a form to the user"
trigger is not: minion.town owns initiation, progress, cancellation, and errors.

## Provider and secret model

The durable, non-secret provider data is versioned and retained in a
root-private provider registry. It is split into an immutable descriptor and a
mutable lifecycle place, so provider identity and history are never braided
with current state:

```ts
// Written once at creation commit; never changed afterwards.
type InferenceProviderDescriptor = {
  version: 1;
  providerId: string;       // random object designator, unique per owner
  ownerId: string;          // owning principal's guest formula id
  displayName: string;
  kind: 'anthropic' | 'openai-compatible';
  baseUrl?: string;         // validated, never inferred from key text
  defaultModel: string;
  secretGrantFormulaId: string; // host-private retention edge, never in UI
  createdAt: string;
  supersedes?: string;
};

// The only mutable provider data; one per descriptor.
type InferenceProviderLifecycle = {
  version: 1;
  providerId: string;
  state: 'active' | 'retiring' | 'retired';
  limits: ProviderLimits;   // changed by Edit limits within deployment ceilings
  upstreamRevocationAssertedAt?: string; // owner's "I revoked it upstream"
  updatedAt: string;
};
```

Every change to the lifecycle place is also appended to the provider's audit
log (old value, new value, operation id, time), so history is reconstructible
even though the current-state place is overwritten. Usage lives only in the
usage ledger.

The provider's facets are separate:

- `InferenceProviderDirectory`, one per owner, minted when the owner's guest is
  provisioned and held by that owner's signed-in UI capability. It lists, looks
  up, and creates providers whose `ownerId` is that owner, and nothing else.
- `InferenceProviderAdmin`, obtained only from the owner's directory, returns
  safe summaries, sets limits, creates a superseding provider, and retires this
  provider. It cannot read key bytes.
- `InferenceProviderUse`, held only by the host-side agent factory/broker,
  creates a per-agent inference facet over a specific guest powers facet,
  harness, model, and budget. It does not vend its `SecretBlob`.
- `AgentInference`, held by one agent driver, is an `InferenceEndpoint` grant
  (§ Harness adapter boundary): it accepts bounded provider-wire requests and
  returns response bytes, with admission, credentials, and accounting applied
  by the broker. It cannot change provider, model allowlist, or spend policy.

The browser endpoint invokes provider creation on the owner's directory, which
runs the creation operation below and calls `@secrets/create` on the Endo root. The resulting
`SecretBlob` is retained by the provider broker through a lookup formula; no
minion.town database, guest formula, agent transcript, URL, log, exception,
metric, or MCP result contains the bytes. The provider adapter reads the blob
inside the host broker only for the duration of an upstream request. An
authenticated HTTP client assembled there is preferable to returning bytes to
a harness.

The store lives in the Endo host: `@secrets` owns encrypted bytes, lifecycle,
and audit; the provider registry owns non-secret interpretation; the usage
ledger owns usage (§ Ownership map).
minion.town is the UI/gateway and keeps no second durable key copy. Production
backup and encryption follow
[`daemon-secret-manager.md`](daemon-secret-manager.md). The `@secrets` catalog
is deliberately root/single-principal, so the registry, not `@secrets`, carries
ownership; secret names are registry-assigned and never shown to a principal.

### Ownership and cross-principal denial

minion.town already serves many signed-in principals from one Endo root, so
ownership partitioning is a phase 1 requirement, not a later multi-tenant
extension.

- **Owner binding.** `ownerId` is set from the directory that runs creation and
  is never taken from a request field. No API changes it; **Replace key** creates the
  superseding provider in the same owner's directory.
- **Selection is capability lookup.** A provider id is a name inside one owner's
  directory, not a global designator. The app resolves it as
  `E(directoryOfSignedInPrincipal).lookup(providerId)`; it never calls a
  root-wide registry lookup on a request's behalf. The root-private registry
  facet that can see every owner is held only by the directories and the
  recovery reconciler.
- **Denial semantics.** Lookup of an id that is unknown or owned by another
  principal returns the same fixed
  `provider-not-found` error with the same timing class, so a caller cannot use
  it as an existence oracle. Listing returns only the owner's records. Usage
  and audit rows are readable only through the owner's admin facets.
- **Agent binding.** The agent factory accepts an `InferenceProviderUse` only
  from the same directory as the target guest's owner; a use facet and a guest
  with different owners are refused with `provider-owner-mismatch` before any
  guest or responder is created.
- **Sharing.** Cross-principal sharing is out of scope for the first release.
  If added later, it must be an explicit attenuated grant from the owner's
  admin facet, never an id another principal can name.

### Creation and retirement operations

Provider creation and retirement span two independently committed stores
(`@secrets` and the registry), so the provider registry is the single
coordinator for both, and each runs as a durable operation record in the
registry. The secret manager is a participant; the app holds only an
idempotency receipt pointer.

```ts
type ProviderOperation = {
  version: 1;
  operationId: string;      // random; also derives the registry-assigned secret name
  ownerId: string;
  idempotencyKey: string;   // client-supplied, scoped to ownerId
  kind: 'create' | 'retire';
  providerId: string;       // preallocated before any external effect
  request: SafeProviderFields; // display name, kind, base URL, model, limits; never key bytes
  state: 'intent' | 'secret-created' | 'committed' | 'aborted';
  updatedAt: string;
};
```

Creation proceeds through these commit boundaries:

1. **Intent.** The registry atomically checks `(ownerId, idempotencyKey)`. If a
   committed operation exists with the same safe fields, it returns that
   provider; with different fields, it returns `idempotency-conflict`. If an
   uncommitted operation exists, it resumes it. Otherwise it writes a new
   `intent` record with a preallocated `providerId` and secret name.
2. **Secret.** The registry calls `@secrets/create` under the preallocated name.
   If that name already exists, the earlier attempt reached the secret manager,
   and the existing blob is kept; the retry's key bytes are discarded. The
   registry then records `secret-created`.
3. **Commit.** The registry writes the provider descriptor and its `active`
   lifecycle and marks the operation `committed` in one registry transaction.
   Success means this commit; the response follows it.

Crash and retry behavior at each boundary:

- Crash before the intent record: nothing exists; a retry starts fresh.
- Crash after intent, before the secret: the retry resumes at step 2 with the
  retried key bytes. Without a retry, recovery aborts the operation after its
  expiry and no secret exists.
- Crash after the secret, before `secret-created`: recovery finds the
  preallocated name in `@secrets` and records `secret-created`.
- Crash after `secret-created`, before commit: recovery or a retry performs
  step 3 without needing key bytes.
- Lost response after commit: a retry with the same idempotency key returns the
  committed provider; the client never creates a second provider.

On daemon start and periodically, a registry-owned reconciler scans
uncommitted operations. It drives `secret-created` operations to commit. It
aborts `intent` operations older than the retry window (default 24 hours),
revoking the preallocated secret if it exists. It also revokes any
registry-named secret that has no operation or provider record. An operation in
`intent` or `secret-created` is visible to its owner as `provider creation in
progress`, never as an active provider.

Retirement uses the same record with `kind: 'retire'`. The registry first sets
the provider to `retiring`; from that commit, admission refuses new and queued
turns. It then revokes the `SecretBlob` and finally sets `retired`. Recovery
drives any `retiring` provider forward to `retired`, so the registry can never
show an `active` provider whose secret is already revoked.

### Agent creation, wake, and deletion operations

Agent creation spans three stores: the Endo root's guest formulas, the provider
registry's per-agent inference grants, and the new guest's `@pins` and
inventory names. The **agent factory** is the single coordinator. It owns a
root-private agent registry holding the durable `AgentRecord` (agent id, owner,
guest formula id, provider id, harness, model, limits, desired wake state,
lifecycle state) and an operation record for every change; the guest, the
provider registry, and the responder are participants that each make one
idempotent, name-keyed effect.

Wake state has one owner. `AgentRecord.wakeState` is the **desired** state and
is authoritative. The responder's paused/running flag is only the **applied**
state, a cache the factory drives toward the desired state and never reads as a
source of truth. Every operation that changes wake, including creation, ends
with an *activation* step that applies the desired state to the responder, and
the operation is not finished until that step is recorded.

```ts
type AgentOperation = {
  version: 1;
  operationId: string;      // random; derives every preallocated name below
  ownerId: string;
  idempotencyKey: string;   // client-supplied, scoped to ownerId
  kind: 'create' | 'set-wake' | 'delete';
  agentId: string;          // preallocated before any external effect
  request: SafeAgentFields; // provider id, harness, bot name, model, limits, wake
  state:
    | 'intent'
    | 'guest-created'
    | 'inference-bound'
    | 'responder-ready'
    | 'named'
    | 'committed'   // AgentRecord written; activation still pending
    | 'completed'   // desired wake state applied to the responder
    | 'aborting'
    | 'aborted';
  updatedAt: string;
};
```

Creation proceeds through these commit boundaries. Each step's effect is keyed
by a name preallocated at intent, so repeating a step finds its earlier effect
instead of making a second one.

1. **Intent.** The factory atomically checks `(ownerId, idempotencyKey)` as
   provider creation does: a completed match returns the agent, a mismatch
   returns `idempotency-conflict`, an unfinished match resumes. It resolves
   the provider through the owner's directory and checks the owner match
   (§ Ownership and cross-principal denial), reserves the bot name in the
   owner's agent registry (`agent-name-conflict` if another live agent holds
   it), and writes `intent` with a preallocated `agentId`, guest name,
   inference grant id, and responder name.
2. **Guest.** The factory asks the Endo root to provide the guest under its
   preallocated, root-private name; an existing guest under that name is the
   earlier attempt's. It records `guest-created`.
3. **Inference.** The factory asks the provider's `InferenceProviderUse` for the
   agent's grant under the preallocated grant id; the registry returns the
   existing grant for a known id. It records `inference-bound`.
4. **Responder.** With wake on, the factory pins the responder formula under its
   preallocated name in the guest's `@pins`, in the paused state; with wake off,
   it skips this effect. It records `responder-ready`.
5. **Name.** The factory writes the bot name into the owner's inventory,
   designating the agent. A name already designating this agent is accepted.
   It records `named`.
6. **Commit.** The factory writes the `active` `AgentRecord`, with the desired
   wake state, and marks the operation `committed` in one agent-registry
   transaction. From here the operation can only roll forward.
7. **Activate.** The factory applies the desired wake state: it unpauses the
   responder when wake is on and leaves it paused (or absent) when wake is off.
   Unpausing an already running responder is a no-op. It then records
   `completed`. Success means `completed`; the response follows it.

No step after intent needs anything the client holds, so recovery always rolls
forward. On daemon start and periodically, a factory-owned reconciler resumes
every operation that is neither `completed` nor `aborted`, including
`committed` ones, from its recorded state. It also sweeps every `active`
`AgentRecord` and reapplies its desired wake state to the responder, so an
applied state that drifted for any reason (a lost unpause, a restored
backup) converges. Crash and retry behavior:

- Crash before intent: nothing exists; a retry starts fresh.
- Crash after any later boundary, or between an effect and its state record:
  the retry or the reconciler repeats the next step, which finds the earlier
  effect by its preallocated name and records the state.
- Crash after commit, before activation: the reconciler or a retry with the
  same idempotency key performs step 7, so a committed wake-enabled agent is
  never left paused. A retry does not return success until step 7 completes.
- Lost response after completion: a retry with the same idempotency key returns
  the completed agent.
- A step before commit that fails permanently (provider retired or not found,
  owner mismatch, name conflict, guest creation refused) sets `aborting`. The
  factory then undoes the effects already made, in reverse order: it removes the
  inventory name if this operation wrote it, unpins the responder, disposes the
  grant, and releases the guest. Then it records `aborted` and returns the
  fixed error. Recovery drives `aborting` to `aborted` the same way. Activation
  cannot abort the operation: a responder that fails to start is retried by the
  reconciler and shown to the owner as `waking`.

Until commit the owner sees the agent as `agent creation in progress`, and no
responder runs a turn, so a crash can never leave a running agent without an
`AgentRecord`.

**Wake toggles** (`kind: 'set-wake'`) follow the same desired-then-applied
order. The factory first commits the new desired wake state to the
`AgentRecord` (with the confirmed queued-mail cursor when enabling, § Agent
management), then pins the responder (on first enable), unpauses, or pauses
it, and records `completed`. The reconciler finishes a toggle interrupted after
its commit, and its sweep reapplies desired state for any agent.

**Deletion** (`kind: 'delete'`) first commits the `AgentRecord` as
`deleting`, from which the grant refuses new turns. It then cancels any
in-flight turn, unpins the responder, disposes the grant, removes the
inventory name, and releases the guest, which discards its unread mail and the
harness transcript, and finally commits `deleted`. Recovery drives `deleting`
forward. Usage and audit rows for the agent remain in the usage ledger.

### "Indelible" and retirement

Indelible means a created provider's identity, audit trail, and historical
agent/usage references are append-only through the product API. It does **not**
mean a leaked key must remain usable, and it does not mean nothing about a
provider ever changes.

- The provider descriptor is never overwritten in place. Only the lifecycle
  place mutates (`state`, `limits`, and the upstream-revocation assertion), and
  every mutation is appended to the audit log (§ Provider and secret model).
- **Replace key** creates a new secret and provider descriptor whose
  `supersedes` points to the prior provider; agents move only by an explicit
  reattachment.
- Retirement marks the provider `retiring`, revokes the old `SecretBlob`, then
  marks it `retired` (§ Creation and retirement operations). New and queued
  turns fail closed from the first step. The old provider id and audit rows
  remain so historical spend is intelligible.
- The ordinary product UI never calls `SecretAdmin.delete`. An operator may
  crypto-delete revoked backend material under the secret-manager's recovery
  procedure, but does not erase the non-secret tombstone or audit history.

This is revocation by supersession, not "no deletion ever." It lets a user
stop Endo using a leaked key immediately without rewriting history or silently
changing what an existing provider capability designates. Retirement is local:
the upstream key stays valid until the owner revokes it in the provider's
console (§ Provider management).

### Relation to the existing hosted provider broker

The per-agent facets adapt the existing hosted-agent broker rather than add a
parallel one. `InferenceProviderUse` is a thin wrapper that constructs one
`makeProviderBrokerGrantIssuer` (`packages/hosted-agent/src/provider-grant-issuer.js`)
per active provider record. Its `secret` is the provider's `SecretBlob`, its
`policy` comes from the provider kind and base URL, and its `audit` and
`onReading` feed the usage ledger. `AgentInference` wraps one grant from that
issuer, scoped to one agent's model allowlist and caps.

`makeOwnedProviderBrokerService` (`packages/hosted-agent/src/provider-broker-service.js`)
is not reused directly. It owns one operator profile read from persisted
operator configuration and serves container slices through a loopback
listener. Here, providers are user-imported records (many per deployment), and
Lal and Fae run in-process. The design needs one registry-driven issuer per
record, not one operator-configured service. The issuer already returns its
endpoint as an in-process `InferenceEndpoint` exo; phase 1 confirms that it
serves requests without the slice listener. If it cannot, the gap is closed by
extending the issuer, not by forking a second broker.

### Harness adapter boundary

The issuer's grant surface is an `InferenceEndpoint`
(`InferenceEndpointInterface` in `packages/hosted-agent/src/subscription-share.js`):
`request(message)` and `requestByteStream(message)` over a provider-wire
message `{ method, path, body }`. Neither first-release harness consumes that
today. Lal builds a Pi agent around a `getApiKey` callback
(`packages/lal/agent.js`), and Fae's `makeProviderOwner` reads a `SecretBlob`
per turn and builds a local keyed provider (`packages/fae/src/provider-owner.js`).
Both would hold key bytes. The bridge is a capability-backed provider adapter
that follows the existing precedent
`makeSubscriptionResponsesProvider` (`packages/lal/providers/subscription-responses.js`),
which already drives `E(endpoint).requestByteStream` with no URL or credential
in the harness and which Fae already accepts as its `subscription-responses`
provider kind.

- **Adapter.** Add `makeBrokeredMessagesProvider` to `@endo/lal/providers`. It
  takes an `AgentInference` remotable and a model, and speaks the Anthropic
  Messages wire format (an OpenAI-compatible sibling ships with that provider
  kind). It translates the harness's messages and tool schemas into a Messages
  request body, parses the server-sent-event byte stream into the same events
  and result shape that the direct `anthropic.js` adapter yields, and surfaces
  the stream's usage events. Its requests carry no `x-api-key`,
  `authorization`, or base URL. The issuer refuses a request that carries any
  of them and adds the credential itself.
- **Fae.** `makeProviderOwner` accepts a new provider kind `brokered-messages`
  whose recipe holds the `AgentInference` capability in place of
  `authSecretName`. Like `subscription-responses`, it takes no
  `provideAuthToken`, so Fae never reads a `SecretBlob`.
- **Lal.** For a brokered agent, `spawnWorkerLoop` passes `makePiAgent` a
  `streamFn` built over the same adapter (`packages/agentry/src/harness/pi-agent.js`
  already accepts one) and supplies no `getApiKey`; `LAL_AUTH_TOKEN` and
  ambient `*_API_KEY` variables are absent from the worker environment.
- **Lifecycle and revocation.** Each model call opens one request on the grant.
  The issuer checks grant and provider state per request, so retirement fails
  the agent's next call with a fixed `provider-retired` error, not its next
  provisioning. Deletion disposes the grant, after which every call fails
  with `agent-deleted`.
- **Accounting.** The issuer's `onReading` and `audit` hooks write
  reservations and settlements to the usage ledger (§ Cost and abuse
  controls). Usage the adapter reports to the harness is informational and is
  never a billing input.
- **Cancellation.** A harness abort (Pi's `AbortSignal`, Fae's turn
  cancellation) closes the byte-stream iterator. The issuer then cancels the
  upstream request and releases the admission slot, and settlement charges the
  reservation if no usage arrived.

The agent factory refuses a harness configuration that contains
`authSecretName`, `authToken`, `getApiKey`, or a provider other than
`brokered-messages`, so neither harness keeps a direct-key path for an agent
created by this flow.

## Confinement and wake-on-message

Agent creation asks the Endo root to create one dedicated guest. The factory
derives the powers facet from that guest, never from the root host, and gives the
harness only the methods its declared profile needs:

| Capability | Lal | Fae | Constraint |
|---|---|---|---|
| Own pet-store list/lookup/rename/remove | yes | yes | Resolves only within this guest; no `@endo` or `@secrets` |
| Own mail follow/list/send/dismiss/adopt | yes | yes | Send only through capabilities/pet names the guest holds |
| Own form/request/evaluation mediation | Lal only | no by default | Evaluation remains host-mediated; no ambient host facet |
| Dynamic tool adoption | no | yes | A tool must arrive as a capability attachment; discovery grants nothing |
| Per-agent inference | yes | yes | Fixed provider, model allowlist, limits, and guest projection |
| Root provider admin, raw secret, sibling guest lookup, deployment/network/filesystem | no | no | Not present, not checked by identity |

The agent driver receives a `GuestPowers` facet produced at guest creation and
an `AgentInference` facet minted for that exact guest. A caller cannot supply a
formula id to redirect either facet. Harness tool catalogs are derived from the
held facet, not from an account role or caller identity.

With **Wake on messages** enabled, creation reuses minion.town #165's pattern:
an inbox-responder formula is retained in the new guest's `@pins`, stores its
cursor and effect-dedup records, and follows only that guest's mailbox. A message
acquires the provider's per-agent slot, runs one bounded turn, records the
effect, and dismisses only after the reply is durably sent. Restart revives the
pinned responder; duplicate delivery consults the effect record. Deletion
cancels an in-flight turn before releasing the guest and responder.

If a loopback bridge is needed, its bearer is a random, revocable designator for
that one responder or inference object. Possession authorizes calls to that
object; it does not denote the OAuth subject or authenticate an identity. This
bearer test was settled during minion.town
[#180](https://github.com/kriscendobot/minion.town/pull/180) and recorded by
[#203](https://github.com/kriscendobot/minion.town/pull/203). A bearer derived
from guest id, account subject, or provider name is forbidden. Prefer direct
Endo capabilities where no bearer is needed.

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
|---|---|---|---|---|---|
| UI -> provider endpoint | Password POST and safe summary response | Signed-in guest may create within quota, only in its own directory | None in UI; idempotency key in app | Registry operation commit decides success | Key in request only; safe provider summary back |
| Provider registry -> `@secrets` | Retained `SecretBlob` lookup formula | Provider admin chooses create/supersede/retire | Secret manager owns bytes/audit; registry owns metadata and operation records | Registry coordinates each create/retire operation; secret manager commits/revokes bytes as a participant; registry reconciler recovers | Secret capability inward; no bytes or admin facet outward |
| Provider broker -> agent | Per-agent `AgentInference` facet | Broker enforces model, spend, rate, concurrency | Usage ledger per provider and agent | Broker admits, cancels, and releases turns | Bounded prompt/result/usage |
| Agent factory -> guest, grant, responder | Agent operation records in the agent registry | Owner creates, toggles wake, and deletes | `AgentRecord` and agent operation records | Factory coordinates create/wake/delete; guest, registry grant, and responder commit their effects as participants; factory reconciler recovers | Preallocated names inward; agent summary outward |
| Guest -> responder -> harness | Pinned mailbox subscription over one guest facet | Wake state set through the factory | Guest formula, responder cursor/effects, harness transcript | Endo revives; responder commits mail effect | Message plus explicitly held guest capabilities |

Persistent state has one owner per datum: `@secrets` owns key material; the
provider registry owns provider lifecycle, ownership, and provider operation
records; the agent factory's registry owns agent lifecycle and agent operation
records; the usage ledger owns accounting; and the guest owns mail/responder
state. The usage ledger is the single source of truth for usage, reservations,
and settlements: the broker is its only writer, admission and the Providers
page read it directly, and no other store keeps a usage projection that would
need rebuilding. The provider admin owns retire; the factory owns agent
create/wake/delete; the broker owns per-turn admit/discard. Endo owns
formula restart/replay. The harness owns
execution classification, while the broker owns retry/spend policy. Inner
types use provider, turn, result, and grant; none are named for outer commit,
replay, or persistence policy.

## Cost and abuse controls

The key owner pays the upstream provider. Before first agent creation the UI
says so plainly and shows the provider name and configured limits. The provider
page reports per-agent calls, input/output/cache tokens when returned, estimated
cost when the catalog has pinned prices, refusals, and reset times. Unknown cost
is displayed as unknown, never zero.

Every provider has a concurrent-turn cap, request-rate bucket, daily token or
dollar budget, model allowlist, maximum turns, wall clock, and output bytes.
Every agent receives equal or smaller caps. Admission is atomic at the broker;
over-limit work is refused before reading the secret or calling upstream.
Cancellation and agent deletion release the slot and terminate streaming work.

**Aggregation scope.** Every cap is enforced per provider record and per agent.
It is not an upstream-account cap. Endo cannot tell whether two provider
records hold the same API key or two keys on the same upstream account: it
does not compare key bytes, and storing a key fingerprint for comparison would
add a durable key derivative this design otherwise avoids. Importing one key
into two providers therefore gives two independent sets of caps, while the
upstream account is charged for both. The first release narrows the guarantee
to match: the Providers page and the step 1 notice state that caps apply per
provider, that the same key imported twice is capped twice, and that the
provider-side spend limit is the only account-wide bound. A per-owner
aggregate cap across all of an owner's providers is open question 7.

Budgets are enforced by **worst-case reservation and settlement**, because
output usage and final charges are unknown at admission:

- **Reservation.** Admission counts input tokens with the provider's tokenizer
  or a conservative byte-based upper bound. It sets the upstream `max_tokens` to
  the agent's per-turn output cap and reserves
  `input bound + max output + cache-write bound` tokens. For a dollar budget, it
  reserves those tokens at the model's pinned catalog price. A turn whose
  reservation does not fit the remaining budget is refused.
- **Unknown price.** A model without a pinned price cannot be admitted under a
  dollar budget. The provider must use a token budget for that model, or the
  model is excluded from its allowlist.
- **Settlement.** When the upstream reports usage, the reservation is replaced
  by reported usage at the pinned price. If a turn is cancelled, times out, or
  ends without usage, the full reservation is charged and marked `estimated`.
  Late usage reports (for example a streaming response the upstream bills after
  cancellation) are reconciled into the ledger when received. If reported usage
  exceeds the reservation, the excess is charged, the overrun is recorded, and
  the next admission sees the reduced balance.
- **What the cap guarantees.** The broker never admits work whose worst-case
  reservation exceeds the remaining budget. Upstream invoices can still differ,
  through price changes the catalog has not pinned or provider-side billing the
  API does not report. The UI says so and recommends a provider-side spend limit
  as the outer bound.

A runaway agent can consume its allowed inference budget, generate mail, and
invoke the guest capabilities it actually holds. It cannot read/copy the API
key, change providers or limits, call arbitrary authenticated endpoints, use a
sibling's guest powers, mint more authority, or obtain admission past
broker-enforced reservations.
Compromise of the host broker or secret backend remains inside the operator
threat model; object-capability attenuation cannot protect a secret from the
component deliberately entrusted to present it upstream.

## Build and acceptance plan

Each phase is one builder-sized job and ends with its own tests and rollback.

1. **Endo provider registry, ownership, and facets.** Add durable provider
   metadata with `ownerId`, per-owner `InferenceProviderDirectory`,
   `InferenceProviderAdmin`/`Use`/`AgentInference` over the existing grant
   issuer, the creation/retirement operation records and reconciler, and
   secret-manager retention. Test restart, supersession, retirement, and
   no-admin derivation from use. Confirm the issuer serves an in-process
   `InferenceEndpoint` without the slice listener. Test cross-principal denial: a foreign id in
   lookup, admin, and agent creation returns `provider-not-found` or
   `provider-owner-mismatch`, and listing never shows another owner's provider.
   Inject a crash at each creation and retirement commit boundary, including a
   lost response, and assert exactly one active provider, no orphan secret
   after reconciliation, and no `active` provider with a revoked secret.
   Test that a lifecycle change leaves the descriptor byte-identical and
   appends one audit row.
   Rollback leaves inert records.
2. **Provider adapters and accounting.** Bind Anthropic API keys through the
   provider-neutral `@endo/inference` contract, usage recorder, model catalog,
   limits, and a fake upstream. Add the `brokered-messages` adapter, Fae's
   provider kind, and Lal's broker-backed `streamFn` (§ Harness adapter
   boundary); test that neither harness can be configured with key material,
   that a retired provider fails the next call, and that a harness abort
   cancels upstream and releases the slot. Test 401, rate limit,
   cancellation, unknown usage, concurrency, budget refusal before secret read, and log redaction.
   Test reservation and settlement: refusal when the worst-case reservation does
   not fit, refusal of an unpriced model under a dollar budget, a streaming
   cancellation charged at full reservation, a late usage report reconciled
   after cancellation, and upstream usage exceeding the reservation.
3. **minion.town provider endpoint, UI step, and Providers page.** Add the
   button, provider list, password form, Providers page with limits,
   **Replace key**, and **Disable key in Endo**, CSRF/account gates,
   request-size bound, fixed errors, and no echo/cache/logging. Use the clip
   browser recipe against Chromium, Firefox, and WebKit: inspect rendered DOM,
   network URL/body lifetime, history, console, retry, Back, and reload. Exercise both steps keyboard-only and
   with a screen reader (focus order, focus return, announced errors and
   progress). Plant a unique canary key and apply the
   secret-retention check below. Test that a second signed-in principal cannot
   list, select, or revoke the first principal's provider. Test **Disable key
   in Endo** against the fake upstream: the next agent call fails with
   `provider-retired`, the fake upstream still accepts the same key from
   outside Endo (demonstrating that the action is local), and the confirmation
   and the provider row both show the upstream-revocation instruction until
   the owner records the assertion. Test **Replace key**: the old provider
   keeps serving unselected agents, and the remaining-agents count reaches
   zero before disabling is offered. Import the same canary key into two
   providers and assert that each enforces its own caps and that the page
   shows the per-provider scope notice.
4. **Agent factory and UI step.** Add the server-supplied Lal/Fae catalog,
   name/model/limit validation, idempotent agent creation, and exact powers
   profiles, the agent operation records and reconciler, and the agent
   detail view with the wake toggle. Test same-name conflicts, stale provider,
   foreign provider id, model exclusion, and absence of root/secret/sibling
   methods. Inject a crash at each creation, wake, and deletion boundary,
   including a lost response, and assert exactly one guest, grant, and
   responder per agent, no running responder without a committed
   `AgentRecord`, and no residue after an abort. Inject a crash after the
   creation commit and before activation, and assert that the reconciler, and
   separately a retry, leave a wake-enabled agent running and that no success
   is returned before activation. Test that mail sent while wake is off stays
   unread; that enabling wake with queued mail shows the queued count and
   processes nothing until confirmed; that **Skip queued mail** processes only
   later mail; and that **Delete agent** names the unread count, defaults
   focus to **Cancel**, and leaves usage rows after deletion.
5. **Pinned responder.** Generalize #165 away from Claude names and attach it to
   the created Lal/Fae agent. Test message wake, duplicate delivery, restart,
   busy/rate-limit refusal, cancellation, effect commit, and deletion cleanup
   against a real temporary daemon plus fake inference.
6. **Production canary and UI rollout.** Import a dedicated low-budget key,
   create one Lal and one Fae bot, send messages, restart the daemon and app,
   replace the key by supersession, disable the old provider, and verify both
   old agents stop until explicitly reattached. Record usage receipts and the secret-canary
   grep. No broad rollout until all observations pass.
7. **Legacy migration.** Convert Claude child records into parked generic agent
   records preserving bot names, mail, responder cursors, and delegation
   topology. Require provider/harness selection before wake. Test rollback before
   swap and crash at every commit boundary.

Acceptance requires all seven phases, a real browser observation for both UI
steps, a real-daemon restart/wake observation, a real upstream turn for each
advertised harness, revocation stopping the next turn, a passing
secret-retention check, cross-principal denial evidence, and usage/refusal
evidence. Unit tests alone do not satisfy it.

**Secret-retention check.** The invariant is about durable or observable
retention, not about transport. The key necessarily passes through, and may be
held transiently by: the browser page's memory and the in-flight request body,
TLS, the minion.town app process memory for the duration of the request, the
Endo daemon process memory, the `@secrets` backend in its encrypted form, the
host broker's memory during an upstream request, and the upstream provider. No
check inspects those.

The gate covers only storage the application controls. After import, and
again after a restart and after one upstream turn, the canary must have zero
copies in:

- application-controlled browser state: DOM after submission, history entries
  and history state the app writes, HTTP cache (responses are `no-store`),
  Cache Storage and service-worker caches, local and session storage,
  IndexedDB, and cookies;
- browser observability: console output and any test-harness trace or
  screenshot captured after submission;
- minion.town: its database, files under its state directory, access and
  application logs, error reports, metrics, and analytics;
- the reverse proxy's access and error logs, and the systemd journal for every
  garden, app, and daemon unit;
- Endo: formula and pet-store state, mail, agent transcripts, audit rows, the
  usage ledger, operation records, MCP results, and daemon logs, plus the
  `@secrets` store searched for plaintext (it holds only ciphertext).

Browser-managed state is outside that gate, because the product can neither
prevent nor reliably inspect it: form autofill and password-manager stores,
session-restore snapshots of field values, and crash reports. Browsers may
ignore `autocomplete` hints. For these the requirement is mitigation plus
recorded evidence, not a zero-copy claim:

- the key field uses `autocomplete="off"`, is not paired with a username
  field, and is cleared once the request is sent and before any navigation
  (§ Step 1), and the UI tells the user to decline any offer to save the key;
- in each test browser, with a fresh profile, the clip recipe submits the
  canary, closes the browser cleanly, and searches the profile directory for
  it. The result is recorded per browser as observational evidence. A hit is
  documented as a known limitation of that browser in the UI copy and the
  canary report; it does not fail the gate, and a clean result is not
  certified as proof of non-retention.

## Open questions

1. **First provider kinds?** Ship Anthropic only as recommended, or include an
   allowlisted OpenAI-compatible base-URL provider in the first release?
2. **First harness menu?** Is the recommended `lal` plus advanced `fae` menu
   correct, with Floot and Jaine hidden until they have dedicated profiles?
3. **Indelible operator escape hatch?** May a root operator call
   `SecretAdmin.delete` after revocation and backup expiry, while the provider
   tombstone/audit remain, or must backend material also remain indefinitely?
4. **Default spend caps?** What concurrent-turn, requests-per-minute, and daily
   dollar/token ceilings should a newly imported provider and newly created
   agent receive?
5. **Provider sharing scope?** May every agent owned by one signed-in guest use
   the same provider by default, or must each attachment be confirmed even
   within that guest?
6. **Model catalogs?** Must creation require a live provider model-list check,
   or may a user type a model id when a provider lacks discovery?
7. **Owner-wide spend cap?** Should the first release add an aggregate cap
   across all of one owner's providers, bounding duplicate imports of one key,
   or is the per-provider scope plus a provider-side spend limit enough?
