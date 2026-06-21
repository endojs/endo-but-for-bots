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
> Each session is now a first-class `claude-client` formula, so the form-driven
> store path works and survives daemon restarts; the end-to-end form path still
> wants a live-daemon test — see [Known issues](#known-issues--future-work).

## Goal

Run Claude Code inside an [`@endo/sandbox`](../sandbox/README.md) rootless
**podman** slice, projecting the agent's workspace from an Endo `Filesystem`
capability and exposing the session to other Endo agents as a `ClaudeClient`.

The intended deployment is a **host daemon on a Linux machine** that lets
**remote peers** bring two capabilities of their own — a `Filesystem` (their
project files) and a `ClaudeCredentials` (their Claude auth) — and run Claude
Code against them in a container on the host.
The peer's long-lived auth stays on the peer's machine; the host receives only
the short-lived per-session secret the credential cap mints (see
`ClaudeCredentials` above).
The sibling [`@endo/claude-container`](../claude-container) (PR #328) explores
the same goal with a heavier QEMU-microVM substrate; this package is the
lighter rootless-podman path with the same capability shape.

## Architecture

Four pieces, all unconfined caplets minted by [`setup.js`](./setup.js):

- **`ClaudeSandboxFactory`** (`src/claude-sandbox-factory.js`) — presents the
  "Create Claude Sandbox" form on `@host`; on submission it projects the
  workspace and mints the slice + client.
- **`ClaudeClient`** (`src/claude-client.js`) — one Claude Code session bound to
  one slice; `send()` spawns a fresh `claude -p … --output-format stream-json`
  per turn and parses the newline-delimited JSON.
- **`ClaudeCredentials`** (`src/claude-credentials-*.js`) — single-shot
  credential wrapper backed by a `0600` sidecar file; the secret never enters
  the formula store.
  It advertises a `kind()` — `apiKey` or `oauthToken` — so the factory injects
  the materialised secret as `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
  respectively.
  Because `issue()` / `materialise()` are eventual-sends, the cap can live on a
  remote **peer**: the peer holds the long-lived auth (e.g. an OAuth refresh
  token) and mints a short-lived `oauthToken` per session, so the host daemon
  only ever sees the short-lived bytes.
  This mirrors the R3 `ClaudeCredentials` contract in `@endo/claude-container`
  (PR #328).
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

### 1. `storeValue` could not persist the `ClaudeClient` — FIXED

Originally the form path built the `ClaudeClient` as a `makeExo` inside the
factory worker and called `E(hostAgent).storeValue(client, name)`, which threw
`No corresponding formula for Object [Alleged: ClaudeClient]`
(`packages/daemon/src/host.js`): a worker-local exo — and the slice / mount
handles it wrapped — have no daemon **formula** identity, so
`formulateMarshalValue` cannot store a reference and the pet name pointed at a
non-existent formula.
The dependency-injected unit tests masked this because the mock `storeValue`
just recorded the object.

**Fixed: each session is now a first-class `claude-client` formula.**
The factory formulates the session via
`E(hostAgent).makeUnconfined('@main', claude-client-module.js, { resultName,
powersName: '@agent', env })`, so the stored `ClaudeClient` has a real daemon
identity and reincarnates across restarts.

Because an `@endo/sandbox` slice (`makeExo('SandboxHandle', …)` minted inside
the sandbox-factory's worker, `packages/sandbox/src/factory.js`) and the 9P
mount handle are worker-local and cannot cross a formula boundary, the client
formula **owns its slice and mount**:
[`src/claude-client-module.js`](./src/claude-client-module.js) provisions them
lazily from its `env` on first use — looking up the `sandbox-factory` /
`fs-mounter` / `Filesystem` / `ClaudeCredentials` caps by pet name, mounting the
workspace, registering the Mount cap, and minting the slice.
On reincarnation it re-mounts and re-mints a fresh container; the workspace and
the conversation persist in the `Filesystem` cap, and the (possibly
peer-hosted) credential is re-materialised at spawn time — so no secret ever
enters the formula `env`.

The per-session client worker currently runs with `@agent` (full host
authority) so it can call the privileged `provideMount` and look up those caps.
Scoping that to a per-session guest profile that introduces only the needed caps
(mirroring `@endo/claude-container`'s `provideGuest` pattern) is tracked in
follow-ups below.

### 2. Factory error path leaks the slice and the 9P mount — FIXED (structurally)

Originally, on any failure after the mount / slice were created the factory's
`catch` only replied with the error message, leaving a running `endo-sandbox-*`
container and a mounted 9P filesystem behind.

**Fixed.**
With issue #1's refactor the factory no longer mounts or mints anything — the
client formula owns that lifecycle — so the factory cannot leak.
The client module provisions atomically: if the slice mint fails after the
mount, it unmounts the workspace before rejecting (covered by the
`a slice-mint failure unmounts the workspace` test in
`test/claude-client-module.test.js`), and `terminate()` disposes the slice and
unmounts.

### 3. Integration-test gap — ADDRESSED

The pure mocks could not catch the formula-identity constraint in #1.
[`test/integration.test.js`](./test/integration.test.js) is a podman-gated test
(skips when podman/rootless or the image is unavailable) that exercises a real
`@endo/sandbox` podman slice, a real bind-mounted workspace, and a real
process's stdout flowing over the `@endo/exo-stream` wire protocol into
`parseStreamJsonLines` — the layer the unit mocks fake.
A second case (gated on `CLAUDE_SANDBOX_TEST_IMAGE`) drives a real `claude`
through `ClaudeClient.send`.
Still open: a full **live-daemon** test that drives the form → `makeUnconfined`
→ stored `ClaudeClient` path end to end (the `@agent` powers wiring is only
exercised against a real daemon).

### 4. Other follow-ups

- Exercise the **live path with a real credential** — both an
  `ANTHROPIC_API_KEY` and an `oauthToken` (`CLAUDE_CODE_OAUTH_TOKEN` from
  `claude setup-token`). Only the no-credential path is validated live so far;
  the credential-kind → env-var wiring is unit-tested but not yet run against a
  real `claude`.
- Token refresh for long-lived sessions: a short-lived `oauthToken` is injected
  into the slice env at creation, but each `send()` spawns a fresh `claude`
  reading that fixed env, so the token is not refreshed mid-session. For
  long-running sessions, re-materialise the credential per `send()` (per-spawn
  env) or push a rotated token in, mirroring `@endo/claude-container`'s
  `RotateCreds`.
- Validate `network` profiles beyond `none` (`private` etc. need
  `slirp4netns`/`pasta` reachable from the daemon's user). Note Claude Code must
  reach `api.anthropic.com`, so a usable session needs an egress-capable profile
  — `none` blocks the API entirely; the default is `private`.
- **Least authority for the per-session client worker.** The `claude-client`
  formula runs with `@agent` (full host authority) so it can call `provideMount`
  and look up caps by pet name. Scope this to a per-session guest profile that
  introduces only the `sandbox-factory`, `fs-mounter`, the workspace
  `Filesystem`, and the credential — mirroring the `provideGuest` pattern
  `@endo/claude-container` uses for its bridge — and confirm `provideMount` can
  be reached (or pre-resolve the Mount cap in the factory and pass it by pet
  name) under that reduced authority.
- Reconcile the form's `rootfs` help with the podman driver: either drop
  `host-bind`/`minimal` from the advertised options under the podman backend or
  document that they require `bwrap`.
- Redirect `claude -p` stdin from `/dev/null` to drop the stdin warning.
- Decide and document session lifecycle across daemon restarts (the client is
  intentionally non-persistent today; the podman driver sweeps orphans at boot).
