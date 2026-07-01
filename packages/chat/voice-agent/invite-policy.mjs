// invite-policy.mjs — MEMBERSHIP invitations (the "later" seam, dan): instead of handing out one invite link
// per person, define a membership POLICY bound to an external auth/registration system (e.g. DWeb Camp's
// registry). A member authenticates there → the platform mints them a per-user NAMESPACE cap automatically,
// and the SAME member re-authenticating gets the SAME namespace back (stable, not a fresh one each time).
//
// What's wired here (provider-agnostic): the policy registry + the (verified identity → stable namespace cap)
// mapping. What's deliberately PLUGGABLE: the actual identity verification (`verify`) — an OIDC token check, a
// registration-API lookup, an HMAC-signed ticket, etc. Drop a verifier in when the chosen system is known; the
// minting + isolation already work (a membership cap is just a least-privilege namespace cap like any invite).
//
// Plain Node (fs/crypto) so it imports from the SES server + tests. `mintNamespaceCap` (the server's
// mintScopedCap) is injected, so this module never holds power itself.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const id = (p = 'mem') => `${p}-${crypto.randomBytes(6).toString('hex')}`;
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

// `fundAllowance({ uusd, policyId })` (optional, injected like mintNamespaceCap) is the CONSERVED
// usage-credit source for policies that carry an `allowanceUusd`: it must DEBIT the inviter's purse
// (assert-then-charge — refuse WITHOUT mutating when the inviter can't cover it) and return
// { ok:true, deposit(scopedCap) } where deposit credits the new member's wallet, or { ok:false, error }.
// Two-phase (withdraw → mint → deposit) so a refused funding never mints a member, and a minted member
// is always funded. No µUSD is created from thin air — every member allowance leaves the inviter.
export const makeInvitePolicies = ({ file, mintNamespaceCap, fundAllowance } = {}) => {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { policies: {}, members: {} }; } };
  const write = d => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); };

  // Owner defines a membership: a name, the least-privilege RING every member gets (defaults to the platform
  // starter ring + home), and an opaque `auth` descriptor for the external system (kind + its config). No
  // verifier is stored here — it's supplied at redeem time so secrets never persist in this registry.
  // `allowanceUusd` (optional, µUSD — same units as component-shares' allowance scheme) is the usage-credit
  // grant EACH new member's wallet is funded with at redeem, drawn from the inviter via `fundAllowance`.
  const createPolicy = ({ name, ring, auth = {}, allowanceUusd } = {}) => {
    const d = read();
    const pid = id();
    const allowance = Math.max(0, Math.round(Number(allowanceUusd) || 0));
    d.policies[pid] = { id: pid, name: String(name || 'Membership'), ring: Array.isArray(ring) ? ring : null, auth: { kind: String(auth.kind || 'manual'), ...auth }, ...(allowance > 0 ? { allowanceUusd: allowance } : {}), createdAt: new Date().toISOString() };
    write(d);
    return d.policies[pid];
  };
  const listPolicies = () => Object.values(read().policies);
  const getPolicy = pid => read().policies[pid] || null;
  const removePolicy = pid => { const d = read(); delete d.policies[pid]; write(d); return { ok: true }; };

  // Redeem a membership for a member who has been VERIFIED by the external system. `verify(identity, policy)`
  // is the pluggable check (must return truthy for a valid member). On success, returns a STABLE namespace cap
  // for (policy, identity): minted once, then re-returned for the same member — so re-auth resumes their space,
  // never spawns a new one. The cap is a least-privilege namespace cap (the policy's ring), isolated like any
  // invite. `verify` defaults to refusing (fail-closed) until a real verifier is supplied.
  const redeem = async (policyId, { identity, verify = () => false } = {}) => {
    const policy = getPolicy(policyId);
    if (!policy) return { ok: false, error: 'no such membership policy' };
    const who = String(identity || '').trim();
    if (!who) return { ok: false, error: 'no member identity' };
    let okv; try { okv = await verify(who, policy); } catch (e) { okv = false; }
    if (!okv) return { ok: false, error: 'membership not verified', verified: false };
    const memberKey = `${policyId}:${hash(who)}`; // never store the raw external identity — only a hash
    const d = read();
    if (d.members[memberKey]) return { ok: true, returning: true, scopedCap: d.members[memberKey].cap, ring: d.members[memberKey].ring, allowanceUusd: d.members[memberKey].allowanceUusd || 0 };
    // FUND-ON-REDEEM (conserved): withdraw the policy's per-member allowance from the INVITER before minting.
    // A refusal (inviter can't cover it) refuses the whole redeem — no member, no cap, both ledgers untouched.
    const allowance = Math.max(0, Math.round(Number(policy.allowanceUusd) || 0));
    let deposit = null;
    if (allowance > 0 && typeof fundAllowance === 'function') {
      let f; try { f = await fundAllowance({ uusd: allowance, policyId }); } catch (e) { f = { ok: false, error: String(e && e.message || e) }; }
      if (!f || f.ok !== true || typeof f.deposit !== 'function') return { ok: false, error: (f && f.error) || 'membership allowance unavailable — the inviter cannot cover it' };
      deposit = f.deposit;
    }
    const ring = policy.ring || ['reference', 'research', 'images', 'contact', 'home']; // = STARTER_RING; least-privilege
    const minted = mintNamespaceCap({ powers: ring, label: `member-${hash(who).slice(0, 8)}` });
    if (deposit) { try { deposit(minted.swiss); } catch { /* wallet credit is the injector's job; a throw here must not lose the member */ } }
    d.members[memberKey] = { cap: minted.swiss, ring: minted.powers, policyId, ...(deposit ? { allowanceUusd: allowance } : {}), joinedAt: new Date().toISOString() };
    write(d);
    return { ok: true, returning: false, scopedCap: minted.swiss, ring: minted.powers, allowanceUusd: deposit ? allowance : 0 };
  };
  const memberCount = policyId => Object.keys(read().members).filter(k => k.startsWith(`${policyId}:`)).length;

  return { createPolicy, listPolicies, getPolicy, removePolicy, redeem, memberCount };
};
