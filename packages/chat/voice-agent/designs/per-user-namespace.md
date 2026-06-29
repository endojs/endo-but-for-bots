# Per-user namespace for invited users

Goal (dan, 2026-06-28): finish inviting users who get their **own basic namespace** — their entry-agent
**home folder**, their own **projects**, their own **chats** — mutually isolated from the owner's personal
data. Plus: an **allowance through the owner's inference providers** (exists), AND the ability to **connect
their own inference provider** for unlimited inference. NOT in scope: per-user notes (they'd build a notes
connector — the platform makes that easy). LATER (design hook only): membership invites gated by an external
auth/registration system (e.g. DWeb Camp's user registry) for bulk/federated onboarding.

## What already works (verified)
- **Chats** are already per-cap isolated server-side: `chatStorePath(cap)=sha256(cap)[:40].json` (server.mjs:269).
- **Home folders** are already per-cap: an invitee's entry agent gets `HOME_BASE/cap-<label>` (agent-caps.mjs:2222),
  the owner gets `HOME_BASE/root`. No cross-cap home access (no homeBinding handed to child nodes).
- **Allowance**: a per-(cap,session) metered **purse** already gates every turn (purse.mjs / meter.mjs); the
  owner sets a default + can top up; invitees self-top-up (Stripe / ERC-7715). Runs on the owner's keys.
- **Invite**: `/invite` (root-only) mints a scoped cap with the STARTER_RING; owner UI mints + copy/QR.
- **Escalation**: requestAccess → owner Grant card → rescopeCap. **No `notes` in the starter ring** → invitees
  can't read the owner's vault (good, and intended to stay that way).

## The gaps to close
1. **Invitee home not usable** — STARTER_RING lacks `home`, so the isolated `cap-<label>` folder exists but the
   entry agent can't use it. → add `home` to the invitee default ring.
2. **Projects are global + root-only** — one `projects.json`, all `/projects/*` gated on `isRoot` (server.mjs:2741).
   → partition projects by OWNER (the cap's owner id); let a non-root cap manage **its own** projects only.
3. **Client localStorage not cap-scoped** — `field-agent-chats`/`-tx-*` are per-browser, so opening an invite on
   the OWNER's own browser shows the owner's chat list (server is already isolated; this is the client cache).
   → scope the localStorage keys by a hash of the active cap.
4. **No BYO inference provider** — every turn runs on the owner's keys + purse. → let a user attach their own
   provider+key (runtime-injected, never in DOM); their turns route to it and BYPASS the owner's purse.

## STATUS (2026-06-29): Inc 1–5 SHIPPED + TESTED
- ✅ **Inc 1** invitee home (STARTER_RING += `home`; isolated cap-<label>) — per-user-namespace.test 4/4.
- ✅ **Inc 2** per-user projects (owner-partitioned; non-owner 404; scheduled-agent tools capped to the owner's
  ring → no escalation) — unit 5/5 + live endpoint smoke (isolation both ways, host/notes stripped, 404).
- ✅ **Inc 4** BYO inference (callLLM apiKey override + byo-store w/ vaulted key + /byo/* + unmetered routing +
  Settings UI for invitees) — byo-store 3/3, byo-ui 5/5, endpoint smoke (key never leaked).
- ✅ **Inc 5** membership-invite SEAM scaffolded (invite-policy.mjs: verified identity → stable namespace cap;
  pluggable fail-closed verifier) — invite-policy.test 4/4. To go live: /membership/* + the camp's verifier.
- ⏳ **Inc 3** cap-scoped client localStorage — OPTIONAL/deferred. Chats are already per-cap isolated SERVER-side
  (the real boundary); the localStorage cache only matters if an invite is opened in the OWNER's own browser,
  and the per-cap /chats/load overwrites it. Minor UX, not a security gap. Noted, not built.

## Plan (incremental, each commit shippable + tested)
- **Inc 1 — invitee home + isolation proof.** Add `home` to STARTER_RING (default-on, owner can uncheck). Test:
  an invitee cap's home is `cap-<label>`, disjoint from `root`; an invitee turn can read/write its own home and
  CANNOT reach the owner's home or notes.
- **Inc 2 — per-user projects.** Add an `owner` key to projects (root → 'root'; invitee → their cap/user hash).
  `listProjects(owner)`/access scoped to owner; change `/projects/*` from `isRoot`-gated to
  any-valid-cap-scoped-to-its-own. Scheduled-agent execution stays global (server-side); only ACCESS is scoped.
  Each user's projects keep their own `project-<id>` home subdirs (already isolated by id).
- **Inc 3 — cap-scoped client storage.** Prefix `field-agent-chats/-tx-/-active` with `sha256(cap)[:12]` so a
  second cap on the same browser gets a fresh local view; migrate the current cap's existing keys once.
- **Inc 4 — BYO inference provider.** Per-user `{provider, key}` stored server-side scoped to the user (key in
  the named vault, never in DOM/transcript). When set, the turn's `callLLM` routes to the user's provider with
  their key and **bypasses the owner's purse** (their cost, their account; unlimited). Owner's allowance remains
  the default for users who don't BYO. UI: a "Connect your own AI provider" panel in settings/the invite view.
- **Inc 5 (LATER, design only) — membership invites via external auth.** An invite "kind=membership" bound to an
  external identity provider (OIDC/registration API): a member authenticates → the platform mints them a
  per-user cap automatically (no per-person link). Scaffold the seam (an `invite-policy` that maps a verified
  external identity → a minted namespace cap) without wiring a specific provider yet.

## Isolation invariants (hold across all increments)
- A user cap names ONLY its own namespace (home/projects/chats) — designation by reference; no user can name
  another user's or the owner's objects.
- The owner's notes/home/personal data are never in an invitee's reachable graph (no `notes`; separate home).
- BYO keys + allowance: runtime-injected, never rendered/persisted to DOM/URL/log; per-user, revocable.
- Membership (later) only ever mints a least-privilege namespace cap; external auth gates issuance, not authority.
