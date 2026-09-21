# Claude hosted backend architecture

This document describes the current native-controller path.
The older inbox-form factory, peer credential sidecar, and client-formula topology
are removed; their implementation history remains in Git.
See [legacy-retirement.md](./docs/legacy-retirement.md) before deploying that removal.
Source changes and passing tests do not establish runtime retirement or Tokyo acceptance.

## Phase 3 — daemon-owned sessions

The Floot factory owns logical sessions and durable conversation records.
`claude-backend-factory.js` implements the shared hosted backend contract.
`claude-backend-module.js` records a passive session plan and exact service dependencies
under the daemon's session owner.
The owner starts `claude-native-controller.js`, which uses the shared
`session-supervisor.js` for acquisition, fencing, and cleanup.

| Component | Responsibility |
| --- | --- |
| Floot | Conversation, user submissions, Endo tools, durable turn/effect evidence |
| Backend factory/module | Validate requests, record/revise plans, connect run/admin facets to the owner |
| Daemon session owner | Persist lifecycle intent and retain exact native-controller/service identities |
| Native controller | Acquire native resources for one approved plan and return the protocol client |
| Shared supervisor | Stop admission, track owned resources, retry incomplete cleanup |
| Claude client | Spawn CLI turns, parse stream-json, interrupt, restore CLI conversation records |
| Provider broker | Credential ownership, upstream policy, subscription selection/renewal, quota observations |
| Session storage/state provider | Own and remove session directories without adopting CLI files as transcript authority |

## Acquisition and authority

The controller receives null construction powers and no ambient host lookup.
Activation supplies the approved plan and a resolver for its recorded dependencies.
It acquires a session sandbox scope and provider scope, starts the broker grant, and
checks its image and network evidence against the plan.
It prepares the current Claude config directory, mounts the workspace using the session's
own host-side 9P projection, and starts the pinned Endo MCP bridge.
Finally it asks the sandbox scope for a slice and verifies that slice's attestation.

The slice runs `network: 'broker-only'` in the attested provider namespace.
Its mount table declares `/workspace`, `/claude-config`, `/endo-mcp`, bounded `/tmp`
and `/run`, plus a generated read-only resolver file for public-internet policy.
The shared `HOSTED_SLICE_RESOURCES` policy fixes resource ceilings.
There is no independent recorded `nativeProfile` knob.

An arbitrary requested `containerMounts` list is refused by the current backend.
The legacy client's successful dynamic `/mnt` bind path is not silently emulated.
Generic bridge/registrar code remains for consumers that support it, but enabling this
backend needs recorded mount authorization and matching attestation first.

## Credentials and networking

Current setup uses Secrets-backed managed credentials and host-side provider brokers.
The CLI receives only a placeholder under its selected authorization variable, together
with the listener endpoint.
The listener strips client authorization and injects the real upstream credential.
Renewal ownership and subscription pooling remain outside the model container.

`off` admits only the provider path.
`public-internet` additionally supplies the broker's attested proxy and resolver, only
when enabled by deployment configuration.
Neither setting grants host networking or access to the host's Secrets store.
The approved source/image and recorded provider configuration remain the authority;
an existing binding is not implicitly upgraded by changing an environment variable.

## Turns and restoration

One client serializes Claude CLI invocations.
Protocol cancellation is distinct from a browser losing its view: Floot owns the turn,
while browser observers may detach independently.
The Claude event adapter emits text, tool observations, usage and terminal
outcomes; Floot also journals Endo execution intent and results independently.

Floot restores full canonical transcript records on a new incarnation.
`claude-transcript-writer.js` translates them into the CLI's native JSONL.
A persistent config directory is used by the controller, but surviving guest-written
files are not permission to replace Floot's record.
Within an incarnation the CLI continues its delivered conversation.
The backend therefore retains `continuity: 'transcript'` so Floot mirrors partial delivered
turns after cancellation or failure.

## Stop, restart, and removal

Stop fences new work before releasing resources.
The client disposes its slice; the controller/supervisor releases sandbox scope, broker
grant, MCP bridge, and workspace mounter with their original owners.
A failed cleanup remains retryable and is not reported as stopped.
Reconstruction uses recorded identities and refuses to invent missing local ownership.
A logical-session removal also invokes its recorded storage owner; a normal stop preserves
workspace and transcript for a later incarnation.

Keep current Claude state-provider modules: unlike the old OpenCode unused allocation,
the native controller uses the returned directory as its config bind.
Keep generic sandbox and 9P functionality even when an old hosted caller disappears.

## Verification

Current native-controller tests cover approved acquisition, attestation, read-only MCP,
credential placeholders, network policy, cancellation during acquisition, context loss,
failed cleanup retry, and reconstruction.
Shared supervisor tests cover the common ownership state machine.
Protocol, transcript-writer, package integration, and 9P tests remain.
The [retirement coverage map](./docs/legacy-retirement.md) identifies which old tests moved
to daemon fixtures, which behaviors remain independently covered, and which APIs retired.
A Podman/9P-gated test skipped on an unsupported machine is not live acceptance.
