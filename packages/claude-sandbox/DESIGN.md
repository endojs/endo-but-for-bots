# @endo/claude-sandbox — design & status

This document records the as-built architecture, what has been verified
end-to-end, the environment gotchas worth knowing, and the known bugs /
future work.
It complements [`README.md`](./README.md) (usage) and [`DEMO.md`](./DEMO.md)
(runbook).

> Status: experimental.
> The provisioning, credentials, and host-9P-mount paths are verified live on
> Linux.
> Claude Code has been run inside a rootless podman slice (without an API key).
> The form-driven `storeValue` path has a known blocker — see
> [Known issues](#known-issues--future-work).

## Goal

Run Claude Code inside an [`@endo/sandbox`](../sandbox/README.md) rootless
**podman** slice, projecting the agent's workspace from an Endo `Filesystem`
capability and exposing the session to other Endo agents as a `ClaudeClient`.

## Architecture

Four pieces, all unconfined caplets minted by [`setup.js`](./setup.js):

- **`ClaudeSandboxFactory`** (`src/claude-sandbox-factory.js`) — presents the
  "Create Claude Sandbox" form on `@host`; on submission it projects the
  workspace and mints the slice + client.
- **`ClaudeClient`** (`src/claude-client.js`) — one Claude Code session bound to
  one slice; `send()` spawns a fresh `claude -p … --output-format stream-json`
  per turn and parses the newline-delimited JSON.
- **`ClaudeCredentials`** (`src/claude-credentials-*.js`) — single-shot API-key
  wrapper backed by a `0600` sidecar file; the key never enters the formula
  store.
- **`parse-rootfs.js`** — maps the `rootfs` form field to a `RootfsSpec`.

It leans on two upstream caplets: the `@endo/sandbox` podman driver and the
`@endo/9p-server` mount caplet (`fs-mounter`).

### Workspace projection ("plan B")

Rootless podman cannot run `mount -t 9p` (it needs `CAP_SYS_ADMIN`), so the 9P
mount happens on the **host** and the container bind-mounts the result:

```
Filesystem cap ──E(fsMounter).mount(fs,P)──▶ 9P bridge + host `mount -t 9p` at P
        P ──E(host).provideMount(P)──▶ workspace Mount cap
  Mount cap ──mounts:[cap → /workspace]──▶ podman slice (E(sandboxFactory).make)
      slice ──E(slice).spawn(claude -p …)──▶ stream-json on stdout
```

This reconciles two opposing privilege models: the daemon runs as a **non-root**
user so the podman probe reports rootless, and the privileged `mount(2)` is
delegated through `sudo` via `NINEP_SUDO=1`.

## Verified status

Validated in a privileged Docker container (`node:22-bookworm`, Docker Desktop
LinuxKit kernel 6.12, aarch64) — see [DEMO.md](./DEMO.md).

### Phase 1 — provisioning, credentials, host 9P mount (root daemon)

- `setup.js` mints `sandbox-factory`, `fs-mounter`, `claude-credentials-factory`
  and `claude-sandbox-factory`, and both forms land in `@host`'s inbox.
- Credentials form → `0600` sidecar in a `0700` dir;
  `E(c).issue(tag)` then `.materialise()` round-trips the key through the daemon.
- `fs-mounter` performs a real kernel 9P mount
  (`… type 9p (rw,trans=unix)`); read and write-through both work;
  `provideMount(path, petName)` and clean `unmount()` verified.

### Phase 2 — Claude Code in a rootless podman slice

- Daemon runs as a non-root user (uid 1000) with `/etc/subuid`+`/etc/subgid`;
  `podman info` reports `Rootless: true`; `crun`; `cgroupfs` manager.
- `NINEP_SUDO=1` + a narrow `sudoers` entry (`mount`, `umount` only) lets the
  unprivileged daemon do the host 9P mount.
- `sandbox-factory.listBackends()` → `podman available: true (v4.3.1)`.
- Built a `localhost/claude-demo` image (`node:22-bookworm-slim` +
  `@anthropic-ai/claude-code`, claude `2.1.183`).
- The form submission mounted the workspace over 9P and started a rootless
  podman slice with the workspace bound at `/workspace`.
- `claude` runs in the slice. With **no API key** it fails gracefully:
  - `claude --version` → `2.1.183 (Claude Code)`, exit 0;
  - `claude -p "…" --output-format stream-json --verbose` emits valid
    stream-json — a `system/init` event (`"apiKeySource":"none"`,
    `cwd:"/workspace"`), an `assistant` event
    (`"Not logged in · Please run /login"`, `error:"authentication_failed"`),
    and a `result` event (`is_error:true`), exit 1;
  - `ClaudeClient.send()` parsed those same three events via
    `parseStreamJsonLines`, validating the client path against real output.

## Environment gotchas

- **Use the `vfs` storage driver under nested Docker, not `fuse-overlayfs`.**
  On the Docker Desktop LinuxKit kernel, every in-container `execve` from a
  `fuse-overlayfs` rootfs failed with `EINVAL`
  (`exec /bin/sh: invalid argument`), independent of OCI runtime (crun 1.8.1 and
  1.28, and runc 1.1.5 all reproduced it).
  Setting podman's storage driver to `vfs` fixed it completely.
  Upgrading crun was a red herring.
- **uid/gid 1000.**
  The 9P server synthesizes uid/gid 1000; under rootless podman's uid mapping
  workspace files may appear owned by `root`/`nobody` inside the container.
- **`claude -p` stdin.**
  Without a redirected stdin, claude prints
  `Warning: no stdin data received in 3s, proceeding without it.`
  before running; pass `stdin` from `/dev/null` to silence it.
- **podman rootfs is OCI-only.**
  The podman driver only accepts `rootfs: { kind: 'oci', ref }`; `host-bind` and
  `minimal` are bwrap-only and throw at `make()` — even though the form help
  still advertises them (see future work).

## Known issues & future work

### 1. `storeValue` cannot persist the `ClaudeClient` (blocker for the form path)

The form path creates the slice and 9P mount correctly, but
`E(hostAgent).storeValue(client, name)` throws
`No corresponding formula for Object [Alleged: ClaudeClient]`
(`packages/daemon/src/host.js`).
A `makeExo` built inside the factory worker — and the slice / mount handles it
wraps — are worker-local remotables with no daemon **formula** identity, so
`formulateMarshalValue` cannot store a reference; the pet name ends up pointing
at a non-existent formula.
The dependency-injected unit tests masked this because the mock `storeValue`
just records the object.

**Proposed fix.**
Stop `storeValue`-ing a worker-local exo as a top-level pet name.
Instead have the factory **own its sessions in memory** and expose them through
its own (formula-backed) interface — e.g. `list()`, `get(name)`,
`send(name, …)`, `terminate(name)` — mirroring how genie manages sessions
through its controller.
Alternatively, formulate the client as a first-class formula (e.g. a dedicated
`claude-client` caplet) so it has a real identity.

### 2. Factory error path leaks the slice and the 9P mount

On any failure after the mount / slice are created, the `catch` block only
replies with the error message; it does not dispose the slice or unmount the
workspace.
The failed `storeValue` above left a running `endo-sandbox-*` container and a
mounted 9P filesystem behind.

**Proposed fix.**
Track the `mountHandle` and `slice` in the submission scope and, on error,
best-effort `E(slice).dispose()` + `E(mountHandle).unmount()` before replying.

### 3. Integration-test gap

The pure mocks could not catch the formula-identity constraint in #1.
Add a podman-gated integration test (skipped when podman/rootless is
unavailable) that exercises mount → `provideMount` → `make` → store → `send`
against a tiny image, so the storage contract is covered.

### 4. Other follow-ups

- Exercise the **live path with a real `ANTHROPIC_API_KEY`** (only the no-key
  path is validated so far).
- Validate `network` profiles beyond `none` (`private` etc. need
  `slirp4netns`/`pasta` reachable from the daemon's user).
- Reconcile the form's `rootfs` help with the podman driver: either drop
  `host-bind`/`minimal` from the advertised options under the podman backend or
  document that they require `bwrap`.
- Redirect `claude -p` stdin from `/dev/null` to drop the stdin warning.
- Decide and document session lifecycle across daemon restarts (the client is
  intentionally non-persistent today; the podman driver sweeps orphans at boot).
