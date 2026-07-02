# Trace-Viz Paradigm: **Provenance / Causality Node-Link DAG**

*One of a gallery of "how a complicated agent task was completed" views. This one answers*
***WHY this result — what evidence and authority does the final answer rest on?*** *It renders the
lineage: which tool results, sub-agent answers, and retrieved data actually flowed into the
conclusion, and — first-class here — which **capabilities** authorized each derivation.*

Grounded in the live cell: `trace-cells.mjs` (`trace:<sid>`), shape
`{ turn, status, progress, rev, truncated, steps:[…], nodes:[…] }`.

---

## 0. What is actually in the data (read this first)

From `trace-cells.mjs` the render-safe snapshot gives us exactly:

**`steps[]`** — the linear tool/reasoning timeline of a turn. Each settled step:
```
{ i, name, status:'running'|'done', ok:bool, detail?, call?(≤4000), result?(≤4000),
  children?:[{name,detail}]   // sub-agent / delegate fan-out under this step
  granted?:[powerName,…]      // CAPABILITIES granted while this step ran  ← ocap gold
}
```
**`nodes[]`** — the live research sub-tree (upserted by key):
```
{ key, parent?, kind?, label?, detail?, state?('running'|'done'|'fail'), info? }
```

Two structural truths shape the whole design:

1. **The tree is explicit, the dataflow is not.** `nodes[].parent` and `steps[].children` give us a
   *containment/spawn* tree for free. What produced-what — step B *consumed the result of* step A —
   is **almost never recorded as an edge.** We must **infer** consumption edges (§3.4). The paradigm
   is honest about this: inferred edges render differently from asserted ones.
2. **`granted` is an authority edge, not a dataflow edge.** It says "this step was handed capability
   *X* to run." That is the provenance of *authority*, which in an ocap system is as important as the
   provenance of *data* — and it is the thing dan cares about (trusted path, differential enablement).
   No other view in the gallery makes authority a drawable edge. This one does.

---

## 1. The analysis this view makes effective

A causality DAG is the right lens for questions of the form *"is this conclusion sound, and on what
does it stand?"* Concretely, for agent traces:

- **Lineage / derivation.** Trace any node backward: click the final answer → its entire ancestry
  lights up (the tool calls, retrieved docs, and sub-agent verdicts that fed it) while everything
  irrelevant dims. This is the "what did the answer actually depend on" query, answered as a subgraph,
  not a scroll.
- **The failed-tool-laundered-into-a-conclusion bug.** The single highest-value defect in agent runs:
  a tool call returned `ok:false` / empty, yet a downstream synthesis cites it as if it succeeded.
  In a timeline this is invisible (you'd have to read every result). In a DAG it is a **red node with
  a live consumption edge into the answer** — it *pops*. This view is purpose-built to surface exactly
  that. (See splash, §5.)
- **Dead weight / unused retrieval.** Nodes with no path *to* the answer are **orphan branches** —
  work the agent did that changed nothing (a search it ran and ignored, a sub-agent whose answer was
  dropped). They render recessive and off to the side; spotting them tells you the agent over-fetched
  or got distracted.
- **Authority provenance (the ocap angle).** Because `granted` is a first-class edge type, you can ask
  *"what capabilities did reaching this answer require?"* Focus the answer node and the ancestry
  includes the **capability nodes** that authorized each step: e.g. the answer rests on a step that
  held `home-assistant` and `email-send`. This is the drawable form of dan's **data-flow / trusted-path
  lens** (`designs/data-flow-trusted-path-view.md`): "how you are enabled, made visible." A conclusion
  that quietly depended on a high-authority cap (host shell, email send) is now *legible at a glance* —
  you can see that a summary you're about to trust was produced by a step that also held send-email
  authority. That is trusted-path reasoning rendered as a graph.
- **Delegation accountability.** `children` (sub-agents) become their own nodes with their own
  in/out edges — you see not just *that* a delegate ran but *whether its answer was used*, and under
  *what* sub-set of authority (least-privilege check: did the delegate's granted caps ⊆ the parent's?).

No other gallery paradigm answers "why / on what evidence / under what authority." Timelines answer
"in what order"; flamegraphs answer "where did time go"; this answers **"what is this conclusion made
of."**

---

## 2. Grounding — the tradition, and what transfers

| Tradition | What it is | What transfers here |
|---|---|---|
| **W3C PROV** (`prov-dm`) | Standard model of provenance: **Entity / Activity / Agent** + relations `wasGeneratedBy`, `used`, `wasDerivedFrom`, `wasAttributedTo`, `wasAssociatedWith`. | Direct isomorphism. **Activity = step**, **Entity = a result/retrieved datum**, **Agent = a sub-agent or the capability that acts**. `used` = *consumed*, `wasGeneratedBy` = *produced*, `wasAssociatedWith` = *granted/authority*. We are literally drawing a PROV graph of an agent turn; borrow its edge vocabulary and its "everything derives from something" discipline. |
| **Dataflow / def-use graphs** (compilers, program slicing) | Nodes = definitions & uses of values; edges = a use consuming a def. **Backward slice** = "everything this value depends on." | The ancestry-focus interaction *is* a backward slice. The def-use matching heuristic (a later use references an earlier def) is exactly our consumption-edge inference (§3.4). "Reaching definitions" analysis = "which prior result reaches this step's input." |
| **Sankey / lineage flow viz** (data-lineage tools, OpenLineage, dbt DAGs) | Left→right layered flow of how datasets derive from datasets; edge weight = volume. | Layout: **left-to-right layered DAG** reads as "evidence flows toward the answer." We borrow the layering (sources on the left, answer on the right) and the sense that the answer is a *confluence*. We do **not** borrow weighted ribbons (we have counts, not volumes — a ribbon would over-claim precision). |
| **Neo4j / graph-DB node-link** (property graphs, force layout) | Typed nodes + typed edges, colored by label, force-directed, click-to-expand-neighborhood, hover-for-properties. | The **interaction grammar**: color by node *kind*, edge style by relation *type*, expand a node's neighborhood, hover a node → property card. This is the mainstream mental model users already have for "a graph of typed things" — lean on it so the view needs no manual. |

The synthesis: **PROV gives the semantics, def-use gives the inference + the slice interaction, Sankey
gives the layout intuition, Neo4j gives the interaction grammar.** All four are mature; none of it is
novel plumbing — the novelty is applying it to an *agent turn* and adding **capability edges**.

---

## 3. Visual encoding (exact, opinionated)

### 3.1 Node types

| Kind | Source in data | Shape | Fill (see palette) | Notes |
|---|---|---|---|---|
| **Step / activity** | `steps[i]` (a tool call or reasoning move) | **rounded rect** (an *activity* — it happens) | category-blue | the workhorse node; label = `name`, sublabel = `detail` |
| **Sub-agent** | `steps[].children[]`, and `nodes[]` with `kind:'agent'` | **hexagon** (an *agent* — it acts on its own) | category-violet | delegate / specialist; distinct silhouette so fan-out is scannable |
| **Data / entity** | a `result` or `nodes[]` with `kind:'source'|'doc'|'result'` | **cut-corner rect / "document" tab** (a *thing*, at rest) | category-teal | a retrieved doc, a search hit, a settled result value |
| **Capability** | each string in `steps[].granted[]` | **diamond / key glyph** | category-amber | authority, not data. Deliberately a different *class* of shape so cap edges never read as dataflow |
| **Answer** | terminal synthesis (last `ok` step of the turn, or a step named `answer`/`final`/`respond`) | **large rounded rect, ring outline** | category-blue, heavy stroke | the sink; anchored at the far right; the "why does this exist" target |

Node **state** overrides fill saturation, never hue-family, so kind stays readable:
- `running` → pulsing dashed stroke, ~70% fill opacity.
- `done` + `ok` → solid.
- `done` + `ok:false` / `state:'fail'` → **red stroke + red warning pip**, fill desaturated. This is the
  one place hue is overridden — failure must be unmissable.
- `truncated` (cell hit `MAX_STEPS`/`MAX_NODES`) → a ghost "+N more" node (§6).

### 3.2 Edge types (the heart of it)

| Relation | PROV analog | Drawn as | When |
|---|---|---|---|
| **produced** | `wasGeneratedBy` | thin solid, arrow step→data | a step emits a `result` / creates a `nodes` entity |
| **consumed** | `used` | **solid, arrowhead into consumer** | step B used the output of A/data D. **Mostly inferred** (§3.4) → inferred ones are **dashed + lower opacity** |
| **spawned** | `wasAssociatedWith`(delegation) | **double-line / chevron**, parent→child | `steps[].children`, `nodes[].parent` with agent kind (explicit — solid) |
| **granted** | `wasAssociatedWith`(authority) | **amber, dotted, diamond-tail**, capability→step | `steps[].granted[]`. Visually unlike dataflow so authority never masquerades as evidence |
| **derived (fallback)** | `wasDerivedFrom` | light gray, dashed | tree containment we can't type more specifically (`nodes[].parent` with no better signal) |

Edge direction convention: **causality flows left→right toward the answer.** An arrow always points
from cause to effect (evidence → conclusion, capability → step-it-authorized).

**Asserted vs inferred is a visible, load-bearing distinction.** Solid = we have it from the data
(`children`, `parent`, `granted`, a step that literally emitted a `result`). Dashed = we inferred it
(§3.4). A legend line states this plainly: *"dashed edges are inferred from timing & text matching,
not recorded dataflow."* Honesty is a feature — a user must never mistake a guess for a fact when the
whole point of the view is trustworthy provenance.

### 3.3 Layout

**Layered DAG (Sugiyama), left→right**, as the default:
- **Layer assignment** = longest-path from any source (a node with no incoming consumed/produced edge).
  Sources (initial retrievals, the user's request node) pin to the leftmost layer; the **answer pins to
  the rightmost layer** regardless of computed depth (semantic anchor — the eye always finds the
  conclusion on the right).
- **Within-layer ordering** = barycenter of neighbors (standard crossing reduction) with a tiebreak on
  step index `i` (preserves temporal reading top-to-bottom within a layer).
- **Capability nodes** float in a thin **top gutter lane** above the step they grant, connected by the
  short amber dotted edge — they don't participate in layer/crossing math (they'd distort it and they're
  a different semantic plane). Reads as "authority raining down onto the timeline."
- **Orphan/unused branches** (no path to the answer) sink to a **muted bottom lane**, dimmed — present
  but clearly "did not contribute."

**Force-directed** is the alternate layout (toggle), for when the graph is large/dense and the layered
view gets tall: a WebGL force sim (§4) with the answer node given a strong right-anchor and sources a
left-anchor so the causal gradient survives. Layered is default (traces are usually modest DAGs and
layering reads best for lineage); force is the escape hatch for the occasional 200-step monster.

### 3.4 Inferring consumption edges (be honest)

Explicit dataflow is rarely recorded, so we infer, in priority order, and **mark every inferred edge
dashed**. A confidence score (0–1) drives dash density / opacity so weak guesses look weak:

1. **Result→argument text match (strongest, ~0.9).** Tokenize each step's `call` (its arguments, ≤4000
   chars) and each prior step's `result` (≤4000). A distinctive shared substring — a URL, an id, a
   quoted phrase, a filename, a number ≥4 digits — that appears in a *later* `call` and an *earlier*
   `result` = a consumed edge from the earlier step to the later one. (Ignore stopwords/common tokens.)
   This is classic def-use matching and it is the reason `call`/`result` are carried at 4000 chars.
2. **Sub-agent answer → next synthesis (~0.7).** A `children`/agent node that settles, immediately
   followed by a step whose `name` implies synthesis (`answer`, `summar*`, `synth*`, `write`, `respond`)
   → the delegate's answer was consumed by that synthesis. Temporal adjacency + role.
3. **Named-tool convention (~0.6).** Known producer→consumer pairs (`search`→`fetch`→`read`→`answer`;
   `retrieve`→`rerank`). A small built-in adjacency table over common `name`s.
4. **Sibling-under-parent → parent-settle (~0.5).** `nodes[]` children of a `parent` feed that parent
   when it transitions to `done` (research sub-tree rollup).
5. **Temporal fallback (~0.3, only if a step would otherwise be a source).** The final synthesis step,
   if it has no inferred inputs, is tentatively fed by the last N settled `ok` results (so the answer is
   never left dangling). Rendered at lowest confidence — the faintest dash.

**The uncertainty is surfaced, not hidden.** Hovering an inferred edge shows *why* we drew it
("shared token `docket-1994` in fetch result → synthesis args"). A global toggle **"inferred edges:
on/off"** lets a skeptic collapse to only the asserted skeleton (`granted`, `children`, `parent`,
explicit results) and see the *provably* recorded provenance alone. This directly serves the
trusted-path ethos: the honest graph is available, the helpful-but-guessed overlay is opt-out.

### 3.5 Color / shape summary

- **Hue = kind** (blue step, violet agent, teal data, amber capability). Fixed, categorical, from a
  colorblind-safe set; identical mapping in light and dark themes (per the theme-matrix guard —
  register any new trace-viz colors in both palettes).
- **Shape = PROV class** (rect=activity, hexagon=agent, document=entity, diamond=capability) so kind is
  legible even to a colorblind user and even at zoom where fill washes out.
- **Saturation/stroke = state** (running pulse, ok solid, fail red).
- **Edge style = relation** (solid produced/spawned, dashed inferred-consumed, dotted-amber granted).
- **Position = causal role** (left=source, right=answer, top gutter=authority, bottom lane=unused).

Five independent visual channels, five orthogonal data dimensions — no channel overloaded.

### 3.6 Live growth animation (the cell updates by `rev`)

The cell is monotonic append-only; the view mirrors that and **never rewinds**:
- New `start` step → node **fades in** at its layer with a running-pulse; its inferred input edges draw
  as **animated dashes** (a short "flow" shimmer along the edge) so you see evidence *arriving*.
- `done` → the node's pulse resolves to solid; `ok:false` snaps to red. Any `granted` caps drop in from
  the top gutter with their dotted edges.
- A **re-layout is incremental**: new nodes get provisional coordinates immediately (appended to the
  right of their inferred parents) and the layered solver only *eases* existing nodes toward new
  positions (spring tween, ~250ms) so the graph never jumps — you can watch a turn *assemble*.
- The **answer node grows in last**, at the right anchor, and the moment it settles, a one-shot
  "ancestry sweep" briefly pulses its full backward slice (the lineage) — the view's signature moment:
  *here is everything that answer stands on.*
- `truncated:true` fades in the ghost "+N more" node (§6).
- Between turns (`turn` bumps, steps reset) the current graph **collapses to a small "turn N" chip** in
  a left rail and the canvas clears for turn N+1 — history stays reachable (click a chip to re-open a
  past turn's DAG) without cluttering the live one.

---

## 4. WebGL / canvas plan + interaction

**Renderer choice by size (auto):**
- **≤60 nodes → SVG.** Crisp text, trivial hit-testing, cheap animation via CSS/attr tweens; most
  traces live here. Three.js is already vendored (`public/three.module.js`) but SVG wins for small
  clean DAGs.
- **>60 nodes or force layout → WebGL** (regl-style or thin Three.js orthographic scene): nodes as
  instanced quads (one draw call), edges as instanced line segments / thin triangle strips, labels as a
  **signed-distance-field text atlas** (one texture, glyph quads) so 200 labeled nodes stay one-ish draw
  call and pan/zoom holds 60fps. Amber cap-gutter and dashed inferred edges are just per-instance style
  attributes (dash via a fract() shader on edge param). The force sim runs on CPU in a fixed step
  budget per frame (Barnes-Hut / grid) — or as a compute-in-fragment ping-pong if we want it GPU-side;
  CPU is plenty for ≤300 nodes (the cell's `MAX_NODES`).
- A single `render(snapshot)` entry point diffs against the last snapshot by `(rev, node key/step i)` and
  only touches changed instances — cheap live growth.

**Camera / navigation:** semantic-zoom pan+zoom (wheel/drag, pinch); at far zoom, labels drop to node
glyphs + kind color (the *shape* of the lineage survives); zooming in reveals labels then detail
sublabels. "Fit graph" and "focus answer" buttons.

**Interactions:**
- **Hover node** → property card: `name`/`label`, `detail`, `ok`/`state`, truncated `call`/`result`
  preview, and for a step its `granted` caps **listed by name only**. *Cap hygiene: names/kinds only,
  never a swissnum/#cap* (§6). Card also shows in/out edge counts ("used 3 inputs, fed 2 consumers").
- **Hover edge** → the relation + (for inferred) the *reason* and confidence ("inferred: shared token
  `docket-1994`, conf 0.9").
- **Click node → FOCUS ANCESTRY ("what led here").** The node's full backward slice (all transitive
  producers/consumers/granting-caps that reach it) stays vivid; everything else dims to ~12%. This is
  *the* headline interaction — for the answer node it's "show me exactly what this conclusion is made
  of," authority included. A companion **"descendants" toggle** shows forward reach ("what did this
  result end up affecting"). Esc / click-background clears.
- **Expand / collapse.** A step with `children` (sub-agent fan-out) or a `nodes` parent starts
  **collapsed to a single node with a "⊕ N" badge**; click expands the sub-tree in place (spring
  layout). Keeps a 40-child delegation legible. Double-click a sub-agent hexagon to isolate its own
  sub-DAG full-canvas (drill-in), breadcrumb to pop back.
- **Filter chips.** Toggle node kinds (hide data nodes to see just the step/agent skeleton), toggle
  inferred edges (§3.4), toggle the unused-branch bottom lane. "Failures only" chip → dims everything
  not on a path through a failed node (instant audit of "did any bad data reach the answer").
- **The escape-key fiber (trusted-path tie-in).** Per `data-flow-trusted-path-view.md`, the *thin
  un-editable* slice — the capability/granted edges + the "get me out" control — is the part that
  belongs in the host-owned trusted path. This view is the *expressive* content-chrome sibling of that
  fiber; it renders the same authority edges richly, while the denylisted fiber renders them minimally
  and un-spoofably. Keep the amber cap layer's semantics identical between the two so they read as one
  idea at two fidelities.

---

## 5. SPLASH example trace (what the gallery tile renders)

**Canned task:** *"Is the town council meeting still on Thursday, and if so email the neighborhood
list a reminder?"* — a multi-source research → synthesis with one failed tool and a sub-agent
delegation. Canned snapshot (abbreviated to the real fields):

```
turn:1, status:'done', rev:22, steps:[
 {i:0,name:'plan',            status:'done',ok:true, detail:'find meeting status, then draft'},
 {i:1,name:'web.search',      status:'done',ok:true, call:'"Millbrook council" agenda Thursday',
                              result:'3 hits: council.gov/agenda-2214, patch.com/…, cached…'},
 {i:2,name:'web.fetch',       status:'done',ok:false,call:'council.gov/agenda-2214',
                              result:'ERR 503 upstream — empty body'},          // ← THE FAILURE
 {i:3,name:'web.fetch',       status:'done',ok:true, call:'patch.com/millbrook-council',
                              result:'"…meeting MOVED to Friday 7pm, agenda #2214…"'},
 {i:4,name:'delegate:verify', status:'done',ok:true, detail:'cross-check date',
      children:[{name:'reader',detail:'confirms Friday per patch + calendar cache'}],
      result:'CONFIRMED: Friday, not Thursday'},
 {i:5,name:'answer',          status:'done',ok:true,
      call:'draft reminder for agenda #2214',
      result:'Meeting moved to Friday 7pm — reminder ready to send',
      granted:['email-send','contacts']},                                       // ← AUTHORITY
]
```

**What the splash renders (static, at-a-glance):**

A left→right layered DAG:
- Far left: **`plan`** (blue) and the user-request source.
- A **`web.search`** step (blue) → produces a teal **"3 hits" data node**.
- From that data node, **two `web.fetch` steps** branch:
  - the **`council.gov` fetch is RED** (`ok:false`, empty body) and — critically — **has NO
    outgoing consumed edge**. It's a dead end. It sits with a red pip and its "produced" edge goes
    nowhere. *The splash's teaching moment: the authoritative source failed, and the graph shows the
    answer did NOT flow from it.*
  - the **`patch.com` fetch (blue, ok)** produces a teal data node *"moved to Friday"* which flows
    (solid/inferred-dashed, high conf via shared token `#2214`) into…
- **`delegate:verify`** (violet **hexagon**, expandable "⊕1" → a `reader` sub-agent) which produces
  *"CONFIRMED: Friday"*, flowing into…
- **`answer`** (large blue ringed node, right anchor). Above it in the amber gutter: two **diamond
  capability nodes `email-send` and `contacts`** with dotted amber edges *granted* into the answer step.
- The moment it loads, a one-shot **ancestry sweep** from `answer` lights the true lineage:
  `search → patch.fetch → verify(+reader) → answer`, with the amber caps in the halo — and pointedly
  **skips the red council.gov failure**, which stays dim and off the path.

**The at-a-glance story the tile tells:** *"The answer (meeting is Friday, reminder drafted) rests on
patch.com corroborated by a verify sub-agent — NOT on the official council page, which 503'd. And
producing it required email-send + contacts authority."* Three defect-classes are legible in one
frame: (1) a failed tool that was correctly **not** used, (2) a delegation whose answer **was** used,
(3) the **authority** the conclusion depended on. That is the whole pitch of the paradigm in one
picture — and it doubles as the inverse cautionary example: had a consumed edge run *from* the red
node into `answer`, it would scream "conclusion drawn from a failed call."

Splash is fully static/canned (no cell, no port) so the gallery tile renders instantly and offline.

---

## 6. Confinement fit, degradation, cap hygiene

**Tier-2 sandbox fit.** Everything is local compute over a snapshot delivered via MessagePort — no
network, no DOM escape. Layout (Sugiyama or force) and inference (token matching) are pure functions of
the snapshot; SVG and WebGL both run fully inside an opaque-origin `allow-scripts` iframe under strict
CSP. WebGL needs no network; the SDF font atlas is generated at init from a bundled font or canvas-drawn
glyphs (no external fetch). One thing to honor under SES/CSP: no `eval`/`new Function` in the WebGL
helper (some regl builds use codegen) — pin a codegen-free path or precompile shaders as string
constants. Input is exactly the render-safe cell value; the module treats it as untrusted plain JSON
(clamp counts, coerce types, drop malformed entries — the cell already bounds sizes at 200/300).

**Degradation (thin / truncated data), graceful at every level:**
- **No `nodes`, sparse `steps`** → the DAG is basically the step spine with inferred consumption
  edges; still useful (you see the failed-node-not-consumed pattern). If even `call`/`result` are
  absent, fall back to the **named-tool convention** (§3.4 rule 3) and temporal chaining, all rendered
  as low-confidence dashes with an honest banner: *"dataflow inferred from order only."*
- **`truncated:true`** (cell hit `MAX_STEPS`/`MAX_NODES`) → render a **ghost "+N more (truncated)"**
  boundary node on the relevant lane; ancestry through it is marked incomplete rather than silently
  wrong ("this slice may be missing upstream evidence"). Never pretend the graph is complete.
- **`status:'running'`** → partial live DAG with the answer node absent/pending; the growth animation
  (§3.6) is the running-state presentation — there is no separate "loading" mode.
- **Empty / idle cell** → a quiet placeholder ("no trace yet"), not an error.
- **Single-step turn** → degenerate two-node DAG (request → answer); still valid, just small — SVG.
- **Malformed snapshot** → render what parses, drop the rest, small "some events skipped" note. One bad
  entry never blanks the view (mirrors the cell's own "a bad event is dropped" discipline).

**Never render a cap (stack-wide `cap_hygiene_no_render`).** Capability nodes and `granted` edges
display the **power NAME / kind only** (`email-send`, `home-assistant`) — the *shape* of authority,
never the swissnum/#cap that grants it. There are no swissnums in this cell to begin with (emitStep
scrubs upstream; `granted` is already just names), and this view **adds none**: nothing rendered here
goes into the DOM/URL/tooltip/label as a secret. Tooltips show names; if a user wants to act on a cap
that's the Shares panel's job, not this view's — **this lens reveals, it never grants or revokes**
(read-only, per the trusted-path guardrails). Designation is by reference; we draw the edge, never the
key.

---

### Build order (if picked up)
1. Snapshot→graph transform (nodes/edges + inference, pure fn, unit-testable against the §5 canned
   trace). 2. SVG layered renderer + hover/focus-ancestry. 3. Live-growth diffing against `rev`.
4. WebGL path + force toggle for large graphs. 5. Trusted-path fiber split (amber cap layer as the
   denylisted un-editable slice). Splash tile uses only step 1–2 output on the canned trace.
