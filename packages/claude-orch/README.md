# @endo/claude-orch

Host orchestrator for Claude Code microVM sandboxes.

This is the **host process** side of the design in
`packages/claude-container/DESIGN.md`.
It speaks HTTP/1.1 over a Unix domain socket to callers, spawns one
QEMU process per session, mediates the bootstrap handshake into the
guest, brokers credentials, and tears everything down on session end.

`@endo/claude-container` is the Endo capability side — it sits in
front of this orchestrator's UDS API.

## Status

**Milestone 1 — single-host Linux end-to-end** is feature-complete and
validated on real KVM:

- [x] Repo skeleton, protocol types (`protocol.types.d.ts`).
- [x] Session manager with optional disk persistence + restart-survival
  reattach (`src/sessions/session-manager.js`).
- [x] QEMU args builder + spawner, with injectable `spawnVm` for tests
  (`src/qemu/`).
- [x] Network controllers — nftables on Linux, pf-anchor on macOS
  (`src/network/`), with injectable `exec` for tests.
- [x] Bootstrap RPC server, agent RPC server, stdio multiplexer
  (`src/bootstrap/`, `src/agent/`, `src/stdio/`).
- [x] HTTP/UDS API server (`src/api/server.js`).
- [x] Credential broker daemon and client (`src/broker/`,
  `src/broker-client/`).
- [x] `bin/claude-orch`, `bin/claude-broker`.
- [x] Guest image build pipeline: mkosi rootfs config, kernel fragment,
  `scripts/build-image.sh` driving cargo + mkosi + kbuild.
- [x] Rust guest binaries: `rust/claude-orch/bootstrap-init` (PID 1,
  bootstrap handshake, 9P mount via socketpair relay, drop privs,
  exec); and `rust/claude-orch/runtime-agent` (control RPC, optional
  seccomp block-list, stdio framing).
- [x] 9P bridge in `@endo/claude-container` (real bodies; read +
  best-effort write paths).
- [x] In-process e2e smoke test that drives the full lifecycle through
  a mock guest with no QEMU on PATH (`test/e2e-smoke.test.js`).
- [x] **Real-host smoke boot**: `scripts/smoke-boot.sh` cross-compiles
  the guest binaries, builds a minimal Linux 6.18 kernel from the
  microvm fragment, packs an ext4 rootfs, and drives a real
  `qemu-system-x86_64 -accel kvm` boot. Verified end-to-end: Hello
  arrives on ctl.sock, 9P workspace mounts through the socketpair
  relay, claude-agent's Ready arrives on agent.sock. The full
  bootstrap → mount → drop-privs → exec → ready chain works on KVM
  with no kernel patches.

What still needs a real Linux host with root to validate:
- nftables/pf rules taking effect against a live guest's egress.

Tests (all green):
- 39 ava in this package + 2 cargo unit tests in the runtime-agent
  crate.

## Milestone status (per `claude-container/DESIGN.md` §10)

**M1 — single-host Linux end-to-end** — see the checklist above.

**M2 — macOS support** — code paths in place, no macOS end-to-end
run yet:
- [x] `PfController` (`src/network/pf-controller.js`) + injectable
  `exec` for tests.
- [x] Platform-aware QEMU argv (`-accel hvf` on darwin, `-accel kvm`
  on linux; `src/qemu/args.js`).
- [ ] Build arm64 rootfs + kernel in CI; smoke-boot on real macOS
  arm64.
- [ ] LaunchDaemon plist; pf-anchor install script.

**M3 — Claude Code integration + credential broker** — largely
shipped through R3:
- [x] Claude Code pinned in the rootfs (`scripts/build-image.sh`
  reads `CLAUDE_CODE_VERSION`).
- [x] Credential broker (`src/broker/`) with `Issue` / `Revoke` /
  `PreemptiveRotate`.
- [x] `BootConfig.credentials` plumbed from broker through bootstrap
  to `~/.claude/.credentials.json` in guest.
- [x] `RotateCreds` push from orchestrator → runtime-agent. The
  broker drives the schedule (subscribe / push protocol; broker
  holds a `setTimeout` keyed on the access-token `expiresAt`).
  The orchestrator opens a subscription per session in
  `markReady`, uses the first push as the BootConfig credentials,
  and relays every subsequent push to the agent. Default
  api-key mode never rotates (no shorter-term form to derive);
  OAuth mode is real — set the `CLAUDE_ORCH_BROKER_OAUTH_*` env
  vars on the broker bin and the refresher in `src/broker/oauth.js`
  handles RFC 6749 §6 refresh-token grant. DESIGN.md §5.5 walks
  through the short-term-only injection model. Wire path proven
  end-to-end by `e2e-smoke.test.js`'s "broker pushes rotation"
  case (two parallel sessions, broker broadcasts two distinct
  OAuth payloads, orch relays each one to the right agent).
- [x] `initialPrompt` plumbing (`src/main.js`).
- [ ] Live Anthropic API end-to-end (today's smoke-boot uses a stub
  prompt).

**M4 — Security hardening** — most code-level items shipped; audits
deferred:
- [x] Runtime agent drops privileges and runs as `claude` user
  (`rust/claude-orch/bootstrap-init/src/main.rs`).
- [x] seccomp-bpf filter shipped in the guest build
  (`rust/claude-orch/runtime-agent/src/seccomp.rs`). Default
  features are empty so host-side `cargo check` / rust-analyzer
  on macOS+Windows works without the Linux-only dependency;
  `scripts/build-image.sh` and `scripts/smoke-boot.sh` pass
  `--features seccomp` explicitly so the filter is in every
  shipping `claude-agent` binary.
- [x] Agent RPC vocabulary contains no `GetCreds` or file-proxy verb
  (`protocol.types.d.ts`).
- [x] Boot nonce single-use enforcement + replay regression
  (`test/bootstrap-rpc.test.js`, `test/session-manager.test.js`).
- [ ] nftables/pf ruleset audit against real targets (Tailscale, LAN,
  link-local) — needs a real Linux host.
- [ ] Cross-cutting threat-model review of every host↔guest message.
- [ ] Disable IPv6 in guests unless explicitly enabled.

**M5 — Operational maturity** — persistence shipped; observability
and resource caps open:
- [x] Persisted session state + restart-survival reattach
  (`src/sessions/session-manager.js`; doubles as R4 sub-piece).
- [x] Graceful SIGTERM handler in `src/main.js`.
- [ ] Structured JSON logging end-to-end.
- [ ] Metrics endpoint (Prometheus textfile or HTTP).
- [ ] cgroup-v2 per-QEMU resource limits on Linux.
- [ ] Idle-timeout termination.
- [ ] CLI (`claude-orch list / terminate / logs`).

**M6 — Documentation & release**:
- [x] CI smoke-boot job (`claude-orch-smoke-boot-tcg` in
  `.github/workflows/ci.yml`).
- [x] Reference 9P server documentation (`@endo/9p-server`).
- [x] Threat model lives in `claude-container/DESIGN.md` §3 +
  `ENDO-INTEGRATION.md` §3.
- [ ] NixOS module package + publication.
- [ ] Operator install docs for macOS + Linux.
- [ ] Per-tag release artifacts.

## Test coverage gaps (immediate-fix queue)

A pass over the guest-side test surface during the kumavis +
Copilot reviews on PR #328 found the following holes. Each item
names the file the test should live in and a one-line rationale;
all of them belong on the M4 (security hardening) follow-up
rather than M5/M6.

**Rust unit tests — `rust/claude-orch/bootstrap-init/`** — was
zero tests; now covers the pure-logic helpers. Refactored
`parse_cmdline` and `write_credentials` so the pure parts are
testable without `/proc/cmdline` or root:

- [x] `parse_cmdline` (`parse_cmdline_str`): documented shape,
  missing session_id, missing boot_nonce, empty input,
  last-write-wins on duplicate keys, case-sensitive matching.
- [x] `write_credentials` (`write_credentials_to`): file lands
  at `0o600` at create time (no chmod-after window); existing
  longer payload is fully truncated on overwrite.
- [ ] `mount_workspace` uses the 9P `trans=fd` socketpair relay
  the way DESIGN §6.5 / R2a specifies (no kernel-mode-read
  regression). **Deferred** — requires a running 9P responder
  and Linux mount caps; covered indirectly by the smoke-boot
  workspace-read probe (below).
- [ ] `spawn_relay` handles port-fd / socket-fd lifecycle
  correctly. **Deferred** — same constraint as `mount_workspace`.
- [ ] `chown_home` fails closed on a symlink loop. **Deferred**
  — needs to construct a symlink loop owned by another uid,
  which itself needs root.
- [ ] `drop_privileges` issues `setgroups → setgid → setuid` in
  order and verifies a final `getresuid` matches. **Deferred**
  — the syscalls themselves require root; covered end-to-end by
  the smoke-boot uid/gid probe (below). The "load-bearing
  security claim" framing remains: end-to-end coverage is
  necessary but a unit-level test of the order-of-operations
  would catch regressions earlier.

**Rust unit tests — `rust/claude-orch/runtime-agent/`** — was
two framing tests; now covers `rotate_creds` too. The remaining
items need a substantial refactor toward an injectable
trait surface and are deferred:

- [x] `rotate_creds` (`rotate_creds_to`): replace-with-0o600
  (rename carries the tmp file's mode), truncate-on-overwrite,
  rejects a path with no `file_name()` cleanly.
- [ ] `start_attach` / `stop_attach` lifecycle. **Deferred** —
  requires refactoring the attach state out of `run()` into an
  injectable struct.
- [ ] `pump_stdout` forwards child-process stdout into the mux
  with the right stream id and drops on EPIPE. **Deferred** —
  same refactor.
- [ ] `ensure_stdio_open` survives EBADF mid-loop. **Deferred**.
- [ ] `run`'s top-level happy path against fake virtio ports.
  **Deferred** — biggest refactor; entire `run()` would need to
  take its IO surface as a trait object.

**seccomp filter — `rust/claude-orch/runtime-agent/src/seccomp.rs`**
— was compile-only; now runs the filter and observes the kill:

- [x] Per-syscall behavioural test: fork a child, `install()` the
  filter, attempt each of `ptrace` / `keyctl` / `perf_event_open`
  / `bpf`, assert the child dies with `SIGSYS`.
- [x] Negative test: `getpid` succeeds after install (default-allow
  path intact).
- [x] `PR_GET_NO_NEW_PRIVS` reports `1` post-install. The
  "survives execve" half is implied by the bit being set (the
  kernel guarantee), but an actual execve-then-syscall test
  remains roadmap.
- [ ] Execve-then-forbidden-syscall test (proves the filter
  follows the child binary). **Deferred** — needs a tiny helper
  binary in the test fixture.

**End-to-end / fixture tests — `packages/claude-orch/test/`**:

- [x] `RotateCreds` round-trip — broker subscribe/push end-to-end.
  `e2e-smoke.test.js`'s "broker pushes rotation" case runs two
  parallel sessions, simulates two broker broadcasts via the
  stub's `broadcastRotation`, and asserts both mock guests
  receive the OAuth-shaped payloads (plus subscription cleanup
  on session terminate).
- [x] Broker subscribe / push fixture: `broker.test.js` (11
  tests) wires the broker over its real UDS, exercises the
  subscribe-yields-current path, api-key quiescence, OAuth
  refresh fan-out via `forceRefresh`, refresher-failure
  propagation, unsubscribe semantics, malformed-JSON survival,
  UDS-0o600 pinning, and the full RFC 6749 §6 refresh-token
  grant flow against an injected fetch.
- [x] `ClaudeClient.interrupt()` shape pin: new
  `claude-client.test.js` (3 tests).

**Real-QEMU smoke boot — `packages/claude-orch/scripts/smoke-boot.sh`**
— now captures runtime-agent `Log` frames into
`agent-logs.ndjson` and greps for three startup probes the
agent emits unconditionally:

- [x] Read-from-workspace assertion: agent reads
  `/workspace/hello.txt` (pre-populated by `smoke-boot-host.js`)
  post-drop_privileges and logs the contents.
- [x] Write-to-workspace assertion (kernel v9fs → bridge →
  endo-fs round trip): agent writes
  `/workspace/guest-wrote.txt`, `smoke-boot-host.js` re-reads it
  through the endo-fs cap, and the shell driver fails if the
  re-read content doesn't match. Companion JS test in
  `factory-live.test.js` (`live MVP: factory → bridge serves 9P
  from a real in-memory Filesystem`) drives the same write path
  end-to-end against a Node 9P client at unit speed.
- [x] `claude --version` launches successfully inside the rootfs.
- [x] Post-`drop_privileges` uid/gid is `1000/1000`. The probe
  is emitted by the runtime-agent and the shell driver fails the
  job if the line is missing or carries the wrong uid.

The smoke-boot probes give the previously-untested guest
claims (mount, drop_privileges, image-build) end-to-end
regression coverage. Unit-level coverage of the same paths in
bootstrap-init / runtime-agent's `run()` remains the higher-
confidence answer and stays on this list, gated on the
refactors called out above.

## Prerequisites

- **Linux host** with `/dev/kvm` accessible to the orchestrator UID.
  macOS support (`-accel hvf`) is on the M2 roadmap; the **guest
  image build pipeline is Linux-only** because it shells out to
  `mkosi` against an in-tree kernel source.
- `qemu-system-x86_64` (and / or `qemu-system-aarch64`) on PATH.
  TCG falls back transparently when `/dev/kvm` is unavailable, at
  ~5–10× slowdown.
- `rustup` with the musl target for the guest arch
  (`x86_64-unknown-linux-musl` or `aarch64-unknown-linux-musl`),
  `mkosi`, `make`, and a checked-out Linux source tree at
  `$LINUX_SRC` (default `/usr/src/linux`). These are only needed to
  *build* the guest image, not to run sessions against one.
- **Root** is required to install the live nftables ruleset on the
  host (per-session egress isolation). The orchestrator itself
  runs as a non-root UID; the network controller shells out under
  `sudo`/equivalent. macOS pf has the same shape.
- The orchestrator and broker daemons should run as the same
  non-root UID. That UID owns every per-session UDS, the
  `sessions.json` state file, and the guest image directory.

The full `Operator's guide` below walks through how these pieces fit
together. Skip ahead to it if you want a step-by-step setup; the
"Quick smoke boot" section is a one-shot way to see the whole stack
boot end-to-end with no orchestrator wiring.

## Quick smoke boot

The fastest way to see the whole stack work on a Linux host with KVM:

```sh
nix-shell -p qemu rustup e2fsprogs gcc gnumake bison flex openssl bc \
  elfutils pkg-config perl curl \
  --run ./packages/claude-orch/scripts/smoke-boot.sh
```

That cross-compiles `bootstrap-init` + `runtime-agent` to musl, builds
a minimal Linux 6.18 kernel (cached after first run), packs an ext4
rootfs, runs QEMU, and asserts that Hello and Ready both arrive on the
host-side UDS endpoints. Outputs land in `/tmp/claude-orch-smoke/`.

The script auto-detects `/dev/kvm`; on environments without it (most
CI runners), it falls back to TCG (software emulation). Override with
`SMOKE_BOOT_ACCEL=kvm` or `=tcg`. TCG runs the boot end-to-end without
hardware virtualization, ~5–10× slower but functionally identical.
The host-side responder is `scripts/smoke-boot-host.js`, which uses
the real `@endo/claude-container` 9P bridge (closing R1) backed by
an `@endo/endo-fs` in-memory `Filesystem` — the same code path
that `9p-server.test.js` exercises in-process.

CI runs this job as `claude-orch-smoke-boot-tcg` in
`.github/workflows/ci.yml`.

## Operator's guide

This guide assumes the Prerequisites section above. Steps are in
deployment order: build the image once, then start the broker, then
start the orchestrator, then drive sessions.

### 1. Build the guest image (once per arch / pinned `CLAUDE_CODE_VERSION`)

`scripts/build-image.sh` cross-compiles the Rust guest binaries
(`bootstrap-init` and `runtime-agent` with `--features seccomp`),
builds the Linux kernel from `images/kernel/microvm.fragment`,
and runs mkosi to assemble the rootfs. The result lands in
`packages/claude-orch/images/build/<arch>/` as
`vmlinux-<arch>` + `rootfs.raw`.

```sh
yarn workspace @endo/claude-orch build:image
# Pin a specific Claude Code release into the rootfs:
CLAUDE_CODE_VERSION=2.0.0 ./packages/claude-orch/scripts/build-image.sh x86_64
# Pre-flight check (validate prereqs without building):
./packages/claude-orch/scripts/build-image.sh --check x86_64
```

Both `bin/claude-orch` and `scripts/smoke-boot.sh` look for these
artifacts under `$CLAUDE_ORCH_IMAGE_DIR`.

### 2. Start the credential broker

The broker holds the long-lived credential and drives all
rotation. Run it in its own process so the credential isn't in
the orchestrator's address space (DESIGN.md §5.5).

**API-key mode** (single static credential, no rotation):

```sh
mkdir -p /tmp/claude && chmod 0700 /tmp/claude
ANTHROPIC_API_KEY=sk-ant-... \
CLAUDE_ORCH_BROKER_SOCKET=/tmp/claude/broker.sock \
  node packages/claude-orch/bin/claude-broker
```

Or read the key from a 0600 sidecar file:

```sh
CLAUDE_ORCH_BROKER_CONFIG=/etc/claude/api.key \
CLAUDE_ORCH_BROKER_SOCKET=/tmp/claude/broker.sock \
  node packages/claude-orch/bin/claude-broker
```

**OAuth mode** (RFC 6749 §6 refresh-token grant — the broker
periodically swaps a long-lived refresh token for a short-lived
access token and pushes the result to every subscribed session;
the refresh token never enters a guest VM):

```sh
CLAUDE_ORCH_BROKER_SOCKET=/tmp/claude/broker.sock \
CLAUDE_ORCH_BROKER_OAUTH_TOKEN_URL=https://auth.example.com/oauth/token \
CLAUDE_ORCH_BROKER_OAUTH_CLIENT_ID=$YOUR_CLIENT_ID \
CLAUDE_ORCH_BROKER_OAUTH_CLIENT_SECRET=$YOUR_CLIENT_SECRET \
CLAUDE_ORCH_BROKER_OAUTH_REFRESH_TOKEN=$YOUR_REFRESH_TOKEN \
CLAUDE_ORCH_BROKER_OAUTH_SCOPE='claude:read claude:write' \
CLAUDE_ORCH_BROKER_REFRESH_WINDOW_MS=300000 \
  node packages/claude-orch/bin/claude-broker
```

The broker performs an initial refresh at startup; if the IdP is
unreachable it exits 1 rather than serve stale credentials.
`CLAUDE_ORCH_BROKER_OAUTH_CLIENT_SECRET` and `_OAUTH_SCOPE` are
optional. `_REFRESH_WINDOW_MS` controls how far before the
access token's `expiresAt` the broker schedules the next refresh
(default 5 min).

### 3. Start the orchestrator

```sh
CLAUDE_ORCH_SOCKET=/tmp/claude/api.sock \
CLAUDE_ORCH_SESSION_DIR=/tmp/claude/sessions \
CLAUDE_ORCH_STATE_PATH=/tmp/claude/sessions.json \
CLAUDE_ORCH_BROKER_SOCKET=/tmp/claude/broker.sock \
CLAUDE_ORCH_IMAGE_DIR=$PWD/packages/claude-orch/images/build \
  node packages/claude-orch/bin/claude-orch
```

The orchestrator binds `$CLAUDE_ORCH_SOCKET` (0600), restores any
sessions persisted at `$CLAUDE_ORCH_STATE_PATH`, and probes their
QEMU PIDs with `kill(pid, 0)` to mark each as `unhealthy` (VM
still alive) or `terminated` (VM gone) for the operator to
handle.

### 4. Drive a session via the HTTP/UDS API

The API is HTTP/1.1 over `$CLAUDE_ORCH_SOCKET`. With `curl
--unix-socket`:

```sh
SOCK=/tmp/claude/api.sock

# Create a session. `network: "egress"` allows outbound only;
# `network: "none"` is air-gapped. `attachMode: "stream"`
# allocates a per-session attach UDS; `"none"` skips it.
curl --unix-socket $SOCK -X POST http://h/v1/sessions \
  -H 'content-type: application/json' \
  -d '{
        "network": "egress",
        "attachMode": "stream",
        "initialPrompt": "Hello, Claude.",
        "resources": { "vcpus": 2, "memMB": 2048 }
      }'
# → 200 {"id":"<sid>","fsSocketPath":"…/fs.sock",
#         "attachSocketPath":"…/attach.sock", ...}

# Bind your 9P responder to `fsSocketPath` (the orchestrator
# *connects* to it, server=off chardev). For development use the
# host-side 9P bridge from @endo/9p-server backed by an
# @endo/endo-fs Filesystem (see scripts/smoke-boot-host.js for the
# pattern). With the Endo container factory path, the factory
# binds this automatically.

# Now tell the orchestrator the FS is ready — it spawns QEMU,
# waits for Hello on ctl.sock, returns a fresh access token from
# the broker subscription, BootConfig flows in, agent comes up.
curl --unix-socket $SOCK -X POST http://h/v1/sessions/$SID/ready

# Attach: stream stdin/stdout to claude-code inside the guest.
# The attach UDS carries the stdio mux's `default0` frame.
nc -U /tmp/claude/sessions/$SID/attach.sock

# Tear down.
curl --unix-socket $SOCK -X DELETE http://h/v1/sessions/$SID
```

`GET /v1/sessions` lists summaries; `GET /v1/sessions/<id>`
returns the full Session record (with `state`, `vmPid`, sockets).

### 5. (Alternative) Drive sessions via the Endo container factory

`@endo/claude-container` exposes the orchestrator as an Endo
capability: a form on `@host` accepting `{name, filesystem,
network, model, credentials, initialPrompt}`. The factory does
steps 4a/4b for you and stores a `ClaudeClient` exo in the host's
petstore. See `packages/claude-container/README.md` for the
factory provisioning steps and ENDO-INTEGRATION.md §5 for the
form schema.

### 6. Persistence + restart

If `CLAUDE_ORCH_STATE_PATH` is set, the orchestrator journals
session state to that file at every transition (0600,
credentials stripped from the projection). On startup it
restores from that file and reattaches to surviving QEMU
processes. Sessions whose VMs are gone are marked `terminated`;
sessions whose VMs are still alive but whose orchestrator was
killed mid-flight are marked `unhealthy` and the operator can
choose to `DELETE` them.

The credentials broker has no on-disk state; OAuth refresh
tokens that the IdP rotated are lost on broker restart and the
broker walks forward from the configured `_OAUTH_REFRESH_TOKEN`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Unknown filesystem: "<name>"` from the container factory | The `filesystem` form field must be the **pet name** of an FS capability already in `@host`'s petstore. Add one with `endo mkdir` / `endo store` first. |
| Broker `ECONNREFUSED` from the orchestrator on `POST /v1/sessions/:id/ready` | The broker daemon isn't running, or `CLAUDE_ORCH_BROKER_SOCKET` doesn't match between the two processes. The orchestrator hard-requires a reachable broker — sessions cannot mint BootConfig credentials otherwise. |
| `OAuth refresh: response missing access_token` / `…missing valid expires_in` | The IdP returned a 2xx with a malformed body. Confirm `CLAUDE_ORCH_BROKER_OAUTH_TOKEN_URL` is the actual token endpoint (not an authorize endpoint) and that the client is configured for the refresh-token grant. |
| `OAuth refresh failed: HTTP 401 ... invalid_grant` at startup | The configured `_OAUTH_REFRESH_TOKEN` has been revoked or expired. The broker exits 1 rather than serve stale credentials — re-mint the refresh token at the IdP. |
| `EADDRINUSE` when binding `CLAUDE_ORCH_SOCKET` | Another orchestrator (or a stale socket file) is using the path. Stop the other process or `rm` the stale UDS — the orchestrator deletes it on graceful SIGTERM but not on `SIGKILL`. |
| Form submission silently produces no session | Check the factory caplet's stderr — orchestrator HTTP errors and FS lookup failures are mirrored to the form reply, but a crashed factory shows up only in the daemon log. |
| `port !== '' ? Number(port) : default` quirk in Familiar / electron | Port 0 (OS-assigned) is falsy in JS; the Familiar shell guards explicitly. Not orchestrator-specific, but bites integrators. |
| Session marked `unhealthy` after orchestrator restart | The session's QEMU is still alive (`kill(pid, 0)` succeeded) but the orchestrator no longer holds its agent / stdio sockets. Operators choose: `DELETE` to terminate, or leave it for an external recovery flow. |

## Layout

```
packages/claude-orch/
├── README.md
├── package.json
├── protocol.types.d.ts          # protocol types (DESIGN.md §6)
├── bin/
│   ├── claude-orch              # API server entrypoint
│   └── claude-broker            # credential broker daemon
├── src/
│   ├── main.js                  # wiring, lifecycle, restart reattach
│   ├── api/server.js            # HTTP/1.1 over UDS
│   ├── sessions/                # session table, boot nonce, persistence
│   ├── qemu/                    # args + child_process spawner
│   ├── network/                 # platform-specific (nftables / pf)
│   ├── bootstrap/               # Hello/BootConfig over ctl chardev
│   ├── agent/                   # runtime agent JSON-RPC link
│   ├── stdio/                   # per-session stdio multiplexer
│   ├── broker/                  # credential broker daemon
│   └── broker-client/           # used by main.js
├── scripts/
│   ├── build-image.sh           # full image build pipeline
│   └── smoke-boot.sh            # real-KVM end-to-end smoke test
├── images/                      # mkosi + kernel configs
└── test/                        # 39 ava tests (no QEMU required)

rust/claude-orch/
├── bootstrap-init/              # PID 1 in the guest + 9P relay child
└── runtime-agent/               # claude-code wrapper + seccomp (opt)
```

## Configuration

All knobs are environment variables — no config file. The
orchestrator and broker process honour different subsets; the
table is grouped accordingly.

### Orchestrator (`bin/claude-orch`)

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_ORCH_SOCKET` | `/run/claude-orch/api.sock` | Caller-facing HTTP/UDS API. 0600. |
| `CLAUDE_ORCH_SESSION_DIR` | `/run/claude-orch/sessions` | Per-session UDS subdirs are minted here. |
| `CLAUDE_ORCH_STATE_PATH` | `/var/lib/claude-orch/sessions.json` | Persisted session table for restart-survival. Set to empty to disable persistence. |
| `CLAUDE_ORCH_BROKER_SOCKET` | `/run/claude-orch/broker.sock` | Broker UDS the orchestrator subscribes against. |
| `CLAUDE_ORCH_IMAGE_DIR` | `/opt/claude-orch/share/images` | Where `vmlinux-<arch>` + `rootfs.raw` live (output of `build-image.sh`). |
| `CLAUDE_ORCH_DEFAULT_VCPUS` | `2` | Default per-session vCPUs. Overridable on each create. |
| `CLAUDE_ORCH_DEFAULT_MEM_MB` | `2048` | Default per-session RAM (MB). Overridable on each create. |
| `CLAUDE_ORCH_BOOT_DEADLINE_MS` | `30000` | Max wall-clock to wait for the guest's Hello before `boot_failed`. |
| `CLAUDE_ORCH_HEARTBEAT_TIMEOUT_MS` | `60000` | Mark session `unhealthy` after this many ms without an agent heartbeat. |

### Broker (`bin/claude-broker`) — api-key mode

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_ORCH_BROKER_SOCKET` | `/run/claude-orch/broker.sock` | UDS the orchestrator subscribes against. |
| `ANTHROPIC_API_KEY` | _none_ | Long-lived API key (`sk-ant-…`). Used when `CLAUDE_ORCH_BROKER_CONFIG` and the OAuth env vars are unset. |
| `CLAUDE_ORCH_BROKER_CONFIG` | _none_ | Path to a 0600 file containing the API key, alternative to `ANTHROPIC_API_KEY`. |

### Broker — OAuth mode

Switches on when `CLAUDE_ORCH_BROKER_OAUTH_TOKEN_URL` is set. The
broker does an initial RFC 6749 §6 refresh-token grant at
startup, then schedules subsequent refreshes against the access
token's `expiresAt` and pushes fresh credentials to every
subscriber.

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_ORCH_BROKER_OAUTH_TOKEN_URL` | _none_ | OAuth2 token endpoint URL (required to enter OAuth mode). |
| `CLAUDE_ORCH_BROKER_OAUTH_CLIENT_ID` | _none_ | Required in OAuth mode. |
| `CLAUDE_ORCH_BROKER_OAUTH_CLIENT_SECRET` | _none_ | Optional (PKCE-only clients). |
| `CLAUDE_ORCH_BROKER_OAUTH_REFRESH_TOKEN` | _none_ | Long-lived secret. Required in OAuth mode. Stays in the broker process — never crosses into a guest VM. |
| `CLAUDE_ORCH_BROKER_OAUTH_SCOPE` | _none_ | Optional space-separated scope list. |
| `CLAUDE_ORCH_BROKER_REFRESH_WINDOW_MS` | `300000` | Refresh this many ms before the current access token's `expiresAt`. |
