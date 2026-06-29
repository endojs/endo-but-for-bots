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

export const makeInvitePolicies = ({ file, mintNamespaceCap } = {}) => {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { policies: {}, members: {} }; } };
  const write = d => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); };

  // Owner defines a membership: a name, the least-privilege RING every member gets (defaults to the platform
  // starter ring + home), and an opaque `auth` descriptor for the external system (kind + its config). No
  // verifier is stored here — it's supplied at redeem time so secrets never persist in this registry.
  const createPolicy = ({ name, ring, auth = {} } = {}) => {
    const d = read();
    const pid = id();
    d.policies[pid] = { id: pid, name: String(name || 'Membership'), ring: Array.isArray(ring) ? ring : null, auth: { kind: String(auth.kind || 'manual'), ...auth }, createdAt: new Date().toISOString() };
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
    if (d.members[memberKey]) return { ok: true, returning: true, scopedCap: d.members[memberKey].cap, ring: d.members[memberKey].ring };
    const ring = policy.ring || ['reference', 'research', 'images', 'contact', 'home']; // = STARTER_RING; least-privilege
    const minted = mintNamespaceCap({ powers: ring, label: `member-${hash(who).slice(0, 8)}` });
    d.members[memberKey] = { cap: minted.swiss, ring: minted.powers, policyId, joinedAt: new Date().toISOString() };
    write(d);
    return { ok: true, returning: false, scopedCap: minted.swiss, ring: minted.powers };
  };
  const memberCount = policyId => Object.keys(read().members).filter(k => k.startsWith(`${policyId}:`)).length;

  return { createPolicy, listPolicies, getPolicy, removePolicy, redeem, memberCount };
};
