# Hosted Endo Self-Update Loop

| | |
|---|---|
| **Created** | 2026-08-07 |
| **Author** | 0xPatrick (prompted) |
| **Status** | Phases 1-3 landed and verified on endo-server; phase 4 proposed |

## Summary

Let the machine-admin agent change the Endo source it runs on, publish that
change, and move the host onto it — without the machine ever being left in a
state a rollback cannot recover.

The spine of the design is that **the NixOS configuration always names an exact
Endo commit**.
Today the deploy resolves a branch tip at deploy time, so the running revision
is not part of the configuration and a generation rollback does not restore it.
Pinning the revision in the config makes the Endo revision and the system
configuration one atomic unit: the existing `nixos-rebuild switch --rollback`
that `endo-nixos-apply` already performs on a failed health check restores both
together.

The agent-facing half is comparatively small, because the pieces already exist:
Forgejo is running, the config checkout is already mirrored to it, and the
machine-admin agent already holds enough authority to edit and push source.
What is missing is a repository for the Endo source, a validated way to set the
pin, and the retention policy that makes a rollback cheap instead of a rebuild.

## What You Should Know First

- **`endo-nixos-apply`** is the root service that commits the endo-owned config
  checkout, runs `nixos-rebuild switch --flake`, health-checks the gateway, and
  runs `nixos-rebuild switch --rollback` when the health check fails.
  It is triggered by a spool file the `@endo/space-nixos-admin` caplet writes.
  See `modules/endo-nixos-admin.nix` in the endo-host repo.
- **`endo-deploy`** is the endo-user service that clones the Endo repo, builds a
  release into `$stateDir/releases/…`, flips the `current` symlink, restarts
  `endo-daemon`, and rolls the symlink back if the gateway does not return.
  It is triggered by its own spool file, written by `@endo/space-endo-mgmt`.
- **`endo-bootstrap`** is a `RemainAfterExit` oneshot ordered `before
  endo-daemon.service` that builds an initial release on first boot.
- **`floot/nixos-config`** on Forgejo is the mirror of the config checkout,
  pushed by `endo-nixos-apply` on every apply, with an `applied` branch and
  `gen-<n>` tags marking revisions that activated and stayed healthy.
- **`endo-src`** is the read-only daemon mount of the Endo source granted to
  `full-control` and `machine-admin` sessions.
  Read-only is contagious: `provideGit` on it yields a read-only `Git`,
  `provideGitRemote` rejects a read-only `Git`, and `provideShell` rejects a
  read-only mount.

## The Loop

1. The agent edits Endo source in a writable work area.
2. The agent pushes the change to Forgejo.
3. The agent writes the new commit hash into the config checkout and requests an
   apply.
4. The apply commits and mirrors the config, rebuilds the system, and brings the
   daemon up on the pinned revision.
5. If the daemon does not come back healthy, the generation rolls back — and
   because the revision is part of the generation, the previous revision comes
   back with it.

## Design

### The pin is a file, not a Nix expression

The pinned revision lives in `endo.rev` at the root of the config checkout, read
by the host configuration:

```nix
services.endo.rev = lib.fileContents ../endo.rev;
```

A separate file rather than an attribute inside `hosts/endo-server.nix` for two
reasons.
An agent setting the pin does a whole-file write of a validated 40-character
hash instead of a regex edit of Nix source, which removes an entire class of
"the agent mangled the config" failure.
And the diff for a revision bump is one line in a file that contains nothing
else, which makes the config history readable.

The module validates the shape at evaluation time, so a malformed pin fails the
`build` dry-run rather than at activation.

### The build is config-driven, the restart is a restart trigger

`endo-bootstrap` becomes "ensure the pinned revision is built and `current`
points at it", still ordered `before endo-daemon.service`.
Because `cfg.rev` is baked into its script, changing the pin changes the unit,
and `switch-to-configuration` restarts it during activation — a `RemainAfterExit`
oneshot is restarted when its definition changes, unlike a plain oneshot.
When the pin does not change, the unit does not change and nothing rebuilds.

The daemon restart is *not* performed from inside that unit.
A unit that runs `systemctl restart endo-daemon.service` while ordered before
`endo-daemon.service` risks deadlocking against activation's own job queue.
Instead the daemon unit carries `restartTriggers = [ cfg.rev ]`, so
`switch-to-configuration` restarts it for us, correctly ordered after the
bootstrap unit has produced the release.

Nothing new is needed for rollback.
`endo-nixos-apply` already health-checks the gateway after the switch and rolls
the generation back when it does not answer.
With the revision inside the generation, that one mechanism now covers a bad
Endo revision as well as a bad NixOS change.

### Releases are keyed by revision and reused

Release directories are currently named `<timestamp>-<rev12>`, so redeploying a
revision that has already been built creates a new directory and rebuilds from
scratch.
That is the difference between a rollback that takes seconds and one that takes
four minutes of `yarn install` — during a recovery, which is exactly when a
dependency on the npm registry is least welcome.

Releases become `$releases/<full-rev>`, and a release whose build completed is
reused as-is.
Completion is recorded by a `.deploy-complete` marker written after the build
succeeds, so a directory left behind by an interrupted build is rebuilt rather
than trusted.

This matters more than it first appears.
Pinning a revision pins *source*, not the built artifact: the build is an
imperative `yarn install`, not a Nix derivation, so two builds of one commit are
not guaranteed to agree even with `--immutable` against a committed lock file.
Keeping the built release is what turns "the same commit" into "the same bytes",
and therefore what makes a rollback a return to a known-good state rather than a
re-derivation of a hopefully-good one.

### Retention follows the generations

Keeping the newest three releases by modification time silently undercuts the
guarantee: a generation you might roll back onto can outlive the release it
pins.

A release is retained while any system generation still on disk pins it.
The pinned revision of a generation is recoverable from the generation itself —
`system-<n>-link/etc/systemd/system/endo-bootstrap.service` names the script in
the store, and the script contains the pin.
The newest few releases and whatever `current` points at are retained
unconditionally as a floor, so a parsing failure degrades to today's behaviour
rather than deleting something load-bearing.

### A rollback must rewind the checkout too

Restoring the generation is not enough on its own.
The config checkout still holds the commit that failed, so the next apply —
even a no-op "apply the committed tree" — puts it straight back, and with the
revision pinned that means the bad revision as well.

The rollback paths therefore rewind the checkout to the commit that produced
the generation they landed on, which the existing `gen-<n>` tag already
identifies, keeping the commit being left behind on a `rolled-back/<ts>-<sha>`
branch so the record of what was tried survives.

### The applier cannot restart itself mid-apply

`endo-nixos-apply` runs the switch, so it has to survive its own activation.
Without `restartIfChanged = false`, a config change that alters that unit makes
`switch-to-configuration` stop the very service running `nixos-rebuild`: the
apply dies by SIGTERM part-way through, leaving a half-switched system and a
stale `nixos-rebuild-switch-to-configuration` transient unit that then blocks
both the retry and the rollback.

This was observed during the rollout, not predicted.
The new definition still takes effect, because it is written to `/etc`; only
the in-flight run is protected.

### The spool deploy sets the pin instead of bypassing it

If `endo-deploy` keeps flipping `current` directly while the configuration pins
a revision, the two fight: the next switch or reboot reverts to the pin, and the
running revision silently depends on which mechanism ran last.

The branch-tracking deploy therefore resolves the branch to a revision, writes
that revision into `endo.rev`, and requests an apply.
The configuration stays the single source of truth for what is running, and a
branch-tracking deploy gains the audit trail and rollback story the config path
already has.

## The Agent-Facing Half

### A repository for the source

`floot/endo` on Forgejo, alongside `floot/nixos-config`.
The Endo repository is roughly 120 MB against 130 GB free, so size is not the
constraint; the decision is whether Forgejo is upstream for the deployed branch
or a mirror that GitHub can overwrite.
This design treats Forgejo as upstream for what the host runs, and GitHub as
where that work is proposed for review.

Pinning a commit is only useful if the deploy can fetch it, and a commit the
agent authors here is on Forgejo and nowhere else.
`services.endo.mirrorUrl` is therefore consulted when resolving a pinned
revision that `repoUrl` does not have.
It is fetch-only, and only for resolving `rev`: a branch-tracking deploy still
resolves its branch against `repoUrl`, so the mirror cannot quietly become the
source of what a branch deploy builds.

### A writable work area

`endo-src` stays read-only, and should: with `FLOOT_CODE_PATH` unset it resolves
to the live deployed release, which is a worktree of the shared clone.
Making it writable would let a session mutate running code.

The agent gets a separate work area instead.
The daemon already has the constructive form — `provideGitClone({ destMount,
endpoint: { url, credential } })` returns a `{ git, remote }` pair against a
scratch mount.

### Setting the pin

`@endo/space-nixos-admin` gains `getEndoRev()` and `setEndoRev(rev, message)`.
`setEndoRev` validates that the argument is a 40-character hex hash before
writing `endo.rev`, so the failure for a bad argument is an error at the
capability boundary rather than a build failure two minutes later.

## Security Posture

This closes a loop in which the agent can modify the code that confines it and
then cause that code to be deployed, on a machine where applying configuration
is already root-equivalent.
It is worth being explicit that this design does not add that exposure — it
makes existing exposure convenient.

The `machine-admin` preset copies `host-powers`, the factory's full `@agent`.
A session holding it can already call `makeUnconfined`, open a shell as the
`endo` user, mint its own credentials, and reach the credential controllers.
The whole loop is therefore already reachable by shelling out; what is missing
is only that it is tedious and unaudited.

Consequently this design does **not** attempt to bound the agent's push
authority, because bounding it while `host-powers` remains in the preset would
be theatre.
The daemon has the right primitives for a bounded version — a bearer credential
whose guest surface is `audience()` alone, with the secret held daemon-side and
injected through askpass, and `provideGitRemote` policy that can restrict pushes
to `refs/heads/agent/*`.
Using them means removing `host-powers` from `machine-admin` and granting a
narrow set instead.
That is a separate change, and it is mostly subtraction.

A middle path, if the bounded version is wanted later without the full
subtraction: let the agent push freely to `agent/*` but have the host pin only
revisions reachable from a branch a human moves.
The pin file makes this cheap to enforce, because there is exactly one place to
check.

## Failure Modes

| Failure | What happens |
|---|---|
| Pin is malformed | Evaluation fails; caught by the `build` dry-run before any switch |
| Pin names a revision that does not exist | Fetch fails; the apply reports an error and does not switch |
| Pinned revision builds but the daemon is unhealthy | Gateway health check fails; the generation rolls back and restores the previous pin |
| Rollback target's release was pruned | Rebuilt from source; slower, and subject to registry availability |
| Interrupted build leaves a partial release | No `.deploy-complete` marker, so it is rebuilt rather than reused |
| Forgejo unreachable during apply | Push is logged and skipped; the apply proceeds, since a mirror failure must not fail a good rebuild |
| A rollback leaves the bad pin in the checkout | The rollback rewinds it to the `gen-<n>` commit, keeping the bad one on a `rolled-back/*` branch |

## Phasing

1. Revision pinning, per-revision releases, generation-aware retention, and the
   restart trigger.
   Self-contained, and valuable even if nothing else lands.
   **Landed.**
2. `getEndoRev` / `setEndoRev` on the nixos-admin caplet.
   **Landed.**
3. The `floot/endo` mirror and `mirrorUrl`, so a revision that exists only on
   the forge can be pinned and fetched.
   **Landed.**
   The agent's writable clone is not yet wired into a session preset; an agent
   holding `host-powers` can call `provideGitClone` itself in the meantime.
4. Optional: remove `host-powers` from `machine-admin` and grant the bounded
   capability set.

### Verified on endo-server

- A pinned revision builds and activates, and the daemon comes up on it.
- A rollback restores the previous revision in **12 seconds**, reusing the
  retained release rather than rebuilding it, and rewinds `endo.rev` with it.
- A branch deploy resolves the branch, writes the pin, and hands off to the
  apply path rather than flipping `current` behind the config's back.
- A commit pushed only to `floot/endo` — not present on GitHub — was pinned,
  fetched from the mirror, built, and run.

## Alternatives Considered

**Keep the revision in the deploy spool rather than the config.**
Simpler, and it is what exists.
Rejected because the spool is transient: the running revision would not appear
in the config history, would not be mirrored, would not be tagged with the
generation, and would not be restored by a rollback — which is the entire point.

**Build Endo as a Nix derivation.**
This would make the artifact reproducible and retention unnecessary, since the
store would hold the build.
Rejected for now as a much larger change: it requires expressing a Yarn
workspace build in Nix, and the repository deliberately avoids build steps for
runtime imports.
Per-revision release retention buys most of the benefit for a fraction of the
work.

**Have `endo-bootstrap` restart the daemon itself.**
Rejected for the ordering deadlock described above; `restartTriggers` expresses
the same intent declaratively and lets activation sequence it.
