// dist-trust.mjs — the "valid for distribution" social-collateral layer for forks (Phase 5 of
// designs/preact-component-trie.md). Holding distribution-trust = being a REVIEWER who can approve a fork
// VERSION for end-user distribution. Trust flows OUTWARD from the root (core team) along grant edges —
// each grant is a vouching act recorded in the graph (social collateral; misuse is visible in the edges,
// per [[social_collateral_capability_governance]]). NOT a central council: the maximal flow of trust from
// the core team outward.
//
// Confinement note: our forks are exfiltration-safe BY CONSTRUCTION (FORK_VOCAB = pure render functions;
// no caps/DOM/network/fs; props are render-safe). So review is about CONTENT + the trust chain layered ON
// TOP of that structural guarantee — never a substitute for it.
//
// Approvals are pinned to the source CONTENT HASH: an edit changes the hash, so it does NOT inherit the old
// approval — an unreviewed change can never reach end-users. If an approver later loses trust (their grant
// is revoked, breaking their chain to root), their approvals go void automatically.

import crypto from 'node:crypto';
import fs from 'node:fs';

import { writeJsonAtomic } from './write-json-atomic.mjs';

const hashSrc = s => crypto.createHash('sha256').update(`forksrc:${String(s == null ? '' : s)}`).digest('hex').slice(0, 24);

// makeDistTrust({ file, rootId }) — rootId is the implicit base authority (the operator's root owner id).
export const makeDistTrust = ({ file, rootId = 'root' }) => {
  let data = { reviewers: {}, approvals: {} };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); data = { reviewers: d.reviewers || {}, approvals: d.approvals || {} }; } catch { /* fresh */ }
  const save = () => { try { writeJsonAtomic(file, data, { pretty: true }); } catch { /* best-effort */ } }; // INT-1: torn-write-safe

  // isReviewer: root is always a reviewer; anyone else needs an UNREVOKED grant chain back to root.
  const isReviewer = (id, seen = new Set()) => {
    if (id === rootId) return true;
    const r = data.reviewers[id];
    if (!r || r.revoked || seen.has(id)) return false;
    seen.add(id);
    return isReviewer(r.grantedBy, seen);
  };
  // grantReviewer(grantor, reviewerId): an existing reviewer vouches for another (records the edge).
  const grantReviewer = (grantor, reviewerId) => {
    if (!isReviewer(grantor)) return { ok: false, error: 'only a distribution reviewer can vouch for another' };
    if (!reviewerId || reviewerId === rootId) return { ok: false, error: 'invalid reviewer id' };
    data.reviewers[String(reviewerId)] = { grantedBy: String(grantor), at: new Date().toISOString(), revoked: false };
    save();
    return { ok: true };
  };
  // revokeReviewer: only the voucher (or root) can revoke. Revoking breaks the chain → cascades to anyone
  // whose path to root ran through them, AND voids their approvals (isReviewer fails for them).
  const revokeReviewer = (grantor, reviewerId) => {
    const r = data.reviewers[String(reviewerId)]; if (!r) return { ok: false, error: 'not a reviewer' };
    if (grantor !== rootId && r.grantedBy !== grantor) return { ok: false, error: 'only the voucher (or root) can revoke this reviewer' };
    r.revoked = true; save();
    return { ok: true };
  };
  const reviewers = () => Object.entries(data.reviewers).filter(([, r]) => !r.revoked && isReviewer(r.grantedBy))
    .map(([id, r]) => ({ id, grantedBy: r.grantedBy, at: r.at }));

  // approve(reviewerId, forkId, version, source): pin an approval to (fork, content-hash).
  const approve = (reviewerId, forkId, version, source) => {
    if (!isReviewer(reviewerId)) return { ok: false, error: 'not a distribution reviewer' };
    const key = `${String(forkId)}@${hashSrc(source)}`;
    data.approvals[key] = { forkId: String(forkId), by: String(reviewerId), version: Number(version) || null, at: new Date().toISOString(), revoked: false };
    save();
    return { ok: true, version: Number(version) || null };
  };
  const revokeApproval = (reviewerId, forkId, source) => {
    const a = data.approvals[`${String(forkId)}@${hashSrc(source)}`];
    if (!a || a.revoked) return { ok: false, error: 'no such approval' };
    if (reviewerId !== rootId && a.by !== reviewerId) return { ok: false, error: 'only the approver (or root) can revoke it' };
    a.revoked = true; save();
    return { ok: true };
  };
  // approvalFor(forkId, source) → { approved, by?, at? }. The approver must STILL be a valid reviewer (else
  // a revoked reviewer's approvals don't count — trust is live, not a snapshot).
  const approvalFor = (forkId, source) => {
    const a = data.approvals[`${String(forkId)}@${hashSrc(source)}`];
    if (!a || a.revoked) return { approved: false };
    if (!isReviewer(a.by)) return { approved: false, staleReviewer: true };
    return { approved: true, by: a.by, at: a.at };
  };

  return harden({ isReviewer, grantReviewer, revokeReviewer, reviewers, approve, revokeApproval, approvalFor, hashSrc });
};
harden(makeDistTrust);
