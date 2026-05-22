#!/usr/bin/env bash
# Real-host QEMU smoke boot for the claude-orch microVM stack.
#
# Builds a minimal x86_64 kernel from the upstream tarball with the
# microvm.fragment config, cross-compiles the bootstrap-init + runtime-agent
# binaries to musl, packs an ext4 rootfs.raw, and boots QEMU. The
# orchestrator's ctl/fs/agent UDS endpoints are simulated via a tiny
# Node.js listener so the test does not need a full @endo/claude-orch
# daemon — it validates kernel + bootstrap-init + 9P relay + runtime-agent
# wiring in isolation.
#
# Requires:
#   - Linux host with KVM (/dev/kvm world-rw is fine; root not required)
#   - rustup with x86_64-unknown-linux-musl target installed
#   - qemu, e2fsprogs, gcc, make, bison, flex, openssl, bc, elfutils, perl
#     on PATH (or nix-shell -p qemu rustup e2fsprogs gcc gnumake bison ...)
#   - $LINUX_TARBALL pointing at a linux-*.tar.xz, or default to fetching
#     linux-6.18 from kernel.org.
#
# Exits 0 if the in-guest claude-agent's Ready message reaches the host
# orchestrator side, nonzero otherwise. Useful as the human-driven
# counterpart to the no-QEMU ava e2e-smoke test.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BUILD_DIR="${SMOKE_BUILD_DIR:-/tmp/claude-orch-smoke}"
LINUX_VERSION="${LINUX_VERSION:-6.18.28}"

step() { printf '\n== %s ==\n' "$*"; }

step "Staging build dir at $BUILD_DIR"
mkdir -p "$BUILD_DIR"/{rootfs/sbin,rootfs/usr/local/bin,rootfs/home/claude,rootfs/workspace,rootfs/dev,rootfs/proc,rootfs/sys,rootfs/tmp,rootfs/run,rootfs/etc}

step "Cross-compiling guest Rust binaries to x86_64-unknown-linux-musl"
# `--features seccomp` here is the load-bearing flag that puts the
# filter into the shipping `claude-agent`. The crate's default
# feature set is empty (so host `cargo check` works on macOS+Windows
# without pulling in Linux-only constants); guest builds must
# opt in explicitly.
( cd "$REPO_ROOT" && \
  cargo build --release --target x86_64-unknown-linux-musl \
    --manifest-path rust/claude-orch/bootstrap-init/Cargo.toml && \
  cargo build --release --target x86_64-unknown-linux-musl \
    --features seccomp \
    --manifest-path rust/claude-orch/runtime-agent/Cargo.toml )
install -m 0755 "$REPO_ROOT/target/x86_64-unknown-linux-musl/release/init" \
  "$BUILD_DIR/rootfs/sbin/init"
install -m 0755 "$REPO_ROOT/target/x86_64-unknown-linux-musl/release/claude-agent" \
  "$BUILD_DIR/rootfs/usr/local/bin/claude-agent"

step "Packing rootfs.raw"
rm -f "$BUILD_DIR/rootfs.raw"
mke2fs -t ext4 -d "$BUILD_DIR/rootfs" -L claude-rootfs "$BUILD_DIR/rootfs.raw" 32M >/dev/null
# Smoke boot mounts rw so bootstrap-init can write /home/claude/.claude/.
# Production uses a tmpfs overlay; the smoke test keeps a per-run copy.
cp -f "$BUILD_DIR/rootfs.raw" "$BUILD_DIR/rootfs-rw.raw"

if [ ! -f "$BUILD_DIR/vmlinux-x86_64" ]; then
  KSRC="$BUILD_DIR/linux-$LINUX_VERSION"
  if [ ! -d "$KSRC" ]; then
    step "Fetching linux-$LINUX_VERSION source"
    TARBALL="${LINUX_TARBALL:-https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$LINUX_VERSION.tar.xz}"
    # Maintainer-supplied digest. Cross-check against the upstream PGP-signed
    # `linux-<v>.tar.sign` from kernel.org before bumping LINUX_VERSION here.
    # Leave empty only for local one-shot experiments — CI sets it.
    LINUX_TARBALL_SHA256="${LINUX_TARBALL_SHA256:-}"
    DL="$BUILD_DIR/linux-$LINUX_VERSION.tar.xz"
    if [[ "$TARBALL" == http* ]]; then
      curl -sLo "$DL" "$TARBALL"
    else
      cp -f "$TARBALL" "$DL"
    fi
    if [ -n "$LINUX_TARBALL_SHA256" ]; then
      echo "${LINUX_TARBALL_SHA256}  ${DL}" | sha256sum -c -
    else
      echo "WARN: LINUX_TARBALL_SHA256 not set; skipping checksum verification" >&2
    fi
    tar -xJf "$DL" -C "$BUILD_DIR"
    rm -f "$DL"
  fi
  step "Configuring + building kernel ($LINUX_VERSION)"
  ( cd "$KSRC" && \
    make tinyconfig >/dev/null && \
    ./scripts/kconfig/merge_config.sh -m .config \
      "$REPO_ROOT/packages/claude-orch/images/kernel/microvm.fragment" >/dev/null && \
    make olddefconfig >/dev/null && \
    make -j"$(nproc)" bzImage )
  cp "$KSRC/arch/x86/boot/bzImage" "$BUILD_DIR/vmlinux-x86_64"
fi

step "Booting QEMU; expecting Hello on ctl.sock and Ready on agent.sock"
rm -f "$BUILD_DIR"/{ctl,fs,agent}.sock

HELLO_FILE="$BUILD_DIR/hello.json"
READY_FILE="$BUILD_DIR/agent-ready.json"
AGENT_LOGS_FILE="$BUILD_DIR/agent-logs.ndjson"
GUEST_WRITE_FILE="$BUILD_DIR/guest-write-verify.txt"
rm -f "$HELLO_FILE" "$READY_FILE" "$AGENT_LOGS_FILE" "$GUEST_WRITE_FILE"

NONCE="$(printf 'a%.0s' {1..64})"

# Host-side responder: real ctl + agent handshakes, real 9P bridge
# from @endo/claude-container backed by an @endo/endo-fs in-memory
# FS. Replaces the previous inline hand-rolled responder; the bridge
# is now the same code path CI exercises in `9p-server.test.js`.
node "$REPO_ROOT/packages/claude-orch/scripts/smoke-boot-host.js" \
  "$BUILD_DIR" "$HELLO_FILE" "$READY_FILE" "$AGENT_LOGS_FILE" "$GUEST_WRITE_FILE" &
NODE_PID=$!
sleep 0.5

# Accel selection: prefer KVM when available; fall back to TCG.
# CI runners (GitHub Actions) typically lack nested KVM; TCG runs
# the boot in software, ~5-10× slower but functionally identical.
# Override via SMOKE_BOOT_ACCEL=tcg or =kvm.
SMOKE_BOOT_ACCEL="${SMOKE_BOOT_ACCEL:-auto}"
if [ "$SMOKE_BOOT_ACCEL" = "auto" ]; then
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    SMOKE_BOOT_ACCEL=kvm
  else
    SMOKE_BOOT_ACCEL=tcg
  fi
fi
step "QEMU accel: $SMOKE_BOOT_ACCEL"

# `-cpu host` requires KVM; `-cpu max` is the safe TCG choice.
if [ "$SMOKE_BOOT_ACCEL" = "kvm" ]; then
  QEMU_CPU="-cpu host -accel kvm"
  QEMU_TIMEOUT=15
else
  QEMU_CPU="-cpu max -accel tcg"
  # TCG is much slower; give it more headroom.
  QEMU_TIMEOUT=120
fi

timeout "$QEMU_TIMEOUT" qemu-system-x86_64 \
  -machine pc $QEMU_CPU \
  -smp 1 -m 256 -no-reboot \
  -kernel "$BUILD_DIR/vmlinux-x86_64" \
  -append "console=ttyS0 root=/dev/vda rw rootfstype=ext4 earlyprintk=serial,ttyS0,115200 claude.session_id=smoketest claude.boot_nonce=$NONCE" \
  -drive "id=rootfs,file=$BUILD_DIR/rootfs-rw.raw,format=raw,if=none" \
  -device virtio-blk-pci,drive=rootfs \
  -device virtio-serial-pci \
  -chardev "socket,id=ctl,path=$BUILD_DIR/ctl.sock,reconnect=1" \
  -device virtserialport,chardev=ctl,name=orchestrator \
  -chardev "socket,id=fs,path=$BUILD_DIR/fs.sock,reconnect=1" \
  -device virtserialport,chardev=fs,name=workspace \
  -chardev "socket,id=agent,path=$BUILD_DIR/agent.sock,reconnect=1" \
  -device virtserialport,chardev=agent,name=agent \
  -serial stdio -display none >"$BUILD_DIR/qemu.log" 2>&1 || true
wait "$NODE_PID" 2>/dev/null || true

ok=1
if [ -s "$HELLO_FILE" ]; then
  echo "Hello: $(cat "$HELLO_FILE")"
else
  echo "[smoke-boot] no Hello arrived" >&2
  ok=0
fi
if [ -s "$READY_FILE" ]; then
  echo "Ready: $(cat "$READY_FILE")"
else
  echo "[smoke-boot] no Ready arrived" >&2
  ok=0
fi

# Post-Ready probes: the runtime-agent emits three Log frames with a
# stable `probe:` prefix immediately after sending Ready. Each one
# corresponds to a roadmap M4 assertion (see
# packages/claude-orch/README.md "Test coverage gaps"):
#   probe: agent uid=1000 gid=1000          — drop_privileges worked.
#   probe: workspace /workspace/hello.txt="hello from endo-fs"
#                                           — 9P mount readable by guest user.
#   probe: claude --version=<version>       — pinned binary on PATH.
if [ -s "$AGENT_LOGS_FILE" ]; then
  echo "Agent logs:"
  cat "$AGENT_LOGS_FILE"
fi
if grep -q '"probe: agent uid=1000 gid=1000"' "$AGENT_LOGS_FILE" 2>/dev/null; then
  echo "[smoke-boot] uid/gid probe OK"
else
  echo "[smoke-boot] post-drop_privileges uid/gid probe missing or wrong (expected uid=1000 gid=1000)" >&2
  ok=0
fi
if grep -q '"probe: workspace /workspace/hello.txt=' "$AGENT_LOGS_FILE" 2>/dev/null; then
  if grep -q 'hello from endo-fs' "$AGENT_LOGS_FILE"; then
    echo "[smoke-boot] workspace read probe OK"
  else
    echo "[smoke-boot] workspace probe present but contents wrong (expected 'hello from endo-fs')" >&2
    ok=0
  fi
else
  echo "[smoke-boot] workspace read probe missing (9P mount unusable by guest user?)" >&2
  ok=0
fi
if grep -q '"probe: claude --version=' "$AGENT_LOGS_FILE" 2>/dev/null; then
  echo "[smoke-boot] claude --version probe OK"
else
  echo "[smoke-boot] claude --version probe missing (claude-code not on PATH inside guest?)" >&2
  ok=0
fi
# Guest-write probe: smoke-boot-host.js re-reads
# /workspace/guest-wrote.txt off the endo-fs cap the moment the
# agent logs `probe: workspace wrote …`, and writes either
# `ok: <bytes>` or a diagnostic line to $GUEST_WRITE_FILE. The
# write itself is exercised in `factory-live.test.js` against a
# Node 9P client at unit speed; this assertion is the end-to-end
# version with the real linux kernel doing the v9fs Twrite.
if [ -s "$GUEST_WRITE_FILE" ]; then
  echo "Guest write verify: $(cat "$GUEST_WRITE_FILE")"
fi
if grep -q '^ok: bytes written by the runtime-agent' "$GUEST_WRITE_FILE" 2>/dev/null; then
  echo "[smoke-boot] guest-write probe OK (kernel v9fs → bridge → endo-fs)"
else
  echo "[smoke-boot] guest-write probe missing/mismatch (kernel v9fs write didn't land on endo-fs)" >&2
  ok=0
fi

if [ "$ok" = 1 ]; then
  echo "[smoke-boot] PASS"
  exit 0
fi
echo "[smoke-boot] FAIL" >&2
echo "Tail of qemu.log:" >&2
tail -30 "$BUILD_DIR/qemu.log" >&2 || true
exit 1
