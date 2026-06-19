> **Archived verbatim** from the 2026-06-16 design pass (workflow `wf_ffc46d65-0f8`).
> The CURATED, current plan is `../SELF-IMPROVEMENT-ROADMAP.md` (incl. §6 self-tuning). This file is the
> original deep design detail — concrete API sketches — preserved on request; treat the roadmap as
> authoritative where they differ.

---

I have all the real signatures I need. Here is the design doc.

---

# DESIGN — Invitations + Allowance + Social Collateral (vision #3)

Status: design · Author: design:invite-collateral · Target repo: `endo-bfb/packages/chat/voice-agent` (+ a new in-SES allowance module reusing `~/agora` and `endo-bfb/packages/ocapn-noise`)

## 0. One-paragraph thesis

An invitation is a single act that **mints a new agent root cap AND funds a sub-purse drawn from the inviter's own purse**. That funded sub-purse *is* the social-collateral edge: its ceiling is the inviter's exposure, its draw history is the audit trail, and its membership in the existing `share`/`revoke` ocap graph makes misuse visible and revocable. The invitee's default agent holds *nothing of the inviter's* except a private empty home, read-only Wikipedia, and a **prepaid** `createSubAgent` — so every dollar of inference the invitee's whole sub-tree ever spends draws down that one edge and is bounded by arithmetic (`purse.withdraw` throws on underflow), not by hoping the model behaves. That arithmetic bound is the direct fix for the "farting subagents everywhere" trigger.

## 1. Substrate decision (locked, per the agora-collateral ingest)

- **Ledger = agora `makeBank`** (`/home/dan/agora/src/bank.js`). One conserved `tix` currency, one custodial purse per agent id (`bank.enroll(id)` → `account.getBalance()`), journaled + replayable (`makeBank({journal, now})`, `apply` = replay). This survives daemon restart and is auditable (`totalSupply`, `balanceOf`, `listAccounts`).
- **Charge seam = `makePaidCapability` shape** (`/home/dan/endo-bfb/packages/ocapn-noise/paid-capability.mjs:53`). The toll-bridge (designed by the sibling workstream) wraps `callLLM` behind a `quote → deliver → charge` flow whose `authority.charge({amount, payee})` is implemented as **a thin adapter over an agora purse** (`charge` = `purse.withdraw(amount)` → `subsidize(payee)`; `remaining()` = `purse.getCurrentAmount().value`).
- This doc owns the **edge / invite / default-bundle / UI** layer. It depends on the toll-bridge exposing a per-node `authority` it charges; it does **not** re-implement metering.

Key reused signatures (verified in source):
- `bank.enroll(id) → {getId, getBalance}` · `bank.balanceOf(id)` · `escrowAuthority.{escrow,settle,refund}` (`bank.js:159-198`).
- Purse-level draw: agora `issuer.makeEmptyPurse()` → `withdraw(amount)` **throws on insufficient** — this is the monotonicity enforcer.
- `node.share(power, label) → {power,label,swiss,url}` and `node.revoke(swiss)` (`agent-caps.mjs:962-965, 979, 995`); `node.cap.describe()` lists `canMint` powers (`:971-978`).
- Default-grant powers map to real `POWERS` entries: `home`, `reference` (Wikipedia+Gutenberg, `agent-caps.mjs:313`), `delegate` (`delegateTask`, `:632`), `roles` (`employ`/`listRoles`, the 16 stock types in `agent-roles.mjs`, `:662-715`). `META_POWERS` (`:442`) is the existing one-level-deep recursion wall a purse converts into a *budget*.

## 2. The invite flow

`createInvite({ inviterNode, allowance, powers, extras, label })` — a new verb behind a new META-ish power `invite` (root-only at first; see Open Decisions).

```
createInvite(inviterNode, {
  allowance,                 // Nat (tix). The inviter's exposure ceiling for this person.
  powers = ['home','reference','delegate','roles'],   // default suggested set
  extras = [],               // giver-chosen caps the inviter already HOLDS (monotone)
  label,                     // human name for the relationship ("Alex")
}) → { inviteUrl, edgeId, granteeId, fundedAllowance }
```

Steps (all in one atomic op, journaled):

1. **Mint the grantee id + root node.** `granteeId = invite-${newSwiss()}`. Build a fresh `makeAgentNode({ powers: intersection(powers ∪ extras, inviterNode.powers) − {invite}, id: granteeId })`. This is the **invitee's root cap** — exactly the existing share machinery, just minting a *multi-power* node instead of one power. Its `#cap=` URL is the invite link.
2. **Enroll the grantee purse.** `bank.enroll(granteeId)`.
3. **Fund the sub-purse (the collateral move).** `withdraw(allowance)` from the **inviter's** purse and `deposit` into the grantee's purse. If the inviter can't cover it, `withdraw` throws *before* anything is journaled — offer-safe, the invite fails cleanly. **The exposure is escrowed up front**: the inviter's own visible balance drops by exactly `allowance` the moment they invite.
4. **Record the edge** (§3) with `parentEdgeId = inviter's own funding edge` (or `null` if the inviter is dan/root).
5. **Bind the toll authority** to the grantee purse so the grantee node's inference charges draw it down.
6. **Return** the invite `#cap=` link (handed off via copy / on-demand QR per the cap-hygiene principle — never rendered to screen).

Re-invite (the invitee invites someone) is the *same* call with `inviterNode = the invitee's node`: it withdraws from *their* sub-purse, so a grandchild can never be funded beyond what the child holds. Tree of decreasing sums, enforced by arithmetic.

## 3. The collateral data model

The granted allowance **is** the edge. Stored as a JSON record (durable, `mode 0o600`, mirroring `PERSONA_FILE`/`AUTOCONFIRM_FILE` at `agent-caps.mjs:56/424/441`) at `~/.config/field-agent/collateral.json`, with the *value* movements living in the agora journal (so the edge record is a thin join row, not a second source of truth for money):

```js
CollateralEdge {
  edgeId,            // unguessable; this id IS the cap to inspect/top-up the edge
  granterId,         // agora account id of the inviter
  granteeId,         // invite-<swiss>; the invitee's enrolled purse
  granteeSwiss,      // the #cap= swissnum of the invitee root node (for revoke())
  allowance,         // Nat — original funded ceiling (the exposure)
  // balance is NOT stored — it's bank.balanceOf(granteeId) (single source of truth)
  status,            // 'live' | 'revoked' | 'exhausted'
  grantedAt, lastDrawAt,
  parentEdgeId,      // chains the tree; null only for dan's root-funded edges
  label,             // "Alex"
  powers,            // what the invitee root holds (for the graph view)
}
```

- **Balance / remaining** = `bank.balanceOf(granteeId)` — never duplicated.
- **Draw history** = the agora journal filtered to `entries where the charge payee/agent == granteeId`. Each toll adds `{model, queryRef}` marker fields on the journal entry (agora tolerates extra fields). So draw history is *free* and replayable.
- **Per-granter exposure** = Σ `allowance` of live edges where `granterId == X`, cross-checked against the drop in X's own `balanceOf`.
- **Misuse surfaces in the delegation graph** because the edge IS a node in the existing `share`/`listShares` graph (`agent-caps.mjs:962`): granter → grantee with a live balance. The graph view (vision #2's tree can reuse this) renders nodes = enrolled purses, edges = collateral grants, edge weight = `allowance`, edge fill = `1 − balance/allowance` (drawdown). A child draining its purse fast, or fanning out many sub-edges, is visible as a hot subtree under its granter.

## 4. The new-user default bundle

`defaultGrant` mints a node whose c-list is exactly:

| Item | Power | Verb(s) | Exposure |
|---|---|---|---|
| Empty home folder | `home` | `fileList/fileRead/fileWrite/publishSite` — fresh `makeHome('cap-<label>')` (`agent-caps.mjs:367`) | none (private dir) |
| Wikipedia | `reference` | `consult` (`:313, 462`) | none (read-only) |
| `createSubAgent(prompt, powers, payment)` | `delegate` + `roles` | `delegateTask` (`:632`) and `employ`/`listRoles` (the 16 **stock agent types** in `agent-roles.mjs`) | bounded by the funded purse |
| The funded allowance | (not a POWERS entry — a purse + bound toll authority) | charged per `callLLM` | **= the collateral; this is the inviter's exposure** |
| Giver-chosen extras | any power the inviter holds | — | inviter chooses; monotone (`intersection` with inviter's powers) |

Default `powers = ['home', 'reference', 'delegate', 'roles']`. The **stock agent types** are exactly `roleList()` from `agent-roles.mjs`, surfaced via `listRoles()` — "our current best harness architecture." Each spawned stock agent is auto-least-privileged to `intersection(role.ring, parent.powers) − META` (the existing rule at `agent-caps.mjs:680`), so the invitee can hand out sub-agents without ever exceeding what they were granted.

**Wikipedia-only caveat:** the live `reference` power bundles Wikipedia AND Gutenberg (`agent-caps.mjs:19, 160`). For a strict "Wikipedia only" default, attenuate `consult` to the Wikipedia backend at grant time. Decision flagged below; v1 ships the existing `reference` (Wikipedia + Gutenberg, both read-only, zero exposure) and notes it.

**Prepaid `createSubAgent`:** the `payment` arg threads into `delegateTask`/`employ` (`run: async ({ prompt, powers, payment })`) and is a child purse `withdraw`n from the invitee's own purse at sub-node mint time (`agent-caps.mjs:640/683`). This is the method dan's vision says "agents pass whole to subagents." The toll authority of the sub-node binds to that child purse. (This depends on the toll-bridge workstream landing the `payment` plumbing; until then the sub-agent shares the parent purse via the subsidy pattern — still bounded by the parent's balance, just not sub-capped.)

## 5. Draw-down and exhaustion

- **Per query:** the toll-bridge wraps `callLLM`; after the call it reads `usage` (already on the wire — gemma returns `usage.{prompt,completion,total}_tokens`; the code currently discards it at `tool-bridge.mjs:80-81`), computes `cost = tokens × priceTable[provider][model]`, and `charge`s the node's bound authority → `purse.withdraw(cost)` → journal entry annotated `{model, queryRef}`.
- **The agent sees its budget in-context:** one line appended to the `sys` array (`tool-bridge.mjs:144-161`) and the Opus `system` array (`delegate.mjs:48-53`): `Budget: <remaining> tix · this model costs ~<rate> tix / 1k tokens.` (Refreshed per turn; mid-loop refresh via a synthetic `RESULT:` message if wanted.)
- **Exhaustion (balance < quoted cost):** the charge's pre-flight `remaining() >= amount` assertion fails (`paid-capability.mjs:62`). Behavior, in order of preference:
  1. **Refuse the inference** with a structured, non-fatal tool result: `{ ok:false, reason:'allowance_exhausted', remaining, needed }`. The agent gets this *in its loop* and can tell the user "I'm out of allowance."
  2. **Auto-request top-up** — emit a proposal to the inviter (reuse the existing proposal/feed plumbing + the 🔔 notification bell, `server.mjs:608`): "Alex's agent is out of allowance (drew 1000 tix). Top up?" The inviter approves → `withdraw` more from their purse → `deposit` to grantee. This *is* the social-collateral loop: extending more allowance = extending more trust.
  3. **Never silently fail or fall back to the inviter's general balance** — the cap is the whole point. Exhaustion is a hard, visible stop, then a human gate to extend.
- A runaway sub-sub-agent can **at most** drain its leaf purse; the grandparent's exposure was already realized at grant time. `inventory.revoke` / the existing `node.revoke(swiss)` is the kill-switch — revoking the edge cap stops further draws and `refund`s any escrowed-but-unspent value to the granter.

## 6. The invite UI (extend the Shares panel)

The Shares panel already is a cap navigator that calls `/rpc {swissnum, method}` against `node.cap` (`server.mjs:9, 322-324`) and renders `describe().canMint` / `listShares()`. Extend it, don't build new:

- **New "Invite a person" action** next to "Share a power." Form:
  - **Allowance** field (tix), prefilled with the default-allowance setting.
  - **Suggested powers** = the default set as pre-checked chips: `home`, `reference (Wikipedia)`, `createSubAgent` (= `delegate`+`roles` shown as one friendly chip).
  - **"Add more" button** → expands to the inviter's own `canMint` list (from `node.cap.describe().canMint`, `agent-caps.mjs:975`) as additional checkboxes — monotone by construction (you can only check what you hold).
  - Optional **label** ("Alex").
- **Submit** → `/rpc {method:'createInvite', args:[{allowance, powers, extras, label}]}` → returns the invite `#cap=` link. Hand-off = **copy button + on-demand local QR** (the two standard cap hand-offs); the swissnum never enters the DOM as text.
- **Shares panel rows** gain a "people" section listing live edges: label, allowance, `balance/allowance` bar, last draw, **Revoke** + **Top up** buttons. Revoke = existing `node.revoke(swiss)`; Top up = `/rpc {method:'topUpEdge', args:[edgeId, amount]}`.
- **Default-allowance setting** = a new field in `~/.config/field-agent/allowance.json` (`{ defaultAllowance, perChat:{} }`), read by the invite form's prefill and by new-chat creation. New server endpoints alongside `/chats/load` (`server.mjs:426`).

## 7. THE SMALLEST FIRST INCREMENT

A single staging system test ("test like Joshua") proving the spine end-to-end on the real running voice-agent + a real agora bank:

1. **Stand up** `makeBank()` in-process inside the voice-agent server; `bank.enroll('field-agent')` (dan's root); `bank.mintInto('field-agent', 1_000_000n)` (root is the only un-granted balance — the vault is the root of trust).
2. **`createInvite(rootNode, { allowance: 1000n, powers:['home','reference','delegate','roles'], label:'tester' })`** → assert: returns a `#cap=` link; `bank.balanceOf('field-agent')` dropped by exactly 1000; `bank.balanceOf(granteeId) === 1000n`.
3. **Open the invitee link**, run `/chat` queries that hit `callLLM` (local gemma, so the only thing being metered is the *accounting*, not real $). Assert each query journals a `withdraw` against the grantee purse and the in-context `Budget:` line decrements.
4. **Drive it to 0:** keep querying (or set a high per-query cost in the price table) until `balanceOf(granteeId) === 0n`. Assert the next inference returns `{ok:false, reason:'allowance_exhausted'}` and the agent **stops** — does not draw dan's root purse.
5. **Revoke** the edge → assert no further draws possible and the edge shows `status:'revoked'` in `listShares`.
6. **Replay proof:** restart, `economy.load(journal)`, assert balances reconstruct exactly (the durability guarantee).

Deliberately **out of scope for increment 1:** bounded sub-allowance plumbing through `payment` (use the subsidy pattern — sub-agent shares the parent purse, still bounded by parent balance); the cost *table* accuracy ($ realism); top-up proposal UI; the graph viz. Increment 1 proves: **invite mints a cap + funds a sub-purse from the inviter, inference draws it down, it stops at 0, revoke works, restart survives.** That is the whole collateral spine.

## 8. Open decisions for dan

1. **Funded-sub-purse vs. line-of-credit.** Recommend **funded up-front** (exposure realized at invite, misuse costs the granter *immediately and visibly* — the point of collateral). Line-of-credit is cheaper to top up but only realizes exposure as spent. Confirm funded.
2. **Who may invite?** Recommend `invite` is **root-only** in v1 (only dan/root mints people), then opened to one-level-deep delegation once the bounded-sub-allowance primitive lands. Or: anyone with a purse can invite, bounded by their balance. Your call on how fast the collateral web is allowed to grow.
3. **tix ↔ real money.** v1 tix are an honor-system conserved currency (no settlement). Do you want the on-chain gator adapter (`paid-lease-real.mjs`) as a *second* backend for cross-trust-boundary paid edges, or keep tix purely internal indefinitely?
4. **Price table source of truth.** Local gemma = 0 tix (so it never exhausts). OpenRouter/Anthropic need real per-(provider,model) rates. Where does that table live and who updates it (a `~/.config/field-agent/prices.json`? pulled from OpenRouter's `usage` cost field?).
5. **Wikipedia-only vs. reference (Wikipedia+Gutenberg).** The default bundle says "Wikipedia"; the live power is `reference` (both, read-only). Ship `reference` as-is (both are zero-exposure read-only), or attenuate `consult` to a Wikipedia-only backend for the literal default? Recommend ship `reference`.
6. **Exhaustion default: refuse vs. auto-propose-top-up.** Recommend **refuse + emit a top-up proposal to the inviter** (the trust loop), never silent fallback. Confirm you want the proposal auto-emitted vs. only on the invitee asking.
7. **Bank lifetime / process model.** In-process `makeBank` inside the voice-agent server (simplest, journals to a file) vs. a standalone agora daemon over CapTP that the voice-agent dials (matches dan's "accepts CapTP purse currency" phrasing, shares one ledger across services). Recommend in-process for increment 1, CapTP-dialed agora as the second increment.

---

### File/signature appendix (all verified, absolute)
- agora ledger: `/home/dan/agora/src/bank.js` — `makeBank` (`:36`), `enroll` (`:207`), `balanceOf` (`:245`), `escrowAuthority.{escrow:161,settle:177,refund:187}`, purse `withdraw` throws-on-insufficient (`:78,164-165`). `/home/dan/agora/src/issuer-kit.js`, `/home/dan/agora/src/economy.js` (replay `load`).
- charge seam: `/home/dan/endo-bfb/packages/ocapn-noise/paid-capability.mjs` — `makeGatorAuthority` (`:26`), `makePaidCapability` (`:53`), `addCommission` (`:78`), subsidy note (`:105`).
- cap graph / default bundle / attenuation: `/home/dan/endo-bfb/packages/chat/voice-agent/agent-caps.mjs` — `POWERS` (`:311`), `home`/`reference` verbs (`:313,367,462`), `delegateTask` (`:632`), `employ`/intersection rule (`:662,680`), `listRoles` (`:707`), `META_POWERS` (`:442`), `node.share`/`revoke`/`listShares` (`:962-965,979,995`), `describe().canMint` (`:971-978`), config-file pattern `0o600` (`:56,424,441`).
- stock agent types: `/home/dan/endo-bfb/packages/chat/voice-agent/agent-roles.mjs` (16 archetypes via `roleList()`).
- toll-bridge dependency: `/home/dan/endo-bfb/packages/ocapn-noise/tool-bridge.mjs` — `callLLM` (`:64`, discards `usage` at `:80-81`), `sys` array (`:144-161`). `/home/dan/endo-bfb/packages/chat/voice-agent/delegate.mjs` — Opus `system` (`:48-53`).
- server seams (UI + endpoints): `/home/dan/endo-bfb/packages/chat/voice-agent/server.mjs` — `/rpc` dispatch (`:322-324`), `/chat` body+response (`:352,380,414`), config/state pattern, 🔔 feed (`:608`).
- ancestor design: `/home/dan/ocap-obstacle-course/TODO/12-bid-based-tool-economy.md`.