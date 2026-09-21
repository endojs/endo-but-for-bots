# @endo/claude-sandbox

Run Claude Code in a rootless Podman slice under the daemon's session owner.
Floot supplies the conversation and Endo tool catalog; the native controller acquires
the workspace projection, sandbox scope, provider grant, CLI config directory, and MCP bridge.

This is experimental Linux infrastructure.
Unit tests use injected dependencies; live execution requires Podman, the pinned Claude
image, a host-side 9P mounter, and the configured provider listener image.
See [DEMO.md](./DEMO.md) for operator preparation and [DESIGN.md](./DESIGN.md) for ownership.

## Current entrypoints

- `setup-host.js` provides the dedicated native sandbox service and Claude state provider.
- `setup-hosted.js` provides Secrets-backed credentials, the provider broker, session
  storage owner, and the hosted backend; it binds `claude-backend` into the Floot profile.
- `src/claude-backend-factory.js` exposes the common hosted backend interface.
- `src/claude-native-controller.js` runs one recorded session under the shared supervisor.
- `src/claude-client.js` implements the Claude stream-json protocol over an acquired slice.

The former inbox-form factory, peer credential setup, sidecar credential factory, and
client-formula entrypoints have been removed.
This package has no form-driven replacement API; select the Claude backend through Floot.
[Legacy retirement](./docs/legacy-retirement.md) lists the deployment gate and coverage mapping.

## Hosted session interface

| Operation | Behavior |
| --- | --- |
| `describe()` | Backend identity, continuity, tool ownership, and supported network policies |
| `modelCatalog(subscriptionId?)` | What each account of the broker lists, read from Anthropic's model list, with the thinking efforts the pinned runtime drives each model at |
| `create(spec, toolSet)` | Record or reopen a session and return its run/admin facets |
| `run.send(prompt, options)` | Stream provider-neutral events while retaining full transcript restoration options |
| `run.interrupt()` | Stop the in-flight CLI turn; tolerate an idle session |
| `admin.terminate()` | Stop native work through its owner, preserving the logical session |
| `destroy(spec)` | Stop and remove the session through the owner |

A new session's model is admitted by the catalog of an account the session may be served from, with an effort that model takes; a reopen keeps its recorded pin without asking the provider, and an effort changed on its own keeps the recorded model. A session that names no model runs the runtime's own default, unpinned; nobody picks one from the list for it.
The system prompt is pinned for the session and forwarded on every CLI spawn.
Network defaults to `off`; `public-internet` is offered only if the broker's recorded
configuration supports it.
This means the managed public proxy and resolver, not unrestricted host networking.

Arbitrary `containerMounts` are currently refused.
The legacy client's ability to add `/mnt` binds is not implemented by the current hosted
backend; removing its tests does not claim otherwise.
The generic Floot registrar and filesystem bridge remain available for backends that
actually support and attest these mounts.

## Conversation and storage

Floot owns durable conversation records, including known tool effects and failed turns.
On revival the client restores the CLI's JSONL from those records using
`claude-transcript-writer.js`; it does not adopt an arbitrary surviving CLI transcript.
Within an incarnation Claude continues its native conversation.
The backend's `transcript` continuity declaration tells Floot to mirror delivered partial
turns, so cancellation does not silently erase what the CLI already received.

The workspace is projected through a host-side 9P mount at `/workspace`.
Claude's state provider supplies a session config directory at `/claude-config`;
unlike the removed OpenCode allocation, this directory is used by the current controller.
The CLI config directory is not the authoritative conversation.
Temporary storage is bounded tmpfs, and the shared hosted resource policy is fixed in
`@endo/hosted-agent`, not configured through a backend-specific native profile.

## Credentials and tools

Long-lived provider credentials remain in Secrets and in the host-side broker's custody.
A session receives a broker grant and a loopback provider endpoint.
The slice contains only a credential placeholder; the listener strips it and supplies
the real upstream authorization.
Subscription pooling and renewal are broker concerns, not CLI filesystem state.

Floot's pinned Endo tools reach Claude through the shared MCP bridge.
The per-session socket directory is mounted read-only at `/endo-mcp`;
the in-slice stdio relay carries JSON requests to the host-side bridge.
Claude's own shell and file tools execute inside the slice.

## Tests

Run `yarn workspace @endo/claude-sandbox test` for package tests.
The Podman-gated `test:integration` and Linux 9P-gated `test:ninep` suites remain.
A skipped platform test is not deployment acceptance.
Native-controller and shared-supervisor tests cover acquisition, cancellation, resource
confinement, failed-cleanup retry, and reconstruction.
Generic dependency identity/GC and remote-capability adoption tests now belong to the
daemon package, not the retired form topology.
