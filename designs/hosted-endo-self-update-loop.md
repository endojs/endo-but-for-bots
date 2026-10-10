# Hosted Endo Self-Update Loop

| | |
|---|---|
| **Created** | 2026-08-07 |
| **Updated** | 2026-09-08 |
| **Author** | 0xPatrick (prompted) |
| **Status** | **Complete** |

## Status

Designed 2026-08-07 on the hosted-management staging branch
(`feat/hosted-endo-management`, tracked by
[#994](https://github.com/endojs/endo-but-for-bots/pull/994)) and carried here
on 2026-09-08 as a record of **what was implemented**, not what was proposed.
The proposal's phase plan, its speculative host-side Nix snippets, and its
claim of end-to-end verification on a particular deployment are not reproduced:
the first is spent, the second lives in a repository this one does not contain,
and the third is not a fact this repository can assert.

What landed, and where:

- **The revision surface (done, #1115).** `@endo/space-nixos-admin`'s
  `NixosAdmin` exposes `getEndoRev()` and `stageRev(rev, message?)`, pinned by
  `test/endo-rev.test.js`.
- **Prebuild before approval (done, #1115 with the chart work in #1118/#1191).**
  `prebuildRev(rev, message?)` builds a release and publishes it by revision,
  pinned by `test/prebuild.test.js`.
- **The spool contract (done, #1115).** `packages/space-nixos-admin/PROTOCOL.md`
  specifies version 2 between `NixosAdmin` and the privileged service, including
  the prebuild protocol and atomic publication.
- **The wiring (done, #1203).** `packages/floot/machine-admin-setup.js` grants
  the NixOS controller, the Forgejo push credential, and one proposal-only
  deploy connection per chart to the Floot factory host; `agent.js` gains the
  `machine-admin` preset and its workflow-routed prompt.

The loop is driven as durable workflow runs rather than from prose. That half is
[floot-admin-deploy-workflows](floot-admin-deploy-workflows.md); this document
covers only the revision pin the charts operate on.

## Summary

Let a machine-admin agent change the Endo source its host runs on, and move the
host onto that change, without leaving the machine in a state a rollback cannot
recover.

The spine is that **the host configuration names an exact Endo commit**. When
the running revision is resolved at deploy time it is not part of the
configuration, so a generation rollback does not restore it. Pinning the
revision inside the configuration makes the Endo revision and the system
generation one unit, and the rollback the privileged applier already performs on
a failed health check restores both together.

## What You Should Know First

- **`NixosAdmin`** (`@endo/space-nixos-admin`) is the daemon-side capability. It
  edits a Git checkout of the host configuration and publishes requests into a
  spool; it holds no root authority itself.
- **The privileged applier** is whatever service implements
  [`PROTOCOL.md`](../packages/space-nixos-admin/PROTOCOL.md) version 2 — it owns
  the spool's status, outcome and log files, performs builds and activations,
  and health-checks afterwards. `PROTOCOL.md` is deliberately generic: "an
  installation can implement the service as a NixOS module with systemd path and
  service units; it does not need any Endo-specific NixOS configuration." No
  such service ships from this repository.
- **Every file operation is confined** through one `resolveWithin` choke point
  that rejects absolute paths, `..` escapes, and anything under a `.git`
  directory at any depth (`test/resolve-within.test.js`,
  `test/symlink-confinement.test.js`).

## The pin is a file, and "no pin" is a value

The pinned revision lives in `endo.rev` at the root of the configuration
checkout, read by the host configuration.

A separate file rather than an attribute inside a Nix expression, for two
reasons that survived implementation. An agent setting the pin does a whole-file
write of a validated commit hash instead of a regex edit of Nix source, which
removes a class of "the agent mangled the config" failure; and the diff for a
revision bump is one line in a file containing nothing else.

The implemented surface treats the *absence* of a pin as a value rather than an
error:

- `getEndoRev()` returns the trimmed contents, or `''` when the file does not
  exist — meaning the host is still tracking its configured default branch.
- `stageRev('')` removes the pin, restoring branch tracking.
- `stageRev` rejects anything that is not a full commit hash, at the capability
  boundary, so a bad argument fails there instead of as a Nix evaluation error
  minutes later in someone else's log.
- Surrounding whitespace is tolerated, because a hash is usually pasted, and a
  pin written by hand is read back trimmed.

## Compensation is a second `stageRev`

`stageRev` returns **the revision it replaced** — `''` when no pin file existed.
That return value is what makes the operation composable inside a workflow:
restaging the previous value always restores the exact prior state, including
"there was no pin", so compensation needs no separate undo verb and no
out-of-band record of what the previous state was.

This is the shape the deploy charts require. Staging is inert on its own —
nothing happens to the host until `build`/`apply` — so a run that fails between
staging and applying compensates by restaging and leaves no trace.

## Build before approval

`prebuildRev` exists so that an operator is asked to approve a release that has
already been built, rather than approving a build that may then fail. Its
implemented guarantees, each pinned by a test:

- An empty idempotency key is rejected **before** publication.
- Publication is atomic and attaches by revision, so a caller that loses its
  connection reattaches to the build already running for that revision instead
  of starting a second one.
- Concurrent prebuilds do not overwrite the shared deploy slot.
- A malformed request or status is preserved and fails closed rather than being
  interpreted.
- An unreadable release marker is a protocol failure, not a silent miss.
- A failed prebuild can be retried with a new nonce.

## What this repository does not ship

The privileged half. This repository provides the capability, the spool
protocol, and the confinement; an installation supplies a service that
implements `PROTOCOL.md`, and the health-check and rollback behaviour on which
the recovery argument above depends is that service's to honour. Nothing here
verifies that a given deployment does so.

## Deviations from the original design

- **The loop is workflow-driven, not conversational.** The proposal described an
  agent performing the steps in sequence. As implemented, the `machine-admin`
  preset holds a proposal-only connection per chart and the steps are a durable
  run with operator approval — see
  [floot-admin-deploy-workflows](floot-admin-deploy-workflows.md).
- **Prebuild was added.** The proposal built during the apply; the implemented
  `endo-release` chart builds first so approval follows a real artifact.
- **`stageRev` reports what it replaced.** The proposal had no compensation
  story; returning the previous value gave the charts one without a new verb.
- **Retention policy is not implemented here.** The proposal's "retention policy
  that makes a rollback cheap instead of a rebuild" is a property of the
  installation's release directory, outside this repository.

## Dependencies

| Design | Relationship |
|---|---|
| [floot-admin-deploy-workflows](floot-admin-deploy-workflows.md) | Drives this surface. The `endo-release` chart stages, prebuilds, applies and compensates through the methods described here. |
| [endo-workflow](endo-workflow.md) | Supplies the durable run semantics — run-qualified invoke keys, compensation — that `stageRev`'s return value is shaped for. |

## Prompt

The original design (2026-08-07) was written from this prompt:

> Design a loop that lets the machine-admin agent change the Endo source it
> runs on, publish that change, and move the host onto it — without the
> machine ever being left in a state a rollback cannot recover.

This revision (2026-09-08) was written from a follow-up instruction, while
reconciling the `feat/hosted-endo-management` breakout tracked by
[#994](https://github.com/endojs/endo-but-for-bots/pull/994):

> The designs should document what was actually implemented, not the old
> designs. Only include them if they were merged.

Accordingly the phase plan, the speculative host-side Nix expressions, and the
original "verified end to end" status claim were dropped, and every statement
above was checked against the code and tests on `llm` rather than against the
proposal.
