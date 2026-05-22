# AI Agent Requirements: Quinn Pig Screed (reference)

|             |                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| **Created** | 2026-05-21                                                                                                       |
| **Updated** | 2026-05-22                                                                                                       |
| **Author**  | kriscendobot (prompted)                                                                                          |
| **Status**  | Reference                                                                                                        |
| **Source**  | <https://x.com/QuinnyPig/status/2055497559813304735> (transcript supplied by maintainer 2026-05-21)              |

## Purpose

Capture Corey Quinn's (`@QuinnyPig`) post enumerating practitioner-side
requirements for AI agents, and analyze each requirement against what
Endo already provides, what is designed but unbuilt, and what would need
new work.
The post is a frequently-cited "screed" in the AI-agent skeptic
community, and the maintainer wants Endo's design corpus to engage with
its bullets explicitly rather than implicitly.

This is a reference document, not an implementation target.
It does not enter the milestone tables in `README.md`; it cross-links
to existing milestone designs where relevant and flags gaps where the
post raises a concern Endo has not addressed.

## Transcript

The transcript below is the verbatim thread by `@QuinnyPig` from
2026-05-15, followed by a 2026-05-18 quote-tweet by `@QuinnyPig`
endorsing a reply from `@Hey_ross`.
All X / Twitter handles are wrapped in backticks so this document
renders them as inline code rather than triggering @-notifications.

---

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497561855926684)

1. Gated changes.
   The agent does not mutate prod directly.
   It opens a PR, kicks off an Action, proposes a change a human (or
   another agent) reviews.
   So far agents haven't started routing around this pattern, the
   platform should make that the path of least resistance.

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497563244261437)

2. Stop making me fish for API keys every time the agent wants to
   light up a new service.
   The fix is secrets brokering: the platform holds the secret, the
   agent gets a handle, calls go through.
   A compromised agent can't exfiltrate what it never had.

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497564586414447)

3. The API has to be consistent.
   240 services with bespoke verbs pagination and region quirks is
   why Claude Code stumbles looking for the right command, then runs
   it in the wrong account.

   Agents inherit AWS's inconsistency tax at a higher rate than
   humans do.

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497565970538589)

4. Agents need their own identity.
   Today every action is laundered through the human's IAM role, so
   the audit log reads "corey@duckbill did this" when the truth is
   "Claude's third retry at 2am did this."
   First-class agent identities: scoped, attestable, time-limited,
   revocable.

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497567455281199)

5. Hard budget caps that actually halt.
   Not the AWS "we noticed you spent $47K yesterday, here's a
   CloudWatch email" approach.
   Fail closed at the boundary.
   A Lambda stuck in a loop racking up data transfer or inference
   charges is a real failure mode; treat it as one!

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497568805921043)

6. Cost circuit breakers with human escalation.
   The agent session has an allotment.
   It depletes faster than expected -> page a human to either
   authorize more or kill it.
   Finding out at the end of the month is how you take a $50K "oh
   no" media story to the chin every other week.

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497570122907786)

7. Cost preview as a first-class API.
   Before any state-changing call: "this adds ~$340/mo fixed plus
   $0.09 per 1k requests."
   Most pricing is usage-based now, so the preview can't just say
   "X dollars."

   Agents are bad at AWS pricing because AWS pricing is bad at being
   prices.

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497571460899035)

8. Error messages designed for an LLM to act on.
   Not "AccessDenied: User arn:aws:... not authorized because no
   identity-based policy allows."

   More like: "denied: this agent lacks dynamodb:Query on 'users';
   the owner can grant it at LINK."
   Errors as instructions, not puzzles.

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497572790513913)

9. Blast radius as a primitive.
   "This session may spend up to X, touch up to N resources, in
   environment Y, expiring in 30 minutes."
   Capability-bounded sessions, baked in.
   Today every agent is either god-mode or fully fenced off.
   The whole interesting design space is in between.

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497574145249513)

10. Time travel by default.
    Every state change is reversible for some window.
    "Roll back the last 20 minutes" is one command, not a CloudTrail
    seance that ends with you restoring yesterday's snapshot and
    losing four hours of customer data along with the agent's
    mistake.

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497575453925420)

11. Observability that ties action -> reasoning -> cost.
    Not "Lambda X fired" but "agent invoked Lambda X while attempting
    task Y, prompted by request Z, cost $0.0003 against a $5 session
    budget."
    The AI-native equivalent of dmesg for distributed systems.
    Nobody has it yet.

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497576783499544)

12. Convention over configuration, ruthlessly.
    AWS forces explicit decisions on 1000 things with 1 obviously
    right answer 95% of the time.
    The agent-native platform should have brutal opinions about
    defaults, and when it needs to ask, ask the human, not flail
    through alone.

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 15](https://x.com/QuinnyPig/status/2055497578113028321)

Most of this only matters because the agent runs semi-autonomously.
If you're typing prompts and watching every step, you just need a
less hostile CLI.
The interesting work is what changes when the agent runs unattended
and you have to trust the platform not to incinerate money.

[Corey Quinn](https://x.com/QuinnyPig)
`@QuinnyPig`
·
[May 18](https://x.com/QuinnyPig/status/2056424148461826049)

This is a _great_ inclusion point.

> Quote
>
> Ross Brown
> `@Hey_ross`
> ·
> May 15
>
> Replying to `@QuinnyPig` `@vercel` and 2 others
>
> Great list.
> I would only add that a universal and intelligent context
> injection system would be helpful - think of it as a way to create
> dynamic system prompts for agents that inform them on existing
> code and architectures based on what they are trying to do; limits
> and

---

## Per-bullet Endo-side analysis

The analysis lens draws on Endo's standing primitives:

- **SES** (Hardened JavaScript): lockdown, frozen intrinsics, no
  ambient `setTimeout`, capability-only access to host powers.
- **Exo** + **interface guards**: typed remotable objects with method
  guards enforced at the boundary; introspectable via
  `__getMethodNames__`.
- **CapTP** + **eventual send**: object-capability messaging with
  promise pipelining; no synchronous network calls.
- **Daemon**: durable formulas, named pet store, content-addressable
  store, GC across persisted graphs.
- **OCapN**: peer-to-peer capability network with Noise-protected
  transport and per-agent network identities.

### Bullet 1: Gated changes

The guardrail Endo offers here lives in the Daemon, not in any
project-specific workflow built on top of it.
An Endo agent is confined to the capabilities its host explicitly
granted; it has no `process.env`, no ambient filesystem, no socket
constructor, and no path back to a production system except through
exo capabilities that the daemon's capability bank issued.
That makes "agent does not mutate prod directly" a property of the
capability model rather than a convention an agent might choose to
ignore: an agent that holds no `Repo` or `Deploy` capability cannot
mutate either, and an agent that holds a `Repo.openPullRequest`
capability but not a `Repo.push` capability literally cannot route
around the gated-PR pattern.
The PR-and-review workflow is one shape this guardrail enables; the
underlying primitive is the daemon-issued capability that names what
the agent may do.
Relevant existing designs:
[`daemon-capability-bank`](daemon-capability-bank.md),
[`endo-posix-sandbox`](endo-posix-sandbox.md),
[`daemon-agent-tools`](daemon-agent-tools.md).

### Bullet 2: Secrets brokering

Endo's capability model is secrets brokering by construction.
An agent never holds an API key in plaintext; it holds an
`HttpClient` capability (or a service-specific exo) that proxies
authorized calls through the daemon.
A compromised agent can be revoked by withdrawing its capability,
and the credential the capability wrapped never enters the agent's
SES realm.
Relevant existing designs: [`endoclaw-network-fetch`](endoclaw-network-fetch.md),
[`endoclaw-oauth`](endoclaw-oauth.md),
[`daemon-capability-bank`](daemon-capability-bank.md),
[`gateway-bearer-token-auth`](gateway-bearer-token-auth.md).

### Bullet 3: API consistency

This bullet targets AWS specifically; the Endo-side analogue is the
exo interface guard plus the reflection surface that exposes it.
Every `makeExo` remotable carries an `M.interface()` method guard
that names its methods and the pattern each argument must match;
those guards are themselves reflectable.
`__getMethodNames__()` lets a caller (or an LLM) enumerate the
methods, and the interface guard's `getMethodGuards()` surface
returns the argument and result patterns for each method, so a
caller can discover both the method names and the shapes the
implementation will accept without duck-typing.
The pattern language itself (`@endo/patterns`) is a reflective
type-and-shape surface that error-message rendering and runtime
matching share.
The discipline does not solve "240 services with bespoke verbs" at
the AWS scale, but within Endo a capability's surface is
self-describing all the way down to the argument patterns.
Relevant Endo documentation:
[`packages/exo/docs/exo-taxonomy.md`](../packages/exo/docs/exo-taxonomy.md),
[`packages/exo/docs/types.md`](../packages/exo/docs/types.md),
[`packages/patterns/docs/marshal-vs-patterns-level.md`](../packages/patterns/docs/marshal-vs-patterns-level.md),
[`docs/exo-method-banks.md`](../docs/exo-method-banks.md),
[`docs/message-passing.md`](../docs/message-passing.md).

### Bullet 4: First-class agent identity

Endo agents have unforgeable formula ids inside the daemon and (when
networked) keypair-derived OCapN network identities.
"Scoped, attestable, time-limited, revocable" maps onto the OCapN
identity story: a per-agent network identity is a keypair (scoped to
that agent), the public half is attestable, and the daemon's
capability bank can revoke or rebind capabilities issued to that
identity.
Time-limited capabilities (see bullet 9) are the gap on this axis.
Relevant existing designs:
[`daemon-agent-network-identity`](daemon-agent-network-identity.md),
[`daemon-256-bit-identifiers`](daemon-256-bit-identifiers.md),
[`ocapn-noise-network`](ocapn-noise-network.md).

### Bullet 5: Hard budget caps that halt

Endo has XS metering as the substrate on which budget primitives are
built.
XS measures each worker's allocation and computation, the daemon can
issue workers tokens against a quota, rate-limit messages to a worker
that is approaching its quota, terminate a worker that exceeds its
meter, and page a worker's heap into a content-addressable snapshot
so the trade between compute and storage is explicit rather than
ambient.
Storage charging follows the same shape: the daemon can charge for
storage on the basis of writes against a quota the server agrees to
hold (the assumption being that the writer paid enough at write time
to cover the storage costs from reasonable interest projections),
and users can pay for garbage collection to reclaim storage tokens.
Per-agent token / compute / dollar budgets layered on this substrate
are designable rather than aspirational, the meter and the quota
already exist; what remains is exposing the budget as a capability
the agent and its caller can observe and the daemon can fail-closed
on at the boundary.
Relevant existing designs:
[`daemon-xs-worker-metering`](daemon-xs-worker-metering.md),
[`daemon-xs-worker-snapshot`](daemon-xs-worker-snapshot.md),
[`daemon-content-store-gc`](daemon-content-store-gc.md),
[`daemon-cas-management`](daemon-cas-management.md).

### Bullet 6: Cost circuit breakers with human escalation

Circuit breaking at the worker granularity is within reach for the
same reason bullet 5's quota and termination story is: XS metering
sees each worker's allocation and computation, and the daemon can
trip a breaker on a worker, a group of workers, or a particular
capability invocation when the signal warrants it.
The maintainers have prior experience building circuit breakers for
RPC at scale, which gives the worker-granularity story prior art
rather than a from-scratch design.
The remaining design work is the human-escalation half: Endo has the
confirmation UX surface (the chat UI can prompt a user) but no
standing tie between a depletion or breaker-trip signal and a
confirmation prompt.
A confirmation-as-affordance design is distinct from the capability
denial Endo gets by default; this is its own design area.
Relevant existing designs:
[`daemon-xs-worker-metering`](daemon-xs-worker-metering.md),
[`daemon-debug-worker-restart`](daemon-debug-worker-restart.md).

### Bullet 7: Cost preview as a first-class API

A `previewCost(args)` method on a typed cost-bearing exo is one
obvious shape; whether the embedding service can supply the estimate
is a per-service question.
A more general framing the daemon can offer is the **transactional
dry-run**: run the workflow against an ephemeral storage proxy that
mirrors the real CAS for reads and discards all writes when the
dry-run completes, with the client paying the compute and network
costs for the dry-run pass.
The substrate is already there (the daemon's content-addressable
store, the XS worker snapshot mechanism, and the daemon's existing
ability to fork workers).
Getting the economics of dry-runs to work is the interesting open
problem: the dry-run must be cheap enough that a caller would
actually choose it over committing speculatively, but expensive
enough that the daemon is not asked to compute the world for free.
A `previewCost` projection and a full transactional dry-run are
points on the same spectrum.
Relevant existing designs:
[`daemon-xs-worker-snapshot`](daemon-xs-worker-snapshot.md),
[`daemon-cas-management`](daemon-cas-management.md),
[`daemon-content-store-gc`](daemon-content-store-gc.md).

### Bullet 8: LLM-actionable error messages

This is an area that will require attention; the foundation is in
place but the LLM-actionable framing needs deliberate design work.
Endo's `@endo/errors` library encourages structured, taggable errors
(`makeError(X\`No formula for ${ref}\`)`) and `q()` for safe value
quoting in messages, which is closer to "instructions, not puzzles"
than AWS's IAM boilerplate.
The active design surface for the pattern-mismatch case (the
class of error an interface guard raises when an argument fails its
pattern) is
[`patterns-diagnostic-feedback`](patterns-diagnostic-feedback.md),
which spells out how the `@endo/patterns` matcher renders an
explanation of *why* a value failed a pattern.
That diagnostic surface is where the LLM-actionable form of the
"this agent lacks X, the owner can grant it at LINK" shape would
live for Endo: the explanation already names the offending value's
shape and the pattern it failed; extending the explanation to point
at the capability authority responsible for granting the missing
permission is the next step.
See also Endo's general error-tracing surfaces:
[`docs/errors.md`](../docs/errors.md),
[`docs/error-tracing-design.md`](../docs/error-tracing-design.md).

### Bullet 9: Blast radius as a primitive

Endo's capability model is exactly this: each agent's authority is
the union of the capabilities it holds.
"Capability-bounded sessions" maps to a chat session whose root
guest sees only a curated capability bank.
"Expiring in 30 minutes" is the gap, time-limited capabilities are
not a built-out story today.
Relevant existing designs: [`daemon-capability-bank`](daemon-capability-bank.md),
[`endo-posix-sandbox`](endo-posix-sandbox.md),
[`endoclaw-timer`](endoclaw-timer.md) (for the timer half).

### Bullet 10: Time travel by default

The daemon's current persistence stack is a combination of SQLite
(for structured indices and pet-store names) and a content-addressable
store (for immutable formula bodies, transcripts, and blobs).
XS heap snapshots are an additional roll-back surface: a worker's
heap can be snapshotted into the CAS, retired, and re-instantiated
from the snapshot on demand.
With those three substrates (SQLite for the durable name layer, CAS
for the immutable history, XS snapshots for in-memory state) it is
feasible to design a daemon that supports rollback as a first-class
operation rather than a manual surgery.
"Roll back the last 20 minutes" becomes a formula-pointer rewind in
SQLite plus a snapshot reinstantiation for any worker whose heap
diverged in the rolled-back window.
The user-facing "one command" affordance and the bounding rules for
what is reversible across CAS-GC boundaries are unbuilt; the
substrate is there.
Relevant existing designs:
[`daemon-endo-rust-sqlite`](daemon-endo-rust-sqlite.md),
[`daemon-content-store-gc`](daemon-content-store-gc.md),
[`daemon-cas-management`](daemon-cas-management.md),
[`daemon-xs-worker-snapshot`](daemon-xs-worker-snapshot.md),
[`lal-reply-chain-transcripts`](lal-reply-chain-transcripts.md).

### Bullet 11: Action -> reasoning -> cost observability

Partial coverage.
The chat UI renders `value` messages with provenance
([`chat-edit-message-ui`](chat-edit-message-ui.md)) and the formula
inspector lets the user walk an agent's graph
([`formula-inspector`](formula-inspector.md),
[`workers-panel`](workers-panel.md),
[`daemon-retention-paths`](daemon-retention-paths.md)).
Tying each action to the prompting LLM request and to the cost
incurred is the unbuilt half; the action and reasoning surfaces
exist, the cost surface does not.

### Bullet 12: Convention over configuration

Endo's default posture is the capability-only realm, which removes
the "explicit decisions on 1000 things" problem by removing the
ambient surface they would configure.
"Ask the human" is the chat UI's role.
"Flail through alone" is the failure mode Endo's pre-PR checklist,
panel reviews, and pre-push gates exist to prevent for bot-side
work.

### Closing tweet: semi-autonomous operation

The post's closing point ("most of this only matters because the
agent runs semi-autonomously") describes exactly the regime where
the daemon's capability model, XS metering, and rollback substrate
earn their keep: under attended use a less hostile CLI suffices,
but under unattended use the platform itself has to refuse the
runaway-loop and the unbounded-cost cases.
This bullet becomes increasingly relevant to the extent that the
Endo project pursues self-hosting its own development inside its
own harness; the day an Endo agent is itself the thing editing,
testing, and proposing changes to Endo's source is the day the
daemon's confinement, metering, and rollback surfaces stop being
hypothetical and start mattering for the project's own
development loop.

### `@Hey_ross`'s reply: context injection

The quoted reply asks for a "universal and intelligent context
injection system" that builds dynamic system prompts from existing
code and architecture.
Endo's analog is the library / skill / role decomposition: the
garden's own roles read `roles/COMMON.md`, then a per-role
`AGENT.md`, then skills loaded on demand.
The reply's text is cut off after "limits and"; whatever the
remainder said is not on record here.

## Cross-cutting Endo posture

Independent of the specific bullets, the Endo design corpus already
takes a position on several themes the post raises.
This section summarizes that posture as background for the per-bullet
analysis.

### Capability confinement vs. ambient authority

The single largest architectural choice in Endo is to refuse ambient
authority for agents.
An Endo agent has only the `Dir`, `File`, `Shell`, `HttpClient`,
`Timer`, and similar exo capabilities its host explicitly granted;
the SES realm denies it `process.env`, `fs`, network sockets,
`setTimeout`, and every other ambient affordance a Node program would
normally inherit.
See [`endo-posix-sandbox`](endo-posix-sandbox.md) for the OS-level
sandbox, [`daemon-capability-bank`](daemon-capability-bank.md) for
the capability inventory,
[`endoclaw-network-fetch`](endoclaw-network-fetch.md) +
[`trust-on-first-bind`](trust-on-first-bind.md) for the
HTTP-with-allowlist pattern, and
[`endoclaw-timer`](endoclaw-timer.md) for scheduled execution.

### Durable memory and transcripts

Endo persists agent state in two places: per-conversation
transcripts maintained as formula graphs in the daemon
([`lal-reply-chain-transcripts`](lal-reply-chain-transcripts.md),
[`lal-transcript-memory-management`](lal-transcript-memory-management.md)),
and durable formula references in the pet store
([`daemon-form-request`](daemon-form-request.md),
[`daemon-value-message`](daemon-value-message.md)).
This means an agent restarted via inbox replay
([`lal-fae-form-provisioning`](lal-fae-form-provisioning.md)) sees
the same world it saw before the restart; agents do not lose state
across sessions by default.

### Identity and accountability

Each Endo agent has an unforgeable formula id and (when networked) a
keypair-derived OCapN network identity
([`daemon-agent-network-identity`](daemon-agent-network-identity.md)).
Agents address each other by capability, not by name; impersonation
is ruled out by the capability model rather than by trust-on-first-use
of a chat handle.

### Communication and observability

Endo agents communicate with users through a structured Chat UI that
renders `value` messages with provenance, supports edit-message
revision history
([`chat-edit-message-ui`](chat-edit-message-ui.md)), and lets the
user inspect formula graphs to see what an agent is doing
([`formula-inspector`](formula-inspector.md),
[`workers-panel`](workers-panel.md),
[`daemon-retention-paths`](daemon-retention-paths.md)).

### Honest gaps

Areas where the Endo corpus has the substrate but has not yet built
the agent-facing surface, or has not yet taken a position at all,
also flagged in the per-bullet analysis above:

- **Budget-as-capability surface**: XS metering, worker rate limits,
  worker termination, and storage-write quotas exist as substrate;
  a per-agent token / compute / dollar budget exposed as an exo the
  agent and its caller can observe is the unbuilt layer
  (bullets 5, 6, 7, 11).
- **Confirmation UX for irreversible actions**: there is no standing
  design for "agent must ask before doing X-class-of-thing" beyond
  the capability denial it gets if it lacks the capability (bullet 6).
- **LLM-actionable error explanations beyond pattern mismatch**:
  the `patterns-diagnostic-feedback` design covers argument-shape
  failures; extending the explanation surface to point at the
  capability authority that could grant a missing permission is
  unbuilt (bullet 8).
- **Time-limited capabilities**: capability expiry is not a built-out
  story (bullet 9).
- **User-facing rollback affordance and rollback-aware GC bounds**:
  SQLite plus CAS plus XS snapshots make a rollback-capable daemon
  feasible to design; the user-facing "one command" affordance and
  the rules that bound what is reversible across GC boundaries are
  unbuilt (bullet 10).

## Status (Reference)

This is a reference document.
It does not enter `README.md`'s milestone tables and has no per-design
size / duration estimate.
It exists to give future builders a single place to look when a
feature request cites Quinn's screed or AI-agent skeptic critiques
more generally.

## Prompt

> Read the screed at <https://x.com/QuinnyPig/status/2055497559813304735>
> and write a reference design that captures the bullets and analyzes
> each against Endo's standing primitives (SES, exo, captp, daemon,
> OCapN).
> Be honest about gaps.
> Stub the doc with a TODO for the maintainer to paste the source if
> retrieval fails; do not fabricate content.
> Status: Reference.
> Aim is a useful reference, not marketing.
