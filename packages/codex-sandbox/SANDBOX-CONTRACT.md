# Hosted agent sandbox contract

Production must test these assertions against the effective container and host
state, not merely against requested command-line flags.
`makeCodexBackendFactory` fails closed unless the provisioner returns this exact
`HostedAgentPolicyV1` attestation.

The trusted computing base is the host provisioner, credential broker, audit
anchor, and the digest-pinned image including Codex CLI/app-server 0.152.0.
Prompts, dynamic-tool arguments, workspace contents, and every
model-launched command are untrusted.
App-server itself is not sandboxed away from its own state: it must write the
credential-free `/codex-home` and is trusted to apply the pinned per-turn
`workspaceWrite` policy before starting untrusted commands.
Compromise of that pinned runtime invalidates the inner command boundary and
requires revoking its image digest; the outer slice still protects the host and
other sessions.

## Isolation

- The backend is rootless Podman.
- The image is addressed and resolved as `sha256:<64 lowercase hex digits>`;
  tags, including `latest`, are rejected.
- User, PID, IPC, and mount namespaces are private.
- The process runs as UID and GID 1000, with `no-new-privileges`, every Linux
  capability dropped, the default seccomp profile loaded, and a read-only root
  filesystem.
- Every turn uses the pinned Codex `workspaceWrite` sandbox with network access
  disabled and writable roots exactly `/workspace`, `/tmp`, `/run`, and
  `/scratch`.
  Model-launched commands may read the session's `/codex-home` but cannot modify
  its configuration or rollout history; production must verify this against
  symlink, rename, hardlink, and subprocess escape attempts.
  This is an inner sandbox guarantee supplied by the trusted pinned app-server,
  not a read-only outer mount: the outer mount is necessarily writable by
  app-server so it can maintain thread and rollout state.
  Automatic `/tmp` and `TMPDIR` writable-root expansion is disabled; the
  app-server environment pins `HOME`, `CODEX_HOME`, `TMPDIR`, `TMP`, and `TEMP`
  to the declared paths; all caller-supplied environment entries, including
  proxy and credential variables, are rejected.
- No host device, home, daemon socket, Podman/Docker socket, credential store,
  or path belonging to another session is mounted.
- The attestation reports `devices: "none"`, `hostSockets: "none"`,
  `hostHome: "none"`, `credentialInjection: "broker-only"`, and
  `brokerTransport: "loopback-sidecar"`, and `descendantReaping: true`;
  unknown attestation fields are rejected.
- The mount table has exactly five entries, all `nosuid,nodev`: a session
  workspace `workspace:<sessionId>` at `/workspace`; a credential-free,
  session-durable `codex-state:<sessionId>` volume at `/codex-home`; and bounded
  per-slice tmpfs mounts at `/tmp`, `/run`, and `/scratch`.
- The Codex-state volume survives slice replacement for the same logical
  session so app-server can resume its rollout, but is destroyed at session
  teardown. It must never contain `auth.json` or reusable credentials.
- Initialization must report Linux/Unix and the exact `/codex-home` path before
  any thread or turn request is accepted.
- No additional bind, volume, socket, device, secret, or capability mount is
  permitted by this version of the contract.
- Mount path resolution must resist symlink, hardlink, `..`, and
  mount-replacement races.

## Network and credentials

- The slice network is `broker-only`: it contains loopback and one
  credential-free provider sidecar, with no routable interface or other peer.
- Broker reachability is process-scoped: app-server can reach its lease
  endpoint, while every model-launched command and descendant is denied that
  route even though it shares the slice.
- The only provider traffic crosses a unique per-session broker capability.
  Production uses the attested credential-free loopback sidecar, not a host
  socket mount.
- Before slice start, `BrokerLeaseV1` must attest an exact lease ID, session ID,
  image digest, provider HTTPS origin, operator account reference, loopback
  endpoint, expiry, model allowlist, positive request/byte/cost quotas, and the
  same network-namespace ID reported by the slice.
  Unknown or mismatched lease fields fail provisioning before app-server starts.
- The broker pins provider scheme, host, methods, and paths; strips caller
  authentication and forwarding headers; rejects cross-origin redirects,
  arbitrary URLs, CONNECT, account/billing/login/token/session-admin APIs, and
  unknown routes.
- Provider credentials and refresh state never enter the slice.
  The session capability is bound to provider, account reference, session ID,
  image digest, expiration, model allowlist, and request/byte/cost quotas and is
  revoked during teardown.

## Resource and protocol limits

- Memory: 4 GiB.
- Processes: 512 PIDs.
- CPU: quota equivalent to four cores.
- Open files: 4096.
- Core dumps: zero bytes.
- Aggregate writable storage: 16 GiB.
- Prompt: 1 MiB; outbound JSON request: 2 MiB; individual JSONL record: 1 MiB.
- Turn: 10,000 events, 16 MiB normalized output, and 30 minutes wall time.
- Process stdout: 64 MiB; stderr: 1 MiB; displayed tool result: 64 KiB.
- Endo dynamic tools: 128 calls per turn, two minutes per call, and 4 MiB per
  complete intent/result audit payload.
- Audit entry: 16 MiB; audit journal: 100,000 entries, at most 256 MiB of
  canonical entry data in the bulk store, and at most 256 MiB of canonical
  write-ahead data in the independent anchor store.
  Each store independently preserves a 64-KiB reserve usable only for terminal
  lifecycle events; the bulk store also preserves 16 entries for that purpose.
  The combined logical payload bound is therefore 512 MiB, and the production
  stores must separately bound storage-engine metadata.

Provisioning fails when any required control is unavailable.
The attestation must include the exact operator-approved image digest and the
logical Floot session ID.
The current `@endo/sandbox` Podman driver's `network: "private"` and `limits`
fields do not establish this contract, so they must not be used as an
attestation until effective enforcement and inspection land.

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
Any partial failure unwinds in reverse order.

Deletion is `ready/error -> deleting -> deleted`.
It interrupts and awaits the active turn, closes app-server, disposes the slice,
kills and reaps all descendants including setsid/double-fork/background
processes, unmounts the workspace, removes exact mount names, revokes the broker
lease, and durably records closure.
Cleanup is idempotent; failures are aggregated and leave a retriable lifecycle
record rather than falsely reporting deletion.

## Required production tests

Tests from inside two simultaneous release-image sessions must prove they
cannot read each other's workspace, home, processes, host home, sockets,
credentials, or undeclared mounts.
They must also prove that `/codex-home` survives replacement of one slice for
the same session, is absent after durable session deletion, never contains
`auth.json` or a reusable credential, and is never shared across session IDs.
Egress probes must fail for public IPv4/IPv6, loopback except the broker sidecar,
RFC1918/ULA, link-local and metadata addresses, alternate DNS, rebinding,
redirects, proxy CONNECT, and undeclared Unix sockets.

Fork, memory, CPU, file-descriptor, disk, output, and never-EOF bombs must hit
their configured bounds without affecting the host or another session.
SIGTERM-resistant, setsid, double-fork, inherited-pipe, background-terminal,
startup/dispose race, daemon-crash/orphan, and cleanup-failure cases must all be
reaped and journaled.
Broker tests must additionally demonstrate that the sidecar is the only
reachable peer from app-server, is unreachable from tool descendants, cannot be
repurposed as a general proxy, and loses authority immediately when the session
lease is revoked.
