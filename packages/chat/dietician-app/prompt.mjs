// prompt.mjs — the evaluation rubric + verdict parser, ported from the persona's gen_prompts.py /
// reevaluate.py and the live bridge's voice-agent/dietician.mjs (EVAL_SYS / parseVerdict). This is the
// PORT-CRITICAL artifact: the verdict taxonomy, the exact output JSON schema, and the skepticism heuristics
// must survive verbatim — the evaluation quality lives here + in the judge model. Parameterized by the diet
// spec + the person name (generalized away from the hardcoded "Alexa", so any instance brings its own).
// Plain node (no Endo/harden).

// The system prompt fed to the judge. `spec` is the binding diet spec (read verbatim from the store's
// diet.md); `person` names the diner (defaults to a neutral label).
export const EVAL_SYS = ({ spec, person = 'the diner' } = {}) => {
  const name = person ? person.charAt(0).toUpperCase() + person.slice(1) : 'the diner';
  return [
    `You are evaluating ONE restaurant for whether **${name}** can safely eat there. Their binding diet spec:`,
    '--- BEGIN SPEC ---', spec || '(spec unavailable — be conservative)', '--- END SPEC ---',
    'Read the menu provided. Pick a verdict:',
    '- VIABLE — at least one orderable dish (possibly with simple mods) is clean for them, and the kitchen suggests cook-to-order.',
    '- BORDERLINE — viable only with major modification, call-ahead, or off-menu requests.',
    '- SKIP — nothing safely orderable, or the cuisine/format is fundamentally wrong.',
    '- UNKNOWN — the menu provided is not a real/usable menu.',
    'Be SKEPTICAL and honest — chains pre-marinate proteins; delis default to cured meats + aged cheese; Middle-Eastern places default to garlic/tahini/yogurt. Do NOT manufacture options. When unsure, prefer SKIP or UNKNOWN.',
    'Return ONLY a JSON object (no prose, no code fence) with exactly these keys:',
    '{"verdict":"VIABLE|BORDERLINE|SKIP|UNKNOWN","cuisine":"<what they actually serve>","summary":"1-2 honest sentences","promising_dishes":[{"name":"...","modifications":"...","residual_risk":"..."}],"avoid_outright":["dish — short reason"],"kitchen_flexibility":"1 sentence"}',
  ].join('\n');
};

// the user-content side: the one restaurant's name/address/type + the gathered menu text.
export const EVAL_USER = (place, menu) =>
  `Restaurant: ${place.name}\nAddress: ${place.address || ''}\nGoogle type: ${place.primary_type || ''}\n\nMENU (gathered):${menu || ' (none found)'}`;

// extract + validate the verdict JSON from a model reply (tolerant of prose/fences around it). null if invalid.
export const parseVerdict = txt => {
  const s = String(txt || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    return o && /^(VIABLE|BORDERLINE|SKIP|UNKNOWN)$/.test(o.verdict) ? o : null;
  } catch { return null; }
};
