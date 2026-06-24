// self-heal.mjs — promise-preserving error recovery (see designs/self-healing-errors.md).
//
// Run an attempt; if it THROWS, hand { source, error, ctx } to a fixer agent that returns patched source,
// make that source live (apply), and re-run — so the caller's awaited promise RESOLVES with the repaired
// value instead of rejecting. The error is repaired in the gap between throw and report; the user never sees
// it. Only works where `source` is runtime-mutable (recompile + re-run via `apply`). Bounded + never throws.
//
// Invariants: bounded attempts (no repair loops); confined (apply swaps BEHAVIOUR only — it can't widen the
// authority the code already holds; that's the ocap/SES layer's job, not ours); audited (the caller logs each
// returned patch). A fixer that returns null / no change / the same source ends the loop.

// makeSelfHealer({ fix, onHeal, max }) → { heal }
//   fix({ source, error, label, attempt, ctx }) → { source, summary? } | null   (an agent; injectable for tests)
//   heal({ attempt, source, apply, label, ctx }) → { ok, value?, error?, healed, patches }
export const makeSelfHealer = ({ fix, onHeal = () => {}, max = 2 } = {}) => {
  const heal = async ({ attempt, source, apply, label = '', ctx = {} }) => {
    let src = source;
    let lastErr = null;
    const patches = [];
    for (let i = 0; i <= max; i += 1) {
      try {
        const value = await attempt();
        return harden({ ok: true, value, healed: patches.length > 0, patches });
      } catch (e) {
        lastErr = (e && e.message) || String(e);
        if (i === max || typeof fix !== 'function' || typeof apply !== 'function') break; // out of tries / no fixer
        let patched = null;
        try { patched = await fix({ source: src, error: lastErr, label, attempt: i + 1, ctx }); }
        catch { patched = null; } // a fixer that itself errors just ends the loop — never escalates
        if (!patched || !patched.source || patched.source === src) break; // gave up / no change → stop
        try { await apply(patched.source); } catch { break; } // couldn't make the patch live → stop, surface the error
        const entry = { attempt: i + 1, error: lastErr, summary: String(patched.summary || '').slice(0, 300) };
        src = patched.source; patches.push(entry);
        try { onHeal({ label, ...entry }); } catch { /* logging is best-effort */ }
      }
    }
    return harden({ ok: false, error: lastErr, healed: false, patches });
  };
  return harden({ heal });
};
harden(makeSelfHealer);

// Wrap a raw fixer so its PATCH undergoes the same adversarial review every proposed tool faces before it's
// allowed to go live — a self-heal patch is new agent-authored code and must clear the same bar. `review` is the
// panel: ({ source, ctx }) → { worst, findings }. A patch whose worst severity is in `reject` (default the
// top rung) is refused (→ null), so a critically-flawed auto-repair is never applied; the verdict is folded
// into the patch summary for the audit log either way.
export const makeReviewedFixer = ({ fix, review, reject = ['critical'] } = {}) => {
  const rj = new Set(reject);
  return async input => {
    if (typeof fix !== 'function') return null;
    const patched = await fix(input);
    if (!patched || !patched.source) return null;
    if (typeof review !== 'function') return patched; // no panel wired → behave as the raw fixer
    let verdict = null;
    try { verdict = await review({ source: patched.source, ...input }); } catch { verdict = null; }
    if (verdict && rj.has(verdict.worst)) return null; // refuse to auto-apply a patch the panel flags this severely
    return harden({ ...patched, review: verdict, summary: `${patched.summary || 'auto-repair'}${verdict ? ` [review: ${verdict.worst}]` : ''}` });
  };
};
harden(makeReviewedFixer);
