# Durable hosted session volumes

`makeCodexDurableVolumeProvider` implements the resource provisioner's
`makeWorkspace`, `mountWorkspace`, `volumeProvider.describe`, and `destroy`
operations.
A workspace and Codex state use distinct ordinary rootless Podman volumes.
Initialization sets only an empty volume's root to UID/GID 1000 in Podman's user
namespace; it never recursively changes existing data's ownership.

The operator supplies a dedicated volume root, an exclusive XFS project-ID range,
a stable owner ID, and a private registry directory outside every agent slice.
`makeFileVolumeRegistry` persists reservations and lifecycle progress with fsync
and atomic replacement while a Linux `flock --no-fork` worker holds the lock.
Project IDs are never reused, including after deletion.
Quota limits left on empty retired projects do not give later sessions authority.

`makePodmanSessionVolumes` runs as the rootless storage owner.
`makeXfsSessionQuota` receives separate quota-administration authority and verifies
its work through `makeXfsVolumeQuotaObserver`.
The latter reads actual project identity, inheritance, enforcement, and hard limit.
A recorded Podman `size` option does not establish any of these facts.
The privileged runner must execute only supplied fixed executable/argument arrays,
reject unsuccessful commands and diagnostics, and bound/reap their processes.
No runner or quota capability is delegated to the model.

## Recovery

Every resource identity is reserved before creation.
Retries reconcile the same names, physical identities, and quota projects.
Provisioning failure and lease release preserve both volumes.
Explicit destruction records a tombstone first and removes volumes without force;
failed deletion is retryable, and reopening is refused until deletion completes.

Durable leases prevent a second provider instance from attaching the same session.
`recoverLease` is an operator-only recovery operation: stop the previous daemon
incarnation and complete its owner-scoped container reaping before invoking it.
It refuses volumes still referenced by containers and revokes the old lease's
ability to describe the volumes.
It does not itself stop an arbitrary daemon process.

The registry writes a durable transaction marker before permitting host effects.
If its lock worker dies, other processes refuse that marker rather than entering
while the original callback is still operating.
The original parent can clear its marker only after its callback settles.
A crashed parent leaves the marker for `recoverAbandonedTransaction()`.
That operator-only method requires an `ownerReaper` capability supplied to the
registry constructor.
It refuses a still-live PID/start-time identity, waits for the bounded reaper to
finish all descendants and pending host operations, then rechecks the exact
marker and dead-owner identity under the registry lock before retiring it.
A failed or timed-out reaper leaves the marker in place.
Do not treat an unlocked flock as proof that previous host operations stopped.
Control-response deadlines do not cancel arbitrary callback effects; a hung host
capability retains the transaction instead of permitting unsafe overlap.

## Acceptance

`test/volume-host-fixture.js` is an explicit Linux acceptance fixture, including
its test-only fixed-command sudo wrapper.
`test/verify-volumes.js` writes as UID 1000, reopens through a fresh provider,
verifies retained content, releases the lease, and explicitly destroys the pair.
Run it only against an isolated test deployment with its own reserved project-ID
range and the three `ENDO_VOLUME_REGISTRY`, `ENDO_VOLUME_ROOT`, and
`ENDO_QUOTA_FILESYSTEM` environment variables.

The controlled lifecycle tests exercise creation interruption, identity drift,
durable lease exclusion, deletion retries, lost save acknowledgements, and final
uint32 project-ID allocation.
The Linux registry tests separately exercise real file persistence, flock
serialization, and SIGKILL of the lock holder while host work remains pending.
These tests do not replace the complete hosted deployment acceptance run.
