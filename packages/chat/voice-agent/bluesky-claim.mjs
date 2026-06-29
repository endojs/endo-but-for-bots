// bluesky-claim.mjs — the heart of "Sign in with Bluesky → claim credits".
//
// Given a Bluesky identity that has ALREADY been PROVEN (by AT-Protocol OAuth — see bluesky-oauth.mjs), this:
//   1. checks ELIGIBILITY against the Raindrop allow-list (bluesky-raindrop.mjs),
//   2. for an eligible identity, redeems a STABLE per-user NAMESPACE cap via the membership seam
//      (invite-policy.mjs `redeem`, keyed on the DID — re-signing-in returns the SAME space, never a fresh one),
//   3. grants that namespace a one-time CREDIT allowance (into its purse — the same balance paid top-ups feed),
//   4. returns the scoped cap so the caller can sign the user in to their own namespace.
//
// An INELIGIBLE (but proven) identity still gets a signed-in result with `eligible:false` and no credits — the
// caller decides whether to drop them into a free tier or a "not on the list" page.
//
// Pure orchestration: every capability (eligibility check, namespace mint, credit grant) is INJECTED, so this is
// unit-testable with no network and no SES. Designation by reference — it holds no powers of its own.
//
// Plain-node harden fallback (no-op under the SES server).
if (typeof globalThis.harden !== 'function') globalThis.harden = x => Object.freeze(x);

/**
 * @param {object} opts
 * @param {object} opts.eligibility      makeBlueskyEligibility(...) — .isEligible({did,handle})
 * @param {object} opts.invitePolicies   makeInvitePolicies(...) — the membership seam (.createPolicy/.listPolicies/.redeem)
 * @param {(scopedCap:string, uusd:number)=>void} opts.grantCredits  credit µUSD to a namespace's purse (idempotency is OUR job)
 * @param {string} [opts.policyName]     the membership policy these claims mint under
 * @param {string[]} opts.ring           least-privilege starter ring each claimant's namespace gets
 * @param {number} [opts.grantUusd]      one-time credit allowance per newly-claimed namespace (µUSD)
 * @param {object} opts.store            { read():{granted:{}}, write(d) } — records which DIDs already got their grant
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
  const read = () => { try { return store.read() || { granted: {} }; } catch { return { granted: {} }; } };

  const ensurePolicy = () => {
    const existing = invitePolicies.listPolicies().find(p => p.name === policyName);
    if (existing) return existing.id;
    return invitePolicies.createPolicy({ name: policyName, ring, auth: { kind: 'bluesky-oauth' } }).id;
  };

  /**
   * Claim for a PROVEN identity. Idempotent: the namespace is stable (redeem) and credits are granted at most once
   * per DID. Returns { ok, eligible, scopedCap?, ring?, granted? (µUSD this call), returning? }.
   */
  const claim = async ({ did, handle, collection } = {}) => {
    const who = String(did || '').trim();
    if (!who.startsWith('did:')) return harden({ ok: false, error: 'a proven Bluesky DID is required' });

    let eligible = false;
    try { eligible = await eligibility.isEligible({ did: who, handle, collection }); } catch (e) { return harden({ ok: false, error: `eligibility check failed: ${String(e?.message || e)}` }); }
    if (!eligible) return harden({ ok: true, eligible: false, did: who });

    // eligible → mint (or re-fetch) the stable namespace for this DID
    const policyId = ensurePolicy();
    const r = await invitePolicies.redeem(policyId, { identity: who, verify: () => true });
    if (!r.ok) return harden({ ok: false, error: r.error || 'redeem failed' });

    // one-time credit grant, keyed by DID (never re-grant on re-sign-in)
    const d = read();
    d.granted = d.granted || {};
    let granted = 0;
    if (!d.granted[who]) {
      try { grantCredits(r.scopedCap, grantUusd); granted = grantUusd; d.granted[who] = { at: new Date().toISOString(), uusd: grantUusd }; store.write(d); }
      catch (e) { return harden({ ok: false, error: `credit grant failed: ${String(e?.message || e)}` }); }
    }
    return harden({ ok: true, eligible: true, scopedCap: r.scopedCap, ring: r.ring, granted, returning: !!r.returning });
  };

  // Has this DID already claimed (been granted credits)?
  const hasClaimed = did => !!read().granted?.[String(did || '')];

  return harden({ claim, hasClaimed, ensurePolicy });
};
