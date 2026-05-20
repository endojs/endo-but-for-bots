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
./scripts/create-factory.sh
```

That registers `claude-container-factory` on `@host` and surfaces a
"Create Claude Container" form in the host's inbox.
Each form submission spins up a microVM, projects the named filesystem
capability into `/workspace`, starts Claude Code inside, and stores a
`ClaudeClient` exo back in `@host`'s petstore under the name you
chose.

```js
const claude = await E(host).lookup('claude-1');
const reader = await E(claude).send('Tell me a story.');
for await (const event of makeRefIterator(reader)) {
  console.log(event);
}
```

## Layout

```
DESIGN.md                          # microVM sandbox design
ENDO-INTEGRATION.md                # endo capability surface + roadmap
scripts/
  create-factory.sh                # one-shot factory provisioner
setup.js                           # ran by create-factory.sh
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
flow: `create-factory.sh`-equivalent provisioning → form submission
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
