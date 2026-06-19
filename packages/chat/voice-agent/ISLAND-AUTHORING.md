# Authoring a field-agent island (the propagator-by-default prompt)

This is the canonical guidance for anyone — a human or a per-component micro-agent — building or
editing an **island** (a confined-Preact slice of the field-agent UI). It is exported verbatim as the
system prompt `ISLAND_AUTHORING_PROMPT` (`island-prompt.mjs`) so island-authoring agents build
in the house style by default. Pattern-level and public-safe.

## The one rule: islands are PROPAGATORS over CELLS, not stateful components

Build every island as a **propagation network** (Radul & Sussman) — never as a component that owns
mutable state.

- **State lives in CELLS (data grains).** A cell *accumulates information about a value*: write with
  `addContent` (it **merges**, it does not blind-overwrite), read with `read`, and react with
  `subscribe`. The cell notifies its neighbours on change. Use `makeCell(initial?, merge?)` from
  `./propagator.js`. Default merge is last-writer-wins; choose a monotonic merge (`unionSet`, `max`,
  `mergeEqual`) when the grain should only ever gain information.
- **Logic and UI are PROPAGATORS — stateless.** A propagator reads input cells, runs a pure function,
  writes an output cell, and re-fires when an input changes. It holds **no state of its own**. Use
  `propagator(inputs, fn, output)` / `lift(fn)` for logic, and a **render propagator** (`react` +
  `renderConfined`) for UI. A component function must be pure: `(props) => vnode`. No `useState` for
  app data — that state belongs in a cell. (Transient view-only state like "is this menu open" may use
  a local cell or a hook, but anything another part of the app could read or change is a cell.)
- **A propagator's authority IS the cells it is wired to.** Nothing else is in scope. Confinement is
  structural: to limit what an island can touch, wire it to fewer cells.

Why: cells + propagators **compose additively** — you add a propagator or a cell to the network
*without modifying* the existing ones, and it interoperates. That is what lets a component be forked,
swapped at runtime, and shared along the trust graph safely.

## The API (`client/propagator.js`)

```js
import { makeCell, propagator, lift, react, NOTHING,
         lastWriteWins, mergeEqual, unionSet, max } from './propagator.js';

const a = makeCell(), b = makeCell(), sum = makeCell();
propagator([a, b], (x, y) => x + y, sum);   // sum stays NOTHING until BOTH inputs have content
a.addContent(3); b.addContent(4);            // sum.read() === 7
a.addContent(10);                            // sum re-computes → 14   (re-delivering 10 is a no-op)

react([sum], v => console.log('sum is', v)); // a side-effecting propagator (e.g. a render)
```

## Rendering — always confined, never the live DOM

Render only through `renderConfined(vnode, el)` from `@endo/preact-container/renderer` (re-render by
calling it again with the same `el`). It strips refs, removes dangerous tags/attrs, and hands event
handlers a frozen `SafeEvent` — no live DOM, no real `DataTransfer`. Never reach for preact's raw
`render` or `HostPassthrough`. A render propagator is just `react([cells…], (…vals) =>
renderConfined(view(…vals), el))`.

## Cap-hygiene (non-negotiable — stack-wide)

- **Never put a swissnum / secret / `#cap` into a cell, a prop, or the rendered DOM.** Feed islands
  only render-safe data (labels, tags, counts). Keep the secret in the host's closure and expose
  **index- or id-based callbacks** the island can invoke (`onRevoke(i)`), so the island designates an
  action without ever holding the authority.
- An island gets exactly the cells + callbacks it needs — least authority, by construction.

## Worked reference: the Shares island

`shares-panel.js` is a **pure view**: `({ items:[{label,tag}], onCopy, onQr, onRevoke }) => vnode`.
`islands.js` owns a `sharesCell` (the grain) and wires a render propagator `cell → SharesPanel`. The
host (`app.js`) never re-renders imperatively — it pushes render-safe rows into the cell
(`renderShares(el, items, handlers)` → `sharesCell.addContent(items)`), and the propagator re-paints.
The swissnum stays in `app.js`; handlers index back into it. Copy this shape.

## Checklist before you ship an island

- [ ] State is in cells; the component/render fn is pure and stateless.
- [ ] Wired only to the cells + callbacks it needs (least authority).
- [ ] Renders through `renderConfined`; no raw DOM, no `HostPassthrough`.
- [ ] No swissnum/secret in any cell, prop, or the DOM.
- [ ] Re-delivering the same fact is a no-op (the merge makes propagation order-independent).
