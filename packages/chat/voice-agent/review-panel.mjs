// review-panel.mjs — run the per-discipline adversarial reviewers over a submitted tool/island and
// aggregate their findings, so the human (social-collateral) admission gate is informed by every
// discipline before anything is admitted. The reviewers reason over the PROVIDED code (the submission
// is passed inline), so no host powers are needed — we run their ROLE_CATALOG rubric as a direct LLM
// review. (`employ('ocap', …)` is still available for a deeper, tool-using review on demand.)

import { ROLE_CATALOG } from './agent-roles.mjs';

// The disciplines run on every submission, in panel order.
export const PANEL = ['ocapReviewer', 'propagatorReviewer', 'capHygieneReviewer', 'sharingReviewer'];

const SEVERITY = ['none', 'low', 'medium', 'high', 'critical'];
const sevRank = s => Math.max(0, SEVERITY.indexOf(String(s || 'none').toLowerCase()));
export const worstOf = severities => SEVERITY[Math.max(0, ...severities.map(sevRank))];

// Build the submission text the reviewers read (no swissnum — tool records never hold one).
const submissionText = ({ name, description, kind, code, files, entry }) => {
  const head = `SUBMISSION: ${name || '(unnamed)'}  [kind: ${kind || 'instance'}]\n${description ? `Description: ${description}\n` : ''}`;
  if (files && typeof files === 'object') {
    const body = Object.entries(files).map(([f, src]) => `--- ${f} ---\n${String(src).slice(0, 12000)}`).join('\n\n');
    return `${head}entry: ${entry || 'tool.js'}\n\n${body}`;
  }
  return `${head}\n\`\`\`js\n${String(code || '').slice(0, 16000)}\n\`\`\``;
};

const VERDICT_RE = /VERDICT:\s*(none|low|medium|high|critical)/i;

// Run ONE reviewer rubric over the submission via the provided LLM. Returns {discipline, severity, report}.
const runOne = async (key, text, callLLM) => {
  const role = ROLE_CATALOG[key];
  const sys = `${role.prompt}\nEnd your reply with a final line EXACTLY: "VERDICT: <none|low|medium|high|critical>" — the single highest severity you found (none if clean).`;
  let out = '';
  try { const r = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: `Review this submission for ${role.label} discipline:\n\n${text}` }], 'default'); out = String((r && (r.text || r.answer)) || ''); }
  catch (e) { return { discipline: role.label, key, severity: 'unknown', report: `(review failed: ${(e && e.message) || e})` }; }
  const m = VERDICT_RE.exec(out);
  return { discipline: role.label, key, severity: m ? m[1].toLowerCase() : 'unknown', report: out.replace(VERDICT_RE, '').trim().slice(0, 4000) };
};

// Run the whole panel (in parallel) over a tool record. Returns the persisted `review` shape.
export const runReviewPanel = async (record, { callLLM, disciplines = PANEL, ranAt = '' } = {}) => {
  const text = submissionText(record);
  const findings = await Promise.all(disciplines.map(k => runOne(k, text, callLLM)));
  const worst = worstOf(findings.map(f => f.severity === 'unknown' ? 'none' : f.severity));
  return { findings, worst, ranAt, disciplines };
};
