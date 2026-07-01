# Vat affinity — the user's agent computes in the user's chosen vat

Source: dan's principle (2026-07-01): *"We want the agent processes to operate within the user's
chosen endo vat. Currently I want my vat on Archua, but I will want to run a vat on my M1 MacBook
Pro while I'm at DWeb Camp, and run an instance of this on it there."*
Status: **design**. V0 is the camp plan (next week) and needs no new code beyond the in-flight
`FIELD_INSTANCE` seam; V1–V3 are sequenced increments. Companion runbook: `../VAT-MIGRATION.md`.
Sibling design: `packing-up-for-dweb.md` (P1+P5 shipped) — this doc is the phase that plan was
missing: **two instances in the world, one vat, and chats that follow the user.**

## The principle (a designation, not a feature)

A user's **vat** is where their agent computation and their authority live: the process (or
processes) that runs their turns, holds their powers, fires their scheduled agents, and owns the
single-writer stores (chats, purses, specialists, homes). The **instance** is whatever box happens
to be serving the UI at `:8778`.

The principle says these are two different designations. The instance serving your browser tab
need not be the vat that runs your turns — **but TODAY it is**: one process is both the edge and
the vat, and the only way to move the vat is to move its body. This doc makes the two names
separable, in increments, without pretending they're separate before they are.

## Ground truth (verified 2026-07-01 — the constraints we design against)

- **There is no persistent per-chat agent process.** An agent exists only for the duration of one
  `POST /chat` request (`server.mjs:1617→1751`, `runAgentCode`). Between turns the agent IS its
  durable data. "Resume" is three mechanisms, all data-shaped: client transcript restore
  (`/chats/load`, keyed by hash-of-cap), in-memory `runResults` reattach (`server.mjs:999–1003`,
  `/chat/result`), and the reconstruct-and-re-POST fallback. **Mid-turn migration is impossible;
  the clean seam is BETWEEN turns** — everything durable is files.
- **The durable state set that pins a vat is exactly the `field-personal` encrypted-drive bind
  map** (see `field-personal`, mirroring `field-config.mjs`): `CONFIG_DIR` (`root.swiss` = instance
  identity + `scoped-caps.json` + specialists + secrets + `users.json`), `VOICE_STATE_DIR` (chats,
  purses, component-git, projects/scheduled agents), `STATE_DIR` (homes, improvement stores),
  `DASH_STATE_DIR` (feed), and the vault. Because `root.swiss` travels with the drive, **existing
  cap links remain valid on the new instance — the drive is the vat's body.**
- **Client-side caveat:** caps live in per-origin `localStorage`. A new origin (the mac's tailnet
  hostname) means the user re-presents their cap link once. The cap is still valid; the browser
  just hasn't seen it at that origin.
- **Existing multi-instance seams**, none of which yet expresses "run this chat's turns on the
  user's chosen vat": `machines.json` (ssh-exec attenuation — machines as shell targets, not
  vats); `endo-peer-bridge.mjs` — a sidecar `@endo/daemon` with the IROH netlayer
  (dial-by-EndpointId QUIC, `{swissnum, method, args}`), used today to redeem `endo://`
  invitations — **the most vat-shaped seam we have**; the ocapn-noise keystone (host:port TCP);
  and `@endo/daemon` also mounting component gitObject exos (`component-git.mjs:127–157`).
  Caps and chat-ids are meaningful only against the local `root.swiss` + stores.
- `packing-up-for-dweb.md` P2–P6 covers the mode split, per-user isolation, deletion, the drive,
  and LAN events — but has **no phase for two live instances or chats following the user**.
  P1 + P5 shipped; P2/P3 partial; P4/P6 designed-only. This doc is that phase.

## The arc: V0 → V3

Each increment ships alone, is verified with a real run (Joshua), and leaves the previous one as
the fallback. V0 is procedure + docs; V1 is the first code; V2 is the real architecture; V3 is the
social payoff.

### V0 — one vat, moved bodily (camp, next week)

**ONE live vat at a time.** The vat moves by moving its body: the encrypted drive (or its friky
backup restored onto media the mac can read). The M1 instance + the mounted volume ARE the same
vat — same `root.swiss`, same scoped caps, same chats/purses/specialists. Nothing needs to
understand "two instances" because there is never more than one alive.

- Cap links dan and invitees already hold **keep working** against the M1 instance (same
  `root.swiss`); the only friction is the per-origin `localStorage` caveat — re-present the cap
  link once at the new origin.
- **`agentc.chu` stays bound to home** unless dan explicitly re-points it —
  public-internet exposure is an explicit per-instance operator request, never a default
  (`public-domain-binding-explicit-only`). While the archua service is stopped, the public name
  serves nothing; that is correct, not a bug.
- The tailnet origin moves with `tailscale serve` on the mac (which also gives the secure context
  the mic needs — getUserMedia requires HTTPS).
- The discipline that makes V0 safe is procedural: **stop the old instance before starting the
  new one** (the runbook enforces the order). Scheduled agents and timers fire wherever the vat is
  mounted, so a still-running archua instance would double-fire against a stale copy — or worse,
  fork the stores.

Verify: the full runbook (`../VAT-MIGRATION.md`) executed for real — archua → M1 → archua — with a
send, a chat resume via an existing cap link, and a scheduled agent firing on the mac.

### V1 — instance identity + the vat manifest + the split-brain guard

Make the vat/instance distinction **legible** instead of procedural.

- **`FIELD_INSTANCE`** (the sibling seam, in flight now): each running instance has a stable,
  non-secret identity, distinct from the vat identity (`root.swiss` stays the vat; the instance id
  names the box/process serving it).
- **A vat manifest in `CONFIG_DIR`** (travels with the drive, like everything else that names the
  vat): the vat's name, its known instances (`FIELD_INSTANCE` ids + last-seen + how to reach them
  — an iroh EndpointId once V2 lands), and which instance is currently **live** (a lease: instance
  id + heartbeat timestamp, refreshed by the running service).
- **The split-brain guard:** on boot (and on `field-personal unlock`), an instance that finds a
  fresh live-lease held by a DIFFERENT instance **refuses to serve turns** (read-only + a loud
  banner), unless the operator explicitly breaks the lease. Name the risk plainly: **chats and
  purses are last-write-wins JSON files.** Two live instances on copies of the same vat state
  means clobbered chats, double-fired scheduled agents, and — worst — **purse double-spend**:
  tix conservation assumes a single writer. The guard turns "never run both" from a runbook
  sentence into a mechanism.

Verify: two instances pointed at copies of the same `CONFIG_DIR`; second one refuses; break-lease
verb works; stale-lease (crashed instance) recovery works after the heartbeat window.

### V2 — turn execution follows the vat (the real architecture)

The serving instance and the vat become genuinely different processes. When a chat's vat is
remote, the edge instance **forwards the turn** to the vat's instance over the iroh peer bridge —
the `{swissnum, method, args}` RPC shape already proven by `endo-peer-bridge.mjs` for invitation
redemption. Because an agent only exists for one `POST /chat`, "forward the turn" is the whole
job: there is no long-lived process to proxy, just a request to route and a stream of step events
to relay.

- **UI/SSE stays local** (the edge serves the client, relays `/chat/steps` events, holds the
  transcript cache); **computation is remote** (the vat runs `runAgentCode`, holds the powers,
  writes the stores).
- **What stays vat-side:** everything in the bind map — `root.swiss`, scoped caps, chats, purses,
  specialists, homes, projects/scheduled agents, component-git, vault, secrets. Powers execute in
  the vat: the vat's HA is dan's HA, the vat's host shell is the vat's host. **What stays
  edge-side:** static client assets, the SSE fan-out, STT proxying (audio is big; transcribe near
  the mic), per-origin session plumbing. The edge holds **no swissnums at rest** — it relays a
  presented cap to the vat and forgets it (same trusted-path discipline as the client).
- Cap validation moves conceptually from "this process's `root.swiss`" to "the vat this cap
  designates" — the manifest (V1) tells the edge where to dial. ocap discipline unchanged: the cap
  is the boundary; the edge is a dumb pipe that cannot mint, attenuate, or persist authority.

Verify: instance A (platform mode, no personal data on disk) serves the UI; a turn presented with
dan's cap executes on instance B (the vat) over iroh; steps stream live in A's browser; A's disk
shows no chats, no purse, no swissnum.

### V3 — chats follow the user across vats

The per-user namespace (`per-user-namespace.md` / packing-up P3) completes and becomes
**portable**: a user's namespace — their chats, home, specialists, timers, purse — is a unit that
can move to, or be subscribed from, **their own vat**. A guest who joined on dan's platform can
later stand up their vat (a laptop, a pi, a hosted daemon) and take their namespace with them;
dan's instance becomes an edge that forwards their turns home (V2 machinery, per-user rather than
per-instance).

- Social/multi-tenant implications: "bring your own inference" (already shipped) generalizes to
  **bring your own vat** — the platform vends UI + introductions, the user's authority computes at
  home. Delegation across users becomes vat-to-vat capability exchange over the peer bridge —
  which is exactly where the social-collateral trust graph wants to live.
- Movement is **between turns and per-namespace** (still no CRDTs): a namespace hand-off is
  freeze → transfer → flip the user's manifest pointer → thaw, with the split-brain guard scoped
  per-user.

Verify: a second user's namespace moves from dan's vat to a scratch vat; their existing cap link
still opens their chats (served via forwarding); dan's vat retains nothing of theirs (P4 deletion
proof reused).

## What we are NOT doing (and why)

- **Live migration mid-turn.** There is no process to migrate — an agent lives for one POST. The
  between-turns seam is not a compromise, it's the architecture. A turn in flight when the vat
  moves simply fails and is re-POSTed (the existing fallback).
- **CRDT chat stores.** Chats/purses stay single-writer JSON with a live-lease. CRDTs would buy
  concurrent multi-instance writes we have explicitly decided not to allow (split-brain guard),
  at the cost of merge semantics for stores where merge is wrong (a purse is not a set). Revisit
  only if V3 produces a real need for offline-concurrent chat append — and even then, chats
  maybe, purses never.
- **Multi-master purses.** Conservation demands a single writer. The purse lives where the vat
  lives, full stop. Cross-vat payment is a transfer protocol between purses (two single-writers),
  not replication of one.
- **Re-pointing `agentc.chu` implicitly.** Public binding follows the operator's explicit word,
  never the vat.

## Security invariants (carried from packing-up + AUTHORITY-MODEL)

- The cap is the boundary; designation by reference. An edge instance relays caps, never stores
  or mints them; no swissnum to DOM/URL/log/edge-disk.
- Personal authority exists only where the volume is mounted — vat affinity strengthens this: the
  volume IS the vat's body (V0), then the vat's manifest home (V1+).
- One live writer per vat (V1 lease), then per namespace (V3). Split-brain is refused, not merged.
- Default reachability is tailnet; event = LAN; public = explicit per-instance operator request.

## Appendix — the camp migration runbook

The concrete archua → M1 → archua sequence (services to stop, `field-personal` verbs, what works
offline at camp, the return) lives next to the provisioner runbook: **`../VAT-MIGRATION.md`**.
