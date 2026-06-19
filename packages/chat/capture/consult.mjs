// consult.mjs — when a capture is a QUESTION, try to answer it from the agent's
// bootstrap reference sources (the little-free-library now; Wikipedia/Kiwix when
// available) and return an answer so the caller can push it. Bounded + fail-soft:
// any error or low confidence → { answered: false }.

import { E } from '@endo/eventual-send';
import { getLibraryIndex, extractBookText, retrievePassages } from './library.mjs';
import { makeObsidianGraph } from './obsidian-graph.mjs';

// The endo object for dan's personal notes (read-only; no send method).
const graph = makeObsidianGraph();

const GEMMA_URL = process.env.FIELD_GEMMA_URL || 'http://192.168.50.226:8003/v1/chat/completions';
const GEMMA_MODEL = process.env.FIELD_GEMMA_MODEL || 'default';
// Kiwix (local Wikipedia mirror on friky). Empty until a ZIM is serving.
const KIWIX_URL = process.env.FIELD_KIWIX_URL || '';

const gemma = async (messages, maxTokens = 400) => {
  const res = await fetch(GEMMA_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: GEMMA_MODEL, messages, max_tokens: maxTokens, temperature: 0.1 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`gemma ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content?.trim() || '';
};
const gemmaJSON = async (messages, maxTokens) => {
  const raw = await gemma(messages, maxTokens);
  const m = raw.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
};

// Reject gemma "answers" that are really about the passages being inadequate —
// so we never push a non-answer.
const isNonAnswer = a => !a || /NO_ANSWER/.test(a) ||
  /(does not|doesn'?t|do not|don'?t|did not)\s+(contain|include|provide|address|mention|explain|specify|cover|detail)|(the (text|passage|passages|excerpt|content)s?\b[^.]{0,40}\b(do(es)? not|doesn'?t|lack|only))|cannot (be )?(answer|determine|find)|no (relevant |specific )?(information|content|details|answer)|not (enough|sufficient) (information|context|detail)|unable to (answer|determine)/i.test(a);

const ANSWER_SYS = 'Answer the question using ONLY the provided text. If the text does not actually contain the answer, reply with EXACTLY "NO_ANSWER" and nothing else — do NOT describe what the text contains or mention chapters/structure. Be concise and factual.';

const looksLikeQuestion = t =>
  /\?/.test(t) || /\b(what|who|whom|whose|when|where|why|how|which|is|are|was|were|does|do|did|can|could|should|would|will)\b/i.test(t.slice(0, 200));

// --- personal notes consult (the Obsidian graph endo object) ----------------
const consultPersonalNotes = async (question, trail) => {
  let hits;
  try { hits = await E(graph).search(question, { limit: 5 }); }
  catch (e) { trail.push(`Personal notes: search failed (${e.message}).`); return null; }
  if (!hits || !hits.length) { trail.push('Personal notes: no matching notes.'); return null; }
  let ctx = '';
  const used = [];
  for (const h of hits) {
    let c = '';
    try { c = await E(graph).read(h.path); } catch { continue; }
    ctx += `\n## ${h.title}\n${c.slice(0, 3500)}\n`;
    used.push(h.title);
    if (ctx.length > 14000) break;
  }
  if (!ctx) { trail.push('Personal notes: matched notes but could not read them.'); return null; }
  let ans;
  try {
    ans = await gemma([
      { role: 'system', content: ANSWER_SYS },
      { role: 'user', content: `Question: ${question}\n\nFrom dan's personal notes:\n${ctx.slice(0, 15000)}` },
    ], 400);
  } catch (e) { trail.push(`Personal notes: answer step failed (${e.message}).`); return null; }
  if (isNonAnswer(ans)) { trail.push(`Personal notes: checked ${used.length} note(s) (${used.slice(0, 3).join(', ')}) — no answer.`); return null; }
  trail.push(`Personal notes: answered from ${used.slice(0, 3).join(', ')}.`);
  return { answer: ans, source: `your notes — ${used.slice(0, 3).join(', ')}`, kind: 'personal' };
};

// --- library consult --------------------------------------------------------
// `trail` is an array we append human-readable decision steps to (saved into
// the capture note so the reasoning is visible in Obsidian).
const consultLibrary = async (question, trail) => {
  const index = await getLibraryIndex();
  if (!index || !index.length) { trail.push('Library: index empty / unreachable.'); return null; }
  const titles = index.slice(0, 200).map((e, i) => `${i}: ${e.title}`).join('\n');
  let pick;
  try {
    pick = await gemmaJSON([
      { role: 'system', content: 'Pick the single book most likely to answer the question, or none. Return JSON {"i": <index or -1>}.' },
      { role: 'user', content: `Question: ${question}\n\nBooks:\n${titles}` },
    ], 60);
  } catch (e) { trail.push(`Library: book-selection failed (${e.message}).`); return null; }
  const i = pick && Number.isInteger(pick.i) ? pick.i : -1;
  if (i < 0 || i >= index.length) { trail.push(`Library: no relevant book among ${index.length} titles.`); return null; }
  const book = index[i];
  const text = await extractBookText(book.path).catch(() => '');
  if (!text) { trail.push(`Library: selected "${book.title}" but could not extract its text.`); return null; }
  const passages = retrievePassages(text, question);
  if (!passages) { trail.push(`Library: "${book.title}" had no passages matching the question.`); return null; }
  let ans;
  try {
    ans = await gemma([
      { role: 'system', content: ANSWER_SYS },
      { role: 'user', content: `Question: ${question}\n\nPassages from "${book.title}":\n${passages.slice(0, 15000)}` },
    ], 400);
  } catch (e) { trail.push(`Library: answer step failed (${e.message}).`); return null; }
  if (isNonAnswer(ans)) { trail.push(`Library: "${book.title}" did not contain the answer.`); return null; }
  trail.push(`Library: answered from "${book.title}".`);
  return { answer: ans, source: book.title, kind: 'library' };
};

// --- wikipedia (kiwix) consult ---------------------------------------------
const consultWikipedia = async (question, trail) => {
  if (!KIWIX_URL) { trail.push('Wikipedia: offline (local Kiwix mirror still downloading).'); return null; }
  try {
    const terms = (question.match(/[A-Za-z][A-Za-z'-]{3,}/g) || []).slice(0, 6).join(' ');
    const s = await fetch(`${KIWIX_URL}/search?pattern=${encodeURIComponent(terms)}&pageLength=1`, { signal: AbortSignal.timeout(15000) });
    if (!s.ok) { trail.push(`Wikipedia: search failed (${s.status}).`); return null; }
    const html = await s.text();
    const m = html.match(/href="([^"]*\/A\/[^"]+)"/i);
    if (!m) { trail.push('Wikipedia: no article matched.'); return null; }
    const art = await fetch(`${KIWIX_URL}${m[1]}`, { signal: AbortSignal.timeout(15000) });
    if (!art.ok) { trail.push('Wikipedia: article fetch failed.'); return null; }
    const text = (await art.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12000);
    if (!text) { trail.push('Wikipedia: empty article.'); return null; }
    const ans = await gemma([
      { role: 'system', content: ANSWER_SYS },
      { role: 'user', content: `Question: ${question}\n\nWikipedia:\n${text}` },
    ], 400);
    if (isNonAnswer(ans)) { trail.push('Wikipedia: article did not contain the answer.'); return null; }
    trail.push('Wikipedia: answered.');
    return { answer: ans, source: 'Wikipedia', kind: 'wikipedia' };
  } catch (e) { trail.push(`Wikipedia: error (${e.message}).`); return null; }
};

// Main: returns { answered, answer, source, trail } — never throws. `trail` is a
// readable record of what was consulted + why, saved into the capture note.
export const consultReferences = async question => {
  const trail = [];
  try {
    if (!question || !looksLikeQuestion(question)) {
      trail.push('Not a question/request — skipped reference lookup.');
      return { answered: false, trail };
    }
    trail.push('Detected a question/request — consulting bootstrap reference sources.');
    const personal = await consultPersonalNotes(question, trail).catch(e => { trail.push(`Personal notes: error (${e.message}).`); return null; });
    if (personal) { trail.push('→ Answer found; pushing it to your phone.'); return { answered: true, ...personal, trail }; }
    const lib = await consultLibrary(question, trail).catch(e => { trail.push(`Library: error (${e.message}).`); return null; });
    if (lib) { trail.push(`→ Answer found; pushing it to your phone.`); return { answered: true, ...lib, trail }; }
    const wiki = await consultWikipedia(question, trail).catch(e => { trail.push(`Wikipedia: error (${e.message}).`); return null; });
    if (wiki) { trail.push(`→ Answer found; pushing it to your phone.`); return { answered: true, ...wiki, trail }; }
    trail.push('→ No answer in available references — nothing pushed. (The agent can only read your books + Wikipedia, not personal data like contacts/notes/email.)');
    return { answered: false, trail };
  } catch (e) {
    trail.push(`consult error: ${e.message}`);
    return { answered: false, trail };
  }
};
