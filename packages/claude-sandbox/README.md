# @endo/claude-sandbox

Run [Claude Code](https://docs.claude.com/en/docs/claude-code) inside an
[`@endo/sandbox`](../sandbox/README.md) rootless **podman** slice, with the
agent's workspace projected from an Endo `Filesystem` capability and exposed to
other Endo agents as a `ClaudeClient` capability.

> Status: experimental.
> The dependency-injected unit tests run anywhere, but the live path needs
> podman and a host able to 9P-mount (Linux + `CAP_SYS_ADMIN` or passwordless
> `sudo`).
> See [`DEMO.md`](./DEMO.md) for the end-to-end runbook.

## Why

`@endo/claude-container` (on another branch) runs Claude inside a QEMU
microVM orchestrator.
This package keeps the same capability shapes — a form-driven factory, a
`ClaudeClient`, a single-shot `ClaudeCredentials` caplet — but swaps the VM for
an `@endo/sandbox` podman slice and projects the workspace with the 9P mount
caplet from [`@endo/9p-server`](../9p-server/README.md).

## Workspace projection ("plan B")

Rootless podman cannot run `mount -t 9p` inside the container
(`mount(2)` needs `CAP_SYS_ADMIN`, which a rootless userland lacks).
So the 9P mount happens **on the host** and the container merely bind-mounts the
result:

```
Filesystem cap ──E(fsMounter).mount(fs, P)──▶ 9P bridge + `mount -t 9p` at host path P
        P ──E(host).provideMount(P)──▶ workspace Mount cap
  Mount cap ──mounts:[cap → /workspace]──▶ podman slice (E(sandboxFactory).make)
      slice ──E(slice).spawn(claude -p …)──▶ claude --output-format stream-json
     stdout ──parsed line-by-line──▶ ClaudeClient.send() reader
```

The factory's `provideHostPath(cap)` resolves the workspace Mount cap back to
the host mountpoint `P`, which podman bind-mounts into the container at
`/workspace`.
Because `P` is itself a kernel 9P mount, the projected filesystem rides into the
slice.

## Capabilities

### `ClaudeSandboxFactory`

Presents the "Create Claude Sandbox" form on `@host`.
Fields:

| field | meaning |
|-------|---------|
| `name` | pet name for the resulting `ClaudeClient` |
| `filesystem` | pet name of an existing `Filesystem` capability |
| `rootfs` | OCI image (`oci:<ref>` or a bare ref), or `host-bind` / `minimal` |
| `network` | `none` \| `private` (default) — no host networking; `private` gives outbound internet with no reach to the host |
| `model` | optional Claude model id (passed as `--model`) |
| `credentials` | optional `ClaudeCredentials` pet name |
| `initialPrompt` | optional first message |

On submission it mounts the filesystem over 9P, mints a podman slice with the
workspace bound at `/workspace`, builds a `ClaudeClient`, and stores it under
`name`.

### `ClaudeClient`

A single Claude Code session bound to one slice.

| method | behavior |
|--------|----------|
| `send(prompt, opts?)` | run `claude -p <prompt> --output-format stream-json` in the slice; returns a buffered reply reader (consume with `makeRefIterator`) that yields the parsed stream-json events then a terminal `{type:'end'}` or `{type:'abort',reason}`. Closing the reader aborts the turn. |
| `interrupt()` | close the current reader — kills the in-flight `claude` process; the slice survives |
| `terminate()` | dispose the slice, unmount the host 9P workspace, and revoke the credential grant |
| `status()` | `{ sessionId, createdAt, workspaceMountPoint, backend, rootfs, conversationStarted, terminated }` |
| `help()` | usage string |

**Turn model (floot-shaped).**
Each `send()` is one `claude -p` process; turns **queue** (a `turnChain`
serializes them, so two processes never race the same workspace conversation).
Continuity is preserved by passing `--continue` on every turn after the first,
which resumes the conversation persisted in the workspace. The reply reader is
`@endo/exo-stream`'s `makeBufferedReader`; closing it (or `interrupt()`) kills
the in-flight process. See [DESIGN.md § Turn model](./DESIGN.md#turn-model--the-floot-session-shape).

### `ClaudeCredentials`

Ported from `@endo/claude-container`.
The factory writes the submitted secret to a `0600` sidecar file under
`$CLAUDE_CREDENTIALS_DIR` (default `~/.endo-claude-credentials`) and the formula
references only the file path — the secret never enters the Endo formula store.

A credential has a `kind`:

- `apiKey` — a raw Anthropic API key, injected into the slice as
  `ANTHROPIC_API_KEY`.
- `oauthToken` — the short-lived OAuth access token Claude Code accepts
  headlessly (`claude setup-token`), injected as `CLAUDE_CODE_OAUTH_TOKEN`.

Because `issue()` / `materialise()` are eventual-sends, the cap can live on a
remote **peer** that holds the long-lived auth and mints a short-lived
`oauthToken` per session, so the host daemon only ever sees the short-lived
secret.

| method | behavior |
|--------|----------|
| `kind()` | `"apiKey"` or `"oauthToken"` |
| `issue(sessionTag)` | returns an `IssuedCredential`; call `.materialise()` once to get the secret |
| `revoke(sessionTag)` | invalidate grants for that tag |
| `rotate(newSecret)` | replace the secret and invalidate all outstanding grants |

The factory materialises the key just before injecting it as
`ANTHROPIC_API_KEY` into the slice's env.

### `ClaudeBackendFactory` (Floot hosted backend)

[`src/claude-backend-factory.js`](./src/claude-backend-factory.js) presents
the Claude CLI runtime to Floot through `@endo/hosted-agent`'s
`HostedBackendFactoryInterface`, the same seam the Codex backend uses.
`setup-hosted.js` mints it as `claude-sandbox/backend` and binds its guarded
facet into the Floot controller profile as `claude-backend`, which Floot's
factory discovers on its own; a Floot session then selects it as the model
`claude:<model id>`.

| method | behavior |
|--------|----------|
| `describe()` | `{ id: 'claude', title: 'Claude Code', kind: 'hosted', continuity: 'transcript', toolOwnership: 'endo', supportedNetworkPolicies: ['off', 'public-internet'] }` |
| `listModels()` | the Anthropic models `claude --model` accepts, as hosted model descriptors (no reasoning efforts) |
| `create(spec, toolSet)` | one recorded session with the daemon session owner: a plan naming the session's workspace (owned, or the guest's git worktree as `/workspace`), its private socket directories, the broker's pinned image and credential kind, and the requested `networkPolicy` (default `off`); the owner starts the native controller with `toolSet` pinned; returns `{ run, admin }` |
| `destroy(spec)` | idempotently stop the session and remove its record, workspace, private directories, and persistent config directory through the recorded storage owner |

`run.send(prompt, { systemPrompt })` returns a reader of provider-neutral
hosted turn events ([`src/claude-hosted-events.js`](./src/claude-hosted-events.js)
translates the CLI's stream-json wire), forwarding the session model and
persona on every spawn. `run.interrupt()` kills the in-flight `claude -p`
and tolerates an idle client. `run.acknowledge()` is a no-op: continuity is
the CLI's own transcript, which the descriptor declares as
`continuity: 'transcript'` so Floot mirrors a stopped or failed turn into its
history rather than dropping it. `admin.terminate()` stops the session through
the daemon owner: the controller ends the CLI, disposes the slice, releases
the sandbox scope, the 9P mounter, the tool bridge, and the broker grant; the
workspace and transcript stay for the next revival.

**Endo tools over MCP.** The tool set Floot pins for the session reaches the
CLI through a per-session MCP server
([shared MCP protocol](../hosted-agent/src/mcp-bridge.js) over a Unix socket,
[`src/mcp-socket-server.js`](./src/mcp-socket-server.js)) whose directory the
slice mounts read-only at `/endo-mcp`; a plain-node relay
([shared stdio relay](../hosted-agent/src/mcp-stdio-bridge.js)) runs inside the
slice and pipes Claude Code's stdio to the socket, and `claude -p` gets
`--mcp-config /endo-mcp/mcp.json --strict-mcp-config`. Only JSON crosses the
socket: `tools/list` serves the pinned catalog, `tools/call` is refused for
any name outside it and otherwise dispatched to the tool set's `execute`,
which runs against the session guest in Floot's worker. The CLI's own
built-in tools keep running inside the slice.

**The credential stays on the host.** The slice never holds the Anthropic
credential. `setup-hosted.js` seeds it into the daemon's Secrets manager and
mints an Anthropic provider broker (`claude-sandbox/broker-service`, the
shared `@endo/hosted-agent` broker under the Anthropic Messages policy) whose
only powers dependency is that secret's delegated read facet. Each session's
controller takes a grant from the broker, checks the broker's attestation and
sandbox evidence against the plan's pinned image digest and network policy,
and runs the slice joined to the broker sidecar's network namespace with
`ANTHROPIC_BASE_URL` at the listener's loopback endpoint and a placeholder
under `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. The listener admits
only `POST /v1/messages`, strips whatever credential the CLI sends, and
injects the real one upstream: as `x-api-key` for an API key, or as a Bearer
token with the `oauth-2025-04-20` beta for a subscription token from
`claude setup-token`. Only the request body crosses the listener: upstream
it sends the credential header, `anthropic-version`, the operator's
`anthropic-beta` list (`ENDO_CLAUDE_ANTHROPIC_BETA`; the OAuth capability is
the default for subscription tokens only), and `content-type`. The CLI's own
beta capabilities and user agent are not forwarded for either kind, so a CLI
build that needs betas needs them configured there. A subscription session
keeps its subscription billing without the token entering the container. A
retained broker also keeps the model allowlist it was minted with: a model
added to the catalog later is listed but refused by the listener until the
broker is re-minted. `off` gives the slice no route but the listener;
`public-internet` adds the broker's attested proxy and resolver.
See [DESIGN.md § Phase 3](./DESIGN.md#phase-3--daemon-owned-sessions).

The time-boxed exception recorded here on 2026-09-08 (credential
materialisation into the slice, contradicting `@endo/codex-sandbox`'s
[merge blockers](../codex-sandbox/MERGE-BLOCKERS.md)) is retired by this
path: the broker presents the subscription credential upstream itself, which
was the condition for retiring it. Whether Anthropic's gateway accepts a
subscription Bearer token presented by the broker exactly as it accepts one
from the CLI is a live-acceptance question that the fixtures here do not
answer; the reasoning and sources remain in
[`designs/hosted-agent-broker-oauth.md`](../../designs/hosted-agent-broker-oauth.md).

## Setup

Provisioning is split by machine role; everything nests under host
directories (`claude-sandbox/`, `claude-credentials/`), each carrying a
`readme.md` blob (`endo cat claude-sandbox/readme.md`) that documents its
objects and the security of sharing each.

```sh
# HOST (container machine): mints claude-sandbox/{sandbox-factory, fs-mounter,
# service, profile, handle}.
endo run --UNCONFINED packages/claude-sandbox/setup-host.js --powers @agent \
  -E NINEP_SUDO=1                      # if the daemon is unprivileged

# PEER (credential holder; also run here for a single-box demo):
# mints claude-credentials/{service, profile, handle}.
endo run --UNCONFINED packages/claude-sandbox/setup-peer.js --powers @agent

# then submit the forms (see DEMO.md):
endo inbox
endo submit <n> ...

# HOSTED (single machine, no forms; after setup-host.js and
# floot-factory-setup.js): seeds the managed Anthropic credential into Secrets
# from a subscription token or API key (first run only), mints the Anthropic
# broker over it, the session storage owner, and the claude-sandbox/backend
# hosted backend, bound into floot/controller-profile as claude-backend so
# Floot sessions can select `claude:<model>`.
ENDO_CLAUDE_OAUTH_TOKEN=... \
ENDO_CLAUDE_SANDBOX_IMAGE=oci:localhost/claude-sandbox:latest \
ENDO_CLAUDE_BROKER_LISTENER_IMAGE=localhost/endo-provider@sha256:... \
ENDO_CLAUDE_NATIVE_PROFILE='{"uid":1000,...}' \
endo run --UNCONFINED packages/claude-sandbox/setup-hosted.js --powers @agent
```

The hosted variables (`ENDO_CLAUDE_*`, `ENDO_NINEP_*`, `ENDO_SANDBOX_*`) are
documented in the headers of [`setup-host.js`](./setup-host.js) and
[`setup-hosted.js`](./setup-hosted.js). The table below is the inbox-form
factory's configuration.

Configuration env (threaded into the factory formula by `setup-host.js` /
`factory.js`):

| var | default | meaning |
|-----|---------|---------|
| `CLAUDE_SANDBOX_IMAGE` | `docker.io/library/node:22-bookworm-slim` | default OCI image when the `rootfs` field is blank |
| `CLAUDE_SANDBOX_BACKEND` | `podman` | sandbox backend |
| `CLAUDE_SANDBOX_MOUNT_DIR` | OS temp dir | base dir for per-session 9P mountpoints |
| `SANDBOX_NAMESPACE` | `claude-sandbox` (set by the provisioner) | host directory the infra caplets live under; the per-session powers endows `<ns>/sandbox-factory` and `<ns>/fs-mounter`. Empty means the host root. |
| `SANDBOX_FACTORY_NAME` | `sandbox-factory` | name of the sandbox factory caplet within the namespace |
| `FS_MOUNTER_NAME` | `fs-mounter` | name of the 9P mounter caplet within the namespace |
| `CLAUDE_CREDENTIALS_DIR` | `~/.endo-claude-credentials` | sidecar dir for API keys |
| `NINEP_SUDO` | unset | `1` routes host `mount`/`umount` through `sudo` |

## Lifecycle

Each `ClaudeClient` is a **first-class `claude-client` formula**
([`src/claude-client-module.js`](./src/claude-client-module.js)), formulated by
the factory via `makeUnconfined` and parameterised entirely by `env`. It does
**not** hold the slice or mount as construction state: it provisions them lazily
on first use (mount the workspace over 9P, register the Mount cap, mint the
podman slice) and memoizes the result.

The client worker runs with **least authority** — **caps as arguments**, not
`@agent`. For each session the factory builds a per-session powers cap (via
`evaluate`) that bundles the four caps the client needs **by reference** and
exposes only `sandboxFactory()` / `fsMounter()` / `filesystem()` /
`credentials()` accessors plus a `provideMount` bounded to *that session's*
mountpoint. There is **no `lookup`**, so the client cannot resolve any host name
beyond its own caps, nor reach `makeUnconfined` / `provideHostPath` / `remove` /
etc. (The powers must be host-named for `makeUnconfined`, so the factory unnames
it right after — the client's formula dependency edge keeps it alive and collects
it *with* the client, leaving no residue.) See
[DESIGN.md § Known issue #8](./DESIGN.md#8-least-authority-for-the-client-worker--fixed).

Because the formula is a pure value of its `env`, it **reincarnates across
daemon restarts**: a restart re-provisions on the next `send()` — re-mounting
the workspace and minting a fresh container (the podman driver sweeps
`endo-sandbox-*` orphans at boot). The workspace and the conversation persist in
the `Filesystem` cap, and the credential is re-materialised from its (possibly
peer-hosted) cap at spawn time, so no secret is stored in the formula. The
container itself is ephemeral, matching the `@endo/sandbox` plugin's non-goal of
container persistence.

### Creating and destroying a session

- **Remote peer:** the peer `send`s a session-request package (a `filesystem`
  (+ optional `credentials`) edge and a JSON config marked
  `kind: "claude-sandbox-session"`); the factory `adopt`s the caps and replies
  with a `client` edge the peer adopts. Host-rooted under the factory directory.
- **Operator:** submitting the `@host` form (host pet names) stores the client
  under a pet name.
- Both are host-rooted; destroy with `E(host).remove(name)`. A capability cannot
  be passed as a method argument across a daemon boundary (it would arrive as an
  unadoptable presence), so there is no `createSession` cap-argument method.
- **Stop without destroying:** `E(client).terminate()` disposes the container and
  unmounts, but the formula survives and re-provisions on the next `send()`.

Teardown is wired to the daemon's cancellation context, so `cancel`, `remove`,
GC collection, and daemon shutdown all release the container and mount. See
[DESIGN.md § Session lifecycle, teardown & GC](./DESIGN.md#session-lifecycle-teardown--gc).

## Caveats

- **Privilege.**
  The host 9P mount needs `CAP_SYS_ADMIN` (a privileged daemon) or passwordless
  `sudo mount`/`umount` via `NINEP_SUDO=1`.
  See [`@endo/9p-server` DEMO](../9p-server/DEMO.md) § B4.
- **File ownership.**
  The 9P server synthesizes uid/gid 1000; under rootless podman's uid mapping,
  workspace files may appear as `nobody` inside the container.
  Pass `extraMountOptions: 'cache=loose'` for read-heavy workloads.
- **Image contents.**
  The default image is a bare Node base and does **not** ship the `claude` CLI;
  supply an image that bundles `@anthropic-ai/claude-code` (see
  [`DEMO.md`](./DEMO.md) § "Build a Claude image") or `claude` invocations will
  fail with `claude: not found`.

## Testing

```sh
cd packages/claude-sandbox
yarn test       # ava — fully dependency-injected, no podman/root required
yarn lint
```
