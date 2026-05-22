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
- [~] `RotateCreds` push from orchestrator → runtime-agent. The
  runtime-agent handler is wired
  (`rust/claude-orch/runtime-agent/src/main.rs`) but the
  orchestrator never invokes it: broker `rotate_if_needed` is a
  hardcoded noop (`src/broker/main.js:48-49`), so no rotations
  reach the guest in v1.
- [x] `initialPrompt` plumbing (`src/main.js`).
- [ ] Live Anthropic API end-to-end (today's smoke-boot uses a stub
  prompt).

**M4 — Security hardening** — most code-level items shipped; audits
deferred:
- [x] Runtime agent drops privileges and runs as `claude` user
  (`rust/claude-orch/bootstrap-init/src/main.rs`).
- [x] seccomp-bpf filter wired into the default build
  (`rust/claude-orch/runtime-agent/src/seccomp.rs`;
  `Cargo.toml`'s default features include `seccomp`).
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

**Rust unit tests — `rust/claude-orch/bootstrap-init/`** — zero
tests today; the binary is only exercised by real-QEMU smoke
boot, and that job is currently red. Backfill:

- [ ] `parse_cmdline` accepts the documented
  `claude.session_id=… claude.boot_nonce=…` shape and rejects
  short / missing / multi-key inputs.
- [ ] `mount_workspace` uses the 9P `trans=fd` socketpair relay
  the way DESIGN §6.5 / R2a specifies (no kernel-mode-read
  regression).
- [ ] `spawn_relay` handles port-fd / socket-fd lifecycle
  correctly: child closes on parent exit, EOF from one side
  half-closes the other.
- [ ] `write_credentials` writes
  `~/.claude/.credentials.json` with `0600` and refuses an empty
  payload.
- [ ] `chown_home` only touches the home dir; fails closed on a
  symlink loop.
- [ ] `drop_privileges` issues `setgroups → setgid → setuid` in
  that order, propagates each failure, and verifies a final
  `getresuid` matches the target UID. **This is the load-bearing
  security claim of the sandbox; not testing it is the largest
  hole.**

**Rust unit tests — `rust/claude-orch/runtime-agent/`** — two
tests today (`frame_roundtrip`, `partial_frame_left_in_tail`),
both on the framing helper. Backfill:

- [ ] `start_attach` / `stop_attach` lifecycle: attach
  registration is single-writer, `stop_attach` releases the
  stream id, repeat attach to the same stream id works.
- [ ] `pump_stdout` forwards child-process stdout into the mux
  with the right stream id and drops on EPIPE.
- [ ] `rotate_creds` writes the new payload to a tmp file +
  rename (atomic), 0600, and is a no-op on identical input.
- [ ] `ensure_stdio_open` survives an EBADF mid-loop without
  crashing the heartbeat thread.
- [ ] `run`'s top-level happy path: open virtio ports → send
  Ready → install seccomp → enter the heartbeat loop, against
  fake `Read`/`Write` impls for the two ports.

**seccomp filter — `rust/claude-orch/runtime-agent/src/seccomp.rs`**
— compile-checked only; the filter is never loaded and never
exercised in any test. Backfill:

- [ ] Per-syscall behavioural test: fork a child, `install()`
  the filter, attempt each entry in the deny list, assert the
  child dies with `SIGSYS` (`SECCOMP_RET_KILL_PROCESS`).
- [ ] Negative test: a syscall *not* on the deny list (e.g.
  `getpid`) succeeds after install. Pins that we haven't
  accidentally inverted the default action.
- [ ] `PR_SET_NO_NEW_PRIVS` is set before the filter is applied
  and an immediate-following `execve` does not strip the
  filter.

**End-to-end / fixture tests — `packages/claude-orch/test/`** —
the JS-side fakes cover the host wire format but not the
multi-component interactions. Backfill:

- [ ] `RotateCreds` round-trip: orchestrator → agent push
  changes the on-disk creds file from inside the guest fake,
  and a subsequent broker `rotate_if_needed` returning a new
  payload reaches the agent.
- [ ] Broker `rotate_if_needed` fixture that returns a fresh
  payload (the current default is a hard-coded noop, so no
  test ever drives the rotation path).
- [ ] `ClaudeClient.interrupt()` — currently throws
  `"not implemented in v1"`. Pin the message + shape with a
  `t.throwsAsync` so reading the help text never gets ahead of
  the impl again.

**Real-QEMU smoke boot — `packages/claude-orch/scripts/smoke-boot.sh`**
— asserts `hello.json` and `agent-ready.json` land. Doesn't
verify the rest of the guest stack actually works. Backfill:

- [ ] Read-from-workspace assertion: pre-populate the in-memory
  endo-fs with a known file, then have the host-side smoke
  driver read it back through the mounted 9P (e.g. dispatch a
  `cat /workspace/hello.txt` and check the bytes via the stdio
  mux).
- [ ] `claude --version` (or equivalent) launches successfully
  inside the rootfs, proving the pinned `claude-code@2.0.0`
  binary survives image build + boot.
- [ ] Post-`drop_privileges` integrity check: agent reports its
  own `uid/gid` in the first `Log` after Ready; smoke driver
  asserts it's `1000/1000`, not `0/0`.

Track these as a single M4 follow-up; merging them shifts the
"Runtime agent drops privileges" `[x]` checkmark from
"verified by reading the code" to "verified by code + tests".

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
