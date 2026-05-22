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

## Running the full daemons

```sh
# one shell — credential broker
CLAUDE_ORCH_SOCKET=/tmp/claude/api.sock \
CLAUDE_ORCH_SESSION_DIR=/tmp/claude/sessions \
CLAUDE_ORCH_BROKER_SOCKET=/tmp/claude/broker.sock \
ANTHROPIC_API_KEY=sk-... \
  node bin/claude-broker

# another shell — orchestrator
CLAUDE_ORCH_SOCKET=/tmp/claude/api.sock \
CLAUDE_ORCH_SESSION_DIR=/tmp/claude/sessions \
CLAUDE_ORCH_BROKER_SOCKET=/tmp/claude/broker.sock \
CLAUDE_ORCH_IMAGE_DIR=$PWD/images/build \
  node bin/claude-orch
```

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

All knobs are environment variables — no config file:

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_ORCH_SOCKET` | `/run/claude-orch/api.sock` | API socket path. |
| `CLAUDE_ORCH_SESSION_DIR` | `/run/claude-orch/sessions` | Per-session UDS dir. |
| `CLAUDE_ORCH_BROKER_SOCKET` | `/run/claude-orch/broker.sock` | Broker UDS. |
| `CLAUDE_ORCH_IMAGE_DIR` | `/opt/claude-orch/share/images` | Kernel + rootfs. |
| `CLAUDE_ORCH_DEFAULT_VCPUS` | `2` | Default per-session vCPUs. |
| `CLAUDE_ORCH_DEFAULT_MEM_MB` | `2048` | Default per-session RAM (MB). |
| `CLAUDE_ORCH_BOOT_DEADLINE_MS` | `30000` | Hello deadline. |
| `CLAUDE_ORCH_HEARTBEAT_TIMEOUT_MS` | `60000` | Agent unhealthy threshold. |
| `CLAUDE_ORCH_BROKER_CONFIG` | _none_ | Path to a 0600 file containing the API key, alternative to `ANTHROPIC_API_KEY`. |
| `ANTHROPIC_API_KEY` | _none_ | Used by the broker if `CLAUDE_ORCH_BROKER_CONFIG` is unset. |
