# Hosted agent sandbox contract

Production must test these assertions against the effective container and host
state, not merely against requested command-line flags.
`makeCodexBackendFactory` fails closed unless the provisioner returns this exact
`HostedAgentPolicyV1` attestation.

The host provisioner, credential broker, audit anchor, container runtime, and
kernel enforce confinement.
The digest-pinned Codex CLI/app-server 0.152.0 and its commands share one guest
authority domain, including writable `/codex-home` and inference access.
The CLI's native state and notifications are guest-controlled; host-mediated
Endo records remain outside that domain.

## Isolation

- The backend is rootless Podman.
- The image is addressed and resolved as `sha256:<64 lowercase hex digits>`;
  tags, including `latest`, are rejected.
- User, PID, IPC, and mount namespaces are private.
- The process runs as UID and GID 1000, with `no-new-privileges`, every Linux
  capability dropped, the default seccomp profile loaded, and a read-only root
  filesystem.
- Every turn uses Codex's `externalSandbox` policy with network access
  `restricted` for public policy `off` and `enabled` for admitted public access.
  Process/thread configuration uses `danger-full-access` inside the outer slice
  because the pinned API has no external-sandbox mode at those levels.
  Codex's managed proxy is disabled.
  These values do not enforce confinement; the outer slice and host egress
  service do, and native commands share all guest-granted writable mounts.
  Launch environment is fixed and credential-free; admitted public sessions
  additionally receive the explicit proxy configuration.
  The runtime preflight checks the effective merged environment and rejects
  unexpected entries before app-server is launched.
- No host device, home, daemon socket, Podman/Docker socket, credential store,
  or path belonging to another session is mounted.
- The attestation reports `devices: "none"`, `hostSockets: "none"`,
  `hostHome: "none"`, `credentialInjection: "broker-only"`, and
  `brokerTransport: "loopback-sidecar"`, and `descendantReaping: true`;
  unknown attestation fields are rejected.
- The mount table has five fixed entries, all `nosuid,nodev`: a session
  workspace `workspace:<sessionId>` at `/workspace`; a credential-free,
  session-durable `codex-state:<sessionId>` volume at `/codex-home`; and bounded
  per-slice tmpfs mounts at `/tmp`, `/run`, and `/scratch`.
- Beyond those five, the table carries exactly the **runtime attaches** the
  session spec declares (`containerMounts`), each reported as `attach:<key>`
  at a destination under `/mnt/` in its declared `ro` or `rw` mode. An attach
  is a bind of a host mountpoint at which an operator-held bridge serves a
  capability the session holds over 9P. It is admitted only because the
  sandbox attestation reads the anchor's own mount table and proves the
  filesystem the slice sees at that destination is 9P — a projection served
  by a userspace server — rather than host data. An attach the table carries
  but the spec did not declare, or the reverse, is an undeclared mount. See
  `designs/runtime-container-fs-mount.md`.
- The Codex-state volume survives slice replacement for the same logical
  session so app-server can resume its rollout, but is destroyed at session
  teardown. It must never contain `auth.json` or reusable credentials.
- Initialization must report Linux/Unix and the exact `/codex-home` path before
  any thread or turn request is accepted.
- No additional bind, volume, socket, device, secret, or capability mount is
  permitted by this version of the contract. A declared attach is the one
  bind, and it is proved to be a 9P projection before it is attested.
- Mount path resolution must resist symlink, hardlink, `..`, and
  mount-replacement races.

## Network and credentials

- The slice network is `broker-only`: it contains loopback and one
  credential-free provider sidecar, with no routable interface or other peer.
  Admitted public sessions additionally expose the constrained proxy and DNS
  listeners described in [network policy](./NETWORK-POLICY.md).
- Broker reachability is session-scoped: app-server and guest commands can
  reach the same credential-free inference endpoint.
- The only provider traffic crosses a unique per-session broker capability.
  Production uses the attested credential-free loopback sidecar, not a host
  socket mount.
- Before slice start, `ProviderGrantV1` must report an exact grant ID, session ID,
  image digest, provider HTTPS origin, operator account reference, upstream
  authentication mode, loopback endpoint, model allowlist, and the same
  network-namespace ID reported by the slice.
  The grant has no time-based expiry or cumulative usage budget.
  Authentication modes are `api-key`, `oauth`, and the fixed ChatGPT
  `subscription` profile; see
  [SUBSCRIPTION-AUTH.md](./SUBSCRIPTION-AUTH.md).
  An operator may pin the mode it will accept, and a lease issued in the other
  is refused rather than silently admitted.
  Unknown or mismatched lease fields fail provisioning before app-server starts.
- The broker pins provider scheme, host, methods, and paths; strips caller
  authentication and forwarding headers; rejects cross-origin redirects,
  arbitrary URLs, CONNECT, account/billing/login/token/session-admin APIs, and
  unknown routes.
- Provider credentials and refresh state never enter the slice.
  The session capability is bound to provider, account reference, session ID,
  image digest, and model allowlist, and is
  revoked during teardown.

## Resource and protocol limits

- Memory: 4 GiB.
- Processes: 512 PIDs.
- CPU: quota equivalent to four cores.
- Open files: 4096.
- Core dumps: zero bytes.
- Aggregate writable storage: 16 GiB.
- Prompt: 1 MiB; outbound JSON request: 2 MiB; individual JSONL record: 1 MiB.
- Turn: at most 16,384 distinct item, call and request identities retained
  for deduplication. A turn is not bounded in events, bytes or wall time:
  delivery is bounded by credit at the reader, what the host keeps of a turn
  is bounded where it is kept (Floot's hosted turn, 16 Mi characters), and a
  long turn is the user's to interrupt. `turnWallTimeoutMs` is an operator
  option, off by default.
- Process stdout: 64 MiB; stderr: 1 MiB; displayed tool result: 64 KiB.
- Endo dynamic tools: no count per turn (their ids count among the retained
  identities above) and no time per call by default; `toolCallTimeoutMs` is
  an operator option, and when set, a call that exceeds it is recorded as an
  unknown outcome and poisons the session against a successor overlapping it.
- Audit journal: no lifetime ceiling. One stored value — an entry or a
  content value — is at most 16 MiB; a payload text field over 64 KiB is
  stored by reference, named by its hash, with a 4 KiB preview inline. The
  independent anchor store keeps only the newest write-ahead head. The chain
  is verified whole at every recovery, which is linear in the entries and
  transient.

Provisioning fails when any required control is unavailable.
The attestation must include the exact operator-approved image digest and the
logical Floot session ID.
The `@endo/sandbox` Podman driver's `network: "private"` and `limits` fields
still do not establish this contract and must never be used as an attestation:
`private` is NAT rather than filtered isolation, and `limits` is a per-process
rlimit table no cgroup sees.
The driver's `network: "broker-only"` slice policy is the one that does.
It proves the isolation, identity, namespace, mount-table, and ceiling half of
this section from effective container and kernel state and reports it as
`SlicePolicyAttestationV1`; an operator's `makeSlice` composes
`HostedAgentPolicyV1` from that plus the broker's and the pinned app-server's
attestations for their own halves.
See `packages/sandbox/README.md` § "Slice policy and attestation" for what each
control is proved from and what it deliberately leaves uncovered.

## Lifecycle

One resource owner controls one Floot session, one workspace, one
credential-free Codex-state volume, one app-server process, one broker lease,
and one audit journal.
Audit entries and their append-only head anchors are held by separate operator
capabilities; the session, slice, and entry-store mutation authority never
receive the anchor capability.
The operator constructs the audit-journal factory with those powers already
closed over; no session specification or backend run facet can select or
replace either store.
Each anchor first authorizes the exact next entry and hash, then the entry is
appended to the bulk store.
Recovery may restore that one prepared entry from the anchor, but never advances
an anchor over a suffix supplied only by the mutable entry store.
The session ID is a nonempty portable name and the process working directory is
exactly `/workspace`.
Creation is `creating -> ready` only after mounts, broker, policy attestation,
thread state, and audit are durable.
Any partial failure unwinds the ephemeral stages in reverse order: the slice,
the broker lease, and the workspace mount.
The workspace and the Codex-state volume are durable and are never removed by
an unwind or by disposal: a session revived after a restart reopens the ones it
had, and a broker or slice failure on the way must not cost the user their
contents.
A factory holds at most one live instance per session; a `create` or
`destroy` for a session it still runs stops that instance first, so a Floot
factory rebuilt without a daemon restart supersedes the old instance rather
than starting a second app-server over the same workspace and journal.

Deletion is `ready/error -> deleting -> deleted`.
It interrupts and awaits the active turn, closes app-server, disposes the slice,
kills and reaps all descendants including setsid/double-fork/background
processes, unmounts the workspace, revokes the broker lease, and durably records
closure; the factory's idempotent `destroy` then removes the workspace, the
Codex-state volume, and the thread state by their exact names.
Cleanup is idempotent; failures are aggregated and leave a retriable lifecycle
record rather than falsely reporting deletion.

## Required production tests

Tests from inside two simultaneous release-image sessions must prove they
cannot read each other's workspace, home, processes, host home, sockets,
credentials, or undeclared mounts.
They must also prove that `/codex-home` survives replacement of one slice for
the same session, is absent after durable session deletion, never contains
`auth.json` or a reusable credential, and is never shared across session IDs.
Direct external sockets must fail for public IPv4/IPv6, RFC1918/ULA, link-local,
metadata, and alternate DNS destinations.
Guest-local listeners are within the session authority domain.
With public policy off, public proxy authority is absent; when enabled, HTTP and
CONNECT to allowed public destinations must work and private destinations,
rebinding, and redirected private targets must remain denied by the host proxy.
Undeclared host Unix sockets must remain inaccessible.

Fork, memory, CPU, file-descriptor, disk, output, and never-EOF bombs must hit
their configured bounds without affecting the host or another session.
SIGTERM-resistant, setsid, double-fork, inherited-pipe, background-terminal,
startup/dispose race, daemon-crash/orphan, and cleanup-failure cases must all be
reaped and journaled.
Broker tests must additionally demonstrate that the sidecar is the only
provider peer from app-server and guest descendants, cannot be repurposed as a
general proxy, and loses authority immediately when the session grant is revoked.
Pinned app-server acceptance must cover native commands on thread start, resume,
and subsequent turns under the external-sandbox policy.
