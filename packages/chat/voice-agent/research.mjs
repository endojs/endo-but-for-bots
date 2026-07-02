// research.mjs — an orchestrator-worker RESEARCH TEAM the field agent can employ.
//
// Pattern from "Composing Agentic LLM Research Systems" (the reference Anthropic-Research
// design): a LEAD plans (decomposes the query into non-overlapping sub-questions, scaled to
// complexity) → spawns PARALLEL sub-agents each with an ISOLATED context (search → read top
// pages → distill to a dense summary + sources) → a SYNTHESIS + CITATION pass assembles a
// cited report. Sub-agents' raw search/page dumps stay isolated; only the distilled
// summaries reach synthesis ("search is compression"). Runs on the LOCAL model (tinix
// gemma), so the ~N× token cost is GPU time, not cloud $.
//
// `tools` is injected by the caller (so confinement holds): { webSearch, fetchUrl, consult }.
// webSearch (Brave) is preferred; falls back to consult (library + Wikipedia) when no key.
import fs from 'node:fs';
import path from 'node:path';

import { VOICE_STATE_DIR, AGENT_LLM } from './field-config.mjs';

// PORT-6: the AGENT_LLM endpoint now comes from the centralized field-config seam (byte-identical
// default; honors the same process.env.AGENT_LLM override), so a single TINIX_HOST/AGENT_LLM env
// relocates gemma for server.mjs + research.mjs together.
const LLM = AGENT_LLM;
// Personal-family path resolves through field-config (byte-identical default on the NUC;
// rebases onto FIELD_PERSONAL_ROOT when the personal volume is mounted).
const NOTES_DIR = path.join(VOICE_STATE_DIR, 'research');

const callModel = async (messages, { maxTokens = 800, temperature = 0.3 } = {}) => {
  const r = await fetch(LLM, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'default', messages, max_tokens: maxTokens, temperature }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`LLM ${r.status}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '').trim();
};

const parseQuestions = (txt, max) => {
  const lines = String(txt).split('\n').map(l => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim()).filter(l => l.length > 8 && l.length < 240);
  return [...new Set(lines)].slice(0, max);
};

// one ISOLATED sub-agent: search → read top pages → distill. Returns {q, summary, sources}.
// Emits richly-tagged events (sub:i) so the live trace can show EACH action — the search,
// each fetch (with its URL), and the slow "distilling" gemma step — under this sub-question,
// instead of a long stretch of dead air while it reads + summarizes.
const subAgent = async (q, tools, emit, i) => {
  const sources = []; const used = []; let corpus = '';
  let res = null;
  try { res = tools.webSearch ? await tools.webSearch(q) : null; } catch {}
  if (res && res.ok && Array.isArray(res.results) && res.results.length) {
    emit({ kind: 'tool', sub: i, name: 'webSearch', detail: q }); used.push('webSearch');
    for (const hit of res.results.slice(0, 3)) {
      try {
        const page = tools.fetchUrl ? await tools.fetchUrl(hit.url) : null;
        const text = page && (page.text || page.summary || page.content || '');
        if (text) { corpus += `\n\n[${hit.url}] ${hit.title}\n${String(text).slice(0, 2500)}`; sources.push(hit.url); emit({ kind: 'tool', sub: i, name: 'fetchUrl', detail: hit.url }); used.push('fetchUrl'); }
      } catch {}
    }
  }
  if (!corpus && tools.consult) { // fallback: library + Wikipedia (always available, no key)
    try { const c = await tools.consult(q); const a = c && (c.answer || c.text || (typeof c === 'string' ? c : '')); if (a) { corpus += `\n\n[library/Wikipedia]\n${String(a).slice(0, 3000)}`; if (c.source) sources.push(String(c.source)); emit({ kind: 'tool', sub: i, name: 'consult', detail: q }); used.push('consult'); } } catch {}
  }
  if (!corpus) { emit({ kind: 'subdone', sub: i, summary: '(no sources found)', ok: false }); return { q, summary: '(no sources found for this sub-question)', sources, used }; }
  emit({ kind: 'distill', sub: i, state: 'start' }); // the SLOW part — represent it (no dead air)
  const summary = await callModel([
    { role: 'system', content: 'You are a research sub-agent. Read the gathered sources and write a DENSE 4–8 sentence summary answering the sub-question. Cite source URLs inline as (url). State only what the sources support; flag uncertainty. No preamble.' },
    { role: 'user', content: `Sub-question: ${q}\n\nSources:${corpus}` },
  ], { maxTokens: 500 });
  emit({ kind: 'subdone', sub: i, summary, ok: true });
  return { q, summary, sources, used };
};

export const runResearch = async ({ query, depth, tools = {}, onStep = () => {} } = {}) => {
  const q = String(query || '').trim();
  if (!q) return harden({ ok: false, error: 'empty query' });
  const max = depth === 'deep' ? 5 : depth === 'quick' ? 2 : 3; // effort scaling (doc §A)
  // 1) PLAN — decompose breadth-first into non-overlapping sub-questions
  let plan = [];
  try {
    const planTxt = await callModel([
      { role: 'system', content: `You are a lead researcher. Decompose the user's question into ${max} focused, NON-overlapping sub-questions that together cover it breadth-first. One per line, numbered, no preamble.` },
      { role: 'user', content: q },
    ], { maxTokens: 300 });
    plan = parseQuestions(planTxt, max);
  } catch {}
  if (!plan.length) plan = [q];
  onStep({ kind: 'plan', subs: plan.map((p, i) => ({ i, q: p })) }); // the decomposition = "what's in its head"
  // 2) FAN OUT — parallel, context-isolated sub-agents (each streams its own actions, tagged sub:i)
  const findings = await Promise.all(plan.map((sq, i) => subAgent(sq, tools, onStep, i).catch(e => { onStep({ kind: 'subdone', sub: i, summary: `(error: ${e.message})`, ok: false }); return { q: sq, summary: `(error: ${e.message})`, sources: [], used: [] }; })));
  // 3) SYNTHESIZE + CITATIONS
  const sources = [...new Set(findings.flatMap(f => f.sources))];
  const srcList = sources.map((u, i) => `[${i + 1}] ${u}`).join('\n') || '(no external sources — based on the local library/Wikipedia)';
  let report = '';
  onStep({ kind: 'synth', state: 'start' }); // the lead writing the report — the other slow phase
  try {
    report = await callModel([
      { role: 'system', content: 'You are the lead researcher. Synthesize the sub-agent findings into a clear, well-structured report answering the ORIGINAL question. Use inline citations [n] referencing the numbered sources where possible. Be explicit about gaps/uncertainty. End with a "Sources" list.' },
      { role: 'user', content: `Question: ${q}\n\nSub-findings:${findings.map(f => `\n\n## ${f.q}\n${f.summary}`).join('')}\n\nNumbered sources:\n${srcList}` },
    ], { maxTokens: 1200 });
  } catch (e) { report = `(synthesis failed: ${e.message})`; }
  onStep({ kind: 'synth', state: 'done', detail: report.slice(0, 400) });
  // persist the research artifact (external memory + auditable trace)
  let savedTo = '';
  try {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    savedTo = path.join(NOTES_DIR, `research-${Date.now()}.md`);
    fs.writeFileSync(savedTo, `# ${q}\n\n## Plan\n${plan.map(p => `- ${p}`).join('\n')}\n\n${findings.map(f => `## ${f.q}\n${f.summary}\n\nsources: ${f.sources.join(', ') || '(none)'}\n`).join('\n')}\n## Report\n${report}\n`);
  } catch {}
  // surface the sub-agents' REAL tool usage for the 3D trace (nests like delegateTask)
  const toolsUsed = findings.flatMap(f => (f.used || []).map(name => ({ name })));
  return harden({ ok: true, query: q, plan, report, findings: findings.map(f => ({ q: f.q, summary: f.summary, sources: f.sources, used: f.used || [] })), sources, savedTo, toolsUsed });
};
harden(runResearch);
