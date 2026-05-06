# Designs without an in-flight PR on endo-but-for-bots

Snapshot at 2026-05-06T00:00:00Z (drift-check pass).

Of 79 design documents in `designs/` (75 in the root plus 4 under
`channel threads/`, excluding `README.md` and `CLAUDE.md`), 32 have at
least one associated pull request on `endojs/endo-but-for-bots`; the
remaining 47 are listed below grouped by classification.

This snapshot applies the **drift-check pass** procedure (see
[`../roles/groom.md`](../roles/groom.md)) to every entry that the
prior groom marked `Spec'd-but-not-started`. Each entry is
re-classified into `eligible-for-builder`,
`blocked-on-design-revision`, `blocked-on-dependency`, or
`blocked-on-maintainer-decision` so the marshal's eligibility filter
can dispatch from a clean priority list.

## Summary

| Classification | Count |
| --- | --- |
| Started but stalled (branch exists, no PR) | 0 |
| Spec'd but not started | 13 |
| Stale (superseded by another design) | 1 |
| Aspirational / discussion-only | 10 |
| Already complete (work landed without an explicit open PR) | 23 |
| **Total** | **47** |

The Spec'd-but-not-started count dropped from 16 to 13 since the
2026-05-02 snapshot because three entries acquired PRs:

- `chat-rename-dismiss-to-clear` merged as PR #93.
- `daemon-guest-eval-simplification` merged as PR #92.
- `daemon-content-store-gc` is in flight as open PR #99.

## Started but stalled (0)

A design has a working branch (local or on bots) that diverges from
master, but no PR was ever opened. No such branches exist for the
remaining unannotated designs. Two open branches that match queue
slugs (`feat/chat-rename-clear`, `feat/daemon-guest-eval-simplification`)
correspond to merged PRs #93 and #92 above.

## Spec'd but not started (13)

Reads as a polished design ready to be acted on; no branch, no PR.
Each entry is followed by its drift-check classification and a
one-sentence "why".

### eligible-for-builder (3)

Both drift-pattern A (design vs. later code refactor) and drift-pattern
B (compose-pattern dependency) checks pass. The marshal can dispatch a
builder against any of these.

- [`designs/daemon-os-sandbox-plugin.md`](./designs/daemon-os-sandbox-plugin.md)
  pluggable platform-specific worker sandboxing (bwrap, podman,
  sandbox-exec, AppContainer).
  No upstream design dependencies; deps are external (bubblewrap,
  sandbox-exec). 516-line concrete spec with capability flow, endowment
  descriptors, and test plan.
- [`designs/endoclaw-browser.md`](./designs/endoclaw-browser.md)
  Playwright-backed `Browser` exo with origin allowlist.
  Deps are Playwright (external) and worker infrastructure
  (`makeUnconfined` already exists); `daemon-os-sandbox-plugin` is
  listed as optional.
- [`designs/endoclaw-skill-registry.md`](./designs/endoclaw-skill-registry.md)
  capability-aware skills directory.
  Design's `Depends On` section explicitly notes EndoDirectory,
  guest-plugin install infrastructure, and string value storage are all
  already implemented.

### blocked-on-design-revision (4)

Drift pattern A failed (a later refactor invalidated the design's
premise) or the document is structurally an idea-bag / parent index
rather than a single-PR target. Needs a designer to reconcile or to
extract a focused sub-design before a builder can act.

- [`designs/daemon-agent-network-identity.md`](./designs/daemon-agent-network-identity.md)
  per-agent Ed25519 keypair identity for OCapN network registration.
  Drift A: items 1 and 2 are marked `*(Done)*` against a `LOCAL_NODE`
  sentinel that commit `d0ce26b327 refactor(daemon): migrate to SQLite,
  remove LOCAL_NODE and synced pet stores` deliberately removed. The
  design and the code now disagree about the storage representation.
- [`designs/daemon-capability-bank.md`](./designs/daemon-capability-bank.md)
  family overview integrating filesystem, persona, OS-sandbox, and
  other capabilities into a unified bank.
  Structural: this is a parent index document that names eight
  sub-capabilities (filesystem, process, network, git, env, credentials,
  userio, timer) and points at separate sub-designs. There is no
  single PR shape; the document plays the same role as `endoclaw.md`
  and belongs in the Aspirational/Reference group, or needs a
  composition-layer sub-design to be written.
- [`designs/daemon-capability-filesystem.md`](./designs/daemon-capability-filesystem.md)
  `Dir` and `File` capabilities for structural filesystem confinement.
  Structural: explicitly framed as "ideas and directions" and "a bag
  of ideas at varying levels of maturity". The document itself
  recommends contributors "pick one facet and write a focused design
  for it"; it is not itself implementable as one PR.
- [`designs/daemon-capability-persona.md`](./designs/daemon-capability-persona.md)
  delegates and epithets for cross-peer identity tracking.
  Structural: framed as "ideas and directions" exploring "how an agent
  can create subordinate agents". Same shape as
  `daemon-capability-filesystem` above; needs extraction of a focused
  sub-design.

### blocked-on-dependency (6)

Drift pattern B failed (a named dependency is in flight but the phase
the dependent needs has not shipped, OR the design's own `Depends On`
under-declared a dependency the README's milestone-summary annotation
caught). Needs the named dependency to land before the design is
actionable.

- [`designs/endoclaw-notifications.md`](./designs/endoclaw-notifications.md)
  `Notify` exo bridging daemon to Electron `Notification` API.
  Drift B (under-declared dep): the design's `Depends On` claims
  standalone, but `designs/README.md`'s milestone-summary annotation
  explicitly notes "needs daemon↔Electron bridge", which does not
  exist as a design. Architecturally verified: Familiar spawns the
  daemon as a detached Node child with no daemon→Electron-main CapTP
  path. Needs a `daemon-electron-bridge` design (or equivalent) to
  ship before this is actionable. Reclassified from
  eligible-for-builder on 2026-05-06 after a dispatched builder hit
  the impasse and surfaced the under-declaration; `roles/builder.md`
  now cross-checks README annotations against the design's own
  `Depends On` for future passes (see commit `fe9d7ab950`).
- [`designs/daemon-weblet-application.md`](./designs/daemon-weblet-application.md)
  weblet applications hosted from readable-tree zip archives.
  Depends on `familiar-unified-weblet-server` (PR #100, open) for
  virtual host routing AND on the `kriskowal-zip-compression` branch
  being merged to master before implementation begins (the design's
  own `## Prerequisites` section says so).
- [`designs/endoclaw-channel-bridges.md`](./designs/endoclaw-channel-bridges.md)
  Vercel `chat` SDK adapters for Slack, Telegram, Discord, etc.
  Depends on `endoclaw-network-fetch` or `endoclaw-oauth` for platform
  API access. Both are unshipped: `endoclaw-network-fetch` is in flight
  as part of PR #40 (`HttpClient` exo) and `endoclaw-oauth` is itself
  blocked on that same PR.
- [`designs/endoclaw-oauth.md`](./designs/endoclaw-oauth.md)
  credential capability so an agent uses a service without seeing the
  raw token.
  Depends on `endoclaw-network-fetch`, which is in flight as PR #40 but
  not merged. The OAuth design wraps the `HttpClient` from that PR;
  building before the wrapped API lands risks shape mismatch.
- [`designs/endoclaw-proactive-messages.md`](./designs/endoclaw-proactive-messages.md)
  pattern for composing Timer plus data caps plus `send()` for
  briefings and reminders.
  Drift B: depends on `endoclaw-timer`. PR #40 ships only Phase 1
  (`onTick` host-side callback). The proactive-messages pseudo-code
  needs Phase 2 (mail-delivered ticks via the agent's inbox, explicitly
  deferred in the timer design's "Not yet implemented" list). The
  surface-level `Status: In Progress` on the timer design fooled the
  prior eligibility check.
- [`designs/familiar-chat-weblet-hosting.md`](./designs/familiar-chat-weblet-hosting.md)
  iframe hosting and guest profiles for Chat-side weblets.
  Depends on `familiar-unified-weblet-server` (PR #100, open) for the
  WebSocket-to-MessagePort bridge endpoint. Familiar-side
  `localhttp://` infrastructure has shipped, but the design's
  remaining-work list assumes the unified server is available.

### blocked-on-maintainer-decision (0)

No designs in this pass had open questions that the builder couldn't
guess at; all blockers reduced to drift-A or drift-B causes. Reserved
slot for future passes.

### Eligibility ranking for the marshal

Filtered to the three `eligible-for-builder` entries only, ranked by
the prior groom's roadmap-priority signal (M1 capabilities and tools
ahead of M3 weblets/integrations, with smaller surface area as a
tiebreaker):

1. [`designs/endoclaw-skill-registry.md`](./designs/endoclaw-skill-registry.md)
   moderate surface (252 lines), all deps already implemented.
2. [`designs/endoclaw-browser.md`](./designs/endoclaw-browser.md)
   small surface (93 lines), one external dep (Playwright install).
3. [`designs/daemon-os-sandbox-plugin.md`](./designs/daemon-os-sandbox-plugin.md)
   largest surface (516 lines), platform-specific backends; broadest
   M1 capability impact.

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
3. **Reconcile `daemon-agent-network-identity.md` with the SQLite
   refactor.** The design's items 1 and 2 are still marked `*(Done)*`
   but commit `d0ce26b327` removed `LOCAL_NODE` and the synced pet
   stores those items introduced. A designer should rewrite items 1
   and 2 against the SQLite-backed model, or strike them from the
   plan, before any builder can act on items 3 and 4.
4. **Move the three "ideas and directions" documents to the
   Aspirational/Reference group**, or extract focused sub-designs
   from each: `daemon-capability-bank.md` (parent family overview),
   `daemon-capability-filesystem.md`, `daemon-capability-persona.md`.
   They consume slots in the Spec'd-but-not-started list without
   being implementable as written.
5. **Mark `chat-reply-chain-visualization.md` as superseded in the
   README.** The README already lists it as "Deprecated"; the design
   file already declares the supersede chain. Verify the
   `Supersedes` link round-trips correctly and consider removing the
   file from the active design index.
6. **Decide whether the outliner and channel-threads research files
   belong in `designs/`.** They are exploratory and lack the metadata
   format the project's `CLAUDE.md` mandates. A separate `research/`
   directory would let the design corpus stay focused on actionable
   proposals.
7. **For the 22 already-complete designs that have no PR
   reference on bots:** consider adding a brief "Landed in" footer
   pointing at the merge commit on `llm` (or upstream `actual/llm`),
   so future readers can trace the work without grepping git history.
