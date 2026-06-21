# Demo: Claude Code in a podman sandbox with a 9P-projected workspace

This walks through running Claude Code inside an [`@endo/sandbox`](../sandbox/README.md)
rootless podman slice, with the workspace projected from an Endo `Filesystem`
capability via a host-side 9P mount ("plan B" — see
[`README.md`](./README.md)).

> Status: recorded runbook, **not** an automated test.
> The commands are accurate against the caplets on this branch but are not wired
> into CI (same posture as the [9P server DEMO](../9p-server/DEMO.md)).
> The dependency-injected unit tests (`yarn test`) cover the logic without
> podman or root.

## Prerequisites

- Linux with a kernel that has v9fs (`CONFIG_9P_FS`) — needed for the host 9P
  mount.
  macOS cannot 9P-mount; you can still drive the `Filesystem` cap as a
  capability but not project it into a container this way.
- **podman**, rootless-capable.
  Confirm `podman info` works as your user and that `newuidmap`/`newgidmap` are
  installed (`/etc/subuid` + `/etc/subgid` entries for your user).
- `mount(2)` privilege: either a privileged/root daemon with `CAP_SYS_ADMIN`,
  or passwordless `sudo mount`/`umount` (see step 3).
- An Endo daemon from this repo checkout.

## Build a Claude image

The sandbox needs an OCI image with `node` **and** the `claude` CLI on `PATH`.
Build one once and reference it from the form's `rootfs` field (or set
`CLAUDE_SANDBOX_IMAGE` so the form is pre-filled):

```dockerfile
# Containerfile
FROM docker.io/library/node:22-bookworm-slim
RUN npm install -g @anthropic-ai/claude-code
# Claude reads ANTHROPIC_API_KEY from the environment; the factory injects it.
WORKDIR /workspace
```

```bash
podman build -t localhost/claude-code:latest -f Containerfile .
```

## 1. Start the daemon

```bash
yarn exec endo start
yarn exec endo ping        # -> ok
```

## 2. Expose a workspace directory as a `Filesystem` cap

The shipped `node-fs-module.js` caplet reads `ENDO_FS_ROOT` and returns a
high-fidelity Node-backed `Filesystem`:

```bash
yarn exec endo make --UNCONFINED \
  packages/platform/src/fs/extended/node-fs-module.js \
  --powers @none \
  -E ENDO_FS_ROOT="$PWD/my-project" \
  --name project-fs
```

(For a remote workspace held by another daemon, adopt it first per the
[9P DEMO](../9p-server/DEMO.md) Part B3, then use that pet name below.)

## 3. Provision the Claude sandbox stack

`setup.js` idempotently mints, on `@host`: `sandbox-factory` (the
`@endo/sandbox` plugin), `fs-mounter` (the 9P mount caplet),
`claude-credentials-factory`, and `claude-sandbox-factory`.

**Privileged / root daemon** (e.g. a `--privileged` container or dev VM) — no
`NINEP_SUDO`:

```bash
yarn exec endo run --UNCONFINED \
  packages/claude-sandbox/setup.js --powers @agent \
  -E CLAUDE_SANDBOX_IMAGE=localhost/claude-code:latest
```

**Unprivileged daemon** (typical workstation) — route mount/umount through
`sudo`:

```bash
yarn exec endo run --UNCONFINED \
  packages/claude-sandbox/setup.js --powers @agent \
  -E NINEP_SUDO=1 \
  -E CLAUDE_SANDBOX_IMAGE=localhost/claude-code:latest
```

```
# /etc/sudoers.d/endo-9p
youruser ALL=(root) NOPASSWD: /usr/bin/mount, /usr/bin/umount
```

## 4. Store your Anthropic API key as a `ClaudeCredentials` cap

```bash
yarn exec endo inbox            # find the "Create Claude Credentials" form, note its number
yarn exec endo submit <n> \
  name: claude-creds \
  apiKey: sk-ant-...
# -> 'ClaudeCredentials "claude-creds" created.'
```

The key is written to `~/.endo-claude-credentials/claude-creds.key` (mode
`0600`); the formula store only sees that path.

## 5. Create the sandbox session

```bash
yarn exec endo inbox            # find the "Create Claude Sandbox" form, note its number
yarn exec endo submit <n> \
  name: claude-1 \
  filesystem: project-fs \
  rootfs: oci:localhost/claude-code:latest \
  network: private \
  model: claude-sonnet-4-6 \
  credentials: claude-creds \
  initialPrompt:
```

The factory replies with the session id, the host mountpoint, and the resolved
backend.
Under the hood it:

1. `E(fs-mounter).mount(project-fs, <tmp>/claude-sandbox-claude-1-<id>)` — stands
   up the 9P bridge and runs `mount -t 9p`,
2. `E(@host).provideMount(<mountpoint>, claude-claude-1-<id>-workspace)`,
3. `E(sandbox-factory).make({ rootfs, mounts:[{cap → /workspace, mode:'rw'}],
   network, env:{ ANTHROPIC_API_KEY }, cwd:'/workspace', backend:'podman' })`,
4. stores a `ClaudeClient` under `claude-1`.

## 6. Talk to Claude

`send()` returns a reader of stream-json events; drive it with `makeRefIterator`:

```bash
yarn exec endo eval --UNCONFINED \
  '(async () => { const r = makeRefIterator(await E(c).send("List the files in the workspace and summarise the README.")); for await (const ev of r) console.log(JSON.stringify(ev)); })()' \
  c:claude-1
```

Each line is one stream-json event (`{"type":"system",…}`,
`{"type":"assistant",…}`, `{"type":"result",…}`).
Subsequent `send()` calls pass `--continue`, so the conversation builds up in
the workspace.

Check status or interrupt a long turn:

```bash
yarn exec endo eval 'E(c).status()' c:claude-1
yarn exec endo eval 'E(c).interrupt()' c:claude-1   # kills the in-flight claude; slice survives
```

## 7. Tear down

```bash
yarn exec endo eval 'E(c).terminate()' c:claude-1   # dispose slice + unmount workspace
# or release everything the mounter created:
yarn exec endo cancel fs-mounter
```

## Troubleshooting

- **`claude: not found` inside the slice** — your image lacks the CLI; rebuild
  per "Build a Claude image" and pass that ref as `rootfs`.
- **`mount: only root can use "--types" option` / `EPERM`** — the daemon is
  unprivileged and `NINEP_SUDO` was not set (step 3), or the sudoers entry is
  missing.
- **Workspace files owned by `nobody`** — rootless podman's uid mapping over the
  9P-synthesized uid/gid 1000; usually harmless for Claude's edits.
  Try `cache=loose` via the mount caplet's `extraMountOptions`.
- **`podman` pull/permission errors** — verify rootless podman works standalone
  (`podman run --rm localhost/claude-code:latest claude --version`) before
  blaming the slice.
- **Session vanished after `endo restart`** — expected; `ClaudeClient` holds a
  live slice and does not reincarnate (see [`README.md`](./README.md) §
  "Lifecycle").
  Re-create with step 5.
```
