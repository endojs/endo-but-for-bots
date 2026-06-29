// bluesky-claim.mjs — the heart of "Sign in with Bluesky → claim credits".
//
// Given a Bluesky identity that has ALREADY been PROVEN (by AT-Protocol OAuth — see bluesky-oauth.mjs):
//   1. ALWAYS mint/return a STABLE per-user NAMESPACE cap for that DID (membership seam invite-policy.mjs `redeem`,
//      keyed on the DID — re-signing-in returns the SAME space). So ANY signed-in Bluesky user gets into the app.
//   2. Check ELIGIBILITY against the Raindrop allow-list (bluesky-raindrop.mjs).
//   3. ZERO-UNTIL-CLAIM (dan's model): a namespace's credit wallet starts EMPTY; only an ELIGIBLE identity's claim
//      funds it (a one-time grant). Unclaimed signed-in users have a zero balance → credit-gated features stay
//      locked until they claim. The wallet is SHARED across all that namespace's chats (the server routes every
//      Bluesky-namespace purse to one wallet seeded at zero — see `isNamespace`).
//
// Pure orchestration: every capability (eligibility check, namespace mint, credit grant) is INJECTED, so this is
// unit-testable with no network and no SES. Designation by reference — it holds no powers of its own. The store
// records cap HASHES (never raw swissnums), like the rest of the stack.
//
// Plain-node harden fallback (no-op under the SES server).
import crypto from 'node:crypto';
if (typeof globalThis.harden !== 'function') globalThis.harden = x => Object.freeze(x);

const hashCap = c => crypto.createHash('sha256').update(String(c)).digest('hex');

/**
 * @param {object} opts
 * @param {object} opts.eligibility      makeBlueskyEligibility(...) — .isEligible({did,handle})
 * @param {object} opts.invitePolicies   makeInvitePolicies(...) — the membership seam (.createPolicy/.listPolicies/.redeem)
 * @param {(scopedCap:string, uusd:number)=>void} opts.grantCredits  credit µUSD to a namespace's shared wallet
 * @param {string} [opts.policyName]     the membership policy these namespaces mint under
 * @param {string[]} opts.ring           least-privilege starter ring each namespace gets
 * @param {number} [opts.grantUusd]      one-time credit allowance an ELIGIBLE claim grants (µUSD)
 * @param {object} opts.store            { read():{byDid,namespaces}, write(d) } — records cap HASHES + claim state
 */
export const makeBlueskyClaim = ({
  eligibility,
  invitePolicies,
  grantCredits,
  policyName = 'Bluesky invites',
  ring,
  grantUusd = 1_000_000, // $1.00 default, in µUSD
  store,
} = {}) => {
  const read = () => { try { const d = store.read() || {}; d.byDid = d.byDid || {}; d.namespaces = d.namespaces || {}; return d; } catch { return { byDid: {}, namespaces: {} }; } };

  const ensurePolicy = () => {
    const existing = invitePolicies.listPolicies().find(p => p.name === policyName);
    if (existing) return existing.id;
    return invitePolicies.createPolicy({ name: policyName, ring, auth: { kind: 'bluesky-oauth' } }).id;
  };

  /**
   * Sign in a PROVEN identity. ALWAYS returns a stable namespace; funds it once iff eligible.
   * Returns { ok, scopedCap, eligible, claimed, granted (µUSD this call), returning }.
   */
  const signIn = async ({ did, handle, collection } = {}) => {
    const who = String(did || '').trim();
    if (!who.startsWith('did:')) return harden({ ok: false, error: 'a proven Bluesky DID is required' });

    // 1. ALWAYS mint/return the stable namespace (verify→true: signing in IS the authorization to have a space)
    const policyId = ensurePolicy();
    const r = await invitePolicies.redeem(policyId, { identity: who, verify: () => true });
    if (!r.ok) return harden({ ok: false, error: r.error || 'redeem failed' });

    const d = read();
    d.namespaces[hashCap(r.scopedCap)] = true; // mark this cap a Bluesky namespace (→ shared zero-seeded wallet)

    // 2. eligibility (Raindrop allow-list)
    let eligible = false;
    try { eligible = await eligibility.isEligible({ did: who, handle, collection }); } catch (e) { return harden({ ok: false, error: `eligibility check failed: ${String(e?.message || e)}` }); }

    // 3. zero-until-claim: fund ONCE, only if eligible
    let granted = 0;
    const prior = d.byDid[who];
    if (eligible && !(prior && prior.claimed)) {
      try { grantCredits(r.scopedCap, grantUusd); granted = grantUusd; } catch (e) { return harden({ ok: false, error: `credit grant failed: ${String(e?.message || e)}` }); }
    }
    d.byDid[who] = { capHash: hashCap(r.scopedCap), claimed: eligible || !!(prior && prior.claimed), at: new Date().toISOString(), uusd: (prior?.uusd || 0) + granted };
    store.write(d);

    return harden({ ok: true, scopedCap: r.scopedCap, eligible, claimed: d.byDid[who].claimed, granted, returning: !!r.returning });
  };

  // Is this cap a Bluesky-minted namespace? (→ the server gives it a shared, zero-seeded wallet)
  const isNamespace = cap => { try { return !!read().namespaces[hashCap(cap)]; } catch { return false; } };
  // Has this DID claimed (been funded)?
  const hasClaimed = did => !!read().byDid?.[String(did || '')]?.claimed;

  return harden({ signIn, isNamespace, hasClaimed, ensurePolicy });
};
