# Islands as objects + the Inventory virtual filesystem

Source: dan, 2026-06-25 (next big project, AFTER the islands-forking work in
`preact-component-trie.md` lands). Status: DESIGN — not started.

## The one-sentence vision

Every confined-Preact unit (component / page / island — the ocap-parameterized things) is **both
a visitable page AND a first-class OBJECT in the system**, with its own identity ("island" is the
preferred metaphor precisely because it conveys self-identity), and these objects live in a **virtual
File/Folder filesystem ("Inventory")** that overlays endo objects onto the real unix filesystem.

## What a root reference to an island grants

Holding the **root** reference to an island is holding the island-object. It authorizes:

1. **Read & update its base git object** — the island IS a git-as-Endo object (this is the
   `component-git`/`@endo/exo-git` substrate already in tree; see `preact-component-trie.md` P2).
2. **Traverse the filesystem of that project** — the island's worktree as a navigable folder.
3. **Invoke a unix daemon within that worker** — escalate to running a process inside the island's
   confined worker. **Flag this as a MORE EXPENSIVE operation, a last resort** (it crosses from pure
   data/render into compute; it should be visibly costlier and opt-in, not the default affordance).

Attenuated references hand out subsets (read-only, render-only, a single method) along trust lines —
the same least-authority discipline forks already use.

## The Inventory (renames "Powers")

- The top-level **"Powers" section is renamed "Inventory"** and *includes the filesystem*.
- Inventory = a **virtual File/Folder tree** where leaves can be **either** a real unix file **or** an
  **endo object** (an island, a cap, a grain, a fork, …). Folders can mix both.
- **Adding powers to an agent becomes a file-picker over this Inventory** — browse the tree, select
  objects/files to grant. "View the inventory of any given agent" + "select additional inventory for any
  agent" are the two driving UX flows. This replaces the current string-named power dropdown — and aligns
  with `ocap_designate_by_reference` (designation by reference, not forgeable string names).

## The virtual File/Folder abstraction

Build **our own File/Folder abstraction that inherits from / builds on the unix→endo filesystem object
mapping** (the `@endo/endo-fs` `Filesystem`/`FsBackend` seam; `makeGitFsBackend` already adapts a git
tree onto it). Key requirement: **folders that map to a real unix folder BUT into which the user can ALSO
drop endo objects.** So the backend is a *composite*: unix entries (from the host FS) ∪ endo-object
entries (our overlay), presented as one tree.

- **Plan 9 bridge**: there is a Plan 9 bridge in endo-but-for-bots to potentially build on (everything-is-
  a-file lineage fits the "objects as files" model — verify what it exposes before committing).
- **Name-collision rule (Hilbert-Hotel prefixing):** our overlay names risk colliding with real unix
  files that appear later. When the virtualized host "stomps" a name we used for an endo object, **our
  entry bows out of the way of the root filesystem** via a Hilbert-Hotel-style prefix shift (rename our
  entry aside so the real file keeps the bare name). Safe to do because **all our references are by
  handle, not name** — names are a human convenience, not the identity, so a forced rename never breaks a
  reference. (Design the prefix scheme so it's stable + visibly "this was bumped to avoid the host".)

## Why this matters / how it composes

- It makes the Inventory **browsable + pleasant** (the real ask): see what you hold, see what any agent
  holds, grant more by picking from a tree instead of typing power names.
- It unifies the substrates we already have: islands (`preact-component-trie`), forks (`forks.mjs`),
  component-git objects, grains, caps — all become *files in folders*.
- Sequencing: this lands **after** the islands-forking work (keystone + fork→edit→re-share +
  alt-click + sharing/upgrades, already shipped behind `FIELD_LOCKDOWN`). It is its own large project.

## Open questions to resolve at start

1. What exactly does the in-tree **Plan 9 bridge** expose, and is it a backend we extend or a reference?
2. Composite-FS ordering + the Hilbert-Hotel prefix scheme (stable naming, conflict detection cadence).
3. The "invoke a unix daemon in the worker" escalation — cost model + the confinement story (it's the one
   affordance that breaks pure-data confinement; tie it to an explicit, costlier endowment moment).
4. Inventory persistence: where the overlay (object-entries + folder structure) is stored vs derived.
