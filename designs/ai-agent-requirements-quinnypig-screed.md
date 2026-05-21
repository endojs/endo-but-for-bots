# AI Agent Requirements: Quinn Pig Screed (reference)

|             |                                                                          |
|-------------|--------------------------------------------------------------------------|
| **Created** | 2026-05-21                                                               |
| **Author**  | kriscendobot (prompted)                                                  |
| **Status**  | Reference (Phase 1 retrieval pending; see Source-retrieval status below) |
| **Source**  | <https://x.com/QuinnyPig/status/2055497559813304735> (retrieved 2026-05-21; see Source-retrieval status)         |

## Purpose

Capture Corey Quinn's (@QuinnyPig) post enumerating practitioner-side
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

## Source-retrieval status

> TODO (maintainer): paste the source content here.
>
> Phase 1 retrieval on 2026-05-21 was unsuccessful through every
> automated channel available to the dispatched designer:
>
> - Direct WebFetch against `https://x.com/QuinnyPig/status/2055497559813304735`:
>   X.com returns a 402 / login wall to unauthenticated clients; no
>   tweet content is served.
> - Wayback Machine (`https://web.archive.org/...`): the harness'
>   WebFetch is not permitted to reach `web.archive.org`.
> - Nitter mirrors: `nitter.net` returned an empty body;
>   `nitter.poast.org` and `nitter.privacyredirect.com` returned
>   503 or Anubis-anti-bot pages; `xcancel.com` returned 503;
>   `nitter.privacydev.net` refused the connection.
> - Thread Reader App's archive of `@QuinnyPig` (which extends back to
>   2022) does not include this status ID.
> - WebSearch for the status ID, for the screed by topic, and for
>   excerpts of Quinn's AI-agent commentary returned no quoted bullets
>   from this specific post.
>
> The designer was explicitly instructed not to fabricate content when
> retrieval fails.
> The bullets below are placeholders to be replaced with the verbatim
> (or paraphrased-with-attribution) content once the maintainer pastes
> the source.
>
> Replace this section with the source quote (preserving bullet
> structure), then fill in the per-bullet analysis under
> *Captured bullets and Endo-side analysis* below.

## Captured bullets and Endo-side analysis

The structure below is a scaffold for the maintainer's paste-and-fill
pass.
Each bullet gets two parts:

1. **Bullet** (verbatim quote, or paraphrase with `(paraphrased)` tag).
2. **Endo-side analysis** (2-4 sentences): what Endo provides today,
   what is designed but unbuilt, and any honest gap.

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

### Bullet 1 - TODO

> TODO (maintainer): paste bullet text.

Endo-side analysis: TODO.
Relevant existing designs: TODO.

### Bullet 2 - TODO

> TODO (maintainer): paste bullet text.

Endo-side analysis: TODO.
Relevant existing designs: TODO.

### Bullet 3 - TODO

> TODO (maintainer): paste bullet text.

Endo-side analysis: TODO.
Relevant existing designs: TODO.

*(Add additional bullets as needed.
The original post's bullet count is unknown to the designer
because retrieval failed; the scaffold above is a starter, not a
ceiling.)*

## Cross-cutting Endo posture

Independent of the specific bullets, the Endo design corpus already
takes a position on several themes the post is likely to raise.
This section summarizes that posture as background for the per-bullet
analysis.

### Capability confinement vs. ambient authority

The single largest architectural choice in Endo is to refuse ambient
authority for agents.
An Endo agent has only the `Dir`, `File`, `Shell`, `HttpClient`,
`Timer`, and similar exo capabilities its host explicitly granted; the
SES realm denies it `process.env`, `fs`, network sockets, `setTimeout`,
and every other ambient affordance a Node program would normally
inherit.
See [`endo-posix-sandbox`](endo-posix-sandbox.md) for the OS-level
sandbox, [`daemon-capability-bank`](daemon-capability-bank.md) for the
capability inventory, [`endoclaw-network-fetch`](endoclaw-network-fetch.md)
+ [`trust-on-first-bind`](trust-on-first-bind.md) for the
HTTP-with-allowlist pattern, and [`endoclaw-timer`](endoclaw-timer.md)
for scheduled execution.
A bullet asking "what stops an agent from doing X?" routes to this
chain.

### Durable memory and transcripts

Endo persists agent state in two places: per-conversation transcripts
maintained as formula graphs in the daemon
([`lal-reply-chain-transcripts`](lal-reply-chain-transcripts.md),
[`lal-transcript-memory-management`](lal-transcript-memory-management.md)),
and durable formula references in the pet store
([`daemon-form-request`](daemon-form-request.md),
[`daemon-value-message`](daemon-value-message.md)).
This means an agent restarted via inbox replay
([`lal-fae-form-provisioning`](lal-fae-form-provisioning.md)) sees the
same world it saw before the restart; agents do not lose state across
sessions by default.
A bullet about "agents forget everything between conversations" routes
here.

### Identity and accountability

Each Endo agent has an unforgeable formula id and (when networked) a
keypair-derived OCapN network identity
([`daemon-agent-network-identity`](daemon-agent-network-identity.md)).
Agents address each other by capability, not by name; impersonation is
ruled out by the capability model rather than by trust-on-first-use of
a chat handle.
The garden's own bot-vs-maintainer identity split (`kriscendobot` for
routine work, `kriskowal` for upstream landings) is a worked example of
the same principle applied to GitHub operations.
A bullet about "who is liable when an agent does X?" routes here.

### Communication and observability

Endo agents communicate with users through a structured Chat UI that
renders `value` messages with provenance, supports edit-message
revision history
([`chat-edit-message-ui`](chat-edit-message-ui.md)), and lets the user
inspect formula graphs to see what an agent is doing
([`formula-inspector`](formula-inspector.md),
[`workers-panel`](workers-panel.md),
[`daemon-retention-paths`](daemon-retention-paths.md)).
A bullet about "I want to see what the agent is actually doing" routes
here.

### Honest gaps

Areas where the Endo corpus has not yet taken a strong position, to
flag in the per-bullet analysis when the post touches them:

- **Cost accounting**: per-agent token / compute budgets are not yet a
  first-class daemon concern.
  Quinn writes about AWS billing for a living; if a bullet asks for
  hard cost ceilings, Endo's current answer is "the embedding host
  controls API keys and can rate-limit at the gateway", which is
  incomplete.
- **Confirmation UX for irreversible actions**: there is no standing
  design for "agent must ask before doing X-class-of-thing" beyond the
  capability denial it gets if it lacks the capability.
  Confirmation-as-affordance is distinct from
  confirmation-as-capability.
- **Multi-user provenance**: the chat UI is single-user; if a bullet
  asks for clear "this answer was generated for tenant A, do not leak
  to tenant B", the answer routes to the capability model in principle
  but not to a built-out UI.

## Open questions for the maintainer

The following are explicit questions the designer surfaces rather than
guesses:

1. **Source retrieval.** Can the maintainer paste the source content
   (verbatim) into the *Captured bullets* section above?
   The designer is explicitly forbidden from fabricating the bullets,
   and every automated retrieval channel failed.
   See *Source-retrieval status* for the details.

2. **Attribution and quotation.** Is verbatim quoting appropriate
   here, or should the document paraphrase each bullet under
   attribution?
   The designer defaults to verbatim quotation under "fair use for
   commentary" when the post is publicly authored, but the maintainer
   may prefer paraphrasing.

3. **Scope of analysis.** Should the per-bullet analysis stay at 2-4
   sentences as the dispatch specified, or expand to a full subsection
   per bullet (with code references, ADR-style decisions) when the
   bullet touches a topic Endo has thought about deeply?

4. **Cross-link discipline.** Should bullets that map cleanly to an
   existing design link to that design only, or should the design also
   gain a back-link to this reference document (so future readers find
   the practitioner motivation)?
   The designer defaults to one-way links unless the maintainer asks
   for the back-link pass.

5. **Reference vs. design status.** This document is currently marked
   `Status: Reference`.
   If a bullet identifies a genuine gap, should that bullet spawn a
   sibling design (as `endopi` spawned eight `endopi-*` siblings) or
   stay annotated here?

6. **Posting back to the source.** The dispatch is explicit ("Don't
   post on X").
   If the maintainer later wants to engage with Quinn's post publicly,
   that is a separate decision and requires a separate authorization;
   nothing in this document presupposes it.

## Status (Reference)

This is a reference document.
It does not enter `README.md`'s milestone tables and has no per-design
size/duration estimate.
It exists to give future builders a single place to look when a feature
request cites "Quinn Pig's screed" or AI-agent skeptic critiques more
generally.

When the maintainer fills in the bullets, update the *Updated* field
in the metadata table and the per-bullet analysis under each bullet.
The *Honest gaps* subsection of *Cross-cutting Endo posture* should be
revisited if a bullet identifies a gap the designer did not anticipate.

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
