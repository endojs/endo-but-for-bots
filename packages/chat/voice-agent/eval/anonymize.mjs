// anonymize.mjs — Task 2 / roadmap §6b. Turn a real user prompt into a SHAREABLE eval
// candidate, FAIL-CLOSED on anything secret or personal.
//
// Two axes, both fail-closed (a match => DROP the candidate, never emit a partial):
//   1. SECRETS (deterministic, always enforced): a swissnum / #cap fragment / 64-hex blob /
//      bearer-or-authorization token. These must NEVER reach a published artifact. A leaked
//      swissnum is permanent authority — so the rule is drop-on-any-match, no redaction.
//   2. PERSONAL DATA (email / phone / a "social" reference to a named person): generalizing
//      this safely needs the gemma rewrite pass. When gemma is reachable we rewrite; when it
//      is NOT (e.g. tinix down), we DROP rather than emit un-anonymized personal text.
//
// `npx ava anonymize.test.mjs` proves the fail-closed behaviour without a live model.

// ── 1. SECRET shapes — drop on any match (security-critical) ─────────────────────────────
const SECRET_PATTERNS = [
  { name: 'cap-fragment', re: /#cap=[0-9a-z]/i },
  { name: '64-hex (swissnum/key)', re: /\b[0-9a-f]{64}\b/i },
  { name: 'long-hex secret', re: /\b[0-9a-f]{40,}\b/i },
  { name: 'authorization token', re: /\b(authorization|bearer)\b\s*[:=]?\s*\S{8}|token\s+[0-9a-f]{16}/i },
  { name: 'private key', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
];
export const findSecret = text => {
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) return p.name;
  return null;
};

// ── 2. PERSONAL shapes — need the gemma generalize pass; drop when gemma is unavailable ──
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i;
const PHONE_RE = /(?<!\d)(\+?\d[\d().\s-]{7,}\d)(?!\d)/;
// Deterministic name-detection is inherently best-effort, so we err toward OVER-flagging (a
// flagged-clean prompt is merely dropped when gemma is down — safe; a missed name leaks — unsafe).
// Trigger is matched CASE-INSENSITIVELY (it may start a sentence: "Talk to Mansi"); the name must
// stay case-SENSITIVE (a real proper name has an uppercase initial), so we scan a window in code.
const TRIGGER_RE = /\b(?:talk(?:ed|ing)?|spoke|speak(?:ing)?|call(?:ed|ing)?|email(?:ed|ing)?|text(?:ed|ing)?|ask(?:ed|ing)?|met|meet(?:ing)?|referred|introduced|named|mention(?:ed|ing)?|with my|from my)\b/gi;
const NAME_RE = /\b[A-Z][a-z]{2,}\b/;
const PERSON_THEN_VERB = /\b[A-Z][a-z]{2,}\s+(?:said|told|asked|referred|mentioned|recommended|suggested|works at|is my|told me|wants|knows)\b/;
const hasNamedPerson = text => {
  TRIGGER_RE.lastIndex = 0;
  for (let m = TRIGGER_RE.exec(text); m; m = TRIGGER_RE.exec(text)) {
    const window = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (NAME_RE.test(window)) return true;     // a Capitalized name within ~4 words of the trigger
  }
  return PERSON_THEN_VERB.test(text);
};
export const findPII = text => {
  const hits = [];
  if (EMAIL_RE.test(text)) hits.push('email');
  if (PHONE_RE.test(text)) hits.push('phone');
  if (hasNamedPerson(text)) hits.push('named-person');
  return hits;
};

/**
 * anonymize(text, { gemma }) → { ok, text, reason, axes }
 *   ok:false  => DROP this candidate (never emit). reason explains which axis tripped.
 *   ok:true   => `text` is safe to emit (secrets clean AND (no PII OR gemma-generalized)).
 * `gemma` is an optional async (prompt) => string rewriter. If absent/unreachable, PII => drop.
 */
export const anonymize = async (rawText, { gemma = null } = {}) => {
  const text = String(rawText || '').trim();
  if (!text) return { ok: false, reason: 'empty', axes: {} };

  const secret = findSecret(text);
  if (secret) return { ok: false, reason: `secret:${secret}`, axes: { secret } };

  const pii = findPII(text);
  if (!pii.length) return { ok: true, text, reason: 'clean', axes: { pii: [] } };

  // PII present → must generalize via gemma, then RE-SCAN fail-closed.
  if (!gemma) return { ok: false, reason: `pii-needs-gemma:${pii.join(',')}`, axes: { pii } };
  let rewritten = '';
  try { rewritten = String(await gemma(text)).trim(); } catch (e) { return { ok: false, reason: `gemma-error:${e && e.message}`, axes: { pii } }; }
  if (!rewritten) return { ok: false, reason: 'gemma-empty', axes: { pii } };
  // re-scan the MODEL output fail-closed on BOTH axes (the model could echo a secret/name back).
  if (findSecret(rewritten)) return { ok: false, reason: 'gemma-output-leaked-secret', axes: { pii } };
  if (findPII(rewritten).length) return { ok: false, reason: 'gemma-output-still-pii', axes: { pii } };
  return { ok: true, text: rewritten, reason: 'gemma-generalized', axes: { pii } };
};
