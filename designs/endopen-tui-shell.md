# EndOpen: OpenCode-shaped Space (TUI-style layout in Chat)

|             |                                              |
|-------------|----------------------------------------------|
| **Created** | 2026-05-15                                   |
| **Author**  | kriscendobot (prompted by kriskowal)         |
| **Status**  | Not Started                                  |
| **Source**  | [`endopen.md`](endopen.md) § Gap 3           |

## What is the Problem Being Solved?

The maintainer's framing: *"a space that is more like opencode UX
might be helpful"*. OpenCode's TUI
([`packages/opencode/src/cli/cmd/tui/`](https://github.com/anomalyco/opencode/tree/d59d9966/packages/opencode/src/cli/cmd/tui),
Bubble Tea / Go) has a distinctive layout that coding-agent users
have grown to expect: file-tree sidebar, prompt + transcript in the
center, status bar with model + tokens + cost at the bottom, and a
keyboard-first command palette accessed by a leader key.

Endo's primary UX surfaces are:

- **Chat** ([`packages/chat`](../packages/chat)):
  browser-based, message-list-oriented, color-scheme-aware.
- **Familiar** ([`packages/familiar`](../packages/familiar)):
  the Electron shell that wraps Chat for desktop installation.

Neither is shaped like a coding agent's IDE. The Chat UI's strength
is messaging; its weakness for coding work is the lack of a file
tree, a diff viewer, and a status bar pinning the agent's current
state.

The `endor-tui` design (M6) is the Rust terminal incarnation, much
further out. The proposal here is the **browser-side complement**
that ships earlier: a new *space kind* in `packages/chat` whose
layout is opencode-shaped.

## Design

### What is a "space kind"?

Chat today has space kinds: home, inbox, microblog, channel, etc.
Each kind renders the same underlying guest data differently. A
*coding space* is a new kind whose layout privileges file-tree
navigation and inline diffs over message-list browsing.

Adding a space kind is a Chat-layer concern; the daemon does not
learn about it. The space's guest exposes the data
(`Mount`-backed file tree, transcript, todo list, cost telemetry);
Chat's rendering layer picks the layout.

### Layout

The following is an illustrative UI mockup (literal rendered layout,
not an architecture diagram), with ASCII stand-ins for the tree and
cursor glyphs:

```
+---------------------------------------------------------------------+
| [v] workspace                     | user > implement endopen.md     |
|   [v] designs                     |                                 |
|     * endopen.md          (sel)   | assistant > I will start by     |
|     * endopen-openrouter.md       | reading the prompt, then walk   |
|   [v] packages                    | opencode end-to-end, then       |
|     [>] chat                      | author the comparative doc.     |
|     [>] daemon                    |                                 |
|     [>] lal                       | * read designs/endoclaw.md      |
|   * README.md                     |   (template)                    |
|                                   | * read designs/README.md        |
| --------------- todo ------------ |                                 |
| [x] read designs/endoclaw.md      |                                 |
| [ ] author designs/endopen.md     |                                 |
| [ ] spin out 4 sibling designs    |                                 |
| [ ] commit + push                 |                                 |
| --------------- status ---------- |                                 |
| model: anthropic/claude-sonnet    | _                               |
| tokens: 47k in / 8k out / 28k$    |                                 |
| cost: $0.42                       | [/ command]    [esc back]       |
+---------------------------------------------------------------------+
```

Components:

- **Sidebar (file tree)**: rendered from a `Mount` capability the
  space's guest holds. Folder collapse-expand is local UI state;
  selecting a file opens it in the center column. Backed by
  [`packages/chat/browser-tree.js`](../packages/chat/browser-tree.js)
  (the existing tree component) reconfigured for the
  daemon-mounted directory rather than the pet-name namespace.
- **Center column**: the transcript. Same data as the regular Chat
  space; rendered with the opencode shape (user / assistant /
  tool-call blocks, todo updates, diff blocks). The file-tree
  selection opens an inline blob viewer in this column when the
  file is text (
  [`packages/chat/blob-viewer.js`](../packages/chat/blob-viewer.js)
  exists for this); diffs render the same way OpenCode renders them
  (chunked, color-coded; the existing `markdown-render.js` does not
  speak diff syntax yet, so this is one new component).
- **Todo pane** (bottom of sidebar): the agent's running plan,
  rendered from durable state on the space's guest. The parent design's
  persistence invariant ([endopen.md](endopen.md) § Major Contrasts:
  Persistence) rules out a transport-only model: "any imported OpenCode
  data model (sessions, parts, todos) lands as new formula types or as
  fields on existing types." So even the minimal initial cut keeps the
  todo list *durable*: a `todo` field on the space's guest (readable
  after a reconnect or reload), updated through the guest's normal
  message handling and surfaced to the space via the same subscription
  used for other guest state. A dedicated `todo` formula type (one more
  in the [`formula-type.js`](../packages/daemon/src/formula-type.js)
  registry) is the fuller shape if the plan later needs its own
  identity, addressing, or cross-space sharing; the guest field is the
  smaller durable cut that still honors the invariant. A transient
  `value` message with no backing state is explicitly *not* the cut,
  since it would leave the plan unreadable after reload.
- **Status bar**: model name, token count, cost (from the Lal
  provider's response metadata; the OpenRouter provider design's
  Phase 3 surfaces cost in the chat envelope), and a clock /
  busy indicator.
- **Command palette**: leader-key (`/`) opens a fuzzy-filtered
  list of commands the space supports (analogue to OpenCode's
  command bar). Reuses
  [`packages/chat/chat-bar-component.js`](../packages/chat/chat-bar-component.js)
  and
  [`packages/chat/command-registry.js`](../packages/chat/command-registry.js).

### Borrowed OpenCode patterns

OpenCode's TUI lives in
[`packages/opencode/src/cli/cmd/tui/`](https://github.com/anomalyco/opencode/tree/d59d9966/packages/opencode/src/cli/cmd/tui);
the routes are at
[`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`](https://github.com/anomalyco/opencode/tree/d59d9966/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx).
The components worth borrowing:

- **Dialog pattern** for permission requests / model selection /
  agent selection: see
  [`packages/opencode/src/cli/cmd/tui/component/dialog-agent.tsx`](https://github.com/anomalyco/opencode/tree/d59d9966/packages/opencode/src/cli/cmd/tui/component/dialog-agent.tsx)
  and
  [`dialog-model.tsx`](https://github.com/anomalyco/opencode/tree/d59d9966/packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx).
  Endo's analogue is the `add-space-modal.js` / `endow-modal.js`
  family; the dialogs above show the shape we want: a single
  full-screen overlay with a filterable list and a single
  confirm-or-cancel.
- **Sidebar with collapsible sections**:
  [`packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`](https://github.com/anomalyco/opencode/tree/d59d9966/packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx)
  shows the structure (sections for messages, files, branches);
  the chat space's sidebar borrows the section-collapse keyboard
  shortcuts.
- **Todo rendering**:
  [`packages/opencode/src/cli/cmd/tui/component/todo-item.tsx`](https://github.com/anomalyco/opencode/tree/d59d9966/packages/opencode/src/cli/cmd/tui/component/todo-item.tsx)
  is the OpenCode renderer for a todo row; the markup translates
  almost line-for-line to a Chat component.
- **Permission inline prompt**:
  [`packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`](https://github.com/anomalyco/opencode/tree/d59d9966/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx)
  shows how OpenCode interrupts the transcript with a permission
  request and waits for an allow / deny / always click. Endo's
  [`daemon-form-request`](daemon-form-request.md) is the existing
  analogue; the opencode shape (inline, in-flow, three-button) is
  worth borrowing as the layout for form-request rendering inside
  the coding space.

### Keyboard map

Coding-space-specific bindings, in addition to existing chat-bar
bindings:

| Key                | Action                                                      |
|--------------------|-------------------------------------------------------------|
| `/`                | Open command palette                                        |
| `g f`              | Focus file tree                                             |
| `g t`              | Focus transcript                                            |
| `g d`              | Focus todo pane                                             |
| `g s`              | Focus status bar (for action: switch model / clear cost)    |
| `j` / `k`          | Move within focused pane (vim-style)                        |
| `enter`            | Open file under cursor / submit prompt                      |
| `esc`              | Pop focus / dismiss dialog                                  |
| `?`                | Help (existing keybindings overlay)                         |

The existing chat-bar `enter` semantics are preserved; the new
bindings are scoped to when the focus is *not* in the chat bar.

Note for implementation: the status bar doubles as an action trigger
(`g s` above), but the § Layout mockup renders it as plain read-only
text. When this phase lands, give the focused/actionable status bar a
visible affordance distinct from a read-only status line (focus ring,
underline, or a chevron), so a user who has not memorized the keymap can
discover that the region is interactive.

### Composition with other designs

- **Panel widget** from [endopen-concurrent-subagents](endopen-concurrent-subagents.md):
  renders inline in the transcript exactly as in a regular chat
  space; the coding-space layout does not change panel rendering.
- **OpenRouter cost telemetry** from [endopen-openrouter](endopen-openrouter.md)
  surfaces in the status bar.
- **ACP server** from [endopen-acp-server](endopen-acp-server.md):
  orthogonal; the coding space is a UX layer, ACP is a protocol
  layer.
- **Mount** ([daemon-mount](daemon-mount.md)) provides the
  file-tree data source; the coding space subscribes to mount
  change notifications.

## Phased Implementation

1. **New space-kind plumbing**:
   register the `coding` space kind in `packages/chat/spaces-gutter.js`;
   add a kind selector to `add-space-modal.js`.
   ~150 LOC.
   **Size: S.**
2. **Layout shell**:
   three-column CSS grid (sidebar | center | dialog overlay);
   reuse `blob-viewer.js` for the center column when a file is selected.
   ~300 LOC.
   **Size: M.**
3. **File-tree pane**:
   rebind `browser-tree.js` to a `Mount` capability rather than the
   pet-name namespace.
   ~200 LOC.
   **Size: M.**
4. **Todo pane**:
   a new component subscribing to a `todo` shape on the space's guest.
   ~150 LOC.
   **Size: S.**
5. **Status bar**:
   a new component reading model / tokens / cost from the latest Lal
   envelope.
   ~100 LOC.
   **Size: S.**
6. **Diff viewer**:
   a new component for rendering unified-diff blobs inline.
   ~250 LOC.
   **Size: M.**
7. **Keyboard map**:
   extend `platform-keys.js` with the coding-space bindings.
   ~80 LOC.
   **Size: S.**

Total: 4-5 weeks for all phases; phases 1+2+3 alone deliver a usable
shell.

## Dependencies

| Design                          | Relationship                                                 |
|---------------------------------|--------------------------------------------------------------|
| [daemon-mount](daemon-mount.md) | Phase 3 file-tree depends on Mount capability                |
| [endopen-concurrent-subagents](endopen-concurrent-subagents.md) | Panel widget composes into the transcript |
| [endopen-openrouter](endopen-openrouter.md) | Phase 5 status bar reads cost from provider envelope |
| [chat-edit-message-ui](chat-edit-message-ui.md) | Hover-pencil pattern composes with file-edit in center column |
| [endor-tui](endor-tui.md)       | M6 successor in the terminal; design vocabulary should align |

## Open Questions

- **Default model selection**:
  should the coding space default to a different model than a regular
  chat space?
  Proposal: yes;
  agent-mode default is a stronger model (Sonnet / Opus class),
  plan-mode default is the same.
  The user can override via the model dialog.
- **Multi-session in one space**:
  OpenCode's TUI lets the user have multiple sessions in one window
  via tabs.
  Should the coding space have tabs?
  Proposal: no in v1;
  the spaces gutter already provides multi-space navigation and tabs
  would duplicate that surface.
- **Mobile**:
  the layout assumes >=120 columns;
  what is the mobile fallback?
  Proposal: the coding space is desktop-only in v1;
  on narrow viewports, fall back to the regular chat space.

## Design Decisions

1. **Browser-side first, terminal-side later.** The terminal port is
   the `endor-tui` design (M6). Shipping the browser version first
   validates the layout vocabulary; the terminal version reuses the
   keybinding semantics and dialog shapes.
2. **Reuse, do not replace.** Every existing Chat component
   (`blob-viewer`, `browser-tree`, `markdown-render`,
   `chat-bar-component`, `command-registry`) is reused; the coding
   space is a layout composition, not a parallel implementation.
3. **Considered and rejected: building a full Monaco-based IDE
   inside Chat.** Reason: scope blow-up; the goal is "an opencode-shaped
   space", not "Endo VSCode". The diff viewer is one new component;
   if a user wants full edit affordances they can shell out
   ([cli-edit-verb](cli-edit-verb.md)).

## Verification

- **Durable todo state.** A test writes a todo list to the space's
  guest, reloads the space (fresh subscription), and asserts the todo
  pane re-renders the same list, confirming the plan survives a
  reconnect (the durability the § Layout todo-pane cut commits to, not a
  transient message).
- **Responsive fallback.** A test renders the coding space at a viewport
  narrower than the assumed `>=120` columns and asserts it falls back to
  the regular chat space rather than overflowing, making the
  desktop-only assumption (§ Open Questions, Mobile) a checked boundary
  rather than an untested one.
- **Component reuse.** A test asserts the coding space instantiates the
  existing `blob-viewer`, `browser-tree`, and `command-registry`
  components (Design Decision 2) rather than parallel reimplementations.

## Related Designs

- [endopen](endopen.md): primary comparative analysis.
- [endor-tui](endor-tui.md): M6 Rust TUI successor.
- [daemon-mount](daemon-mount.md): provides the file-tree data source.
- [chat-slot-slash-commands](chat-slot-slash-commands.md): command-palette discipline.
- [chat-edit-message-ui](chat-edit-message-ui.md): hover-pencil pattern for inline edits.

## Prompt

> A space that is more like opencode UX might be helpful.
>
> kriskowal, 2026-05-15
