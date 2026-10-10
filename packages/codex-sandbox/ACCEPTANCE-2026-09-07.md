# Linux acceptance evidence

These runs used a disposable ARM64 Linux VM with no host filesystem mounts.
They establish the specific mechanisms below, not a completed production
deployment or subscription authentication integration.

## Environment

- Ubuntu 24.04, Linux `6.8.0-138-generic`, rootless Podman `4.9.3`.
- Systemd cgroup v2 with delegated `cpu`, `memory`, and `pids` controllers.
- Node `22.19.0`, Codex CLI `0.152.0` from the checked-in image lockfile.
- A separate XFS filesystem mounted with project quotas enabled.
- Final native ARM64 runtime image digest:
  `sha256:ec59273a0a012bdcad49a66996139ce166fd0f847e0c640763e110fbe2e15f61`.
- Credential-free listener image digest:
  `sha256:ecbbea70fcffba4ec2fe1a8aff898320a1aaa63bb6ff278b2e3775bbada21f17`.

`oci/verify-reproducible.sh linux/arm64` passed two clean builds under Podman
4.9.3, producing identical exported OCI manifests with digest
`sha256:0cfee04e3fce4123734b6237d4a3f94e031d72d3f8e9da9eb4e18ca59e2d2737`.
The exported representation has a different manifest digest from local storage.
A third build retained for acceptance had the same image ID as those builds:
`313bb77aa2bd1db25068c9bc7f080312584ea054129f92dd2304864b69ef1e72`.
Independent image comparison exposed random Codex probe directories, Node
compilation caches, and linker caches containing inode identities.
The recipe now removes those build artifacts.

## Observed results

The strict outer-policy acceptance command passed under all four SES test
configurations, reporting that every required control was attested:

```sh
systemd-run --user --scope -p Delegate=yes \
  corepack yarn workspace @endo/sandbox test:policy:acceptance
```

Live testing found two bugs that controlled filesystem fixtures had missed.
The default cgroup reader decoded an already-decoded string and reported no
controllers; it now reads bytes before decoding.
The operation fingerprint compared a not-yet-started operation with a running
anchor, whose metadata had gained inherited `NPROC` defaults.
It now compares configuration at the same lifecycle stage while preserving the
running anchor's independent kernel attestation.

The initial runtime preflight passed against a build with digest
`sha256:d8781266b40516c7b9ac21dddf6d95d3ca77e7c9855e5a793eacfe3368e8b0c3`,
using a real sandbox
factory and driver, private namespaces, and a credential-free loopback listener.
The parent reached the listener; the inner command could not.
Direct, symlink, hardlink, rename, and subprocess attempts to modify control
state were denied, while `/workspace`, `/tmp`, `/run`, and `/scratch` were writable.
The probe verified the effective environment, CLI version, `NoNewPrivs=1`, and
`Seccomp=2`.
Declared tmpfs mounts now use Podman's supported ownership mechanism and verify
UID/GID and mode; read-write mount flags alone had left them root-owned.

```sh
ENDO_CODEX_RUNTIME_IMAGE=localhost/floot-goal:0.152.0 \
  node packages/codex-sandbox/test/verify-runtime.js
```

The runner reported `LIVE RUNTIME ACCEPTED AND CLEANED`.
It bounds Podman operations and cleanup, attempts sidecar removal even when
slice disposal fails, and reports acceptance only after successful cleanup.
A subsequent container inventory was empty.

That initial runtime fixture uses bounded tmpfs mounts, including workspace and
control state; the combined test below establishes persistent-volume composition.
The pinned runtime remains trusted to apply the same checked policy to later
app-server commands; this preflight is not continuous process observation.

Separately, a plain rootless named volume received XFS project `1176` and a
64 MiB hard limit from the trusted host.
An 80 MiB container write stopped with `ENOSPC` at 64 MiB.
Project-ID and inheritance changes from the rootless user namespace failed.
The actual `makeXfsVolumeQuotaObserver` returned `hardBytes=67108864`, matching
the volume's device, inode, project, and active enforcement state.
Its privileged read-only runner enforced a 5-second deadline and 16 KiB output
limit; no privileged quota authority entered the model container.

Podman's recorded volume-size options did not prove enforcement and failed
when used rootlessly.
The driver now requires independent kernel quota evidence instead.
The host owner can change project IDs and is explicitly part of the trusted
provisioning boundary.

## Concrete service and combined acceptance

The actual pinned listener worker passed private-pipe CapTP transport, HTTP
streaming, host-only credential-canary injection, explicit revocation, worker
crash invalidation, and cleanup with a controlled upstream.
The runner reported `LIVE PROVIDER ACCEPTED AND CLEANED` and verified that no
owned listener containers remained.

The concrete file registry, rootless Podman volume adapter, and XFS allocator
created a durable workspace/state pair.
A container running as UID 1000 wrote a sentinel; a newly constructed provider
reopened the same workspace and read the same contents, then destroyed the pair.
Three actual Linux registry tests exercised concurrent transactions, lock-worker
death fencing, and new-owner recovery after owner death and descendant reaping.
Quota readback now includes zero-usage projects; XFS otherwise omits those rows.

The combined runner composed these actual services with the default runtime
verifier, attested slice factory, transport, and stock Codex client:

```sh
systemd-run --user --scope -p Delegate=yes env \
  ENDO_CODEX_RUNTIME_IMAGE=localhost/floot-goal:0.152.0 \
  ENDO_PROVIDER_IMAGE=localhost/endo-provider:live \
  ENDO_VOLUME_ROOT=/srv/floot-storage/containers/volumes \
  ENDO_XFS_FILESYSTEM=/srv/floot-storage \
  ENDO_XFS_PROJECT_START=14200 \
  node packages/codex-sandbox/test/verify-deployment.js
```

It reported `LIVE DEPLOYMENT SUBSTRATE ACCEPTED AND CLEANED`, with five models
from the initialized app-server catalog and zero outbound requests.
It repeated the inner sandbox/environment preflight using the final image and
quota-backed persistent mounts, then disposed and reopened the durable workspace.
This run exposed closed stdin at Podman container creation: `start --interactive`
alone could not keep app-server alive.
The driver now creates interactive containers; a real stdin round-trip regression
passed in all four SES configurations.

## Remaining deployment gates

No live provider credential or billable inference request was used here.
Catalog admission is not vendor authentication or inference acceptance.
The operator still supplies a supported account/credential, durable audit and
thread-state services, and independently held quota/reaper authorities.
Subscription modes and a Claude hosted implementation remain unavailable until
their separate authentication and confinement requirements are satisfied.
See [deployment acceptance](./DEPLOYMENT-ACCEPTANCE.md) for those gates.
