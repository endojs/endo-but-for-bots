# @endo/claude-container

Expose Claude Code microVM sandboxes as Endo capabilities.

This package is the **Endo capability side**: a factory caplet on
`@host`, a form whose `filesystem` field names an Endo FS capability
to project into a new microVM, and a `ClaudeClient` exo that wraps the
`claude -p --output-format stream-json` I/O contract.

The **host process side** — QEMU, networking, bootstrap/agent RPC,
credential broker — lives in `@endo/claude-orch` as a sibling package.

## Documents

- `DESIGN.md` — end-to-end plan for the host orchestrator.
- `ENDO-INTEGRATION.md` — how the sandbox is presented as an Endo
  capability. §9 carries the roadmap. R1 (remote-friendly Filesystem
  capability), R2a (9P-over-virtio-serial relay), R3 (credential
  capability), and R4 (restart-survivable `ClaudeClient`) are
  shipped; R2 (native Rust 9P), R5 (tools-as-capabilities), R6
  (factory permission scoping), and R7 (snapshot/restore) are open.

## Quick start

With the orchestrator (`@endo/claude-orch`) running on the host:

```sh
# Register the container factory on @host
yarn workspace @endo/claude-container factory

# Optional: also register the credentials factory (R3)
yarn workspace @endo/claude-container credentials
```

Both scripts are fae-style setup modules invoked via
`endo run --UNCONFINED ... --powers @agent`; they are idempotent
(re-running with the same name is a no-op) and accept positional args
to override the defaults:

```sh
# yarn workspace @endo/claude-container factory <factoryName> <orchestratorSocket>
yarn workspace @endo/claude-container factory my-claude-factory /tmp/orch.sock

# yarn workspace @endo/claude-container credentials <factoryName>
yarn workspace @endo/claude-container credentials my-creds-factory
```

That registers the factory on `@host` and surfaces the corresponding
form ("Create Claude Container" / "Create Claude Credentials") in the
host's inbox. **You must submit the form first** (e.g. through the
Familiar electron shell, or via the CLI) — only then does the named
exo land in `@host`'s petstore.

### Form fields — "Create Claude Container"

| Field | Required | Accepted values | Notes |
|---|---|---|---|
| `name` | yes | pet-name shape (`[a-z][a-z0-9-]*`) | Resulting `ClaudeClient` is stored under this pet name in `@host`'s petstore. |
| `filesystem` | yes | pet name of an FS in `@host`'s petstore | Must resolve to an `@endo/endo-fs` `Filesystem` capability. The factory replies with an error if the name is missing or not FS-shaped. |
| `network` | no (default `egress`) | `egress` \| `none` | `egress` allows outbound only (nftables-isolated); `none` is air-gapped. |
| `model` | no | Claude model id (e.g. `claude-sonnet-4-5`) | Forwarded to `claude -p --model`. |
| `credentials` | no | pet name of a `ClaudeCredentials` cap | When set, overrides the broker's default key for this session. Submit the "Create Claude Credentials" form (R3) to mint one. |
| `initialPrompt` | no | string | Sent to the agent at session ready. Fire-and-forget; the response stream is drained in the background. |

### A complete first session

```js
import { E } from '@endo/eventual-send';
import { makeRefIterator } from '@endo/daemon/ref-reader.js';

// `host` is the @host capability — your runtime hands it to you via
// the same mechanism it hands you any other top-level cap (Familiar
// passes it in; the CLI exposes it via `endo open ...`).
//
// Prerequisites: you've submitted the "Create Claude Container"
// form on @host with name="claude-1", filesystem=<some pet name>,
// and (optionally) initialPrompt.
const claude = await E(host).lookup('claude-1');

// Send a prompt. The reader yields one parsed JSON event per line
// (claude -p --output-format stream-json):
//   { type: 'system', ... }     — session metadata at start
//   { type: 'assistant', ... }  — model output (one per turn)
//   { type: 'user', ... }       — tool-result echoes
//   { type: 'result', ... }     — final summary; iteration ends
const reader = await E(claude).send('Tell me a story.');
for await (const event of makeRefIterator(reader)) {
  console.log(event.type, event);
}

// Inspect lifecycle state at any point.
const status = await E(claude).status();
// → { sessionId, createdAt, fsSocketPath, attachSocketPath, terminated }

// Tear down — releases the QEMU process, broker subscription, 9P
// bridge, and the per-session UDS files. Idempotent.
await E(claude).terminate();
```

`ClaudeClient` also exposes `interrupt()`, but in v1 it always
throws — the orchestrator does not yet surface a Detach/Attach
interrupt path. See `ENDO-INTEGRATION.md` §9 for the roadmap.

#### Failure modes worth knowing

- Calling `send()` (or any verb except `terminate()`) after
  `terminate()` throws `ClaudeClient(<id>) is terminated.`.
- `send()` requires the session to have been created with
  `attachMode: "stream"` — without an `attachSocketPath` the
  orchestrator throws
  `session "<id>" has no attach stream; use attachMode "stream".`.
- A non-existent `filesystem` pet name causes the factory to reply
  to the form with an error and leave no side effects (no orphan
  session, no orphan petstore entry).

## Layout

```
DESIGN.md                          # microVM sandbox design
ENDO-INTEGRATION.md                # endo capability surface + roadmap
factory.js                         # fae-style setup for ClaudeContainer
credentials.js                     # fae-style setup for ClaudeCredentials
src/
  claude-container-factory.js      # factory caplet (form loop)
  claude-client-module.js          # per-session ClaudeClient caplet
                                   # (loaded by makeUnconfined per session)
  claude-client.js                 # ClaudeClient exo constructor
  fs-bridge-module.js              # per-session 9P bridge caplet
                                   # (delegates to @endo/9p-server)
  claude-credentials-factory.js    # R3 ClaudeCredentials factory caplet
  claude-credentials-module.js     # per-credential exo entry point
  orchestrator-client.js           # HTTP-over-UDS client
test/
  orchestrator-client.test.js      # HTTP-over-UDS + sendPrompt contract
  factory.test.js                  # form-loop + replay guard (mocked deps)
  factory-live.test.js             # full Endo daemon + orchestrator e2e
  claude-credentials-factory.test.js # R3 form-driven credential minting
```

## Status

The Endo-side surface is implemented and validated end-to-end against
a live Endo daemon plus a live `@endo/claude-orch` daemon (with a
mock VM in place of QEMU). `factory-live.test.js` drives the full
flow: `yarn ... factory`-equivalent provisioning → form submission
on `@host` → orchestrator `POST /v1/sessions` → 9P bridge start →
`POST /v1/sessions/:id/ready` (which kicks the mock guest's
bootstrap + agent handshake) → `makeUnconfined` of a per-session
`ClaudeClient` caplet under the chosen pet name → `send(prompt)`
round-tripping a stream-json frame through the stdio mux → `terminate`.

The host stack is separately validated on real KVM end-to-end through
`@endo/claude-orch/scripts/smoke-boot.sh` — Hello → BootConfig → 9P
mount → drop-privs → exec claude-agent → Ready.

9P operations implemented:
- Read path (mount + traverse + read): `Tversion`, `Tattach`, `Twalk`,
  `Tlopen`, `Tread`, `Tclunk`, `Tgetattr`, `Treaddir`, `Tstatfs`,
  `Tflush`.
- Write path (best-effort against the FS capability): `Tlcreate`,
  `Twrite`, `Tmkdir`, `Tunlinkat`, `Trenameat`. Errors map to
  `Rlerror(ENOSYS)` when the FS capability lacks a verb,
  `Rlerror(EACCES)` for permission failures, `Rlerror(EIO)` for
  genuine I/O failures.
- `Tsetattr` returns `Rlerror(EOPNOTSUPP)` rather than a silent no-op.
- Other ops return `Rlerror(ENOSYS)` so the guest VFS surfaces a
  clean errno.

Tests: 16 ava cases across 4 files — all green. Live-daemon tests
in `factory-live.test.js` spin up a real Endo daemon and a real
`@endo/claude-orch` daemon (mock VM) to exercise both the form-driven
provisioning flow and the bridge-formula reincarnation across a full
Endo daemon restart (R4 bridge re-attach).
`claude-credentials-factory.test.js` exercises R3 form-driven
credential minting, the `issue` / `rotate` / `revoke` verbs, and the
factory's replay guard.

See `ENDO-INTEGRATION.md` §9 for the prioritized roadmap.
