// revise-loop.mjs — feed the discipline panel's findings BACK to the developer to autonomously improve
// the code (INTEGRATE a fix / NOTE why it's acceptable / UNIFY several findings into one elegant change),
// then RE-REVIEW — so a proposed component CONVERGES toward an elegant solution instead of dead-ending at
// admit/reject. The criticisms become a forcing function, not a wall.
//
// `revise` (the developer) and `runPanel` (the review) are INJECTED so the loop is fully testable without
// a model. In production: revise = a strong-model completion; runPanel = runReviewPanel.

const ORDER = ['none', 'low', 'medium', 'high', 'critical'];
const sevRank = s => { const i = ORDER.indexOf(String(s || 'none').toLowerCase()); return i < 0 ? 0 : i; };
const ACCEPTABLE = 'low'; // worst severity at/below which we stop (none/low are fine to admit)

// reviseToConverge({ record, revise, runPanel, maxRounds })
//   record   — { name, description, kind, code, review? }  (single-file source today)
//   revise   — async ({ source, findings, name, description, round }) → { source, resolutions:[{finding,action,how}] }
//   runPanel — async ({ name, description, kind, code }) → { findings:[{discipline,severity,report}], worst }
// → { source, review, reviseLog:[{round,worstBefore,worstAfter,resolutions}|{round,error}], rounds, converged }
export const reviseToConverge = async ({ record, revise, runPanel, maxRounds = 3 } = {}) => {
  if (!record || typeof revise !== 'function' || typeof runPanel !== 'function') return { source: '', review: { worst: 'unknown', findings: [] }, reviseLog: [], rounds: 0, converged: false, error: 'missing record/revise/runPanel' };
  const base = { name: record.name, description: record.description, kind: record.kind };
  let source = String(record.code || '');
  let review = record.review || (await runPanel({ ...base, code: source }));
  const reviseLog = []; let rounds = 0;
  while (rounds < maxRounds && sevRank(review.worst) > sevRank(ACCEPTABLE)) {
    rounds += 1;
    const worstBefore = review.worst;
    let r;
    try { r = await revise({ source, findings: review.findings || [], name: record.name, description: record.description, round: rounds }); }
    catch (e) { reviseLog.push({ round: rounds, worstBefore, error: String((e && e.message) || e) }); break; }
    if (!r || !r.source || !String(r.source).trim()) { reviseLog.push({ round: rounds, worstBefore, error: 'the reviser produced no source' }); break; }
    source = String(r.source);
    review = await runPanel({ ...base, code: source });
    reviseLog.push({ round: rounds, worstBefore, worstAfter: review.worst, resolutions: Array.isArray(r.resolutions) ? r.resolutions : [] });
    // no-progress guard: if a round did not reduce the worst severity, stop rather than burn rounds.
    if (sevRank(review.worst) >= sevRank(worstBefore)) break;
  }
  return { source, review, reviseLog, rounds, converged: sevRank(review.worst) <= sevRank(ACCEPTABLE) };
};
harden(reviseToConverge);
