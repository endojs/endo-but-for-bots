# Component view switching — flip between views of the same data

Source: dan's voice note 2026-07-02 (`vault/inbox/capture-20260702T032822-f2d57a.md`; filed to
`the field/TADA/plans/component-view-switching-and-trusted-path.md`). This is the **concrete marquee
feature** of that note (the trusted-path/data-flow lens is the sibling exploratory doc
[`data-flow-trusted-path-view.md`](data-flow-trusted-path-view.md); the magic-stories gallery is
[`magic-stories.md`](magic-stories.md)).

Status: **IN FLIGHT** — a view-switching worker is implementing this in `public/app.js` +
`chrome-components.mjs`. **This doc is the reference the implementer rides**; keep it in sync with
what lands. It builds directly on the alt-click selection + component-git substrate already shipped
(see `preact-component-trie.md` Phase 3 + "App chrome as registry-backed components").

## The one-sentence feature

Holding Alt/Option over a component, you can **flip through every other view of the same data** you
have access to — earlier versions of it, more-stable upstream views, and more-custom downstream
views from your social feed — and **settle on one** to make it your main view, all without leaving
the flow. It is the iPhone app-switcher gesture, but for *islands rendering the same grain*.

## Why it's coherent with the substrate (not a bolt-on)

The component trie already made a view a **stateless render propagator over data grains**
(`preact-component-trie.md` §"data GRAINS vs functional PROPAGATORS"): the data lives in a grain, the
view is just one `(endowments, props) => vnode` propagator wired to it, and swapping the propagator
leaves the grain untouched. **That is exactly what view-switching is** — hold the grain still, cycle
the propagator bound to it. Each candidate propagator is a component-git object (`component-git.mjs`),
so "other views" = other oids / other repos:

- **history** = other commits in *this* component's git lineage (up/down),
- **upstream** = the version you were forked from / the maintainer's HEAD (left),
- **downstream** = views your peers forked and shared along the trust graph (right).

Nothing new is invented at the data layer; the feature is a **selector over the fork/version graph**
plus a settle action (adopt = check that oid out as your live view — the same runtime source-swap the
Studio already does).

## The gesture spec (verbatim intent from the note)

**Entering the switcher.**
- Hold **Alt/Option** and hover a component → it lights up (the existing selection outline).
- To *edit*: **click** it (opens the component's edit chat — the shipped alt-click ✎ behavior;
  unchanged).
- To *switch views*: while holding Alt/Option, also **hold Shift** (or click a dedicated toolbar
  item — the "switch views" affordance). This distinguishes "edit this view" (click) from "try a
  different view" (hold + rotate).

**Rotating through views** (any one input; they are equivalent):
- mouse **scroll wheel**,
- **trackpad** two-finger scroll,
- **arrow keys**.

**The two axes** (this is the core mental model):
- **Up / Down — history, like a commit log.** Cycle through *versions of this same view* over time
  (the component-git lineage of this node). Down = older, Up = newer (or the reverse — pick one and
  label it in-UI; the note says "different ones in history").
- **Left — upstream / more stable.** Toward "one size fits all," the maintained/canonical view. "If
  you want something more stable, more serves-all, swipe right or hit the left arrow key." (Left =
  travel upstream toward the source.)
- **Right — downstream / more custom / social.** Toward the algorithmic, chaotic, feed-sourced views:
  "something from your feed, something a friend of a friend made, something that made it different."
  (Right = travel downstream into your social graph's forks.)

**Settling.**
- **Enter** → pop the currently-focused view into position; it becomes your main component view
  (adopt-now).
- Or reach the **end of the swap flow** and hit an **Adopt** button.
- **Before adopting** you can also **chat about it** (open its edit chat from within the switcher) and
  **learn to use it** — a "try before you adopt" beat: focus a candidate, converse with its agent,
  then adopt or keep rotating. (This is the try-on primitive the sharing model already wants —
  `preact-component-trie.md` §"Atomic upgrades … non-destructive try-it-on".)

## The feel (the aesthetic ask)

The transition should feel like the **iPhone app-switcher** — swipe up from the bottom to flip
between apps. Here it's flipping between *islands rendering the same piece of data*. dan: "It'd be a
similar kind of flow to switch between islands for rendering the same piece of data — we're just
playing with how we're viewing stuff."

- **CSS may be enough** for the shift (transform/opacity crossfade + a slight depth/parallax).
- **3D-accelerated / GPU effects would be nicer** ("really cool if we used 3D acceleration graphics
  engine type effects for this kind of shift") but are a **nice-to-have, not a blocker**. If the
  transition wants real GL, that's a host-mounted exception (see `confined-canvas.md` guardrail) —
  the *views themselves* stay confined; only the inter-view transition chrome may reach for GL. This
  overlaps the "needs an aesthetic" thread in `data-flow-trusted-path-view.md`; share the transition
  primitive if built.

## Expressiveness principle (from the note, load-bearing for the whole trie)

dan: the agent's response should ideally **always be the same framework** so it is *flexible to* and
*expressive in* the user's current modality. Views should be reused freely — "we shouldn't be shy
about using components" — with **small component-librarian agents** (tiny models) picking the right
existing view for a datatype instead of polluting a large model's context with the whole library.
"Choose the right way to make this bold in this context" is a high-frequency, low-stakes call → a
small model's job. This motivates:
- keeping every candidate view cheaply enumerable per datatype (the switcher needs a fast "what views
  exist for this grain?" query), and
- a librarian-agent seam that, on first render of a datatype, proposes the best-fit existing view
  before minting a new one.

## Implementation notes for the in-flight worker

- **Ride the shipped pieces.** Selection overlay = `componentSelect()` (app.js). Version graph =
  `component-git.mjs` (`history`, `readAt`, `fork`, `revert`). Live source-swap = the Studio
  revert/apply path (`reloadChromeComps` / `renderTx`). Confined mount = `mountChrome` / the fork
  render pipeline. Do **not** fork these.
- **Respect the trusted-path denylist.** Anything carrying `data-trusted-path` (consent sheet, Shares
  panel, powers banner, proposal cards) is **not switchable** — the same refusal `componentSelect`
  already gives for editing must cover the switcher (no rotate, no adopt, the 🔒 indicator). See
  `preact-component-trie.md` §"THE TRUSTED-PATH DENYLIST".
- **State lives in the grain, not the switch.** Rotating views must never touch the underlying grain
  — only rebind which propagator renders it. Adopt = persist the chosen oid as this node's live
  source (a git commit / a per-user pref — the same reload-durable mechanism the Studio uses).
- **Left/right needs the trust graph.** "Downstream/social" views require enumerating peers' forks
  along the capability-graph trust lines (Phase 4/5 sharing). Until that lands, **left/right can be
  scoped to upstream-HEAD + local forks only**; up/down (history) works today with just
  component-git. Ship the axes incrementally.
- **Cap hygiene.** A shared/downstream view is reached by reference along the trust graph, never by a
  rendered #cap. Do not surface swissnums in the switcher UI.

## Increments (suggested, smallest-first)

1. **Up/Down history switcher** on an already-git-backed component (local lineage only), Enter to
   adopt. No social axis. Pure component-git + a CSS crossfade. Verifiable against the Studio-seeded
   demo component.
2. **Left = upstream HEAD**, Right = local forks. Adopt-from-fork.
3. **Try-before-adopt**: open the candidate's edit chat from inside the switcher; adopt/keep-rotating.
4. **Social downstream** (right axis over the trust graph) — gated on Phase 4/5 sharing; and the
   **librarian-agent** best-fit-view suggestion on first render of a datatype.
5. **GPU transition** (optional polish; shares the aesthetic primitive with the data-flow lens).

## Related follow-up — Studio sort + fold (NOT part of this feature; do not build here)

The same note asks that the **Component Studio list be sorted**: NEEDS-REVIEW at top → MOST-USED next
→ then a **fold** hiding the long tail ("nobody looking at the components view should see every little
thing anybody ever made"). That is a small client-only `chrome-components.mjs` follow-up scoped for a
future worker (a chrome-components worker is currently in that file). Ticketed under P4/ISL in
`AUDIT-WORKLIST.md`; captured here so the switcher worker doesn't duplicate it. The switcher and the
Studio sort are independent — the switcher enumerates views *per datatype*; the sort orders the
*Studio registry list*.
