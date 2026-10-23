# API-key inference providers and pinned guest agents

| | |
|---|---|
| **Created** | 2026-10-23 |
| **Status** | Proposed |
| **Parent** | [Course correction after `claude --bare` rejected subscription credentials](claude-bare-course-correction.md) |
| **Grounded against** | `endojs/endo-but-for-bots` `llm` at `d5ac41980a`; `kriscendobot/minion.town` `main` at `68c3960bbe` |

## Summary

"Add agent" is a two-commit workflow, even when presented as one short wizard:

1. import an API key and create a reusable **inference provider**; then
2. create a named **guest agent** attached to a selected provider and harness.

The key becomes a host-held `SecretBlob` behind a provider broker. The agent
holds neither the key nor the `SecretBlob`; it receives a per-agent inference
facet and its own attenuated guest powers. A daemon-pinned responder wakes the
agent on mail. Provider creation is driven by an explicit minion.town UI action,
not by an unsolicited form message.

## Existing substrate and harness choice

The existing Lal/Fae form design and implementation are useful but not the UI
contract. [`packages/fae/llm-provider-factory.js`](../packages/fae/llm-provider-factory.js)
already validates provider fields, calls the daemon secret manager, and stores
only `authSecretName` in provider configuration. Its own comment also records
the defect this design must avoid: a daemon form submission is durable before
the factory processes it, so a typed raw token remains in the form message.
Reuse its provider validation, `SecretBlob` binding, per-turn reread/rotation in
`packages/fae/src/provider-owner.js`, and tagged error behavior. Do not reuse the
unsolicited form transport or persist the raw submission.

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

### Step 1: create or choose an inference provider

The page first lists the user's active providers by non-secret display name,
provider kind, default model, spend summary, and status. The user may select one
or choose **New provider**, which asks for:

- provider name;
- provider kind (`Anthropic` first; `OpenAI-compatible` only when its base URL
  allowlist and response adapter ship);
- API key in `<input type="password">`;
- default model; and
- base URL only for a supported non-default provider kind.

Submit performs one authenticated HTTPS `POST` with the key in the body. The
client clears the field synchronously before awaiting the response. The request
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
- **Wake on messages**, on by default; and
- initial spend/rate limits, initialized from deployment defaults.

Submit is a separate authenticated operation containing only provider id,
harness, bot name, model, and limits. Success adds the agent to the guest's
inventory. Retrying the same idempotency key returns the same provider or agent;
it never creates a second spend source or responder.

The Lal demo's field validation, provider config, model resolution, and
manager/worker separation are reusable. Its "server sends a form to the user"
trigger is not: minion.town owns initiation, progress, cancellation, and errors.

## Provider and secret model

The durable, non-secret provider record is versioned data retained in a
root-private provider registry:

```ts
type InferenceProviderRecord = {
  version: 1;
  providerId: string;       // random object designator
  displayName: string;
  kind: 'anthropic' | 'openai-compatible';
  baseUrl?: string;         // validated, never inferred from key text
  defaultModel: string;
  secretGrantFormulaId: string; // host-private retention edge, never in UI
  createdAt: string;
  state: 'active' | 'retired';
  supersedes?: string;
};
```

The record's facets are separate:

- `InferenceProviderAdmin`, held by the signed-in user's root UI capability,
  returns safe summaries, sets limits, creates a superseding provider, and
  retires this provider. It cannot read key bytes.
- `InferenceProviderUse`, held only by the host-side agent factory/broker,
  creates a per-agent inference facet over a specific guest powers facet,
  harness, model, and budget. It does not vend its `SecretBlob`.
- `AgentInference`, held by one agent driver, accepts bounded turns and returns
  provider-neutral tagged results and usage. It cannot change provider,
  model allowlist, or spend policy.

The browser endpoint invokes `@secrets/create` on the Endo root. The resulting
`SecretBlob` is retained by the provider broker through a lookup formula; no
minion.town database, guest formula, agent transcript, URL, log, exception,
metric, or MCP result contains the bytes. The provider adapter reads the blob
inside the host broker only for the duration of an upstream request. An
authenticated HTTP client assembled there is preferable to returning bytes to
a harness.

The store lives in the Endo host: `@secrets` owns encrypted bytes, lifecycle,
and audit; the provider registry owns non-secret interpretation and usage.
minion.town is the UI/gateway and keeps no second durable key copy. Production
backup and encryption follow
[`daemon-secret-manager.md`](daemon-secret-manager.md); a multi-principal
deployment must add provider ownership partitioning because the current
`@secrets` catalog is deliberately root/single-principal.

### "Indelible" and retirement

Indelible means a created provider's identity, audit trail, and historical
agent/usage references are append-only through the product API. It does **not**
mean a leaked key must remain usable.

- A provider record is never overwritten in place.
- Rotation creates a new secret and provider record whose `supersedes` points
  to the prior provider; agents move only by an explicit reattachment.
- Retirement first revokes the old `SecretBlob`, then marks the provider
  retired. New and queued turns fail closed. The old provider id and audit rows
  remain so historical spend is intelligible.
- The ordinary product UI never calls `SecretAdmin.delete`. An operator may
  crypto-delete revoked backend material under the secret-manager's recovery
  procedure, but does not erase the non-secret tombstone or audit history.

This is revocation by supersession, not "no deletion ever." It lets a user
retire a leaked key immediately without rewriting history or silently changing
what an existing provider capability designates.

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
pinned responder; duplicate delivery consults the effect record. Dismissal
cancels an in-flight turn before releasing the guest and responder.

If a loopback bridge is needed, its bearer is a random, revocable designator for
that one responder or inference object. Possession authorizes calls to that
object; it does not denote the OAuth subject or authenticate an identity. This
is the test settled during minion.town
[#180](https://github.com/kriscendobot/minion.town/pull/180) and recorded by
[#203](https://github.com/kriscendobot/minion.town/pull/203). A bearer derived
from guest id, account subject, or provider name is forbidden. Prefer direct
Endo capabilities where no bearer is needed.

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
|---|---|---|---|---|---|
| UI -> provider endpoint | Password POST and safe summary response | Signed-in guest may create within quota | None in UI; idempotency receipt in app | Endo import commit decides success | Key in request only; safe provider summary back |
| Provider registry -> `@secrets` | Retained `SecretBlob` lookup formula | Provider admin chooses create/supersede/retire | Secret manager owns bytes/audit; registry owns metadata | Secret manager commits/revokes bytes; registry commits provider state | Secret capability inward; no bytes or admin facet outward |
| Provider broker -> agent | Per-agent `AgentInference` facet | Broker enforces model, spend, rate, concurrency | Usage ledger per provider and agent | Broker admits, cancels, and releases turns | Bounded prompt/result/usage |
| Guest -> responder -> harness | Pinned mailbox subscription over one guest facet | User selects harness and wake policy | Guest formula, responder cursor/effects, harness transcript | Endo revives; user dismisses; responder commits mail effect | Message plus explicitly held guest capabilities |

Persistent state has one owner per datum: `@secrets` owns key material, the
provider registry owns provider lifecycle, the usage ledger owns accounting,
and the guest owns mail/responder state. The provider admin owns retire; the
broker owns per-turn admit/discard. Endo owns restart/replay. The harness owns
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
Cancellation and dismissal release the slot and terminate streaming work.

A runaway agent can consume its allowed inference budget, generate mail, and
invoke the guest capabilities it actually holds. It cannot read/copy the API
key, change providers or limits, call arbitrary authenticated endpoints, use a
sibling's guest powers, mint more authority, or spend past broker-enforced caps.
Compromise of the host broker or secret backend remains inside the operator
threat model; object-capability attenuation cannot protect a secret from the
component deliberately entrusted to present it upstream.

## Build and acceptance plan

Each phase is one builder-sized job and ends with its own tests and rollback.

1. **Endo provider registry and facets.** Add durable provider metadata,
   `InferenceProviderAdmin`/`Use`/`AgentInference`, idempotent creation, and
   secret-manager retention. Test restart, supersession, retirement, no-admin
   derivation from use, and fixed errors. Rollback leaves inert records.
2. **Provider adapters and accounting.** Bind Anthropic API keys through the
   provider-neutral `@endo/inference` contract, usage recorder, model catalog,
   limits, and a fake upstream. Test 401, rate limit, cancellation, unknown
   usage, concurrency, budget refusal before secret read, and log redaction.
3. **minion.town provider endpoint and UI step.** Add the button, provider list,
   password form, CSRF/account gates, request-size bound, fixed errors, and no
   echo/cache/logging. Use the clip browser recipe against Chromium, Firefox,
   and WebKit: inspect rendered DOM, network URL/body lifetime, history,
   console, retry, Back, and reload. Plant a unique canary key and grep app,
   proxy, systemd, audit, metrics, and browser artifacts for zero copies after
   import.
4. **Agent factory and UI step.** Add the server-supplied Lal/Fae catalog,
   name/model/limit validation, idempotent agent creation, and exact powers
   profiles. Test same-name conflicts, stale provider, foreign provider id,
   model exclusion, and absence of root/secret/sibling methods.
5. **Pinned responder.** Generalize #165 away from Claude names and attach it to
   the created Lal/Fae agent. Test message wake, duplicate delivery, restart,
   busy/rate-limit refusal, cancellation, effect commit, and dismissal cleanup
   against a real temporary daemon plus fake inference.
6. **Production canary and UI rollout.** Import a dedicated low-budget key,
   create one Lal and one Fae bot, send messages, restart the daemon and app,
   rotate by supersession, revoke the old provider, and verify both old agents
   stop until explicitly reattached. Record usage receipts and the secret-canary
   grep. No broad rollout until all observations pass.
7. **Legacy migration.** Convert Claude child records into parked generic agent
   records preserving bot names, mail, responder cursors, and delegation
   topology. Require provider/harness selection before wake. Test rollback before
   swap and crash at every commit boundary.

Acceptance requires all seven phases, a real browser observation for both UI
steps, a real-daemon restart/wake observation, a real upstream turn for each
advertised harness, revocation stopping the next turn, no secret canary outside
the backend, and usage/refusal evidence. Unit tests alone do not satisfy it.

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
