# Hosted deployment acceptance

Codex now composes shared sandbox services, session ownership, broker scopes,
supervision, and directory-backed storage.
Mocked evidence and skipped native tests are not deployment acceptance.

## Boundaries

The broker owns renewal credentials and revocable inference grants.
The listener exposes a credential-free endpoint in the selected namespace.
The controller verifies session, account, model, image, network, and complete
observed native policy before admitting the CLI.
The runtime verifier checks effective configuration and absent CLI-home auth files.
Launch arguments alone do not prove descendant confinement.

The supervisor fences inference before shutdown and removes the namespace anchor
and 9P projection only after sandbox closure.
Failed cleanup remains retryable.
The session owner persists plans and immutable dependencies.
Storage deletion follows native cleanup and preserves external workspaces.
Host records are separate from the guest-writable CLI home.
There is presently no per-session kernel quota on persistent directories.

The volume registry, quota host, registry worker, and storage leases are retired.
Historical XFS acceptance cannot certify the replacement.

## Live migration gates

Record commit, image digests, CLI version, native profile, and host configuration
without recording credentials.

1. Deliberately retire old retained Codex formulas and exact native resources,
   preserving Secrets, then provision fresh services.
   Check setup retains services and refuses changed dependencies.
2. Run a fresh Floot Codex session with an Endo tool call and native workspace
   write; independently read back final replies and tool records.
   Inspect actual mounts for separation of workspace, CLI home, and host records.
3. Restart with native state present, verify stack-authoritative restoration,
   and run another tool call.
   Record manual repairs honestly rather than claiming automatic recovery.
4. Interrupt a turn and run another.
   Separately emergency-stop the session and verify inference revocation.
5. Delete and verify absence of owned containers, namespace anchors, 9P mounts,
   workspace, private directory, CLI home, and records.
   Check repeated deletion, failed-cleanup retry, and external-workspace preservation.
6. Run native sandbox policy tests on Linux.
   Exercise network-off and public-internet policies, private-address denial,
   direct bypass attempts, effective environment, and descendants.
7. Exercise refresh, secret replacement, model/route denial, active-response
   revocation, listener failure, malformed traffic, and redirect rejection.
   Verify durable errors and credential-free diagnostics.

Unit tests cover raw evidence mismatches, cleanup order, protected roots,
retained-service identity, and checkpoints; they do not replace these live checks.

## Evidence status

Previous Tokyo runs demonstrated subscription inference and renewal, Floot tool
use, durable readback, and stack-authoritative restoration on the old composition.
Codex restoration required manual orphan and stale-mount repair.
That is not evidence of automatic recovery for this migration.

The shared supervisor cleanup-order correction passed fresh Claude and OpenCode
tool use and first-attempt deletion on Tokyo at `fa1d91ac6`.
The Codex directory-storage migration still awaits its own live gate.
Historical observations remain in [Linux acceptance](./ACCEPTANCE-2026-09-07.md).
Use [current setup](./HOSTED-SUBSCRIPTION.md) for provisioning rather than historical
volume or authentication assumptions.
