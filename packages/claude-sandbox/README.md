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
| `network` | `none` \| `private` \| `host-loopback` \| `host-lan` \| `host-net` |
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
| `send(prompt, opts?)` | spawn `claude -p <prompt> --output-format stream-json` in the slice; resolves to a reader of parsed stream-json events (consume with `makeRefIterator`) |
| `interrupt()` | kill the in-flight `claude` process; the slice survives |
| `terminate()` | dispose the slice and unmount the host 9P workspace |
| `status()` | `{ sessionId, createdAt, workspaceMountPoint, backend, rootfs, conversationStarted, terminated }` |
| `help()` | usage string |

**Turn model.**
Each `send()` is one-shot: a fresh `claude -p` process per call.
Continuity is preserved by passing `--continue` on every turn after the first,
which resumes the conversation persisted in the workspace.

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

## Setup

```sh
# Mints sandbox-factory, fs-mounter, and the two factories on @host.
endo run --UNCONFINED packages/claude-sandbox/setup.js --powers @agent \
  -E NINEP_SUDO=1                      # if the daemon is unprivileged
# then submit the two forms (see DEMO.md):
endo inbox
endo submit <n> ...
```

Configuration env (threaded into the factory formula by `setup.js` /
`factory.js`):

| var | default | meaning |
|-----|---------|---------|
| `CLAUDE_SANDBOX_IMAGE` | `docker.io/library/node:22-bookworm-slim` | default OCI image when the `rootfs` field is blank |
| `CLAUDE_SANDBOX_BACKEND` | `podman` | sandbox backend |
| `CLAUDE_SANDBOX_MOUNT_DIR` | OS temp dir | base dir for per-session 9P mountpoints |
| `SANDBOX_FACTORY_NAME` | `sandbox-factory` | pet name of the sandbox factory |
| `FS_MOUNTER_NAME` | `fs-mounter` | pet name of the 9P mounter |
| `CLAUDE_CREDENTIALS_DIR` | `~/.endo-claude-credentials` | sidecar dir for API keys |
| `NINEP_SUDO` | unset | `1` routes host `mount`/`umount` through `sudo` |

## Lifecycle

A `ClaudeClient` holds **live** references — the podman slice handle and the
host 9P mount handle — in the factory worker.
It is therefore not a pure-env formula and does **not** reincarnate across
daemon restarts: a restart drops live sessions and the podman driver sweeps
`endo-sandbox-*` orphan containers at boot.
This matches the `@endo/sandbox` plugin's non-goal of persistence.

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
