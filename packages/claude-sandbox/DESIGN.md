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

## Session lifecycle, teardown & GC

Each session is a first-class `claude-client` formula. Two things govern its
lifetime: **who roots it** (whether it is collected) and **the cancellation
context** (how it tears down).

### Two create paths — who roots the session

- **`E(factory).createSession(config)`** (peer-callable) formulates the client
  **without** a pet name and **returns the cap**. The session is therefore
  rooted only by the **caller's retention**: when a remote peer holds the
  returned cap, the host records a retention edge under that peer; when the peer
  drops it, the edge is removed and — if nothing else roots it — the formula is
  collected. This is the intended remote-peer shape: _the peer owns the
  session's lifetime._
- **The "Create Claude Sandbox" form on `@host`** stores the client under a pet
  name (`resultName`) — a **host-side** root. This is the operator path; the
  host owns the lifetime and must `E(host).remove(name)` to destroy it.

Delivery dictates rooting: a form **reply** (and `send`) can only attach a cap
**by pet name** (`Mail.reply(number, strings, edgeNames, petNamesOrPaths)`), so
handing a session to a peer *without* a host root requires the direct CapTP
return that `createSession` provides.

### Teardown — the cancellation context

The client module wires `context.whenCancelled()` (the pattern `@endo/9p-server`
and genie use). When the formula is cancelled or collected, the session tears
down: dispose the slice (kills the container) then unmount the 9P workspace.
`terminate()` does the same and is a no-op when nothing was provisioned, so a
never-used session cancels for free.

- **`cancel`** (explicit `E(host).cancel(name)`, **and every daemon shutdown**)
  is _transient_: the formula stays on disk and **reincarnates**, re-provisioning
  a fresh container on the next `send()` (the workspace and conversation persist
  in the `Filesystem` cap; `claude --continue` resumes).
- **`remove`/collection** additionally **deletes** the formula. Because teardown
  is wired to the same `whenCancelled` signal, removal is a clean delete with no
  leftover container or mount — _"remove == delete, no further cleanup."_

### Distributed GC (validated against the daemon source)

Collection is reachability mark-and-sweep from roots = **pet-name edges** +
**pins** + **retention edges** (a remote peer holding a cap). The peer-drop →
collection chain, verified end-to-end:

1. the peer's retention-set `remove` delta → `formulaGraph.removeRetention(...)`
   (`daemon.js`),
2. → `removeGroupEdge` decrements the refcount; at zero → `maybeCollect`
   (`graph.js`),
3. → if refcount 0 **and not a root**, collect → `onCollect`,
4. → `deleteFormula` **and** `controller.context.cancel(...)` — which fires our
   `whenCancelled` teardown.

Caveats worth knowing:

- GC is on by default (`gcEnabled = true`) but can be disabled.
- "Not otherwise rooted" is load-bearing: a host pet name (the form path) keeps
  the refcount above zero, so a peer dropping its copy will **not** collect a
  form-created session — only a `createSession` (peer-rooted) one.
- A _transient disconnect_ does **not** drop a known peer's retention; retentions
  are durable (SQLite) and reconciled only when the peer **reconnects** without
  the reference. So "offline" ≠ "collected"; an explicit drop (or host `remove`)
  is what destroys the session.

### Destroying a session

- **Peer-rooted** (`createSession`): the peer drops the returned cap → GC
  collects it → teardown. No explicit host call needed.
- **Host-rooted** (form): `E(host).remove(name)` — cancellation fires teardown
  and the formula is deleted.
- **Stop without destroying:** `E(client).terminate()` disposes the container +
  unmounts but leaves the formula (it will re-provision on the next `send`).

## Turn model — current vs. the floot session (target)

A _session_ is one `ClaudeClient`; a _turn_ is one `claude -p … --output-format
stream-json` process spawned in the slice, whose parsed stdout is returned to
the caller as a Far event reader. The current turn model is deliberately thin
and has known gaps (see [Known issues](#known-issues--future-work) §5); the
intended model mirrors the **floot session** (`packages/floot` on the
`llm-kumavis-floot` branch).

### How floot does it (three layers)

1. **Buffered reply channel** (`floot/src/buffered-channel.js` → `makeBufferedReader`):
   a `Far` reader (`next`/`return`/`throw`) fed by an imperative `push`/`writer`,
   buffering so a producer can run ahead of a slow consumer. When the **consumer
   stops pulling** (`return`/`throw`), `finalize()` fires an **`onClose`** hook.
2. **Turn runner + abort** (`floot/agent.js` `converse`/`runTurn`): each turn
   gets an `AbortController`; the reply channel's `onClose` calls
   `controller.abort()`, and the turn threads `signal` into the provider and
   bails on `signal.aborted`. So **closing the reply reader aborts the in-flight
   turn** — there is no separate `interrupt()`; closing the reader _is_ the
   interrupt (UI "Stop" / barge-in).
3. **Turn serialization** (`turnChain`): `converse` chains each turn after the
   previous (`turnChain.then(() => runTurn(...))`), so concurrent calls **queue**
   and run one at a time over the shared conversation rather than racing.

"Queued messages, submitted as an interrupt" = `turnChain` queues turns, and a
new submission closes the current reply reader (abort/barge-in) before
enqueuing, so it preempts the in-flight turn cleanly.

### Mapping onto this package

The analogy is exact; only the _abort action_ differs (floot aborts a fetch
stream; here we **kill the `claude -p` OS process** in the slice):

| floot | claude-sandbox |
| --- | --- |
| `converse(input) → replyReader` | `send(prompt) → eventReader` |
| a turn = provider HTTP stream | a turn = `claude -p` process |
| abort = `controller.abort()` (signal) | abort = `E(proc).kill()` |
| `turnChain` serializes turns | **missing** (see §5: `send()`s race) |
| reply channel `onClose → abort` | **missing** (see §5: reader close ≠ kill) |

Adopting the floot shape — a buffered event reader whose close kills the
`claude` process (subsuming the manual `interrupt()`), plus a `turnChain` that
serializes `send()`s — fixes review findings §5 (1)–(2) at the right altitude
rather than patching `inFlight` ad hoc. `makeBufferedReader` is ~100 self
-contained, harden-clean lines; the open choice is whether to port it into this
package, factor it into a small shared package both depend on, or wait for floot
to land.

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

### 5. Turn-lifecycle defects (from code review) — OPEN

These are symptoms of the missing floot layers (see
[Turn model](#turn-model--current-vs-the-floot-session-target)); the floot
refactor is the intended fix.

1. **Closing a reader does not kill the turn** (`src/claude-client.js`,
   `makeEventReader`'s `return`/`throw`). On early consumer stop the
   `parseStreamJsonLines` generator stops pulling stdout and `inFlight` is
   cleared, but `E(proc).kill()` is never called: the `claude -p` process keeps
   running (and a later `interrupt()` can no longer target it; it may even block
   on a full stdout pipe). Floot's `onClose → abort` is the fix — here
   `onClose → E(proc).kill()`.
2. **Overlapping `send()`s race** (`src/claude-client.js`, `send` sets
   `inFlight = proc`). A second `send()` before the first drains overwrites
   `inFlight`, orphaning the first process; both run with `--continue` and write
   the same workspace conversation concurrently, which can corrupt it. Floot's
   `turnChain` (serialize/queue) is the fix; decide queue vs. barge-in for an
   in-flight `send()`.
3. **Provision rejection is memoized with no retry** (`src/claude-client.js`,
   `ensureProvisioned`). `provisioned = Promise.resolve(provision())`; if
   `provision()` rejects (image pull, 9P mount EPERM, `make` error) the rejected
   promise is cached, so every later `send()` re-rejects until the formula
   reincarnates. The post-mount `catch` unmounts the 9P mount, but the issued
   credential grant is **not** revoked, so it lingers in the credentials exo's
   `outstanding` set. Fix: reset `provisioned = undefined` on rejection (enable
   retry; `issue()` re-mints fine) **and** best-effort `revoke(sessionId)`.

### 6. Smaller defects (from code review) — OPEN

- **Loose form-reply guard** (`src/claude-sandbox-factory.js` and
  `src/claude-credentials-factory.js`): `msg.replyTo === formMessageId` matches
  `undefined === undefined` when the factory's own form has not been observed
  yet, so a stray `value` message with no `replyTo` is treated as a submission.
  Require `formMessageId !== undefined`.
- **`sessionId` collision** (`src/claude-sandbox-factory.js`): `slug +
  Date.now().toString(36)` collides for same-name requests in the same
  millisecond, clashing the mountpoint and the workspace pet name. Add a random
  suffix.
- **Credential trailing-newline strip** (`src/claude-credentials-module.js`):
  `/\n$/` removes only a single `LF`, not a `CRLF` or a doubled newline, leaving
  stray bytes in the materialised secret. Trim all trailing `CR`/`LF`.
- **Integration test self-skips green** (`test/integration.test.js`): when the
  alpine image is absent the case `t.pass()`es, so a host where the slice path
  is actually broken can report passing rather than a visible skip.

### 7. Other follow-ups

- Decide and document session lifecycle across daemon restarts. The client is a
  pure-`env` formula that **reincarnates** (re-provisioning a fresh container on
  the next `send()`); the podman driver sweeps `endo-sandbox-*` orphans at boot.
