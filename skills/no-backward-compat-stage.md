# No backward-compat for daemon, familiar, chat at this stage

## The rule

At this stage of the project, the **daemon**, **familiar**, and
**chat** packages do **not** preserve backward compatibility.
A change that breaks an existing call site is acceptable, **provided
the call sites are updated in the same PR**.

This means:

- No backward-compat shims, aliases, or fallback code paths to keep
  old call sites working.
- No deprecation periods, no soft-removed-then-hard-removed cycles.
- No version-bump-major signals; these packages are not yet
  semver-stable and the maintainer has not promised they would be.
- A renamed flag, a removed CLI verb, a changed daemon method
  signature, a moved formula identifier shape: all of these may
  land directly, with the in-tree consumers (the CLI, the chat UI,
  the familiar shell, the tests) updated in the same PR.

The bot's job is to update every in-tree call site, not to keep the
old surface alive.

## Which packages this applies to

The no-backward-compat rule covers the **"shipped surface"
packages that are still iterating**:

- `packages/daemon`
- `packages/familiar`
- `packages/chat`

Other CLI-adjacent packages that exist purely to support the above
(`packages/cli`, `packages/endo`) follow the same posture by
extension; they have no third-party consumers outside the monorepo.

## Which packages this does NOT apply to

**The semver-stable library packages** that are published and
consumed by external users continue to follow semver discipline:

- `@endo/marshal`
- `@endo/pass-style`
- `@endo/eventual-send`
- `@endo/captp`
- `@endo/errors`
- `@endo/init`
- `@endo/ses-ava`
- `@endo/exo`
- `@endo/patterns`
- `ses` itself
- and the rest of the core SES / hardened-JS surface

For these packages, a breaking change requires a major version bump
and the standard CHANGELOG / changeset entry.
The boundary is "would an external `package.json` `dependencies:`
entry break?"; if yes, the package is on the semver-stable side.

When in doubt, check whether the package has a published `CHANGELOG.md`
with semver-style entries (left-of-stable side) or whether it ships
with the daemon / familiar / chat as one tightly-coupled piece
(right-of-stable side).

## What this means in practice

For a builder writing a new feature in the daemon, familiar, or
chat:

- Rename the daemon method directly; update the CLI invocation in
  the same PR.
- Drop a CLI verb whose function is now elsewhere; remove its
  command file, its test, and any docs that mention it.
- Change the on-disk persistence format if the new format is
  better; do not write a migration shim if no production data is
  in flight.

For a fixer responding to a maintainer's "just remove" review note:

- Remove the offered backward-compat code path; do not negotiate
  for a deprecation period.
- Strip the legacy alias / shorthand / fallback in the same commit
  as the new surface.

## What this does NOT permit

- Breaking a test without updating the test.
  The new surface still has to be testable; the no-back-compat rule
  is about what code the in-tree consumers run, not about leaving
  red CI behind.
- Breaking an external SDK consumer of `@endo/*` without a major
  version bump.
  The boundary above is sharp: the daemon / familiar / chat trio
  is what iterates freely; the libraries underneath are stable.
- Hand-waving a behavior change as "we don't promise back-compat"
  without updating call sites.
  The rule is "may break, must fix in same PR", not "may break, may
  leave broken".

## Source

Maintainer directive on PR endojs/endo-but-for-bots#153,
review id 4256759685, comment 3212465507 (kriskowal,
2026-05-09): "We do not have a backward compatibility guarantee
at this time."

## When to cite this skill

- A maintainer review says "just remove it" or "drop the alias".
- A builder is tempted to add a deprecation alias to keep an old
  call site working "just in case".
- A panel juror flags a backward-compat concern on a daemon /
  familiar / chat change; cite this skill to confirm the concern
  does not apply.
- A design document proposes a "backward compatibility window" or
  "deprecation period" section for one of the three packages;
  remove the section.
