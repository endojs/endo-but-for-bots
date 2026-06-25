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

## The virtual File/Folder abstraction — build on the Endo **"directory"** (Kris Kowal, 2026-06-25)

Authoritative guidance from Kris Kowal — this **corrects** the earlier "inherits from" framing:

- **The thing to build on is the Endo "directory"**, which is a *superset/generalization* of the Endo
  platform **filesystem** directory: it has `readFile`/`writeFile` among other things, and **holds its
  entries directly in the CAS** (content-addressed store) — but with **less** of the unix baggage (no
  `stat`/`mode`/`xattrs` or such). So "objects as files" is native: an Endo directory already holds
  CAS-backed entries, which is exactly where islands/caps/grains-as-files live.
- **The relationship is METHOD-NAME PARITY, not subset/superset/inheritance.** Endo directories and
  filesystem directories are *neither* a subset nor superset of each other; the discipline is: **if both
  implement a method name, it has the SAME SEMANTICS on both**, and **to the extent a method name has a
  sensible interpretation, both implement it.** So our composite Inventory folder must follow the same
  rule — implement the shared verbs (`readFile`/`writeFile`/list/lookup/…) with identical semantics
  whether the entry is a real unix file or an endo object; don't model it as one extending the other.
- **`editFile` (hashline editing, "for the bots")** — in our tree the fs/edit tooling lives in
  **`packages/fae/`** (`setup-fs-tools.js`, `src/tool-makers.js`) and **`packages/genie/`** (`DESIGN.md`);
  ride that for the in-place-edit verb the per-component/fork edit agents want. (Kris: the hashline
  `editFile` is in a PR — reconcile with `fae` before building our own.)
- **9p / Plan 9 is the target, not yet reached.** The bridge is **`packages/9p-server/`**
  (`src/fs-bridge.js`, `src/wire.js`, `README.md`) — that's the "Plan 9 bridge in endo-but-for-bots."
  Kris: hasn't yet figured out whether the Endo directory squares with 9p, "but that's where we should
  arrive." So convergence is a *goal*, not a solved bridge to wrap. **Status: ~two rounds of work done
  upstream toward endo-dir↔fs-dir parity; Kris is NOT confident it's done** — build on a moving target:
  expect gaps, track upstream, contribute parity fixes rather than fork.
- **Endo directory** itself lives in **`packages/daemon/src/`** (the directory/CAS powers —
  `daemon-node-powers.js`, `daemon-persistence-powers.js`).

Concretely: the Inventory backend is a **composite Endo directory** — unix entries (host FS) ∪ endo-object
entries (our CAS overlay), presented as one directory that honors the shared-method-name parity contract.

- **Name-collision rule (Hilbert-Hotel prefixing):** our overlay names risk colliding with real unix
  files that appear later. When the virtualized host "stomps" a name we used for an endo object, **our
  entry bows out of the way of the root filesystem** via a Hilbert-Hotel-style prefix shift (rename our
  entry aside so the real file keeps the bare name). Safe because **all our references are by handle, not
  name** (entries are CAS/handle-addressed) — a forced rename never breaks a reference.

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
