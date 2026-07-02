# The data-flow lens — capability flow in the trusted path (the escape key)

Source: dan's voice note 2026-07-02 (`vault/inbox/capture-20260702T032822-f2d57a.md`; filed to
`the field/TADA/plans/component-view-switching-and-trusted-path.md`). This is the **exploratory second
lens** that framed the concrete component-view-switching feature
([`component-view-switching.md`](component-view-switching.md)). dan called it "a sort of prologue" —
it is design-now / build-later.

Status: **DESIGN — not scheduled.** Concrete increments below; the first is cheap and rides shipped
pieces (the trace island + the trusted-path denylist).

## The idea in one breath

We render data through components (islands) wired by **capabilities and propagators**. Today you can
*view* the data, and (soon) *switch views* of it — but there is no way to see **how the data got
here**: which capabilities carried it, along which propagator edges. dan wants a **second lens** that
reveals the **data / capability flow underneath the component layer**, and he wants that lens to live
in the **trusted path** — because seeing how you are enabled, and getting out of an immersive
experience, is a *trust* act, not a content act.

## The layered gesture (a second modifier on top of selection)

- The existing **Option/Alt** layer highlights components (selection).
- Add a layer: **Option + Shift held together** (or a distinct toolbar icon) → reveal the **data-flow
  view** for what's under the cursor. This is deliberately parallel to the component-view switcher's
  own Option+Shift/toolbar affordance — they are two lenses reached the same way; keep the entry
  gestures legible and distinct (the switcher rotates *views of the data*; this lens reveals *the flow
  of the data*).

## Why this belongs in the trusted path (dan's argument, verbatim intent)

> "You want someone to be able to enter an experience fully, but if they enter fully, they need the
> trusted path for getting out. You need that little escape key. You need the way to say, I want to
> look at this differently — and that's where the trusted-path renderer comes in."

Data-flow / capability-flow is **exactly the information you must not let an immersive experience
suppress or forge**. An immersive island could lie about what it's connected to; the *trusted path*
can't be edited by the island (that is what makes it trusted). So the flow view is the honest,
un-spoofable answer to "what is this, really, and how do I leave it?" — the escape hatch.

**Concretely: fibers of the trace belong in the trusted path.** dan: "We've talked about trace as one
component, but the trace's job might be a little bit more related to the trusted path. We may find
that there are fibers of the trace that belong in the trusted path." Today the trace is a *content*
island (`chrome-trace-view`, the cell-fed 2D fan-out; see `preact-component-trie.md` §"cell-as-
interface pattern"). The proposal: **split the trace.** The *expressive, riffable* visualization stays
editable content chrome; but a **thin, un-editable fiber** — the actual capability/data-flow edges +
the escape control — is promoted into the **trusted path** (the `data-trusted-path` denylist:
`preact-component-trie.md` §"THE TRUSTED-PATH DENYLIST"). The denylist already protects the consent
sheet, Shares panel, powers banner, and proposal cards — the flow-fiber joins that family: an element
inside a `[data-trusted-path]` container that **cannot be given a component identity**, cannot be
alt-selected, cannot be forked — so an experience can never repaint or hide "how you got here" or "how
to get out."

## The aesthetic (the Liquid-Glass riff — a real moment that needs a look)

dan: "We may need to incorporate the GPU here, because it's a thing that needs to be inherently
subtle, unobtrusive, but ever-present. When Apple released Liquid Glass, they wanted an aesthetic
worthy of their new moment, but they didn't really have a new moment their aesthetic was worthy of. I
think we may have something that actually needs an aesthetic — how to show how things are differently
enabled, and how to get out of them."

The design target is a **subtle / unobtrusive / ever-present** treatment for the trusted path: always
there at the edge of perception, never grabbing attention, but instantly legible when you reach for
it. This is the one place where reaching for the **GPU** is justified even though the *content* layer
defaults to confined CSS/canvas (`confined-canvas.md`): the trusted-path renderer is host-owned by
definition (it must not be confined-editable), so a host-mounted GL treatment is *architecturally*
allowed here — the same exception the trace pendant already takes. Share the transition/aesthetic
primitive with the view-switcher's optional GPU shift (`component-view-switching.md` §"The feel").

Aesthetic requirements, distilled:
- **Ever-present but recessive** — an edge/ambient treatment, not a panel that occludes the
  experience. It should read as "the frame of reality," not "another window."
- **Reveals differential enablement** — the *look* itself should encode *how this thing is enabled
  differently from that thing* (which caps it holds, what it can reach). Enablement made visible.
- **Is the escape** — invoking it is also how you leave: the flow view and the exit are the same
  surface. "How things are differently enabled, and how to get out of them" is one design, not two.

## Concrete increments (design-now, build-later)

1. **Flow overlay from the existing trace cell (cheap, no new authority).** On Option+Shift over a
   component, render an overlay listing the **capability/propagator edges** that fed the data under
   the cursor, sourced from the already-flowing trace cell (`trace-cells.mjs` / `/chat/steps`). Pure
   host read; no new caps. This is the MVP of "see the flow" and validates the gesture. Still content
   chrome at this stage.
2. **Split the trace: promote the flow-fiber into the trusted path.** Extract the un-editable
   edges+escape control into a `data-trusted-path` element; leave the expressive viz as editable
   `chrome-trace-view`. Add the denylist assertions to the chrome staging suite (the flow-fiber can
   never acquire a component identity; alt-click yields the 🔒 refusal) mirroring the consent-sheet
   test. This is the load-bearing trust increment.
3. **The escape-key affordance.** A single, always-reachable trusted-path control = "look at this
   differently / get me out." Bind it so that from *inside* an immersive island the user can always
   surface the flow lens and step out — the literal escape key. Coordinate the keybinding with the
   view-switcher so the two lenses don't collide.
4. **The aesthetic layer (GPU, optional).** The subtle/ever-present Liquid-Glass-grade treatment for
   the trusted-path frame + the enter/exit transition. Host-mounted GL exception, justified per
   `confined-canvas.md`. Do this last — increments 1–3 deliver the *function*; this delivers the
   *feel*.

## Guardrails (do not regress)

- **The trusted path is not editable chrome — ever.** The flow-fiber joins the denylist; it must not
  be alt-selectable, forkable, or tag-able. Enforced by the explicit `data-trusted-path` mechanism,
  not by omission (`tagComponent` refusal + `componentSelect` 🔒 refusal + a staging assertion).
- **Cap hygiene.** The flow view shows *that* an edge exists and *what kind* of authority it carries —
  never the swissnum. No #cap, no swissnum in the DOM/overlay (stack-wide `cap_hygiene_no_render`).
  Designation by reference; render the shape of the flow, not the secret that grants it.
- **Read-only lens.** This lens *reveals*; it never grants, revokes, or mutates authority. Grant/
  revoke stays in the Shares panel (already trusted-path). The flow view is the map, not the steering
  wheel.
