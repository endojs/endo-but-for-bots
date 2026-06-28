# Live-editable everything — alt-click any component, talk to its agent

Brainstorm + phased plan (dan, 2026-06-28; updated with dan's annotations). Goal: the **whole app
feels live-editable, small to large** — hold ⌥/Alt, any component you hover lights up, click it, and
you're in a chat with the agent that owns that component, shaping it live. The scaffolding exists but
is mostly disconnected.

## Where we are (the gap)

- **Selection + red hover works** (`componentSelect`, app.js ~3230): holding Alt draws a red outline
  on the hovered component and a chip with ✎ edit / 🍴 fork.
- **But very few things are selectable.** Only elements carrying `data-component-id` /
  `data-component-name` (or `.gw-component` / `[data-fork-id]`) qualify, set in just ~4 spots (trace
  strip, trace overlay, grain-ui confined widgets, live forks). The rest of the DOM is untagged.
- **"Edit" was not a chat.** ✎ edit → `window.prompt()` → one-shot POST `/components/edit`. No
  conversation with the component's agent. **(Fixed in Increment 1 / Phase 1.)**

The substrate IS built: confined components (`preact-container/confineComponent` + `renderConfined`),
per-component git versioning (`component-git.mjs`: commit/readAt/fork/revert, real `@endo/exo-git`),
the edit agent (`editComponentSource` → Opus → commit → live `setSource`), authorship (`proposedBy`),
a review panel. Missing wiring: **universal tagging** + **alt-click → a scoped edit-chat with the
component's agent** + **live re-render**.

**Two kinds of "component" today — only one is already confined (this is the crux of P4):**
- *Agent-authored* components (`ui:` widgets, forks, custom views) already flow through the confining
  renderer (`makeConfinedFromSource` → `confineComponent` → `renderConfined`) and ARE git objects.
- *The shell* (header, composer, sidebar, chat list, settings, the bubbles) is **hand-written
  imperative DOM** in app.js — NOT preact, NOT confined, NOT a git object, NOT in the renderer.

## The model

Every component is a node with: an **id**, a **name**, a **source** (`(endowments,props)=>vnode`,
versioned in git), an **owning agent** (`proposedBy`, default Agent C), and **live state** in grains.
Alt-click resolves the lowest tagged ancestor → opens a chat **scoped to that component**: the agent
holds exactly two powers — read this component's source, and propose/apply an edit (commit a new
version, re-render live, revertable). Conversation is the point: ask "which button?", show a diff,
iterate. This is the notesFolder-scoping pattern (a cap bound to one subtree) applied to one
component. The target invariant (dan): **everything editable is a confined preact component going
through the confining renderer** — including, eventually, the shell. There is no user-facing
"edit raw DOM" path; the shell migrates into confined components (P4).

Small→large is the same gesture at every scale: a chip, a panel, a whole chat surface, the shell
itself — each is a component with an id and an agent. Same alt-click, same edit-chat.

## Multi-user: per-user capabilities + per-user app variants (dan)

We are building toward a **multi-user** app where different users load **different route versions** of
the application. On a user's FIRST receipt of a capability (the main cap they draw from), we mint a
**user capability** they hold, which stores **their preferences** + a **pointer to the Root object**
they treat as the application's main entry point. That pointer is what lets each user **fork and vary
the whole application in real time**, diverging from one another: a user's app = the component trie
rooted at *their* Root pointer. Editing a component forks it within their variant; their user-cap's
Root pointer advances to the new root version. Different users = different Root pointers over a shared
fork-tree of component git objects.

## Durability: continuously sync the component git objects to gitea (dan)

The component/fork git objects must be **continuously synchronized to gitea** — a DB failure must not
lose them (today they live only in the local component-git store). Approach (open to alternatives):
a git repository that keeps the variants alive as **branches** — the **Root capability syncs to
`main`** (so main always reflects the latest canonical app state), and **each user's variant lives on
its own branch** (kept alive alongside main). Possibly a worktree per fork of a sub-component. Since
`component-git.mjs` is already real git (`@endo/exo-git`), this is pushing refs to a gitea remote;
the branch-per-variant model maps straight onto git branches, and aligns with the existing
dogfood/continuous-push discipline (field-preact-push.timer).

## Phased plan (each phase ships + is felt)

- **Phase 1 — alt-click opens a real edit CHAT. ✅ SHIPPED (Increment 1, 2026-06-28).** ✎ edit
  (component or fork) → `openComponentEditChat(id, name)`: a conversational panel. Each message edits
  the component live via its edit endpoint; the exchange renders as a chat; the live component
  re-renders; session thread per id. `component-edit-chat.staging.test.cjs` 6/6.
- **Phase 2 — a scoped component-editor agent (the real loop). [DEFAULT — dan].** Mint a cap bound to
  one componentId (`mintScopedCap({componentId})`, mirroring `mintScopedCap({notesFolder})`). The
  chat runs the normal CodeMode loop with two verbs — `readComponentSource()` + `editComponent({prompt})`
  — bound to that id. A true agent conversation (clarifying questions, multi-step, its own trace).
  The component's owning agent (`proposedBy`) is the entry agent. P1's one-shot stays as the cheap
  fallback; **P2 is the default**.
- **Phase 3 — universal tagging (everything is a component). BOTTOM-UP (dan).** A single
  `tagComponent(el, {id, name, agent})` helper at every render site. **Start with the SMALLEST
  components first and step up ONE level at a time** — because larger components contain pointers to
  the smaller ones; going large→small risks duplicating the small components across the larger ones.
  Implement leaves first (minimally duplicated), then compose upward. The hover overlay already
  resolves the lowest tagged ancestor; coverage grows monotonically; untagged elements fall back to
  their nearest tagged parent.
### P4 progress + the migration recipe (2026-06-28)

The recipe (each surface): a `client/*.js` confined island reproducing the structure EXACTLY (every id +
attribute — all in the renderer's safe-attr allowlist) + registered in `island-source` + a `renderX`
tag-method + mounted EARLY in app.js (before app.js grabs/wires the elements) with a **snapshot→verify→restore**
guard so a bad render can never break the live app. The confined renderer keeps `id`, so app.js's existing
getElementById wiring (`.onclick`, `addEventListener`, even pointer-capture) binds to the island-rendered
controls — verified: the wired `sendBtn === live #send`, still in the DOM. **No app.js wiring changes needed.**

Shipped:
- **Landing tagline** (`island-tagline-hero`) — display-only leaf.
- **Header bar** (`island-header-bar`) — first interactive surface; 8/8 (every id present, hamburger/tab/
  theme-toggle wired, alt-click → edit chat targets the island).
- **Composer input row** (`island-input-row`) — the highest-stakes surface; 7/7 incl. the critical send
  regression (the composer still SENDS via the island-rendered #text/#send, file input keeps accept/multiple).

Testing note (important for future surfaces): a first-send on an EMPTY/landing chat is flaky to drive
headlessly — seed an existing chat (a prior you/agent tx) so the send is a FOLLOW-UP (as
tool-output-history does). An earlier "the composer island broke send" conclusion was a FALSE NEGATIVE from
testing a landing first-send; the authoritative tool-output-history (seeded chat) shows send works with the
island.

**The boundary the recipe DOESN'T cross — container surfaces that host OTHER islands.** Converting the
sidebar/drawer frame to an island was tried + reverted: the drawer hosts `#chat-list` (the chat-list
island). Confined-rendering the drawer takes `#chat-list` under the drawer's preact render, so the chat-list
island's own `renderConfined` into it no longer composes — the chat list fell back to a plain-DOM render
(it still WORKED + populated, but lost its OWN island/alt-click-edit). Net-negative: you'd trade a valuable
inner island for a less-valuable container one. So:

- **Standalone surfaces** (no nested islands) convert cleanly with the recipe: **tagline, header, composer**
  ✓ done.
- **Container surfaces** that host other islands — sidebar/drawer (→chat-list), chat bubbles
  (→message-controls), inbox sections (→notification/changelog cards) — and **dynamically-generated**
  surfaces (the settings modal, built by `openSettings()` innerHTML) need a different approach: a SLOT
  mechanism (the container island declares an opaque slot the inner island still owns) or tag-only (mark the
  container alt-clickable, keep its render imperative). That's a real architectural extension (the
  preact-container "opaque-child" machinery is the likely basis) — scoped as the next P4 step, not a naive
  swap.

- **Phase 4 — the shell migrates into confined git-object components. [RESOLVED — dan: yes].** Convert
  the hand-written shell pieces (composer, chat-list, header, panels, bubbles) into confined
  `(endowments,props)=>vnode` components rendered through the confining renderer and seeded into
  `component-git` — so editing one forks + swaps it live, revertable, shareable. This is the
  "everything goes through the preact renderer that confines it" invariant, realized for the shell.
  Done bottom-up per P3. The Blacksmith editing raw app.js source survives only as a developer escape
  hatch, never the user edit path.
- **Phase 5 — share mutations along the cap graph.** Edited components carry their mutated state +
  inbox into invites; accept/reject/auto-upgrade. (Ties into the multi-user variant model above.)

## Decisions (resolved with dan)

1. **Tagging order (P3) → BOTTOM-UP.** Smallest components first, step up one level at a time, so the
   larger components reference (not duplicate) the smaller ones.
2. **Shell vs targeted patches (P4) → MIGRATE THE SHELL.** Everything editable becomes a confined
   preact component in the confining renderer; agent output already is, the shell gets converted.
   Raw-source patching (Blacksmith) is a dev-only escape hatch.
3. **One-shot vs agent-loop edits → P2 (the agent loop) is the default.** P1's one-shot remains a
   cheap fallback.

## Increment 1 (shipped)

Alt-click ✎ edit → `openComponentEditChat(id, name, {kind})` — a focused conversational panel for that
component instead of `window.prompt`. Each message → the component's edit endpoint; the panel renders
the exchange (you → "make the header teal"; agent → "✓ updated — v3 · review: none. Applied live.")
and re-renders the live component. The felt unlock: editing a component is a conversation with its
agent.
