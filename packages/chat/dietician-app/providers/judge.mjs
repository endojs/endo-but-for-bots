// providers/judge.mjs — the injected LLM evaluator. Wraps a `complete` adapter (the package's anthropic.mjs,
// the SES opusComplete, or a fake in tests) + an optional `localComplete` fallback, and turns a (spec, place,
// menu) into a validated verdict object. UNKNOWN is the SAFE default: if the model can't produce a valid
// verdict — or there is no usable menu — the place is UNKNOWN, never a false VIABLE. Mirrors the live bridge's
// dietician.mjs evaluateArea judging (opus → local fallback → UNKNOWN). Plain node.
import { EVAL_SYS, EVAL_USER, parseVerdict } from '../prompt.mjs';

const norm = (v, place) => ({
  verdict: v.verdict,
  cuisine: v.cuisine || place.primary_type || '',
  summary: String(v.summary || '').slice(0, 600),
  promising_dishes: Array.isArray(v.promising_dishes) ? v.promising_dishes.slice(0, 8) : [],
  avoid_outright: Array.isArray(v.avoid_outright) ? v.avoid_outright.slice(0, 12) : [],
  kitchen_flexibility: String(v.kitchen_flexibility || '').slice(0, 300),
});

export const makeJudge = ({ complete, localComplete } = {}) => ({
  // evaluate ONE place against the spec + a gathered menu → verdict object (always returns a verdict).
  evaluate: async ({ spec, person, place, menu, signal } = {}) => {
    const system = EVAL_SYS({ spec, person });
    const prompt = EVAL_USER(place, menu);
    let v = null;
    if (menu && typeof complete === 'function') { const a = await complete({ system, prompt, maxTokens: 900, signal }); if (a) v = parseVerdict(a); }
    if (!v && menu && typeof localComplete === 'function') { const a = await localComplete({ system, prompt, signal }); if (a) v = parseVerdict(a); }
    if (!v) {
      v = {
        verdict: 'UNKNOWN', cuisine: place.primary_type || '',
        summary: menu ? 'Could not produce a confident verdict from the menu.' : 'No usable menu found.',
        promising_dishes: [], avoid_outright: [], kitchen_flexibility: 'N/A',
      };
    }
    return norm(v, place);
  },
});
