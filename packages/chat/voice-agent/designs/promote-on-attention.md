# Promote on attention — "oh, this!" turns a message (or a segment) into a shareable object

Brainstorm (dan, 2026-06-29). Trigger: a small model (gemma) produced a decent "Alameda County Fair
plan" — but as **plain markdown**, "not one of our apps." dan: *let the framework do the heavy lifting.*
An output like that should be **shareable as a page, like any component**. Which implies the general move:

> **Any message could become a shareable object — it just doesn't START as one (for performance). When a
> person says "oh, this!" they highlight a segment, and that part becomes a new object with a shareable link.**

This is **lazy reification**: objects are born from *attention*, not from generation. You pay the cost of
identity + confinement + a cap only for the things someone actually points at. The transcript stays a cheap
stream; promotion is how you pull a durable, composable, shareable *thing* out of the stream.

## The good news: the rails already exist (this is mostly a seam, not a build)

Everything the promoted object needs is already in the framework:
- **break-out** (`/components/break-out` → `componentGit.commit` → `/c/<id>` page) — source → versioned git
  object → standalone confined page. (server.mjs:2432; app.js:801 `breakOutComponent`.)
- **shares** (`component-shares.mjs` + `/components/share`) — a least-authority, **revocable**, optionally
  metered `#k=<token>` link; token hashed on disk, copied/QR'd, never rendered (cap-hygiene).
- **the confined renderer** — `renderConfined`/`confineComponent` runs ANY `(ui)=>vnode` function sandboxed;
  `renderWidgets({type:'component', source, cells})` already mounts one inside a message.
- **component-git** — the object is versioned + forkable + revertable + alt-click-editable (rides the
  live-editable-everything plan: a promoted thing is immediately "talk to its agent, edit it live").
- **publishSite** (`/sites/<token>/`) — the static-page variant, with the inline `site-preview` card
  (now with Expand/Share).

**The only missing piece is the gesture:** *select text in a message → promote it.* No new server endpoints
are required for the content grade.

## Three grades of promotion (same gesture, framework picks/offers the fidelity)

The selected segment can be reified at increasing fidelity. Default to the cheapest that captures it; offer
"make it an app" for more. The gesture ("this!") is identical; the framework decides the grade.

1. **Content grade — a "clipping page" (instant, no LLM).** Wrap the markdown segment as a confined component
   that renders it (a styled doc card). → a `/c/<id>` page + a share link, immediately. The fair plan becomes
   a shareable fair-plan page in one tap. This is the baseline "shareable as a page, like any component."
   *Cost: one git commit. No agent call.*

2. **App grade — a "reified app" (the heavy lifting).** The framework RE-EXPRESSES the segment's *intent* as a
   real component: the fair schedule → a timeline with check-off; the food guide → a filterable allergy list.
   This is a scoped micro-agent task ("turn THIS selection into a confined component") via the apps-on-the-fly /
   customView / proposeTool path — the agent + the renderer already do this; promotion just points them at the
   selection. *Cost: one small LLM task, paid only when asked.*

3. **Live grade — a grain-backed object.** If the segment references live data (an HA entity, a GPU lease, a
   contact, a countdown), promotion binds it to declared cells → the shared page stays LIVE + cell-gated +
   revocable (the existing component-shares cell model). *Cost: cell wiring; only when the content is live.*

## The interaction — "this!" as a first-class verb

- **Select → a floating chip.** Selecting text in ANY bubble (yours or the agent's) pops a small chip by the
  selection: `✦ make this · 🔗 share · 🧩 app`. Like the OS text-selection menu, but for reification. (There is
  no selection→promote handler today — app.js only *guards against* clobbering selections; this is the seam.)
- **Mobile-first.** long-press → native selection → the chip (dan lives on his phone). The chip's primary
  action is **Share** (content grade + mint link + copy/QR) — the fast 90% path.
- **Spoken designation.** "share that schedule" / "make the food list an app" → the agent resolves the segment
  by reference and promotes it. Designation-IS-authorization in language (ties to the spoken-designation
  memory): careful words pick the segment; the chip is just the visual form of the same verb.
- **After promotion, the segment is marked** — a subtle left-border / 🔗 badge in the message shows "this is
  now an object." Re-selecting it offers Open / Re-share / **Revoke** (the owner keeps the revoker).
- **Whole-message** is just the degenerate selection (select all) — a per-message ⋯ → "make this a page"
  covers "promote the whole reply" without a drag.

## The deeper model dan named: messages are LATENT objects

- A message has a stable *address* (chatId + index, or a content hash) but **no reified identity** until
  promoted. Promotion mints the identity on demand.
- **Idempotent by content** — promoting the same segment twice resolves to the SAME object (hash-keyed), so
  "this!" is stable, never duplicative. Re-share returns the existing link.
- The promoted object joins the **component trie** (the preact-component-trie direction): a git object,
  forkable, shareable, owned by a micro-agent you can alt-click to edit. **The chat becomes a source of
  objects, not just a transcript.** This is the chat-as-window-manager / Endo-OS thesis made concrete: the
  stream is ephemeral; the durable, shareable, composable world is the promoted objects.
- **Multi-user fit** (the per-user-namespace work): a promoted object lands in the promoter's namespace; a
  share hands others a read facet — least authority, revocable, isolated.

## Performance + laziness (dan's constraint, honored)

- Messages stay plain markdown → **zero object cost** by default.
- Promotion is on-demand → identity/confinement/cap created only on gesture.
- Content grade = one commit (cheap); app grade pays an LLM task only when asked.
- **Pre-warm hint (optional):** the agent can FLAG promotion-worthy segments (a faint affordance) WITHOUT
  reifying them — a hint that "this is promotable," not a commitment. Cheap nudge, no object until the tap.

## Security / cap model

- Promoted object = a confined component (lexical confinement + the renderer sandbox). Content grade leaks no
  authority (it's rendered markdown). App/live grades share only declared cells (existing gating).
- Share link = least-authority, revocable, metered token (`#k=`); copy/QR, **never render the swissnum**; the
  owner holds the revoker (forwarder/revoker pair). All of this is the existing share rail.

## Smallest shippable slice → then grow

1. **`promoteSelection()` (content grade).** Select in a bubble → chip → wrap the selected markdown as a
   confined "doc" component (a generic island that takes `markdown` as a prop + renders it) → POST the existing
   `/components/break-out` → mint a share via `/components/share` → copy the `/c/<id>#k=` link. **No new server
   code.** This alone delivers "any output is shareable as a page."
2. **Promotion marker + idempotence.** Hash the selection → if already promoted, reopen/re-share. Mark promoted
   segments in the transcript; persist the (segment-hash → component id) map per chat.
3. **App grade.** Add "🧩 app" → a scoped micro-agent task that reifies the selection into a real component
   (apps-on-the-fly). The agent owns it; alt-click → edit live.
4. **Live grade + voice.** Bind referenced entities to cells; wire spoken "share that" to the same verb.

## Open questions for dan
- **Default grade on the fast tap:** content (instant, static) vs always offer app? (I lean: tap = content +
  share; a second affordance = "make it an app.")
- **Naming the thing:** "clipping" / "shard" / "object" / "card" / just "a thing"? And the verb on the chip
  ("Make this" / "Reify" / icons only)?
- **Whole-message default:** should every agent reply get a quiet ⋯→"make a page", or only on selection?
- **Pre-warm hints:** worth the agent flagging promotable segments, or keep it purely user-initiated?
