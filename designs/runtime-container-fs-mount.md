# Runtime container filesystem mount

| | |
|---|---|
| **Created** | 2026-08-10 |
| **Updated** | 2026-09-08 |
| **Author** | kumavis (prompted) |
| **Status** | **Complete** |

## Status

Built and wired end to end for the runtime `llm` has: a Floot session on the
attested hosted backend attaches a capability it holds under `/mnt/`, the
sandbox is recreated with the bind declared and kernel-proved, and the bind
survives a daemon restart.
The ClaudeClient (CLI-runtime) path is built and tested but has no session
runtime on `llm` to be wired into — see *Hosted wiring* below.

Built:

- `packages/floot/src/container-mounts.js` — the host attach registrar:
  `normalizeInnerPath` (the `/mnt/` validator), ref-counted attach records
  keyed by cap identity (daemon formula id) with the session-id sets,
  persistence in the factory petstore (`floot-container-mounts`), replay on
  arm, and the three session tools.
- `packages/claude-sandbox/src/container-mount-bridge.js` —
  `provideContainerMountBridge` / `releaseContainerMountBridge`: resolves
  the cap by formula id (`lookupById`), projects it as a `Filesystem`
  (`EndoGit` → `worktree()`; `Mount` → `mountAsFilesystem`; `Filesystem`
  as-is), 9P-mounts it at a host-picked mountpoint, and registers the
  daemon `Mount` cap the slice binds. Idempotent per deterministic key, so
  post-restart replay re-lands on the same host layout. Ships both as a
  standalone caplet (`make`, for `endo make-unconfined`) and as a
  composition seam (`makeContainerMountBridge`) a session provisioner can
  mix into its own exo.
- `packages/claude-sandbox/src/claude-client.js` /
  `claude-client-module.js` — `ClaudeClient.setExtraMounts(extras)`
  records the runtime bind set; a live slice is disposed and immediately
  re-minted with `mounts = workspace + extras` (the in-flight turn aborts
  with a recreate-labelled reason), while an unprovisioned client binds the
  set on its next lazy provision. Neither a recreate nor `terminate()`
  touches an extra's 9P handle: the registrar owns every bridge, because
  releasing one also means dropping its daemon `Mount` pet name and the
  provider's cache entry for it (see *Who releases a bridge* below).
  The bridge also reports the host **mountpoint** it served the cap at, for
  a runtime that binds by declaration rather than by cap.
- `packages/sandbox/src/policy.js`, `observe.js`, `drivers/podman.js` — a
  `kind: 'attach'` mount in `SlicePolicyRequest.mounts`: validated (the
  destination under `/mnt/`, the host source the bridge chose), bound like
  any other mount, and **attested** by reading the container's own mount
  table (`/proc/<pid>/mountinfo`) and requiring a `9p` filesystem at the
  destination — the kernel's proof that the bind is a projection served
  through a capability, not a host directory.
- `packages/codex-sandbox/src/sandbox-policy.js`, `backend-factory.js` — a
  hosted session spec may carry
  `containerMounts: [{ key, source, destination, mode }]`; each becomes an
  `attach-<key>` row of the slice table, `assertHostedAgentPolicyV1`
  expects `5 + n` rows and verifies every attach against the attestation,
  and `createSession` audits them.
- `packages/floot/agent.js` — the session wiring: a per-session kit built
  before the hosted tool catalog is pinned, so the thread's `toolSetId`
  covers the three tools, and `makeHostedMountClient`, the registrar's view
  of a hosted backend session, whose bind set is the `containerMounts` its
  next `create` declares (see *Hosted wiring* below).
  The full-control and machine-admin presets teach the tools.
- Tests: `packages/floot/test/container-mounts.test.js` (the registrar
  against fakes), `packages/claude-sandbox/test/container-mount-bridge.test.js`
  (the 9P bridge), recreate coverage in
  `packages/claude-sandbox/test/claude-client.test.js` and
  `claude-client-module.test.js`,
  `packages/floot/test/container-mounts-sandbox.test.js` — the three real
  pieces wired together with only the daemon host agent, the 9P mounter and
  the sandbox factory faked: a held cap becomes a `/mnt/` bind in the
  slice's mount list, survives a restart of every worker-local map, honours
  `ro` at all three layers, is released by the registrar on last detach, and
  outlives a `terminate()` that has no business releasing it —
  `packages/floot/test/container-mounts-hosted.test.js` — the factory's
  hosted path against a fake backend: an attach recreates with the
  declaration once the tool call has settled, a bind declared during a
  recreate is applied by one more while a turn sent meanwhile waits, a
  restart replays into the first create, a refused recreate sheds the bind,
  and deletion releases the bridges after the backend is gone — and the
  attach cases of `packages/sandbox/test/{observe,policy,podman-policy}.test.js`
  and `packages/codex-sandbox/test/{backend-factory,sandbox-policy}.test.js`.

### Hosted wiring

`llm` has no Claude CLI runtime for a Floot session to run in (`getAgent`
refuses legacy CLI sessions outright), so the session wiring lands on the
hosted backend, whose slice table is **attested**: a bind the policy did not
declare would (correctly) fail verification.
Rather than smuggle an undeclared sixth mount, an attach is a declared,
verified part of the policy.

- **Declaration.** The registrar's bind set for a hosted session becomes
  `containerMounts` on the backend session spec — `{ key, source,
  destination, mode }`, where `source` is the host mountpoint the bridge
  reports (host layout the bridge chose, never guest input) and `key` is the
  registrar's content-hash key. The hosted policy expects `5 + n` rows, the
  attach rows named `attach:<key>`.
- **Proof.** The sandbox attests each attach by reading the container's
  mount table and requiring a `9p` filesystem at the destination. A host
  directory bound at `/mnt/…` does not pass; only a projection served by the
  9P mounter — through the cap — does. This is the attested form of "the cap
  is the policy".
- **Recreate, deferred.** The attested runtime cannot change a live slice's
  mount table (the table is what it attests), so a changed set terminates
  the backend session and creates it again with the new declaration; the
  workspace, the state volume and the thread survive, the turn in flight
  does not. A backend refuses to stop under an unsettled Endo tool call, and
  the attach that asks for the recreate *is* one until its result is back,
  so `setExtraMounts` records the declaration and schedules the recreate on
  a per-session chain that retries `terminate` until the call settles
  (bounded at 10 s). The recreate is idempotent — a declaration that changes
  while a create is in flight is applied by the next chain entry, and one
  the live session already declares costs no restart — and a turn sent
  meanwhile waits for the successor rather than failing.
- **Restart.** The registrar replays its journal into the adapter when the
  kit is armed, *before* the first create, which therefore already declares
  the persisted binds: a restart costs no recreate.
- **Refusal.** A recreate the sandbox rejects (its attestation would not
  prove an attach) sheds this session's binds — records and bridges — so no
  record claims a bind the container lacks, recreates without them, and
  reports why on the session's next turn.
- **Teardown.** `deleteSession` waits for a recreate in flight and closes
  the adapter so none is scheduled after, terminates the backend, and only
  then calls `containerMountRegistrar.releaseSession(id)` — no container
  still binds a mountpoint being unmounted.
- `getBridgeProvider` resolves the deployment's named bridge provider
  (`FLOOT_CONTAINER_MOUNT_BRIDGE`, default `container-mount-bridge`) and
  checks for `provideContainerMountBridge` by introspection; a deployment
  without one leaves attach unavailable, with a clear error.

The ClaudeClient path (`setExtraMounts` + slice recreate) stays built and
tested for a CLI runtime.
When the *claude-cli runtime + MCP bridge* cluster of #994 lands, its wiring
is the same kit armed with a ClaudeClient instead of the hosted adapter, plus
`identifyClient` for a shareable client key.

Deviations from the sketch:

- The 9P bridge is its own module rather than two methods on
  `ClaudeSessionProvisioner`, which does not exist on `llm`. Nothing about
  bridging a cap is session-provisioning, so the split stands on its own;
  the provisioner can compose `makeContainerMountBridge` when it lands.
- The session-guest API landed as the session **tools**
  (`attachContainerMount` / `detachContainerMount` / `listContainerMounts`)
  rather than methods on a daemon guest facet — tools are floot's existing
  session-guest surface, reachable from both runtimes.
- The `cap` (direct passable) attach variant is deferred: tools speak JSON,
  so v1 resolves by pet name only; possession is proven by resolving the
  name through the session guest's own petstore (`identify`).
- Bridges are per attach record (`clientKey`, `capId`, `innerPath`), not
  per `capId`; attaching one cap at two inner paths mints two bridges.
  The per-cap reuse remains an optimization for later.
- Every attach bridges over 9P — the daemon-mount fast path via
  `provideHostPath` was deliberately not taken, because a raw host-path
  bind would bypass the cap's own attenuations (read-only views, denied
  segments); serving through the cap is what makes "the cap is the policy"
  true.
- Attach requires a bridge provider (it holds the `fs-mounter` and
  root-host authority); deployments without one get a clear
  attach-unavailable error rather than a degraded bridge.
- The shared-client ref counting (Goal 5) is implemented and tested at the
  registrar (records keyed by client cap identity, session-id reference
  sets, last-reference teardown), but nothing in floot yet hands two live
  sessions the same `clientKey`: a hosted session's client key is its own
  session id. The machinery is the forward-looking safety story for when
  sharing is wired, not a behavior reachable today.

### Known gaps

Found by adversarial review and deliberately left standing; each is a
consequence of the design as written, not an oversight in the code.

- **One registrar lock spans every session.** Attach, detach, `releaseSession`
  and the arm-time replay serialize on a single chain, and inside it a push
  awaits `setExtraMounts` — a full container recreate. A session whose
  recreate stalls therefore delays every other session's first turn, and a
  `setExtraMounts` that never settles (a CapTP promise to a lost worker) wedges
  the registrar for the rest of the boot. The lock is what stops a sibling
  attach from slipping a conflicting record into the window between validating
  against the record set and appending to it, so narrowing it means splitting
  the record mutation from the slow push rather than simply scoping the lock
  per client. The bridge provider, which has no shared record set, already
  locks per key.
- **`releaseSession` assumes its caller has already removed the client.** For
  a deleted session's own client it drops the records and releases the bridges
  without pushing a shrunken bind set, because the client is being torn down
  anyway; `detach` does the opposite (push first, release second). If a future
  caller releases a session whose client stays alive, the container keeps the
  bind until its slice is next disposed. The wiring sketch above puts
  `releaseSession` after the client removal for exactly this reason.
- **No timeout on the recreate teardown.** Every step of it — dispose, unmount,
  revoke — is wrapped so a *rejection* cannot wedge the gate, but a call that
  never settles (an unresponsive slice worker, an unreachable 9P mounter)
  leaves `pendingTeardown` unresolved, and every later turn chains behind it.
  `terminate()` has always had the same shape; attach makes it reachable from a
  hotter path.
- **The bridge trusts its caller to derive keys.** `assertBridgeKey` rejects
  anything that could escape the mountpoint base, but the mount pet name it
  builds (`claude-attach-<key>`) shares a namespace with the workspace name
  (`claude-<sessionId>-workspace`). The registrar's keys are content hashes, so
  it cannot collide; another caller passing literal keys could.
- **The overlap check sees only other attaches.** `/mnt/` is assumed disjoint
  from the slice's own binds, which holds while `WORKSPACE_PATH` is
  `/workspace`. A deployment that set it under `/mnt/` could let a guest attach
  over the workspace; the registrar has no way to ask the client what it
  already binds. The hosted policy validates the same structural rule at
  its own boundary, so an overlap there fails the create rather than the
  attestation.
- **The three tools rotate every existing hosted thread once.** The hosted
  tool catalog is pinned per thread by `toolSetId`, and the Codex client
  starts a new thread when it changes. Adding the three tools changes it for
  every hosted session that predates this change, so each resumes on a
  fresh thread the first time it runs after the upgrade — a one-time cost
  of the tool set being part of the thread's identity, which is the
  property that stops a thread from silently resuming with different powers.
- **The settle budget is a wait, not a guarantee.** A hosted backend that
  keeps refusing to stop for the whole budget (a tool call that never
  settles) fails that recreate. The next turn retries it with the current
  declaration and carries the failure if it repeats; until then the records
  claim a bind the container does not yet have, and `listContainerMounts`
  says so as if it did.
- **The kernel proves the projection, not which projection.** Attestation
  requires fstype `9p` and `root === '/'` at the destination, so a host
  directory and a bind of a subtree both fail. *Which* 9P tree is bound
  still rests on the runtime's inspect `Source`, which
  `packages/sandbox/src/observe.js` otherwise declines to trust. Closing it
  means tying the mount's `deviceId` — the superblock's `major:minor`,
  which `parseMountInfo` now keeps — to that of the host mount at the
  attach's `source`, read from the daemon's own `/proc/self/mountinfo`.
  That is a deployment-topology decision (it assumes the 9P mounter shares
  the daemon's mount namespace) and would fail every attach where it does
  not hold, so it is deliberately left for its own change rather than
  slipped into a hardening pass.
- **The attach source is confined by the 9P proof alone.** The hosted layer
  accepts any absolute normal path as an attach `source`; nothing requires
  it to lie under an operator-minted bridge root, so a source naming a
  bridge's *parent* is refused only because that parent is not itself a 9P
  mount. An operator-supplied root in `powers`, checked as a prefix, would
  make the confinement structural instead of incidental.
- **The mount table is a spot check, not a census.** It is read only when
  the policy declares an attach, and only the declared destinations are
  kept, so a bind present in the anchor's namespace but absent from the
  runtime's inspect record is still invisible to attestation. That
  predates attaches — the undeclared-mount scan has always walked the
  runtime's record — and generalizing it (always read the table, require
  every mount point to be declared or explicitly allowed) would harden
  `hostHome` and `hostSockets` as well as attaches.

## Summary

A Floot session drives an agent inside an `@endo/sandbox` slice — a
`ClaudeClient` running Claude Code on the CLI runtime, or a hosted backend
session on the attested runtime.
The slice binds a fixed set of host capabilities at first provision — the
workspace, plus whatever the runtime adds (a config dir, an MCP socket dir,
the hosted runtime's attested state volumes).
Sessions often **acquire filesystem authority at runtime** (MCP tools, adopted
`workspace`, future code mode) and need that same tree visible inside the
Linux environment so shell tools — especially **`git`** — can read, modify, and
commit on the bytes the cap already grants.

This design adds **runtime attach**: the **session guest** registers a cap it
already holds, chooses a **container path under `/mnt/`**, and the host bridges
the cap over 9P and **immediately recreates** the sandbox slice with an
expanded bind list.
Authority is **only** the cap; the host does not re-decide file access with a
parallel host-path ACL.

## What is the problem?

1. **Fixed mounts at slice birth.**
   `claude-client-module.js` lazily mounts the provisioned workspace once,
   then calls `sandboxFactory.make({ mounts })`.
   `@endo/sandbox` Phase 1 resolves binds at slice **creation**; dynamic bind
   into a live slice is not implemented.

2. **Runtime caps stay outside the container.**
   Endo-side `grep`, `glob`, and MCP `exec` can use a mount the guest holds,
   but Claude's in-container file tools and arbitrary shell commands cannot
   see that tree unless it was bound at provision time.

3. **Git iteration is a primary use case.**
   A session should check out an `EndoGit` worktree (or equivalent), run
   `git status`, edit files, and **`git commit -m "..."`** inside the slice
   on the same physical tree the daemon cap represents.

4. **Persistence across daemon restart.**
   Like the workspace mount the client re-establishes on reincarnation,
   attach intent must replay so the client formula rebuilds the same
   container view.

## Goals

1. Session guest API to **attach** and **detach** caps for container use.
2. Guest-chosen **inner paths under `/mnt/`** (container namespace only).
3. **Read-write** binds by default so Linux tools can modify the cap's tree.
4. **Immediate** slice recreate when the attach set changes.
5. **Shared `ClaudeClient`** across Floot sessions when cap identity and ref
   counting make that safe.
6. Correct **unmount cleanup** when the last reference to an attach goes away.

## Non-goals

- Guest control of **host** bind sources (9P socket directories stay
  host-allocated under the session mount base).
- Replacing Endo-side git exo methods; native **`git` in the slice** is the
  target for commits.
- Phase 2 **live bind** into a running slice without recreate (may follow; this
  design assumes recreate).
- Exposing `lookup` on confined `ClaudeSessionPowers`.

## Security model (cap-first)

**The cap is the policy** for which files may be read or written.
Attach does not second-guess that with a host-path allowlist.

The host enforces only:

1. **Possession** — the session guest must already hold the cap (via petname
   lookup on the guest, or an equivalent passable the guest could have
   obtained).
2. **Bridge compatibility** — the object is a filesystem the `@endo/9p-server`
   mounter can serve (daemon-minted `Filesystem`, `EndoMount` /
   `mountAsFilesystem`, or a resolved git **worktree** mount for `EndoGit`).
3. **Container slot safety** — `innerPath` is validated as structure under
   `/mnt/` (normalization, no `..`, no collision with reserved paths such as
   `/workspace` and `/claude-config`).
4. **Host layout** — the host picks the 9P **host mount point** directory; the
   guest never supplies it. Bridge keys are content hashes over (client
   identity, cap identity, inner path), constrained to a filename-safe
   alphabet, so nothing a guest writes reaches a host path.

Inherited exposure worth stating plainly: the attach mountpoint base defaults
to `CLAUDE_SANDBOX_MOUNT_DIR` or `os.tmpdir()`, the same default the workspace
mount already uses.
On a shared host that makes an attached tree readable by any local user who
can traverse the mountpoint — a property of this package's existing default
rather than something attach introduces, but one a multi-user deployment
should override.
The 9P **socket**, which carries the cap's full authority, is separate and
already lands under `XDG_RUNTIME_DIR` (see `@endo/9p-server`).

Anti-escape concerns are about **smuggled or fake caps** and **guest-chosen
host paths**, not about rejecting `provideHostPath` output against an ACL.
See [endo-agent-tools](endo-agent-tools.md) for persisting mount petnames and
plain paths across turns — attach persistence uses the same cap-identity story.

## Decisions

| Topic | Decision |
|-------|----------|
| Who calls attach? | **Session guest** (Floot session host facet), not the confined container client. |
| Inner path | **Guest-specified**, must lie under **`/mnt/`** (or a documented prefix). |
| Mode | **Read-write** (`rw`) for attached extras; primary use case is modify via Linux tools. |
| Git | **First-class** — attach must support `EndoGit` worktree (or repo → worktree resolution) so in-container `git commit` works on the cap's tree. |
| Shared client | **Allowed** — identity is the **cap** (`storeIdentifier` / formula id), not Floot session id. |
| When to apply | **Immediate** — dispose and recreate slice as soon as attach succeeds. |

## Architecture

```text
Session guest --attachContainerMount--> Host attach registrar
       |                                      |
       |                              validate innerPath (/mnt/)
       |                              resolve cap (petname / EndoGit worktree)
       |                              fsMounter.mount + provideMount
       |                              persist attach record (cap id + innerPath)
       v                                      v
  MCP / code mode                     Claude client (lazy provision)
                                            |
                                            v
                              sandboxFactory.make({ mounts: [..., extras] })
```

### Session guest API (sketch)

Methods on the Floot **session guest** (exact facet name TBD in implementation):

- **`attachContainerMount(options)`**
  - `petName` — resolve cap from the guest pet store, or
  - `cap` — only when it is a passable the guest already holds.
  - `innerPath` — absolute path under `/mnt/…`.
  - `mode` — optional; default **`rw`**.
  - For **`EndoGit`**: if the held cap is the repo object, the registrar may
    resolve **`worktree()`** internally for 9P so guests need not repeat that
    step.
- **`detachContainerMount({ innerPath })`** — drop this guest's reference to
  that slot.
- **`listContainerMounts()`** — current attach set visible to this guest /
  client.

The **confined** `ClaudeSessionPowers` exo does not gain `lookup` or unbounded
`provideMount`; the host registrar performs 9P and `agent.provideMount` after
validation.

### Inner path rules

- Normalize POSIX paths; require prefix `/mnt/` (exact rules in implementation).
- Reject `..`, empty segments, and paths that normalize outside `/mnt/`.
- Do not allow overwriting reserved slice paths (`/workspace`, config inner dir,
  MCP inner dir).
- **Idempotent attach** to the same `(capId, innerPath)` is preferred over hard
  error on retry.

### Attach registry and shared client

Attach records are keyed by **cap identity**, not only Floot session id:

```js
// Illustrative persisted shape (hardened at runtime)
harden({
  capId: '<storeIdentifier>',
  innerPath: '/mnt/project',
  mode: 'rw',
});
```

**Reference counting:** each guest attach increments a ref (or records the set
of session ids) for `(capId, innerPath)` on the **shared `ClaudeClient`**.
**Detach** decrements; when no guest still references that pair, tear down 9P,
call `removeMount` for the session mount pet name, and drop the bind on the
next slice.

**`ClaudeClient.terminate()`** disposes the slice and unmounts the mounts it
owns — the workspace, and the config dir when the CLI runtime adds one. It
does **not** unmount the runtime-attached extras; see below.

### Who releases a bridge

The registrar mints every bridge and is the only thing that releases one,
including when the client it was bound into terminates.

The sketch originally had `terminate()` unmount each extra's 9P handle, on the
reasoning that terminate destroys the whole CLI environment rather than one
session's view of it. That is wrong in a way adversarial review made concrete.
A bridge is three things — a kernel 9P mount, a daemon `Mount` pet name, and
the provider's cache entry — and only the provider can drop all three
together. Unmounting the handle from the client tears down the first while the
other two still point at it. Because bridge keys are **deterministic**, the
next request for that same `(key, capId, mode)` — a restart replay, a retry, a
second session attaching the same cap at the same path — hits the provider's
cache and is handed the stale `Mount` cap. The slice binds it without error,
and `git` inside the container runs against an empty directory. Silently, on
the design's primary use case.

So the client only ever binds. The cost is that a client terminated without a
corresponding `detach` or `releaseSession` leaves its bridges up until the
registrar drops the records — a bounded, visible leak (the mounts are listed
by the mounter, the names are in the petstore, and the records are in the
journal) rather than a silent wrong answer.

### Immediate slice recreate (MVP)

`@endo/sandbox` today declares mounts at slice construction; `mountInSlice` is
Phase 1 tracking only.
When attach succeeds:

1. Ensure 9P + Mount cap exist for the cap (reuse if already bridged for this
   `capId`).
2. Update persisted attach list on the client formula (or attached registry the
   client reads on provision).
3. **Immediately** dispose the current slice and call `make()` with
   `mounts = workspace + config + mcp + all registered extras`.
4. Abort or fail fast any **in-flight turn** with a clear reason (attach is
   disruptive by design).

Future work may add **live bind** without full recreate; the guest API should
not assume mounts are immutable forever, but v1 is recreate-only.

### Persistence / daemon restart

On client reincarnation:

1. Load persisted attach records (`capId`, `innerPath`, `mode`).
2. Resolve caps by formula / pet store identity.
3. Replay 9P + mount registration when the session's kit is armed, before the
   first post-restart turn: an unprovisioned client simply binds the replayed
   set on its next lazy provision, so a restart costs no recreate.

Floot session registry may **mirror** attach metadata for UI; the **source of
truth** for container binds is the attach set tied to the **`ClaudeClient`**
that owns the slice.

## Current code touchpoints

| Area | Role |
|------|------|
| `packages/claude-sandbox/src/container-mount-bridge.js` | 9P bridge: cap → `Filesystem` → mountpoint → daemon `Mount` |
| `packages/claude-sandbox/src/claude-client-module.js` | Lazy 9P, `provideMount`, `sandboxFactory.make({ mounts })` |
| `packages/claude-sandbox/src/claude-client.js` | `setExtraMounts`, slice recreate, teardown gate |
| `packages/floot/src/container-mounts.js` | Attach registrar, ref counting, persistence, session tools |
| `packages/floot/agent.js` | Session wiring: per-session kit, hosted adapter (`makeHostedMountClient`), release on delete, preset prose |
| `packages/sandbox/src/policy.js` | `kind: 'attach'` validation, bind argv, and 9P attestation |
| `packages/sandbox/src/observe.js` | The container's mount table, read for attestation |
| `packages/codex-sandbox/src/sandbox-policy.js` | `attach-<key>` rows; `5 + n` hosted policy expectation |
| `packages/codex-sandbox/src/backend-factory.js` | `containerMounts` on the session spec; attach audit |
| `packages/9p-server/mount-caplet.js` | `mount(fs, mountPoint, { lazyUnmount, readOnly })` |
| `packages/sandbox/src/factory.js` | Mount resolution at slice create; Phase 1 dynamic mount note |
| `designs/endo-agent-tools.md` | Cap-only persistence across turns |

## Implementation phases

1. **Design** — this document. ✅
2. **Guest API + validator** — `/mnt/` normalization, cap possession, git
   worktree resolution, `capId` extraction. ✅ (session tools + registrar in
   `packages/floot/src/container-mounts.js`)
3. **Registry + ref counting** — shared client safe detach. ✅ (registrar
   behavior; see Status — production wiring does not yet share a client)
4. **Client recreate path** — immediate dispose/`make` on attach/detach. ✅
   (`ClaudeClient.setExtraMounts`)
5. **Persistence replay** — attach records in the factory petstore, replayed
   on arm before the first post-restart turn. ✅
6. **Tests** — two guests, one client, same cap; last detach unmounts;
   terminate clears all; restart replay. ✅ (an end-to-end in-container
   `git commit` against a live daemon remains a live-daemon follow-up,
   alongside the existing `test:live` suite)
7. **Session wiring** — a per-session kit in floot's session path, so a
   live session reaches the three tools. ✅ (the hosted path; the CLI-runtime
   branch follows the *claude-cli runtime + MCP bridge* cluster of #994)
8. **Attested declaration** — an attach as a declared, kernel-proved `9p`
   row of the hosted slice policy, and the deferred recreate that applies a
   changed declaration. ✅ (see *Hosted wiring* under Status)

## Related

- [endo-agent-tools](endo-agent-tools.md) — persisting mount petnames + paths.
- [daemon-mount-capabilities](daemon-mount-capabilities.md) — `EndoMount` /
  `provideHostPath` host bridge.
- [floot-daemon-owned-turns](floot-daemon-owned-turns.md) — in-flight turn
  behavior when slice recreate aborts a turn.
