// agent-caps-bundle.mjs — designation by REFERENCE, not by name.
//
// This is the ocap-correct successor to the field agent's string-name power set
// (see the "OCAP DEBT" note in agent-caps.mjs makeAgentNode). The old form
// designated authority by a NAME-SET (powers are STRINGS), which is itself the
// ocap smell dan flagged: a name is forgeable — code can emit a string for a
// power it was never given. The correct form is designation by REFERENCE: a
// bundle HOLDS the actual Far power references keyed by petname, and you can
// only ever hand out a SUBSET of what you already hold. You cannot name what you
// do not hold.
//
// makeCapabilityBundle(refs) → a hardened Far('CapabilityBundle', …) with:
//   names()                → the petnames it actually holds a ref for
//   has(petname)           → true iff it holds that ref
//   get(petname)           → the held Far ref, or undefined (never fabricated)
//   attenuate(requested)   → a NEW bundle = (requested ∩ own). A superset request
//                            yields exactly the own refs; absent names are dropped,
//                            never minted. Attenuation is monotonic — a sub-bundle
//                            can never re-grow to reach a ref the parent withheld.
//
// This module is intentionally dependency-free (only @endo/marshal's Far +
// the global `harden` from @endo/init / lockdown) so the permission core is
// testable + portable without dragging in the agent's heavy I/O affordances.
import { Far } from '@endo/marshal';

export const makeCapabilityBundle = (refs = {}) => {
  // Snapshot ONLY own, defined entries — never inherit/leak a prototype name,
  // and never carry an `undefined`/`null` (an absent ref) into the bundle.
  const own = harden(Object.fromEntries(
    Object.entries(refs || {}).filter(([, ref]) => ref !== undefined && ref !== null),
  ));
  const names = harden(Object.keys(own));
  const nameSet = new Set(names);
  return harden(Far('CapabilityBundle', {
    names: () => harden([...names]),
    has: petname => nameSet.has(String(petname)),
    // Resolve a petname to its held Far ref — or undefined if not held. There is
    // no way to obtain a ref the bundle does not already hold.
    get: petname => own[String(petname)],
    // attenuate(requested) → INTERSECTION of the requested petnames with the
    // ones THIS bundle holds. Absent names are silently dropped (cannot be
    // fabricated); attenuate(superset) === own refs.
    attenuate: (requested = []) => {
      const want = Array.isArray(requested) ? requested : Object.keys(requested || {});
      const sub = {};
      for (const p of want) { const k = String(p); if (nameSet.has(k)) sub[k] = own[k]; }
      return makeCapabilityBundle(sub);
    },
  }));
};
