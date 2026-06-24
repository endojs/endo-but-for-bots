// tool-bridge.mjs — a voice/text agent whose TOOLS are Endo capabilities. The reasoning model
// (gemma @ tinix:8003) is probabilistic; its AUTHORITY is not. The agent can only invoke the
// caps in the bundle it was handed — "correct by lexical construction": there is no name for it
// to reach a power outside the bundle, no matter what it emits. This is the confinement layer
// for a real-time voice agent (Moshi feeds `userText` in; the agent's reach is this cap bundle).
//
// Two tools to start (both already real media caps): generateImage (tinix GPU) + saveNote (vault).
import '@endo/init';
import fs from 'node:fs';
import { Far } from '@endo/marshal';
// Lazy GPU image generator: imported on FIRST use (inside generateImage.run) rather than at module load,
// so importing this module on a host WITHOUT the GPU box (CI / tests) does not hard-fail. Path overridable.
const GPU_GEN_MODULE = process.env.GPU_GEN_MODULE || '/home/dan/gpu-img/gen.mjs';
let _generate = null;
const generate = async (...a) => {
  if (!_generate) { ({ generate: _generate } = await import(GPU_GEN_MODULE)); }
  return _generate(...a);
};

const LLM = process.env.AGENT_LLM || 'http://192.168.50.226:8003/v1/chat/completions';

// ── the cap bundle: the agent's ENTIRE authority. Each cap is attenuated to one verb. ──────────
// Returns { toolbox: {name → Far cap}, manifest: [{name, description, args}] (data for the prompt) }.
export const makeToolbox = ({ outDir }) => {
  fs.mkdirSync(outDir, { recursive: true });
  const toolbox = harden({
    generateImage: Far('generateImage', {
      run: async ({ prompt }) => {
        const p = String(prompt || '').trim().slice(0, 400);
        if (!p) throw new Error('prompt required');
        const r = await generate(p, { steps: 4, width: 512, height: 512, seed: Math.floor(Date.now() % 1e9) });
        const file = `${outDir}/image-${Date.now()}.png`;
        fs.writeFileSync(file, r._buf);
        return harden({ ok: true, savedTo: file, prompt: p, bytes: r.info.bytes, ms: r.info.ms });
      },
      // REVERSIBLE: barge-in / cancel kills the in-flight GPU job (ComfyUI interrupt). The
      // escape-token retraction = invoking this abort (structural, like revoke()).
      abort: async () => { try { await fetch('http://192.168.50.226:8188/interrupt', { method: 'POST' }); } catch (e) { /* best effort */ } },
    }),
    saveNote: Far('saveNote', {
      run: async ({ title, body }) => {
        const safe = (String(title || 'note').replace(/[^\w -]/g, '').trim().slice(0, 60)) || 'note';
        const file = `${outDir}/${safe}.md`;
        fs.writeFileSync(file, String(body || ''));
        return harden({ ok: true, savedTo: file });
      },
    }),
  });
  // reversible (abortable: speculate + revoke) vs commit-only (only fire when committed/reached).
  const manifest = harden([
    { name: 'generateImage', description: 'Generate an image on the GPU and save it. Returns the file path.', args: { prompt: 'string — what to draw' }, reversible: true },
    { name: 'saveNote', description: 'Save a markdown note to the vault.', args: { title: 'string', body: 'string' }, reversible: false },
  ]);
  return harden({ toolbox, manifest });
};
harden(makeToolbox);

// OpenRouter routing: a model id of `openrouter:<slug>` (chosen in the provider menu) is dispatched
// to OpenRouter instead of the local gemma. The key is read lazily from the env, then the field-agent
// secret vault, then ~/.env — never hard-coded. No key → a clear message the agent surfaces as its reply.
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
let orKeyCache;
const openrouterKey = () => {
  if (orKeyCache !== undefined) return orKeyCache;
  if (process.env.OPENROUTER_API_KEY) { orKeyCache = process.env.OPENROUTER_API_KEY.trim(); return orKeyCache; }
  try { const s = fs.readFileSync('/home/dan/.config/field-agent/secrets/openrouter-api-key', 'utf8').trim(); if (s) { orKeyCache = s; return orKeyCache; } } catch { /* none */ }
  try { const env = fs.readFileSync('/home/dan/.env', 'utf8'); const m = env.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.+)\s*$/m); orKeyCache = m ? m[1].trim().replace(/^["']|["']$/g, '') : null; } catch { orKeyCache = null; }
  return orKeyCache;
};

// Anthropic routing: a model id of `anthropic:<id>` (the Claude entries in the provider menu) goes DIRECT to
// the Anthropic Messages API with the operator's ANTHROPIC_API_KEY — NOT through OpenRouter. Key precedence
// matches OpenRouter: env, then the field-agent secret vault, then ~/.env.
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
let anKeyCache;
const anthropicKey = () => {
  if (anKeyCache !== undefined) return anKeyCache;
  if (process.env.ANTHROPIC_API_KEY) { anKeyCache = process.env.ANTHROPIC_API_KEY.trim(); return anKeyCache; }
  try { const s = fs.readFileSync('/home/dan/.config/field-agent/secrets/anthropic-api-key', 'utf8').trim(); if (s) { anKeyCache = s; return anKeyCache; } } catch { /* none */ }
  try { const env = fs.readFileSync('/home/dan/.env', 'utf8'); const m = env.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/m); anKeyCache = m ? m[1].trim().replace(/^["']|["']$/g, '') : null; } catch { anKeyCache = null; }
  return anKeyCache;
};
// OpenAI-style chat messages → Anthropic Messages format: `system` is a top-level field; user/assistant turns
// carry text (CodeMode is text-in/text-out, so multimodal blocks degrade to their text parts).
const toAnthropicText = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && p.type === 'text') ? p.text : (typeof p === 'string' ? p : '')).join('') : String(c == null ? '' : c));

// callLLM(messages, model) → { text, usage } where `usage` is the provider's token
// accounting (OpenAI/gemma {prompt_tokens,…} or OpenRouter, or null when a call
// short-circuits to an error string). Increment 0 of the toll-bridge: we used to drop
// usage; the metered seam (meter.mjs) needs it to price each call.
// maxTokens is the OUTPUT ceiling per call (NOT input) — it only ALLOWS longer replies, it does not
// force them, so a higher default is safe for the short classifier calls and gives the main reasoning
// loop room for sprawling programs/answers (the old 700 throttled long voice-note replies).
// Some newer models (Anthropic's Opus 4.8 and kin) REJECT a `temperature` field with a 400 ("temperature is
// deprecated for this model"). The native Anthropic path NEVER sends temperature — its newest models deprecate
// it, matching delegate.mjs and the dietician judge. The OpenAI-style paths (OpenRouter / LiteLLM) send a low
// temperature for determinism but SELF-HEAL: on a 400 that complains about `temperature` we remember the model
// and retry once without it, so any temperature-deprecating model a proxy routes to keeps working.
const NO_TEMP = new Set();
const fetchChat = async (url, headers, makeBody, id, timeoutMs) => {
  const post = extra => fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers, body: JSON.stringify(makeBody(extra)) });
  let r = await post(NO_TEMP.has(id) ? {} : { temperature: 0.2 });
  if (!r.ok && r.status === 400 && !NO_TEMP.has(id) && /temperature/i.test(await r.clone().text().catch(() => ''))) {
    NO_TEMP.add(id);
    r = await post({});
  }
  return r;
};

export const callLLM = async (messages, model = 'default', { maxTokens = 4096 } = {}) => {
  if (String(model).startsWith('anthropic:')) {
    const id = String(model).slice('anthropic:'.length);
    const key = anthropicKey();
    if (!key) return harden({ text: '', usage: null, error: `${id}: no ANTHROPIC_API_KEY configured — add ANTHROPIC_API_KEY to ~/.env (or the field-agent secret), then pick this model again.` });
    const system = messages.filter(m => m.role === 'system').map(m => toAnthropicText(m.content)).join('\n\n');
    const msgs = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: toAnthropicText(m.content) }));
    try {
      const r = await fetch(ANTHROPIC, { method: 'POST', signal: AbortSignal.timeout(120000),
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: id, max_tokens: maxTokens, ...(system ? { system } : {}), messages: msgs }) }); // NO temperature — Opus 4.8 & kin 400 on it
      if (!r.ok) return harden({ text: '', usage: null, status: r.status, error: `${id} via Anthropic returned ${r.status}${r.status === 429 ? ' (rate-limited)' : ''}: ${(await r.text().catch(() => '')).slice(0, 160)}` });
      const j = await r.json();
      // Return the RAW Anthropic usage ({input_tokens, output_tokens, cache_*}) — costModel prices it natively.
      return harden({ text: Array.isArray(j.content) ? j.content.filter(c => c.type === 'text').map(c => c.text).join('') : '', usage: j.usage || null });
    } catch (e) { return harden({ text: '', usage: null, error: `${id} via Anthropic unreachable: ${e.message}` }); }
  }
  if (String(model).startsWith('openrouter:')) {
    const slug = String(model).slice('openrouter:'.length);
    const key = openrouterKey();
    if (!key) return harden({ text: '', usage: null, error: `${slug}: no OpenRouter API key configured — add OPENROUTER_API_KEY to ~/.env (or the field-agent secret), then pick this model again.` });
    try {
      const r = await fetchChat(OPENROUTER, { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://archua.taildd002.ts.net', 'X-Title': 'field-agent' },
        extra => ({ model: slug, messages, max_tokens: maxTokens, ...extra, usage: { include: true } }), slug, 90000); // usage.include → authoritative cost back
      if (!r.ok) return harden({ text: '', usage: null, status: r.status, error: `${slug} via OpenRouter returned ${r.status}${r.status === 429 ? ' (rate-limited upstream)' : ''}: ${(await r.text()).slice(0, 160)}` });
      const j = await r.json();
      return harden({ text: j.choices?.[0]?.message?.content || '', usage: j.usage || null });
    } catch (e) { return harden({ text: '', usage: null, error: `${slug} via OpenRouter unreachable: ${e.message}` }); }
  }
  let r;
  try { r = await fetchChat(LLM, { 'content-type': 'application/json' },
    extra => ({ model: model || 'default', messages, max_tokens: maxTokens, ...extra }), model || 'default', 120000); }
  catch (e) { return harden({ text: '', usage: null, error: `model "${model || 'default'}" unreachable: ${e.message}` }); }
  if (!r.ok) return harden({ text: '', usage: null, status: r.status, error: `model "${model || 'default'}" returned ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}` });
  const j = await r.json().catch(() => ({}));
  return harden({ text: j.choices?.[0]?.message?.content || '', usage: j.usage || null });
};
harden(callLLM);

// parse a single tool call: the first BRACE-BALANCED {...} (handles nested args, respects strings).
const parseToolCall = text => {
  const marker = text.search(/TOOL_CALL/i);
  const start = text.indexOf('{', marker >= 0 ? marker : 0);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null; // unbalanced / truncated
  try { const o = JSON.parse(text.slice(start, end + 1)); return o.name ? o : null; } catch { return null; }
};

// run a tool, ABORTABLE: if `signal` fires mid-run, invoke the cap's abort() (revoke the in-flight
// op — e.g. kill the GPU job) and reject. This is the escape/cancel mechanism, structural via the
// cap's own revocation — not a probabilistic undo. (Barge-in: the user talks over it → cancel.)
const runTool = (cap, args, signal) => {
  if (!signal) return cap.run(args);
  if (signal.aborted) { try { cap.abort?.(); } catch (e) { /* best effort */ } return Promise.reject(new Error('aborted')); }
  return new Promise((resolve, reject) => {
    let done = false;
    const onAbort = () => { if (done) return; done = true; try { cap.abort?.(); } catch (e) { /* best effort */ } reject(new Error('aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => cap.run(args)).then(
      r => { if (done) return; done = true; signal.removeEventListener('abort', onAbort); resolve(r); },
      e => { if (done) return; done = true; signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
};

// Build the user turn's content. Plain string when there are no attachments;
// an OpenAI-style multimodal content array when images/files are attached. Images
// become image_url blocks (gemma on tinix is multimodal — it SEES them, locally);
// text files are inlined into the text block. Used for both the live turn and the
// session history (so a follow-up question can still refer to the attached image).
export const buildUserContent = (userText, attachments = []) => {
  const list = Array.isArray(attachments) ? attachments : [];
  const images = list.filter(a => a && a.kind === 'image' && a.url);
  const texts = list.filter(a => a && a.kind === 'text' && a.text);
  const textPart = [
    String(userText || ''),
    ...texts.map(a => `\n\n[attached file: ${a.name || 'file'}]\n${a.text}`),
  ].join('');
  if (!images.length) return textPart;
  return [
    { type: 'text', text: textPart || '(see attached image)' },
    ...images.map(a => ({ type: 'image_url', image_url: { url: a.url } })),
  ];
};
harden(buildUserContent);

// ── the agent loop: reason → emit a tool call → DISPATCH ONLY INTO THE BUNDLE → feed back. ──────
// `signal` (AbortSignal) makes the whole run retractable: between steps and during an abortable
// tool, a cancel stops the turn and revokes any in-flight op. commit-only tools simply aren't
// reached once cancelled. (commit-only vs reversible declared in the manifest.)
export const runAgent = async ({ toolbox, manifest, userText, history = [], onStep = () => {}, signal, persona = '', attachments = [], model = 'default', llm, budgetLine = '' } = {}) => {
  // `invoke` is the inference seam: a metered llm (meter.mjs) when the caller supplies one
  // (the /chat path), else the bare callLLM. A metered llm can return { exhausted:true } —
  // the prepaid bound; the loop then halts deterministically (no further model spend).
  const invoke = llm || callLLM;
  const sys = [
    'You are a friendly real-time voice assistant. Keep spoken replies short and conversational. You may use tools to act.',
    // Spare a tool cycle: hand the agent "now" directly (fresh per turn) so it never needs a date/time tool.
    `The current date and time is ${new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}. Use this directly — do not call a tool to learn the date or time.`,
    // Bias to ACTION + iterate-until-done. The agent kept enthusing ("I\'m ready to
    // help") instead of starting; this makes it take the reversible first step and
    // keep going until the work is complete or genuinely blocked on dan.
    'BIAS TO ACTION — do not just describe what you could do. When asked to do something, take the concrete first step NOW with your tools, then KEEP GOING (call another tool, then another) until the task is genuinely complete or you are blocked on a decision/authorization only dan can give. Never end on "I\'m ready to help", "let me know", or "would you like me to…": either DO the safe, reversible parts immediately (e.g. draft/save a note, search, summarize, route a build to the dev session), or, if you truly need a decision, ask ONE crisp question. Irreversible/destructive actions still go through a proposal (you propose; dan confirms) — proposing IS taking the step, so do it rather than asking permission in prose.',
    'USE THE BREADTH OF YOUR TOOLKIT — the strongest results come from distributing work across the tools you hold and composing them, not fixating on one or two. Act with PRECISION: prefer specific, targeted moves (the exact note, device, parameter, or recipient) over broad, coarse ones.',
    // operator-confirmed self-authored instructions (the agent can propose edits to this block)
    persona && persona.trim() ? `\nYour instructions (operator-confirmed; you may propose edits via proposeSystemPrompt):\n${persona.trim()}\n` : '',
    // the user attached image(s)/file(s) to THIS turn — they're carried inline in the user message
    attachments && attachments.length
      ? `\nThe user attached ${attachments.length} file(s) to THIS message. Any image is shown inline in the user's message — LOOK at it directly to answer (you do NOT need a tool to "see" an image). Text from attached files is inlined too. Use the attachment to act.`
      : '',
    // the prepaid budget the agent is spending against (toll-bridge): keeps it cost-aware
    budgetLine ? `\n${budgetLine}` : '',
    'Available tools:',
    ...manifest.map(t => `- ${t.name}(${Object.keys(t.args).join(', ')}): ${t.description}`),
    '',
    'To call a tool, reply with EXACTLY: TOOL_CALL: {"name":"<tool>","args":{...}} and nothing else. Keep args concise (short prompts).',
    'After you receive a tool RESULT, either call another tool or give your final spoken reply on one line prefixed with ANSWER:',
  ].filter(Boolean).join('\n');
  const messages = [{ role: 'system', content: sys }, ...history, { role: 'user', content: buildUserContent(userText, attachments) }];
  const used = [];
  const cancelled = () => { onStep({ kind: 'cancelled' }); return harden({ answer: '', toolsUsed: used, cancelled: true }); };
  // No step limit: iterate until ANSWER, ABORT, or the prepaid ALLOWANCE METER is exhausted. Each
  // turn makes a metered LLM call, so the purse bounds the loop — no arbitrary cutoff of real work.
  for (;;) {
    if (signal?.aborted) return cancelled();
    const out = await invoke(messages, model);
    if (out && out.exhausted) return harden({ answer: '', toolsUsed: used, exhausted: true, remaining: out.remaining }); // prepaid allowance spent → halt (the bsky fix)
    if (signal?.aborted) return cancelled();
    const reply = (out && out.text) || '';
    const call = parseToolCall(reply);
    if (!call) { onStep({ kind: 'answer', text: reply }); return harden({ answer: reply.replace(/^ANSWER:\s*/i, '').trim(), toolsUsed: used }); }
    messages.push({ role: 'assistant', content: reply });
    const cap = toolbox[call.name]; // ← THE CONFINEMENT: only bundle names resolve to a cap
    if (!cap) {
      onStep({ kind: 'denied', name: call.name });
      messages.push({ role: 'user', content: `RESULT: error — no such tool "${call.name}". You may only use: ${manifest.map(t => t.name).join(', ')}.` });
      continue;
    }
    onStep({ kind: 'tool-start', name: call.name, args: call.args }); // a tool was INVOKED (before it returns) — lets the UI show work in-flight in real time
    let result;
    try { result = await runTool(cap, call.args || {}, signal); used.push({ name: call.name, args: call.args }); onStep({ kind: 'tool', name: call.name, args: call.args, result }); }
    catch (e) { if (signal?.aborted) return cancelled(); result = { ok: false, error: e.message }; onStep({ kind: 'tool-error', name: call.name, error: e.message }); }
    messages.push({ role: 'user', content: `RESULT: ${JSON.stringify(result)}` });
  }
};
harden(runAgent);
