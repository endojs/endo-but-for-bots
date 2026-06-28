# Live-editable everything — alt-click any component, talk to its agent

Brainstorm + phased plan (dan, 2026-06-28). Goal: the **whole app feels live-editable, small to
large** — hold ⌥/Alt, every component lights up, click it, and you're in a chat with the agent that
owns that component, shaping it live. Today the scaffolding exists but is mostly disconnected.

## Where we are (the gap)

- **Selection + red hover works** (`componentSelect`, app.js ~3132): holding Alt draws a red outline
  on the hovered component and a chip with ✎ edit / 🍴 fork.
- **But very few things are selectable.** Only elements carrying `data-component-id` /
  `data-component-name` (or `.gw-component` / `[data-fork-id]`) qualify, and those are set in just
  ~4 spots: the trace strip (app.js ~570), the trace overlay (index.html), confined Preact widgets
  (grain-ui.js ~154), and live forks (fork-widget.js). The rest of the DOM — sidebar, header,
  composer, chat bubbles, panels, the chat list — is untagged, so Alt-click does nothing on it.
- **"Edit" is not a chat.** ✎ edit → `editComponent()` → a `window.prompt()` → one-shot POST
  `/components/edit` (Opus rewrites the source once). There is **no conversation** with the
  component's agent — the thing the user actually asked for.

The substrate IS built: confined components (`preact-container/confineComponent` + `renderConfined`),
per-component git versioning (`component-git.mjs`: commit/readAt/fork/revert), the edit agent
(`editComponentSource` → Opus → commit → live `setSource`), authorship (`proposedBy`), and a review
panel. The trie/grain design is `preact-component-trie.md`. The missing wiring is: **universal
tagging** + **alt-click → a real scoped edit-chat with the component's agent** + **live re-render**.

## The model

Every component is a node with: an **id**, a **name**, a **source** (its `(endowments,props)=>vnode`,
versioned in git), an **owning agent** (`proposedBy`, default Agent C for built-ins), and **live
state** in grains. Alt-click resolves the lowest tagged ancestor → opens a chat **scoped to that
component**: the agent in that chat holds exactly two powers — read this component's source, and
propose/apply an edit to it (commit a new version, re-render live, revertable). Conversation is the
point: the agent can ask "which button?", show a diff, iterate. This is the notesFolder-scoping
pattern (a cap bound to one subtree) applied to one component.

Small→large is the same gesture at every scale: a single chip, a panel, a whole chat surface, the
shell itself — each is a component with an id and an agent. Editing the shell is editing a
top-of-trie component; editing a chip is editing a leaf. Same alt-click, same edit-chat.

## Phased plan (each phase ships + is felt)

**Phase 1 — alt-click opens a real edit CHAT (this increment).** Replace the `window.prompt`
dead-end: ✎ edit opens a focused, conversational edit surface for that component. Back-and-forth;
each turn reads/edits the component's source via the existing edit endpoint; the live component
re-renders; versions are revertable. Immediately makes editing feel like *talking to the thing*.
(Built client-side on the existing `/components/edit` + `/forks/edit`; see Increment 1 below.)

**Phase 2 — a scoped component-editor agent (the real loop).** Mint a cap bound to one componentId
(mirror `mintScopedCap({notesFolder})` → `mintScopedCap({componentId})`). The chat runs the normal
CodeMode loop with two verbs — `readComponentSource()` + `editComponent({prompt})` — bound to that
id. Now it's a true agent conversation (clarifying questions, multi-step, its own trace), not a
per-message one-shot. The component's owning agent (`proposedBy`) is the entry agent.

**Phase 3 — universal tagging (everything is a component).** A single `tagComponent(el, {id, name,
agent})` helper, applied at every render site, so the shell decomposes into a labeled trie:
header, composer, chat-list, each panel, each bubble, each chip. Start with the big surfaces
(composer, sidebar, header, each settings panel) and push down to leaves. The hover overlay already
resolves the lowest tagged ancestor, so coverage grows monotonically as sites get tagged. Untagged
elements fall back to their nearest tagged parent (you can always edit *something*).

**Phase 4 — built-in components become forkable git objects.** The shell's own pieces (composer,
chat-list, …) get seeded into `component-git` so editing one forks + swaps it live — your interface
mutates under you, revertable, shareable along trust lines (the trie design's endgame). This is the
"feels extremely dynamic" payoff: the app is editing itself, live, at every scale.

**Phase 5 — share mutations along the cap graph.** Edited components carry their mutated state +
inbox into invites (the trie design's sharing/trust phase); accept/reject/auto-upgrade.

## Risks / decisions for dan

- **Tagging blast radius (Phase 3).** Tagging every element is invasive. Mitigation: incremental,
  parented fallback, and a single helper so it's mechanical. Decision: how deep to go (leaves vs
  just panels) and in what order.
- **Editing the shell vs editing agent output.** Today only agent-authored widgets are real git
  components; shell pieces are hand-written DOM. Phase 4 converts them — big but it's the core of
  "live-editable from small to large." Decision: do we commit to migrating the shell into the trie,
  or keep shell-edits as targeted patches?
- **One-shot vs agent-loop edits.** Phase 1 is one-shot-per-message (cheap, ships now); Phase 2 is
  the real loop (richer, costs a scoped cap + power). Both coexist.

## Increment 1 (shipped now)

Alt-click ✎ edit → `openComponentEditChat(id, name, {kind})` — a focused conversational panel for
that component instead of `window.prompt`. Each message is sent to the component's edit endpoint;
the panel renders the exchange (you → "make the header teal"; agent → "✓ updated — recolored the
header; v3 (panel: none)") and re-renders the live component. Revert hint inline. This is the
felt unlock: editing a component is now a conversation with its agent.
