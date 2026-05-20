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
- [x] `RotateCreds` push from orchestrator → runtime-agent
  (`rust/claude-orch/runtime-agent/src/main.rs`).
- [x] `initialPrompt` plumbing (`src/main.js`).
- [ ] Live Anthropic API end-to-end (today's smoke-boot uses a stub
  prompt).

**M4 — Security hardening** — most code-level items shipped; audits
deferred:
- [x] Runtime agent drops privileges and runs as `claude` user
  (`rust/claude-orch/bootstrap-init/src/main.rs`).
- [x] Optional seccomp-bpf filter
  (`rust/claude-orch/runtime-agent/src/seccomp.rs`).
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
