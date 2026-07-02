// toll-ownership.mjs — SEC-10 residual: DURABLE toll-account → owner binding.
//
// SEC-10 cap-gated the toll routes and bound each account to the FIRST non-root cap that touched it
// (trust-on-first-use), so a different cap can't drain someone else's account. But the binding lived only in
// an in-memory Map: after a restart the map was empty, so the NEXT cap to touch an existing account would
// re-TOFU and claim it. This persists the (accountKey → ownerKey) binding through writeJsonAtomic so ownership
// survives a restart — a post-restart claim by a different cap is still refused.
//
// CAP-HYGIENE: the keys stored here are ALREADY HASHES — the account key is a SHA-256 of the account secret
// (`tollAcctKey` in server.mjs) and the owner key is the non-secret `u:<hash>` / 'root' derivation. No swissnum
// or raw account secret is ever written to disk.

import { writeJsonAtomic, loadJson } from './write-json-atomic.mjs';

/**
 * @param {object} opts
 * @param {string} opts.file  path to the durable JSON store (accountKey → ownerKey)
 */
export const makeTollOwnership = ({ file } = {}) => {
  // load the persisted bindings (a plain { accountKey: ownerKey } map). A bad byte here is not money — tolerate
  // a reset (the worst case re-TOFUs, exactly the pre-persistence behavior), so no `guard`.
  const map = new Map(Object.entries(loadJson(file, {}) || {}));
  const persist = () => { try { writeJsonAtomic(file, Object.fromEntries(map)); } catch { /* best-effort; a missed write just re-TOFUs on the next touch */ } };

  return harden({
    // TOFU claim: bind accountKey→ownerKey on first touch; refuse a DIFFERENT owner (durably, across restarts).
    // Returns { ok:true } on success (own or first-use), { ok:false, foreign:true } if another cap owns it.
    claim: (accountKey, ownerKey) => {
      const ak = String(accountKey || '');
      const ok = String(ownerKey || '');
      const bound = map.get(ak);
      if (bound && bound !== ok) return harden({ ok: false, foreign: true });
      if (!bound) { map.set(ak, ok); persist(); }
      return harden({ ok: true });
    },
    ownerOf: accountKey => map.get(String(accountKey || '')),
    size: () => map.size,
  });
};
harden(makeTollOwnership);
