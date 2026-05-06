# Designs without an in-flight PR on endo-but-for-bots

Snapshot at 2026-05-06.

Of 100 design documents in `designs/` (96 in the root plus 4 under
`channel threads/`, excluding `README.md` and `CLAUDE.md`), 59 have at
least one associated pull request on `endojs/endo-but-for-bots` (open
or merged); the remaining 41 are listed below grouped by classification.

The 21-document jump from the prior snapshot's 79-document base is a
single landing: commit 100774ffa0 ("docs(designs): Endor architecture,
SQLite, makeArchive, and supporting designs") brought a Rust/endor
batch onto garden between 2026-05-02 and today. Counting the 21 new
designs against their PRs accounts for the increase in the with-PR
denominator.

## Summary

| Classification | Count |
| --- | --- |
| Started but stalled (branch exists, no PR) | 0 |
| Spec'd but not started | 13 |
| Stale (superseded by another design) | 1 |
| Aspirational / discussion-only | 12 |
| Already complete (work landed without an explicit open PR) | 15 |
| **Total** | **41** |

## Started but stalled (0)

A design has a working branch (local or on bots) that diverges from
master, but no PR was ever opened. None of the 41 unannotated designs
have such a branch on `bots-ssh` or in the local checkout.

## Spec'd but not started (13)

Reads as a polished design ready to be acted on; no branch, no PR.
This is the action-eligible queue.

- [`designs/daemon-agent-network-identity.md`](../designs/daemon-agent-network-identity.md)
  per-agent Ed25519 keypair identity for OCapN network registration.
  Status field claims "In Progress" but no implementation branch or PR
  was found.
- [`designs/daemon-capability-bank.md`](../designs/daemon-capability-bank.md)
  integrating filesystem, persona, OS-sandbox, and other capabilities
  into a unified bank.
- [`designs/daemon-capability-filesystem.md`](../designs/daemon-capability-filesystem.md)
  `Dir` and `File` capabilities for structural filesystem confinement.
  Closely related to `daemon-mount` and `platform-fs` (annotated), but
  this design itself has no PR.
- [`designs/daemon-capability-persona.md`](../designs/daemon-capability-persona.md)
  delegates and epithets for cross-peer identity tracking.
- [`designs/daemon-content-store-gc.md`](../designs/daemon-content-store-gc.md)
  reference-counted content-store sweep at GC time.
- [`designs/daemon-weblet-application.md`](../designs/daemon-weblet-application.md)
  weblet applications hosted from readable-tree zip archives.
- [`designs/endoclaw-browser.md`](../designs/endoclaw-browser.md)
  Playwright-backed `Browser` exo with origin allowlist.
- [`designs/endoclaw-channel-bridges.md`](../designs/endoclaw-channel-bridges.md)
  Vercel `chat` SDK adapters for Slack, Telegram, Discord, etc.
- [`designs/endoclaw-notifications.md`](../designs/endoclaw-notifications.md)
  `Notify` exo bridging daemon to Electron `Notification` API.
- [`designs/endoclaw-oauth.md`](../designs/endoclaw-oauth.md)
  credential capability so an agent uses a service without seeing the
  raw token.
- [`designs/endoclaw-proactive-messages.md`](../designs/endoclaw-proactive-messages.md)
  pattern for composing Timer plus data caps plus `send()` for
  briefings and reminders.
- [`designs/endoclaw-skill-registry.md`](../designs/endoclaw-skill-registry.md)
  capability-aware skills directory.
- [`designs/familiar-chat-weblet-hosting.md`](../designs/familiar-chat-weblet-hosting.md)
  iframe hosting and guest profiles for Chat-side weblets.

### Removed from this list since 2026-05-02

- `daemon-guest-eval-simplification` → **PR [#92](https://github.com/endojs/endo-but-for-bots/pull/92)
  merged 2026-05-06**. Eval-proposal handshake removed.
- `chat-rename-dismiss-to-clear` → **PR [#93](https://github.com/endojs/endo-but-for-bots/pull/93)
  merged 2026-05-06**. `dismiss-all` retained as alias.
- `daemon-os-sandbox-plugin` → **PR [#78](https://github.com/endojs/endo-but-for-bots/pull/78)
  merged 2026-05-01** (jcorbin sandbox; bwrap and podman drivers
  through Phase 2). The design's metadata block on garden still reads
  "Not Started"; recommend re-classifying to "In Progress" or
  partially-complete in a follow-up. Flagged as an open question.

## Stale (1)

The design references a different design that supersedes it.

- [`designs/chat-reply-chain-visualization.md`](../designs/chat-reply-chain-visualization.md)
  the MOI reply-chain layout. Status field reads "Deprecated" with a
  "Supersedes" pointer.
  - Superseded by: [`designs/chat-focus-message.md`](../designs/chat-focus-message.md)
    (Active, no PR yet).

## Aspirational / discussion-only (12)

Reads as exploration, research, or roadmap. Not actionable as a
single PR.

- [`designs/endoclaw.md`](../designs/endoclaw.md)
  parent reference index for the EndoClaw capability family. Status
  is "Reference".
- [`designs/weblet-next.md`](../designs/weblet-next.md)
  reference document recording the previous (now-removed) weblet
  implementation. Status is "Reference".
- [`designs/chat-focus-message.md`](../designs/chat-focus-message.md)
  Active living document (no in-flight PR proposes new changes).
  Listed here because the supersede chain from
  `chat-reply-chain-visualization` lands on it; not strictly
  aspirational, but no actionable PR is open.
- [`designs/outliner-design-doc.md`](../designs/outliner-design-doc.md)
  outliner spec for a Type-3 chat system (Google Wave style). No
  metadata table.
- [`designs/outliner-design-doc-2.md`](../designs/outliner-design-doc-2.md)
  short note on outliner interaction patterns. No metadata table.
- [`designs/outliner_drag_and_drop.md`](../designs/outliner_drag_and_drop.md)
  HTML5 drag-and-drop research for browser-based outliners. Survey
  document.
- [`designs/OUTLINER_INTERACTION_PATTERNS.md`](../designs/OUTLINER_INTERACTION_PATTERNS.md)
  HTML interaction-pattern survey for browser-based outliners. Does
  not propose an Endo design.
- [`designs/channel threads/threading-research-overview.md`](../designs/channel%20threads/threading-research-overview.md)
  research overview for chat threading types 1, 2, 3.
- [`designs/channel threads/type-1-chat-spec.md`](../designs/channel%20threads/type-1-chat-spec.md)
  threaded-channel chat type spec (research / RFC).
- [`designs/channel threads/type-2-chat-spec.md`](../designs/channel%20threads/type-2-chat-spec.md)
  real-time forum chat type spec (research / RFC).
- [`designs/channel threads/type-3-chat-spec.md`](../designs/channel%20threads/type-3-chat-spec.md)
  collaborative outliner chat type spec (research / RFC).
- [`designs/inventory-grouping-by-type.md`](../designs/inventory-grouping-by-type.md)
  UI grouping with collapsible sections. Annotated against
  PRs [#39](https://github.com/endojs/endo-but-for-bots/pull/39) and
  [#41](https://github.com/endojs/endo-but-for-bots/pull/41) (which
  partially deliver the badges and DnD), so this is borderline:
  treated as aspirational here because no PR delivers the design's
  central grouping behavior.

## Already complete (15)

The work the design describes has landed via merged PRs on `actual/llm`
that pre-date the bots PR mirror, or via a closed-but-shipped commit
on `llm`. The metadata table in each file already reads
**Complete** / Implemented (except where noted).

- [`designs/chat-color-schemes.md`](../designs/chat-color-schemes.md)
  Status: Complete.
- [`designs/chat-command-bar.md`](../designs/chat-command-bar.md)
  Status: Complete. Note: PR 43 (annotated against
  `chat-pending-commands`) wires the unlock-on-dispatch behavior the
  command-bar design describes.
- [`designs/chat-components.md`](../designs/chat-components.md)
  Status: Complete.
- [`designs/chat-high-contrast-mode.md`](../designs/chat-high-contrast-mode.md)
  Status: Complete.
- [`designs/chat-invariants.md`](../designs/chat-invariants.md)
  Status: Complete (living document for the principles).
- [`designs/chat-per-space-color-scheme.md`](../designs/chat-per-space-color-scheme.md)
  Status: Complete.
- [`designs/chat-spaces-gutter.md`](../designs/chat-spaces-gutter.md)
  Status: Complete.
- [`designs/chat-spaces-home.md`](../designs/chat-spaces-home.md)
  Status: Complete.
- [`designs/chat-spaces-inbox.md`](../designs/chat-spaces-inbox.md)
  Status: Complete.
- [`designs/chat-test-coverage.md`](../designs/chat-test-coverage.md)
  Status: Complete.

## Suggested follow-ups

1. **Annotate `daemon-os-sandbox-plugin.md` with PR [#78](https://github.com/endojs/endo-but-for-bots/pull/78).**
   That sandbox PR merged 2026-05-01 (jcorbin: bwrap and podman drivers
   through CI). The design's metadata still reads "Not Started"; either
   flip to "In Progress" / "Implemented (Phases 0-2)" or leave alone if
   the design intentionally tracks remaining work beyond the merged
   slice. Open question filed.
2. **Triage the 13 spec'd-but-not-started designs against the
   roadmap.** Most fall under M1 (Capabilities, Tools), M3 (Weblets,
   Integrations), and M5 (Confinement, Ecosystem). The remaining work
   is genuinely planned. Two single-day items make natural builder
   dispatches: `daemon-content-store-gc` (M1, S, 1 day) and
   `daemon-agent-network-identity` (M2, S-M, 2-3 days).
3. **Mark `chat-reply-chain-visualization.md` as superseded in the
   README.** The README already lists it as "Deprecated"; the design
   file already declares the supersede chain. Verify the
   `Supersedes` link round-trips correctly and consider removing the
   file from the active design index.
4. **Decide whether the outliner and channel-threads research files
   belong in `designs/`.** They are exploratory and lack the metadata
   format the project's `CLAUDE.md` mandates. A separate `research/`
   directory would let the design corpus stay focused on actionable
   proposals.
5. **For the 10 already-complete chat-* designs that have no PR
   reference on bots:** consider adding a brief "Landed in" footer
   pointing at the merge commit on `llm` (or upstream `actual/llm`),
   so future readers can trace the work without grepping git history.
