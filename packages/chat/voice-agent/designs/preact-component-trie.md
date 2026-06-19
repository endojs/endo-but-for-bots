# Extensible UI: a trie of confined Preact component-projects

Source: dan's voice note 2026-06-19 (`vault/inbox/processed/Extensible UI via Preact Confinement and Git Objects.md`).
Status: DESIGN — phased. Phase 1 (the DOM→Preact port) is the immediate ask.

## The one-sentence vision

Refactor the field-agent UI from a monolithic DOM app (+ iframed applets) into a
**tree of nested, confined Preact components, where every component is its own
project backed by a git-as-Endo-object** — so any user can select any element,
talk to a micro-agent scoped to just that component, fork it, mutate their own
live interface, and share those mutations along capability-graph trust lines
without iframes.

## Why this is buildable now — the building blocks already exist

| Need (from the voice note) | Building block | Where |
| --- | --- | --- |
| "a project is a git repository exposing the folder/filesystem interface + branches + PRs" | `@endo/exo-git` `makeGit({mount,backend,lineageOf,readOnly})`; `git-filesystem.js`; `git-remote.js` (fetch/pull/push w/ credential caps) | `packages/exo-git` (in tree) |
| Node-side git backend (subprocess over real `git`) | `@endo/endo-git` `makeNativeGitBackend({repoRoot,makeReaderRef})` | `packages/endo-git` (in tree) |
| the folder/filesystem seam a project already speaks | `@endo/endo-fs` `Filesystem`/`FsBackend` (`makeGitFsBackend` adapts a git tree onto it) | `packages/endo-fs` |
| render a component CONFINED under SES (no exfiltration) | `@endo/preact-container`: `confineComponent`, `renderConfined`, `unmount`, `h`, hooks; `renderConfined` strips refs/dangerous tags/attrs, frozen `SafeEvent`, `SafeDataTransfer` (string-only, no File/FS/DOM) | **PR #471 branch** `claude/chat-preact-setup-r95thr` → `llm` (NOT yet in our working tree) |
| micro-agent scoped to one component, forks + adversarial dev flow | our existing `projects` + `delegateTask`/`employ` (CodeMode, traced) + `dev` ring (`host`/`home`) | `voice-agent/` |
| "valid for distribution" = a social-collateral trust act | our social-collateral capability-governance model | memory `social_collateral_capability_governance`, `[[Social Collateral]]` |

The two things we do NOT yet have locally: `@endo/preact-container` (lives on
PR #471, unmerged) and the wiring that makes **a component a project a git
object**. Everything else is in the repo.

## The model: component = project = git object

Today a **project** is a folder (`projects.mjs`, shared home folder). The voice
note upgrades that: a project becomes a **git repository** that *exposes the same
folder/filesystem object interface* (so existing folder-traversal code keeps
working) but additionally supports `checkout`, branch, fork, and pull-request.
`@endo/exo-git` is exactly this — `makeGit` over a backend, with
`git-filesystem.js` presenting the tree as a `Filesystem`.

The app is then a **trie of these project-objects**: the root app-project nests
child component-projects, each nesting theirs. Each node renders a confined
Preact component (`renderConfined`) mounted into its parent's slot — **no
iframes**; confinement is the SES compartment + the sanitizing renderer, not an
iframe boundary. Because each node is a git object, a node can be **forked and
swapped at runtime** (check out a different tree-oid → re-render) per user.

## Interaction model (later phases, but design now)

1. **Alt/Option-select.** Hold Alt/Option → hover draws an outline around the
   *lowest-level component* under the cursor (desktop); click/tap selects it.
2. **Per-component agent.** On select, a button appears → opens a chat with the
   **micro-agent for that element's project**. Its scope is just that component
   → least-privilege, focused edits. (This IS our delegate-as-agent pattern,
   confined to the component-project's git object + a dev ring.)
3. **Mutate.** Submit a prompt → the agent **forks** the component-project,
   edits, **writes tests, runs the adversarial dev flow**, presents the diff.
   A per-element flag makes **revert to a previous version** one tap (git
   lineage). The user freely mutates their own live interface (their fork).
4. **Hosting power.** Keeping your fork live / sharing it requires a capability
   "host your own projects" brought into the interface. Without it you view the
   inviter's current state; with it you keep a personal live fork.

## Sharing & trust (the governance core — design now, build last)

- **Invite = current mutated state.** Inviting someone to a page invites them to
  *its current forked state*. The invite carries an **inbox** (the inviter keeps
  a reference) → the inviter can message the invitee ("I changed X — update?").
- **Atomic upgrades.** Invitee can accept-one / accept-all / reject-all /
  auto-accept-future. Non-destructive "try it on for size" review.
- **Upstream proposals.** An invitee who edits can option-select an element and
  **share it back upstream** (to their inviter) or downstream (to their own
  invitees). At invite time the inviter can flag "I trust this person's judgment"
  / "notify me of their changes" → their edits surface in the notifications feed.
- **The distribution gate = a social-collateral trust act.** Because a component
  is a confined Preact container, *a code-literate admin can verify it cannot
  exfiltrate data* (no network/File/FS/DOM reach; the one residual risk is a
  **destructive write cap passed in**, which stays an explicit endowment-moment
  decision — see memory `endowment_moment_approval`). There is a capability that
  marks a component **"valid for distribution to end users."** Holding/【granting】
  it is a social-collateral act:
  - **Developers** accept external contributions only after **review** — unless
    they granted an explicit "submit-without-review" power (a root power from the
    server administrator).
  - **End users** (default: code-illiterate) must **never** receive a change not
    reviewed by an administrator (or someone granted admin-capacity review).
  - Not "a small council of app-store clerics" — the **maximal flow of trust
    from the core team outward** along the capability graph. (Sits below agora,
    grounded in dan's vault — consistent with `social_collateral_capability_governance`.)

## Phasing

- **Phase 1 — the port (the immediate ask).** Get `@endo/preact-container` into
  our build; stand up the confined-Preact runtime in the voice-agent app
  (pre-lockdown severe taming + `renderConfined`); establish the
  **component-as-project tree** scaffold (one mount point that renders a
  confined component, swappable at runtime); **port one real slice** of the
  current DOM app to prove the path end-to-end. No agent/sharing/trust yet.
- **Phase 2 — component = git object.** Back each component-project with an
  `exo-git` object (fork = branch/clone of a tree-oid; revert = checkout
  lineage); runtime-swap a component by re-rendering a different tree.
- **Phase 3 — alt-click micro-agent.** Selection overlay (Alt/Option hover +
  outline + select), per-component chat → a delegate confined to that
  component-project's git object + dev ring; fork → adversarial dev flow → diff
  review → revert flag.
- **Phase 4 — sharing & upgrades.** Invite-carries-inbox; atomic accept/reject/
  auto upgrades; non-destructive try-on review; upstream/downstream element
  sharing; trust flags in invites → notifications feed.
- **Phase 5 — distribution trust.** The "valid for distribution" capability as a
  social-collateral act; admin review gate for end-user distribution;
  exfiltration-proof verification of a confined container.

## Open sequencing decisions (for dan)

1. **How to obtain `@endo/preact-container`** — rebase our fork onto `llm`/#471
   (clean, but #471 is open/unmerged) vs vendor the package onto our current
   branch now (fast, but divergence to reconcile when #471 merges).
2. **Port strategy** — incremental islands (mount confined Preact components into
   the existing 2223-line DOM `app.js` one at a time; lowest risk; both render
   paths coexist behind a flag) vs a big-bang rewrite.
3. **First slice to port** — a self-contained leaf (e.g. the budget chip, the
   composer, a message bubble, or the Shares panel) to validate confined-render
   + project-backing + runtime-swap before widening.
