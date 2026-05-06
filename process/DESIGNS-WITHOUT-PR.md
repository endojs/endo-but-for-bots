# Designs without an in-flight PR on endo-but-for-bots

Snapshot at 2026-05-02T19:49:26Z.

Of 79 design documents in `designs/` (75 in the root plus 4 under
`channel threads/`, excluding `README.md` and `CLAUDE.md`), 29 have at
least one associated pull request on `endojs/endo-but-for-bots`; the
remaining 50 are listed below grouped by classification.

## Summary

| Classification | Count |
| --- | --- |
| Started but stalled (branch exists, no PR) | 0 |
| Spec'd but not started | 16 |
| Stale (superseded by another design) | 1 |
| Aspirational / discussion-only | 10 |
| Already complete (work landed without an explicit open PR) | 23 |
| **Total** | **50** |

## Started but stalled (0)

A design has a working branch (local or on bots) that diverges from
master, but no PR was ever opened. Looking for branch names matching
unannotated design slugs in `git branch -a` and `git ls-remote bots`:
no such branches exist for the 50 unannotated designs. Every bots
remote branch matches either a PR already counted in the annotated
group or a 2026-04-23 design batch (chat-slot-slash-commands,
endor-tui, endor-bus-tui, ocapn-tcp-syrup-framing, base64-native-
fallthrough, ci-no-npm-lifecycle, hex-package) whose design files were
never landed in this checkout (PR 77 carrying them was closed
unmerged).

## Spec'd but not started (16)

Reads as a polished design ready to be acted on; no branch, no PR.

- [`designs/daemon-agent-network-identity.md`](./designs/daemon-agent-network-identity.md)
  per-agent Ed25519 keypair identity for OCapN network registration.
  Status field claims "In Progress" but no implementation branch or PR
  was found.
- [`designs/daemon-capability-bank.md`](./designs/daemon-capability-bank.md)
  integrating filesystem, persona, OS-sandbox, and other capabilities
  into a unified bank.
- [`designs/daemon-capability-filesystem.md`](./designs/daemon-capability-filesystem.md)
  `Dir` and `File` capabilities for structural filesystem confinement.
  Closely related to `daemon-mount` and `platform-fs` (annotated), but
  this design itself has no PR.
- [`designs/daemon-capability-persona.md`](./designs/daemon-capability-persona.md)
  delegates and epithets for cross-peer identity tracking.
- [`designs/daemon-content-store-gc.md`](./designs/daemon-content-store-gc.md)
  reference-counted content-store sweep at GC time.
- [`designs/daemon-guest-eval-simplification.md`](./designs/daemon-guest-eval-simplification.md)
  remove the eval-proposal handshake; guest eval delegates to
  `formulateEval`.
- [`designs/daemon-os-sandbox-plugin.md`](./designs/daemon-os-sandbox-plugin.md)
  pluggable platform-specific worker sandboxing (bwrap, podman,
  sandbox-exec, AppContainer).
- [`designs/daemon-weblet-application.md`](./designs/daemon-weblet-application.md)
  weblet applications hosted from readable-tree zip archives.
- [`designs/endoclaw-browser.md`](./designs/endoclaw-browser.md)
  Playwright-backed `Browser` exo with origin allowlist.
- [`designs/endoclaw-channel-bridges.md`](./designs/endoclaw-channel-bridges.md)
  Vercel `chat` SDK adapters for Slack, Telegram, Discord, etc.
- [`designs/endoclaw-notifications.md`](./designs/endoclaw-notifications.md)
  `Notify` exo bridging daemon to Electron `Notification` API.
- [`designs/endoclaw-oauth.md`](./designs/endoclaw-oauth.md)
  credential capability so an agent uses a service without seeing the
  raw token.
- [`designs/endoclaw-proactive-messages.md`](./designs/endoclaw-proactive-messages.md)
  pattern for composing Timer plus data caps plus `send()` for
  briefings and reminders.
- [`designs/endoclaw-skill-registry.md`](./designs/endoclaw-skill-registry.md)
  capability-aware skills directory.
- [`designs/familiar-chat-weblet-hosting.md`](./designs/familiar-chat-weblet-hosting.md)
  iframe hosting and guest profiles for Chat-side weblets.
- [`designs/chat-rename-dismiss-to-clear.md`](./designs/chat-rename-dismiss-to-clear.md)
  rename `/dismiss-all` to `/clear` in Chat and CLI.
  Status field is "Proposed".

## Stale (1)

The design references a different design that supersedes it.

- [`designs/chat-reply-chain-visualization.md`](./designs/chat-reply-chain-visualization.md)
  the MOI reply-chain layout. Status field reads "Deprecated" with a
  "Supersedes" pointer.
  - Superseded by: [`designs/chat-focus-message.md`](./designs/chat-focus-message.md)
    (Active, no PR yet).

## Aspirational / discussion-only (10)

Reads as exploration, research, or roadmap. Not actionable as a
single PR.

- [`designs/endoclaw.md`](./designs/endoclaw.md)
  parent reference index for the EndoClaw capability family. Status
  is "Reference".
- [`designs/weblet-next.md`](./designs/weblet-next.md)
  reference document recording the previous (now-removed) weblet
  implementation. Status is "Reference".
- [`designs/outliner-design-doc.md`](./designs/outliner-design-doc.md)
  outliner spec for a Type-3 chat system (Google Wave style). No
  metadata table.
- [`designs/outliner-design-doc-2.md`](./designs/outliner-design-doc-2.md)
  short note on outliner interaction patterns. No metadata table.
- [`designs/outliner_drag_and_drop.md`](./designs/outliner_drag_and_drop.md)
  HTML5 drag-and-drop research for browser-based outliners. Survey
  document.
- [`designs/OUTLINER_INTERACTION_PATTERNS.md`](./designs/OUTLINER_INTERACTION_PATTERNS.md)
  HTML interaction-pattern survey for browser-based outliners. Does
  not propose an Endo design.
- [`designs/channel threads/threading-research-overview.md`](./designs/channel%20threads/threading-research-overview.md)
  research overview for chat threading types 1, 2, 3.
- [`designs/channel threads/type-1-chat-spec.md`](./designs/channel%20threads/type-1-chat-spec.md)
  threaded-channel chat type spec (research / RFC).
- [`designs/channel threads/type-2-chat-spec.md`](./designs/channel%20threads/type-2-chat-spec.md)
  real-time forum chat type spec (research / RFC).
- [`designs/channel threads/type-3-chat-spec.md`](./designs/channel%20threads/type-3-chat-spec.md)
  collaborative outliner chat type spec (research / RFC).

## Already complete (23)

The work the design describes has landed via merged PRs on `actual/llm`
that pre-date the bots PR mirror, or via a closed-but-shipped commit
on `llm`. The metadata table in each file already reads
**Complete** / Implemented (except where noted).

- [`designs/chat-color-schemes.md`](./designs/chat-color-schemes.md)
  Status: Complete.
- [`designs/chat-command-bar.md`](./designs/chat-command-bar.md)
  Status: Complete. Note: PR 43 (annotated against
  `chat-pending-commands`) wires the unlock-on-dispatch behavior the
  command-bar design describes.
- [`designs/chat-components.md`](./designs/chat-components.md)
  Status: Complete.
- [`designs/chat-focus-message.md`](./designs/chat-focus-message.md)
  Status: Active. Living document; no in-flight PR proposes new
  changes.
- [`designs/chat-high-contrast-mode.md`](./designs/chat-high-contrast-mode.md)
  Status: Complete.
- [`designs/chat-invariants.md`](./designs/chat-invariants.md)
  Status: Complete (living document for the principles).
- [`designs/chat-per-space-color-scheme.md`](./designs/chat-per-space-color-scheme.md)
  Status: Complete.
- [`designs/chat-spaces-gutter.md`](./designs/chat-spaces-gutter.md)
  Status: Complete.
- [`designs/chat-spaces-home.md`](./designs/chat-spaces-home.md)
  Status: Complete.
- [`designs/chat-spaces-inbox.md`](./designs/chat-spaces-inbox.md)
  Status: Complete.
- [`designs/chat-test-coverage.md`](./designs/chat-test-coverage.md)
  Status: Complete.
- [`designs/daemon-256-bit-identifiers.md`](./designs/daemon-256-bit-identifiers.md)
  Status: Complete. Landed on `llm` via the 256-bit migration commits
  (Feb-Mar 2026), pre-dating the bots PR mirror.
- [`designs/daemon-cross-peer-gc.md`](./designs/daemon-cross-peer-gc.md)
  Status field reads "Not Started" but commit `1570e88926` (`docs(designs):
  mark daemon-cross-peer-gc complete via retention-set sync`) on `llm`
  declares the work shipped via the retention-accumulator mechanism.
  - Landed in: commit `1570e88926`, with related closed PRs
    [#61](https://github.com/endojs/endo-but-for-bots/pull/61) (early
    CRDT prototype) and
    [#77](https://github.com/endojs/endo-but-for-bots/pull/77) (docs
    batch that was closed unmerged but whose source content is on the
    `llm` branch). The metadata block in this file is out of sync with
    the README plan.
- [`designs/daemon-form-request.md`](./designs/daemon-form-request.md)
  Status: Implemented.
- [`designs/daemon-value-message.md`](./designs/daemon-value-message.md)
  Status: Complete.
- [`designs/daemon-web-gateway.md`](./designs/daemon-web-gateway.md)
  Status: Complete.
- [`designs/familiar-bundled-agents.md`](./designs/familiar-bundled-agents.md)
  Status: Complete.
- [`designs/familiar-daemon-bundling.md`](./designs/familiar-daemon-bundling.md)
  Status: Complete.
- [`designs/familiar-electron-shell.md`](./designs/familiar-electron-shell.md)
  Status: Complete.
- [`designs/familiar-gateway-migration.md`](./designs/familiar-gateway-migration.md)
  Status: Complete.
- [`designs/familiar-localhttp-protocol.md`](./designs/familiar-localhttp-protocol.md)
  Status: In Progress (partially implemented). Familiar-side
  infrastructure landed on `actual/llm`; daemon-side unified server
  remains. PR 48 (annotated against `familiar-unified-weblet-server`)
  flags this and tracks the daemon-side gap.
- [`designs/gateway-bearer-token-auth.md`](./designs/gateway-bearer-token-auth.md)
  Status: Implemented.
- [`designs/lal-fae-form-provisioning.md`](./designs/lal-fae-form-provisioning.md)
  Status: Complete.

## Suggested follow-ups

1. **Resync `daemon-cross-peer-gc.md` metadata.** The on-disk file
   reads "Not Started" while commit `1570e88926` on `llm` declares
   the work complete via retention-set sync. A maintainer should
   either pull the merged metadata into this checkout or, if that
   resync was intentional, file an issue so the discrepancy is
   tracked.
2. **Close PR 61 and PR 77 references from the design.** PR 61 is a
   superseded CRDT-of-pet-stores foundation; PR 77 is the closed-
   unmerged docs batch. Both deserve a one-line note in
   `daemon-cross-peer-gc.md` explaining the supersede chain.
3. **Triage the 16 spec'd-but-not-started designs against the
   roadmap.** Most fall under M1 (Capabilities, Tools), M3 (Weblets,
   Integrations), and M5 (Confinement, Ecosystem). The remaining
   work is genuinely planned work.
   `chat-rename-dismiss-to-clear` and `daemon-agent-network-identity`
   are the smallest items and could be opened as draft PRs by the
   next contributor on those areas.
4. **Mark `chat-reply-chain-visualization.md` as superseded in the
   README.** The README already lists it as "Deprecated"; the design
   file already declares the supersede chain. Verify the
   `Supersedes` link round-trips correctly and consider removing the
   file from the active design index.
5. **Decide whether the outliner and channel-threads research files
   belong in `designs/`.** They are exploratory and lack the metadata
   format the project's `CLAUDE.md` mandates. A separate `research/`
   directory would let the design corpus stay focused on actionable
   proposals.
6. **For the 22 already-complete designs that have no PR
   reference on bots:** consider adding a brief "Landed in" footer
   pointing at the merge commit on `llm` (or upstream `actual/llm`),
   so future readers can trace the work without grepping git history.
