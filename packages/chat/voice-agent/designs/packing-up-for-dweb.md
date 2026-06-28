# Packing up for Dweb — transport-safe, multi-tenant Agent C

Implements the vault doc `the field/TODO/Packing up for Dweb.md`. Decisions locked with dan
(2026-06-28): **factor now + carry hardened**, personal data on an **encrypted thumb drive** that
flips the instance between modes, and **full per-user isolation now**.

## The keystone insight (dan): the encrypted personal volume IS the personal/system layer

The machine runs in one of two modes, keyed only to whether dan's **personal volume** (an encrypted
USB, decrypted + mounted at `FIELD_PERSONAL_ROOT`) is present:

- **platform mode** (no volume) — a clean, fully multi-tenant Agent C. No vault, no secrets, no
  personal/admin caps on disk. Each user is a tenant with a namespace isolated *by construction*:
  their own home, agents/specialists, timers, projects, feed, chats, main-page (Root pointer). A
  generated **platform-admin cap** (stored on the platform, holds NO personal powers) can issue
  invites + manage users. Safe to carry; safe to hand strangers LAN links at the event.
- **personal mode** (volume mounted + decrypted) — dan's vault + secrets + root cap + admin bindings
  (HomeAssistant, email, contacts, kazputer, dietician, host shell) load *from the volume*. dan
  becomes the privileged "user 0" whose namespace also holds the personal/admin caps. Pull the drive
  → none of it is on the box.

This unifies the doc's two projects: **isolating dan's personal data from the machine IS the same
work as making the base platform safe for a stranger to bring their own data.** The seam between
"personal/admin (dan-only)" and "shareable platform" becomes a literal filesystem boundary (the USB)
+ a config switch.

`personal mode` is the DEFAULT on the home NUC today (volume = dan's current `~/.config/field-agent`
+ `~/obsidian/vault`), so nothing changes for dan until the drive is physically separated.

## Current state (from the code map)

- Root node holds **ALL 28 powers** (agent-caps.mjs:2512). Personal/admin: notes/vault, homeassistant,
  email, contacts, kazputer, dietician, phone, feed, host, vm, selfImprove, subagent. Generic/shareable:
  reference, research, web, youtube, images, browser, home, timers, schedule, connectors, customtools,
  objects, contact, toolsmith, roles, delegate.
- ~25 personal couplings hardcoded to `/home/dan` (agent-caps.mjs:106–141, server.mjs:93). Some already
  env-overridable (VAULT, HA_URL, VM_HOST, WORKTREE_*, KAZPUTER_URL); the rest are literals
  (HOME_BASE, PERSONA_FILE, EMAIL_CFG, EMAIL_FROM, KAZPUTER_STATE, FEED_MJS, FEED_FILE).
- Isolated-by-construction ALREADY: per-cap home folders (HOME_BASE/<cap>), notes prefix-scoping,
  HA c-list sub-nodes, contacts granules. Multi-tenant primitives exist: `user-store.mjs`
  (per-user cap → {root, prefs}, hashed), `mintScopedCap`, scoped-cap persistence, `/user/*`.
- ENTANGLED / global (must partition per-user): specialists.json, projects + scheduled agents,
  timers, feed/phone (hardcoded to dan), custom-tools, component-git forks, chats.
- NO disk encryption (plaintext btrfs). BIND + PUBLIC_BASE_URL already control listen + share-link origin.

## Phases (sequenced; each ships + is verified)

### P1 — the config seam + mode switch  ← START HERE (safe, zero behavior change)
Centralize every personal coupling into `field-config.mjs`: resolves `FIELD_MODE`
(`personal` if `FIELD_PERSONAL_ROOT` present + has a `personal.json` marker, else `platform`) and
derives every path/identity constant from it, **env-overridable, current values as defaults** →
identical behavior today. Thread it through agent-caps.mjs + server.mjs (replace the literals).
Verify: service boots, a send works (tool-output-history), root cap unchanged.

### P2 — platform mode = no personal powers; the platform-admin cap
In `platform` mode the entry point is NOT a personal root: no vault/HA/email/contacts/host/etc.
A generated `platform-admin` cap (on the platform, not the volume) holds only invite/user-management
+ generic powers. `PLATFORM_POWERS` (the shareable subset) vs `PERSONAL_POWERS` (loaded only when the
volume is present). dan-with-volume = platform-admin ∪ personal. Verify: boot with no volume → no
personal power resolves, vault tools 404 cleanly, invites still work.

### P3 — full per-user isolation (the big one; parallelizable per store)
A `userScope(uid)` (uid = the user-store hash) partitions every entangled store under
`state/users/<uid>/…`: home, specialists, projects+scheduled agents, timers, feed + push target,
chats, custom-tools, component forks. A user-cap resolves ONLY its own namespace (designation by
reference — no user can name another's objects). "Agent constructors safe to share" = per-user
specialist/agent creation confined to that user's powers ∩ objects. dan = user 0. Verify: two
distinct user-caps each get their own agents/home/timers; neither can see the other's; cross-tenant
access is unnameable.

### P4 — "delete my data" (the doc's standing promise)
`POST /user/data/delete` + an in-app verb: wipe a user's namespace + revoke their caps + drop their
user-store record + their uploaded/referenced objects. Always available to the holder. Verify: a
user deletes → namespace gone, caps dead, downstream shares dead.

### P5 — the encrypted personal volume + the PROVISIONER DRIVE (tooling + handshake)
The `field-personal` tool (voice-agent/field-personal) runs the LUKS lifecycle:
`status / init <part> / unlock / lock / migrate / verify / scrub`. Every destructive (init, scrub) or
passphrase (init, unlock) step is the OPERATOR's to run and is double-confirmed; `scrub` refuses until
`verify` passes. `unlock` writes a systemd drop-in setting `FIELD_PERSONAL_ROOT` + restarts → personal;
`lock` clears it → platform. **No keyfile on the host** — only dan's passphrase decrypts it.

**The provisioner drive (dan, 2026-06-28):** the USB is partitioned so it is BOTH the key AND a
provisioner:
- **p1 — deploy + docs (plaintext)** — a bootable archua image + the Agent C source snapshot + the
  systemd unit template + `PROVISIONER-DRIVE.md` (the AGENT RUNBOOK: stand up a fresh platform-mode
  instance, LAN-event config, and unlock into personal mode — self-contained so an agent can run it).
- **p2 — LUKS personal volume** — dan's `config/ vault/ state/ personal.json`; mounts at
  `FIELD_PERSONAL_ROOT`. `field-personal init` operates on THIS PARTITION so p1 survives.

Layout: GPT, p1 ~8–16 GB (deploy+docs), p2 the rest (LUKS). The personal footprint today is ~1.1 GB
(config 528 K, state ~295 M, vault 818 M) so p2 has vast headroom.
Verify (real-run): provision a fresh box from p1 → platform mode (no secrets); `unlock` p2 → personal
mode + dan's caps; `lock`/unplug → platform mode + nothing personal on disk.

**Straggler secrets (to finish "no secrets without the drive"):** `~/.env` (ANTHROPIC/OPENROUTER/
PERPLEXITY/VLLM + HA token) is HOST-WIDE — shared with other services (ocap-obstacle-course, …).
`migrate` copies the voice-agent's OWN keys to a volume-local `env`; relocating/scrubbing the shared
`~/.env` is a separate, operator-gated host decision (flagged in the checklist), not done automatically.
`delegation-pay.mjs` paths (gator-pay.json, delegations.json) still use `${HOME}` literals → thread onto
the seam so they follow the volume too.

### P6 — LAN-only event networking
`EVENT_MODE`: BIND to the LAN iface + PUBLIC_BASE_URL = LAN origin so share/invite/cap links are
**live only on the event LAN** (the compromise between tailnet-only and public web). Wrinkle: the mic
needs a SECURE CONTEXT (getUserMedia) — provide local TLS (self-signed + one-time trust, or a
`tailscale serve`-style local cert) or fall back to text-only on plain-http LAN. Verify: links open
from a second device on the same LAN; nothing resolves off-LAN.

## Security invariants (carry through every phase)
- Designation by reference, never a forgeable string; a user-cap names only its own namespace.
- Personal/admin powers exist ONLY when the volume is present (filesystem boundary = authority boundary).
- Never render/persist a swissnum to DOM/URL/log; user-cap stored hashed (already true).
- Public-internet exposure stays explicit per-instance; event = LAN, default = tailnet.
- Least authority: a new user starts with the STARTER_RING, requests more (already shipped).
