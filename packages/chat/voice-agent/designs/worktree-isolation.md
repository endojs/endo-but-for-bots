# Per-sub-agent git worktree isolation — retiring THE WRITE RULE

*Shipped 2026-06-21. The mechanism that lets write-capable role sub-agents
(executor / testRunner / debugger) run **in parallel** without racing, replacing the
old "writes are single-threaded through the Blacksmith" rule.*

## The problem

Dev roles moved **in-framework** (`via:'subagent'` — confined CodeMode sub-agents whose
every step shows in the trace), but they hold the `host` power. `hostExec` shells on the
host with `cwd = $HOME`, a **shared** working dir. Two parallel write-capable sub-agents
(`employ('executor', …)` twice in one turn) would edit the **same checkout** and stomp
each other. `roles.test.mjs`'s WRITE RULE still asserted the retired single-threaded
invariant, so the contract was red.

`home`/`fileWrite` were **already** per-node isolated (each sub-node gets its own
`cap-<label>` home dir). `hostExec` was the *one* shared write seam.

## The mechanism

A write-capable role declares a fourth axis, `isolation: 'worktree'`. When `employ()`
runs such a role **and** the granted ring includes `host`, it:

1. **allocates a git worktree** off `WORKTREE_REPO` @ `WORKTREE_BASE_REF` (default
   `/home/dan/endo-bfb-llm` @ `HEAD`) on a fresh branch `agentwt/<id>`, under
   `~/.local/state/field-agent/worktrees/<id>`. `git worktree add` shares the existing
   object db (`/home/dan/endo-bfb/.git`), so it's cheap and safe while the live service
   runs from the same repo.
2. **binds the sub-node's host shell to it** via a new `cwdBinding` on `makeAgentNode`
   (a lazy thunk, exactly like `homeBinding`/`haBinding`/`notesBinding`). The sub-node's
   `hostExec` runs with the worktree as its default dir, and an agent-supplied `cwd` is
   resolved-relative + **refused if it escapes** (`resolveJailedCwd`). The shared
   `aff.host.exec` gained an inert `jail` option — absent jail = byte-for-byte the prior
   behavior, so the root agent and every existing caller are unaffected.
3. **tears the worktree down in `employ`'s `finally`** (cancel-safe): commits any dirty
   tree to `agentwt/<id>` **first** (work is never lost), then `git worktree remove`. On
   commit failure it **refuses to remove** and leaves the work on disk. The branch is
   never auto-merged or deleted — promotion is the operator's gated call (matches the
   dev-spawner / blacksmith merge-back discipline). The branch name is surfaced in the
   `employ` result (`worktree: { branch, committed, dirty, removed }`).

So parallel writers edit **disjoint checkouts** and cannot race — the WRITE RULE's actual
intent, achieved by isolation instead of serialization.

## The new invariant (roles.test.mjs)

> A write-capable role is race-safe **iff** it is either routed to the single-threaded
> executor (`via:'dev'`, still legal for a future role) **OR** confined to its own git
> worktree (`isolation:'worktree'`). Read-only fan-out roles carry no worktree.

Statically enforceable (a pure `roleList()` read, no model). The lifecycle itself is
proven by `worktree.test.mjs` against a real throwaway repo: create → dirty-commit-to-
branch → remove; clean removal; **two parallel writers editing the same path don't
collide**; stale-leak recovery; and the cwd-escape guard.

## What this is NOT (honest scope)

A worktree is **race-isolation + a recoverable diff, not a kernel sandbox.** `host` stays
ambient host-root by construction — a shell command can still `cd` elsewhere or bake an
absolute path into the command string (`hostExec({cmd:'cat /etc/passwd'})` works; that is
the same authority `host` already grants). The worktree sets the **default** dir and guards
the `cwd` **parameter** (syntactically *and* against symlink escape — `resolveJailedCwd`
realpaths the target so a symlink planted inside the worktree can't redirect `cd` outside
it). It does **not** contain a host-root shell that chooses to escape via the command
string. True escape-confinement is the **`@endo/sandbox` (bwrap/podman)** layer —
bind-mount only the worktree, deny the rest — tracked separately (see the
`endo_sandbox_genie` memory). Binding the worktree host facet through a bwrap slice is the
natural next increment, and is what would make `host` itself a real boundary.

> **UPDATE — bwrap confinement SHIPPED (2026-07-02).** The "natural next increment" above is
> done. `hostExec` on a `jail`-bound worktree node now runs **inside a bwrap sandbox** when
> `bwrap` is present: `agent-caps.mjs` (`BWRAP_BIN`/`WORKTREE_BWRAP`/`BWRAP_BASE`, and the
> `if (WORKTREE_BWRAP)` branch in the shared host `exec`) binds **only** the worktree dir with
> `--unshare-all` (no network; secrets / other state / write-elsewhere denied); it **falls back to
> the cwd-jail** (the softer isolation described above) only when bwrap is absent or `WORKTREE_BWRAP=0`.
> The same sandbox wraps the render-check child (`render-check.mjs`, which **fails closed** — skips
> rather than executing unsandboxed). So on this host `host` *is* a real boundary for worktree roles;
> the cwd-jail caveats above apply to the bwrap-absent fallback. Proven by `bwrap-confinement.test.mjs`.

## Safe-teardown specifics (from adversarial review)

- **Reclaim never force-deletes.** If `git worktree add` fails, `create()` runs only
  `git worktree prune` (GCs registrations whose dirs are already gone — never a branch or
  any work) and retries; on persistent failure it **throws** rather than `branch -D`/`rm
  -rf`, so a leaked branch's un-merged commits are never destroyed to make room. (ids are
  unique per spawn, so real collisions are astronomically unlikely anyway.)
- **Gitignored content is not preserved.** `git add -A` commits tracked + untracked
  *non-ignored* changes (the real source diff). Regenerable build output (node_modules,
  `*.o`, dist) is gitignored and intentionally dropped on teardown — committing it would
  bloat the shared repo. The branch *is* the reviewable diff.

## Open questions for dan

1. **Base repo for a generic `executor`.** Hardwired default = `endo-bfb-llm` @ `HEAD`
   (env-overridable: `FIELD_AGENT_WORKTREE_{REPO,BASE,DIR}`), correct for self-improvement
   coders working *on* Agent C. A coder asked to work on a *different* repo would be
   checked out the wrong tree. Wire an optional `repo`/`base` arg on `employ`? (deferred)
2. **PR-open.** This delivers isolation + a recoverable local branch; it stops short of
   opening a PR (the blacksmith `http.extraheader` token reuse). Confirm the isolation
   floor is the intended scope; PR-open is the follow-on.
3. **Parallelism cap + disk.** Each worktree is a full source checkout (~100s of MB;
   partial-clone, so cold blobs need network). Concurrent spawns + the refuse-and-surface
   leak policy accumulate worktrees. A bounded spawn cap + a periodic `git worktree prune`
   reaper is worth adding if parallel dev-role use grows.
