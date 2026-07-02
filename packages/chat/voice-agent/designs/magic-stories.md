# Magic Stories — a gallery of flows this harness made possible

Source: dan's voice note 2026-07-02 (`vault/inbox/capture-20260702T032822-f2d57a.md`; filed to
`the field/TADA/plans/component-view-switching-and-trusted-path.md`). One of the follow-on ideas
around the component-view-switching feature.

Status: **DESIGN + TICKET** (see §"Ticket" at the end). Build after the view-switcher; the collector
half can start early (it's cheap and it's the thing that must not be missed while we ship everything
else).

## The idea

A **magic-wand toolbar item** opens a **"Magic Stories" gallery**: a fun, curated, **identity-
sanitized** collection of interesting flows the system made possible. dan: "It's just a fun-filled
gallery of some interesting stories, sanitized from identity implications, representing different
flows that were made possible by this system."

**The point is advocacy.** The stories exist to make it *obvious why this harness is superior* — so we
can show people how powerful it is and build a collaborative society around it. They are the payoff for
all the plumbing: "all this other stuff is just making the bed so we can collect a lot of really
wonderful stories."

## What makes a good story (the selection bias)

Especially favor flows that showcase the qualities **only** an object-capability substrate gives you:

- **Multi-hop delegation** — a capability passed hand to hand, attenuating at each edge, arriving
  usable but least-privilege. (Our delegation graph is real; these are the stories it tells.)
- **Composition** — dan's canonical example: *"a person can share their digital device with someone
  else, who can then compose it with their agent to do something creative."* One person's cap + another
  person's agent = an emergent capability neither had alone. That is the harness's superpower made
  legible.
- Bonus qualities to look for: revocation caught misuse; a confined component that provably couldn't
  exfiltrate; a fork shared downstream that a stranger improved; a paid/tolled cap that composed with
  a free one. The GpuLease/GPU-Studio share-a-real-lease flows, the rover single-affordance shares,
  and the dietician composition are ready-made candidates.

These are the flows that make the ocap thesis concrete instead of abstract.

## Two halves: the GALLERY and the COLLECTOR

### The gallery (the showcase)

- A **magic-wand (🪟→🪄) toolbar item** opens the gallery view (its own island — a `chrome-magic-
  stories` component in the registry, riffable like any chrome; NOT trusted-path).
- Each card: a short title, a one-line "what made this possible" (the ocap quality it demonstrates),
  and — where safe — a **replayable trace** or a still of the flow (the delegation/composition edges,
  the *shape* of the flow, never the secrets).
- Sanitized-by-construction: cards are the *sanitized* artifact; the gallery never reaches raw chats.

### The collector (the action-item mechanism — the part that must not be forgotten)

dan: "We should make an action item of collecting these little magical stories as we go." The gallery
is worthless without a steady inflow. Proposed mechanism, three small pieces:

1. **A "⭐ save as story" affordance.** In every message's corner action strip (alongside the shipped
   🔗 clip / 📋 copy — reuse `chrome-msg-toolbar`), a **⭐** that nominates *this flow* as a story. It
   captures the message + its trace context (the delegation/composition edges from the trace cell) as
   a story *candidate*. This piggybacks on the promote-on-attention / clips machinery
   (`designs/promote-on-attention.md`) — a story is a clip with a "showcase" grade and an ocap-flow
   payload. Alt: an agent-side `proposeStory({title, flow, why})` verb so the agent can nominate a
   flow it just pulled off (mirrors `proposeImprovement`).
2. **A sanitizer pass.** Before a candidate can enter the gallery it goes through **identity
   sanitization** — reuse the built-in `readChatSanitized` sanitizer (`chat-corpus.mjs`: emails/
   phones/≥16-hex tokens → placeholders, ~8KB clamp) plus a cheap local (gemma) pass to strip names,
   places, and personal specifics while keeping the *structure* of the flow. **No raw swissnum, no
   #cap, no PII ever reaches a story** (stack-wide `cap_hygiene_no_render` + the self-eval sanitizer
   discipline). Sanitization is mandatory and happens *before* persistence, not at render.
3. **A stories store.** A small append-only store (`stories.mjs` over the same `~/.local/state/voice-
   agent/` pattern, or a `stories:` cell if we want it live-subscribable) holding the sanitized
   candidates with a review flag. dan (or a granted reviewer) promotes a candidate → published; the
   gallery renders only published stories. This mirrors the review gate everywhere else in the stack
   (component distribution, backlog merges).

Flow: **⭐ nominate → sanitize → candidate (needs review) → dan promotes → published in the gallery.**
The needs-review queue for stories can surface in the same 🔔 inbox the staged-branch/proposal cards
use.

## Why the collector is P-early even though the gallery is P-later

The gallery is polish; the **collector is not** — every good story we don't capture *as it happens* is
lost (the trace context evaporates, the moment passes). Stand up the ⭐ affordance + sanitizer +
store first so stories accrue while the rest of the roadmap ships. The gallery can render an empty
state until there's a corpus. This is the whole "making the bed" point.

## Guardrails

- **Sanitize before persist, never at render.** A raw personal detail must never be written to the
  stories store. The store holds only sanitized artifacts.
- **No caps, ever.** Stories show the *shape* of a delegation/composition flow (who-ish → who-ish,
  which affordance, attenuated how), never a swissnum/#cap. Designation by reference stays out of the
  gallery entirely.
- **Not trusted-path.** The gallery is expressive content chrome (riffable). The *consent surfaces* it
  might depict are shown as sanitized stills, not live trusted-path elements.
- **Review-gated publication.** A candidate is never auto-published; promotion is a human (or granted-
  reviewer) act — a social-collateral trust act like the rest of distribution.

## Ticket

**MAGIC-STORIES-1 · Story collector (P-early, do first).** Add ⭐ "save as story" to the message
action strip (extend `chrome-msg-toolbar`, host callback `onSaveStory`) + an agent `proposeStory`
verb; a mandatory sanitizer pass (reuse `chat-corpus.mjs` sanitizer + a local gemma name/place strip);
a `stories.mjs` append-only candidate store with a needs-review flag surfaced in the 🔔 inbox. Effort
M. Client + one small store + one route; no new authority (the ⭐ callback is host-gated, the payload
is the already-flowing trace context). **MAGIC-STORIES-2 · The gallery (P-later).** A magic-wand
toolbar item → `chrome-magic-stories` island rendering published (sanitized) stories, with an empty
state; dan-promotes-candidate action. Effort M. Both favor multi-hop-delegation / composition flows as
the marquee examples of why the harness is superior.
