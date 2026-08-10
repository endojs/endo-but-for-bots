# Runtime container filesystem mount

| | |
|---|---|
| **Created** | 2026-08-10 |
| **Updated** | 2026-08-10 |
| **Author** | kumavis (prompted) |
| **Status** | **Complete** |

## Status

Implemented on the floot/claude-sandbox pair, same-day with the design:

- `packages/floot/src/container-mounts.js` — the host attach registrar:
  `normalizeInnerPath` (the `/mnt/` validator), ref-counted attach records
  keyed by cap identity (daemon formula id) with the session-id sets,
  persistence in the factory petstore (`floot-container-mounts`), replay on
  arm, and the three session tools.
- `packages/floot/agent.js` — wires a per-session kit into the CLI-runtime
  branch of `getAgent` (the tools reach the CLI's own tool loop through the
  per-session MCP bridge; API-runtime sessions have no sandbox and do not
  get them), arms it with the resolved client after
  provisioning, adds `identifyClient` to the client resolver (cap identity
  for record keying), and releases the session's references on
  `deleteSession`.
- `packages/claude-sandbox/src/claude-session-provisioner.js` —
  `provideContainerMountBridge` / `releaseContainerMountBridge`: resolves
  the cap by formula id (`lookupById`), projects it as a `Filesystem`
  (`EndoGit` → `worktree()`; `Mount` → `mountAsFilesystem`; `Filesystem`
  as-is), 9P-mounts it at a host-picked mountpoint, and registers the
  daemon `Mount` cap the slice binds. Idempotent per deterministic key, so
  post-restart replay re-lands on the same host layout.
- `packages/claude-sandbox/src/claude-client.js` /
  `claude-client-module.js` — `ClaudeClient.setExtraMounts(extras)`
  records the runtime bind set; a live slice is disposed and immediately
  re-minted with `mounts = workspace + config + mcp + extras` (the
  in-flight turn aborts with a recreate-labelled reason), while an
  unprovisioned client binds the set on its next lazy provision.
  `terminate()` additionally unmounts every extra's 9P handle; a mere
  recreate never touches them (the registrar owns them across recreates).
- Tests: `packages/floot/test/container-mounts.test.js`,
  plus bridge and recreate coverage appended to
  `packages/claude-sandbox/test/claude-session-provisioner.test.js` and
  `test/claude-client-module.test.js` — idempotent attach, two sessions on
  one client with last-detach teardown, restart replay, terminate clears
  all.

Deviations from the sketch:

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
- Attach requires the hosted provisioner (it holds the `fs-mounter` and
  root-host authority); deployments without it get a clear
  attach-unavailable error rather than a degraded bridge.
- The shared-client ref counting (Goal 5) is implemented and tested at the
  registrar (records keyed by client cap identity, session-id reference
  sets, last-reference teardown), but floot's client resolver still grants
  the shared base client to ONE session exclusively (`sharedClaimedBy`) and
  the hosted provisioner mints per-session clients, so no production wiring
  currently lets two live sessions share a `clientKey`. The machinery is
  the forward-looking safety story for when sharing is wired, not a
  behavior reachable today.

## Summary

Floot CLI sessions run Claude Code inside an `@endo/sandbox` slice.
The slice today binds a fixed set of host capabilities at first provision
(workspace, optional config dir, optional MCP socket dir).
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
   `claude-client-module.js` lazily mounts the provisioned workspace (and
   config / MCP caps) once, then calls `sandboxFactory.make({ mounts })`.
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
   Like the dedicated config filesystem and MCP socket mount, attach intent
   must replay after reincarnation so the client formula rebuilds the same
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
   guest never supplies it.

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

**`ClaudeClient.terminate()`** still disposes the slice and unmounts **all**
mounts (workspace, config, extras) — destroying the shared CLI environment, not
equivalent to one session's detach.

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
3. Replay 9P + mount registration before or during lazy provision, same as
   today's MCP `provideMount` replay in `provision-claude-session.js`.

Floot session registry may **mirror** attach metadata for UI; the **source of
truth** for container binds is the attach set tied to the **`ClaudeClient`**
that owns the slice.

## Current code touchpoints

| Area | Role |
|------|------|
| `packages/claude-sandbox/src/provision-claude-session.js` | Session powers allowlist, MCP mount replay pattern |
| `packages/claude-sandbox/src/claude-client-module.js` | Lazy 9P, `provideMount`, `sandboxFactory.make({ mounts })` |
| `packages/floot/agent.js` | Session guest, shared client resolver, workspace dir override |
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

## Related

- [endo-agent-tools](endo-agent-tools.md) — persisting mount petnames + paths.
- [daemon-mount-capabilities](daemon-mount-capabilities.md) — `EndoMount` /
  `provideHostPath` host bridge.
- [floot-daemon-owned-turns](floot-daemon-owned-turns.md) — in-flight turn
  behavior when slice recreate aborts a turn.
