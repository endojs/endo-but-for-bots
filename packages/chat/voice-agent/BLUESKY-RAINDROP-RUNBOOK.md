# Sign in with Bluesky → claim credits — runbook

A user comes to the app and **signs in with their Bluesky handle** (real AT-Protocol OAuth, scope `atproto` =
identity only — no posting, no repo access). If their account is on your **Raindrop eligibility allow-list**, they
**claim a private namespace** (their own home/chats/projects — the same per-user space any invitee gets) plus a
**one-time credit allowance** into that namespace's purse. Credit-gated features then spend from that balance; the
existing MetaMask/ERC-7715 top-up feeds the *same* balance, so claimed credits and paid credits are one wallet.
Anyone can sign in; only allow-listed handles get credits.

This is **pull, not push** — nobody is DMed. It's wired but **switched off until you do the steps below** (the
sign-in page says so; `/bsky/client-metadata.json` and `/bsky/jwks.json` already serve so setup can be staged).

---

## What you do (morning, ~5 min)

### A. Decide to turn it on (host-layer call — I left this to you)

Two things have real blast radius, so I did NOT do them autonomously:

1. **Install the OAuth library** into the shared monorepo:
   ```bash
   cd /home/dan/endo-bfb-llm && npx corepack yarn workspace @endo/field-voice-agent add @atproto/oauth-client-node
   ```
   (Commit the `yarn.lock` change on its own, per the repo's pre-PR checklist.) The first time the server
   constructs the client it auto-generates an ES256 signing keypair at
   `~/.config/field-agent/bluesky-oauth-key.json` (mode 600) — the private half never leaves that file; only the
   public half is served at `/bsky/jwks.json`. No app-registration step exists in AT-Proto OAuth: the client_id
   *is* `https://agentc.chu.vmkqx.com/bsky/client-metadata.json`, which the network fetches at sign-in.

2. **A public OAuth callback** (`/bsky/callback`) is now reachable at agentc.chu — that's inherent to "Sign in with
   Bluesky." It only ever learns a signed-in account's DID (scope `atproto`); it holds no power over their account.

### B. Configure eligibility (the Raindrop allow-list)

Make a Raindrop collection (e.g. **"Bluesky invites"**) and bookmark the profiles to allow —
`https://bsky.app/profile/<handle>` or `.../profile/<did>`. Get a Raindrop **test token**
(https://app.raindrop.io/settings/integrations → create app → Test token). Then:

`~/.config/field-agent/bluesky-raindrop.json` (mode 600):
```json
{
  "raindrop": { "token": "<raindrop test token>" },
  "collection": "Bluesky invites",
  "publicUrl": "https://agentc.chu.vmkqx.com"
}
```
No app password is needed (we only resolve public handles → DIDs to match the sign-in). Edit the collection
anytime — eligibility is read fresh (cached ~5 min).

**`publicUrl` is required for OAuth** and MUST be the public-internet origin (the ngrok domain
`https://agentc.chu.vmkqx.com`), NOT the tailnet URL — AT-Proto's authorization server fetches
`<publicUrl>/bsky/client-metadata.json` over the public internet and redirects back to `<publicUrl>/bsky/callback`.
The server defaults to the tailnet `BASE_URL` if `publicUrl` is unset, which will NOT work for OAuth. (This is the
one place the feature is deliberately public — consistent with agentc.chu already being your public surface.)

### C. Restart + try it

```bash
systemctl --user restart voice-agent
```
Open **https://agentc.chu.vmkqx.com/bsky** → enter a handle that's in the collection → "Sign in with Bluesky" →
authorize on Bluesky → you're redirected into your own namespace with credits. A handle NOT in the collection can
still sign in but lands on a "not on the list yet" page (add them to Raindrop to let them in).

---

## How it fits together (files)

- `bluesky-oauth.mjs` — wraps `@atproto/oauth-client-node` (confidential web client, scope `atproto`). Serves
  `/bsky/client-metadata.json` + `/bsky/jwks.json`; `/bsky/login` → authorize redirect; `/bsky/callback` →
  proven DID. Lazy/dynamic import → degrades gracefully if the dep isn't installed. **Verified to run in-process
  under the SES server** (jose's Web-Crypto paths don't touch frozen intrinsics).
- `bluesky-raindrop.mjs` — `makeBlueskyEligibility`: Raindrop collection → allow-list of DIDs + handles (pages the
  collection, resolves handles→DIDs via the public API, matches on either).
- `bluesky-claim.mjs` — `makeBlueskyClaim`: proven DID → eligibility check → stable namespace (membership seam,
  keyed on DID) → one-time credit grant. Idempotent (same space + credits-once on re-sign-in).
- `server.mjs` — instantiates the three + the `/bsky/*` routes; on an eligible callback, redirects to
  `/#cap=<namespace>` (the cap rides the URL fragment, client-only, exactly as every invite link in this app
  does; the app stores it and strips the address bar).

## Credit model — ZERO until claim (your choice)

- **Anyone** who signs in with Bluesky gets a stable namespace (they're "in the app"), but its credit wallet starts
  **empty**. Credit-gated features (inference, etc.) stay locked at a zero balance.
- An **eligible** sign-in (DID on the Raindrop allow-list) **funds** that wallet once with `grantUusd`
  (= `defaultAllowance`, $1.00; change via `grantUusd` in the server wiring). Re-sign-in never re-funds.
- The wallet is **shared across all that namespace's chats** — `purseFor` routes every Bluesky-namespace purse to
  one `_namespace` wallet seeded at zero, instead of the per-chat default-allowance seeding regular users get. So a
  claim funds the whole namespace, and an unclaimed user can't get free per-chat allowances by opening new chats.
- The existing MetaMask/ERC-7715 top-up credits this **same** wallet, so an unclaimed user could also just pay.
- (dan/root + ordinary invite caps are untouched — they keep per-chat default allowances.)

## Tests & rollback

- `node --test bluesky-raindrop.test.mjs` — 7/7: eligibility (paging/dedup/handle→DID, DID + case-folded handle
  match, strangers rejected) and claim (eligible→namespace+grant, ineligible→nothing, idempotent re-sign-in,
  non-DID rejected). The live OAuth handshake itself needs a real Bluesky sign-in to exercise (step C).
- Additive: new modules + `/bsky/*` routes + one wiring block; no agent power. To remove: revert the feature
  commit + restart. Config files created during setup just go unused. (Branch `bluesky-raindrop-invite`.)
