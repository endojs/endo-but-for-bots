// tool-bridge.mjs — the model-provider seam for Agent C: callLLM (gemma/Anthropic/OpenRouter dispatch +
// metering-friendly usage) + buildUserContent (multimodal turn assembly). The reasoning model is
// probabilistic; its AUTHORITY is not — confinement lives in CodeMode's lexical scope (codemode.mjs), which
// is the ONLY agent loop. The legacy text-marker loop (runAgent + TOOL_CALL:/ANSWER: parsing) was RETIRED
// (2026-06-28): control signals are scope functions, not forgeable in-band strings.
import '@endo/init';
import fs from 'node:fs';

const LLM = process.env.AGENT_LLM || 'http://192.168.50.226:8003/v1/chat/completions';

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

// `apiKey` (optional) OVERRIDES the operator's key for this call — the seam for "bring your own inference
// provider": an invited user supplies their own anthropic/openrouter key and their turns run on THEIR account
// (unmetered against the owner's purse). When absent, the operator's configured key is used as before.
export const callLLM = async (messages, model = 'default', { maxTokens = 4096, apiKey } = {}) => {
  if (String(model).startsWith('anthropic:')) {
    const id = String(model).slice('anthropic:'.length);
    const key = (apiKey && String(apiKey).trim()) || anthropicKey();
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
    const key = (apiKey && String(apiKey).trim()) || openrouterKey();
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
  // SELF-HEAL the local model's modest context (gemma: 16384): a fixed 4096-output request overflows when the
  // prompt is large (400 "maximum context length …"). The model's reported input count is an unreliable lower
  // bound ("at least M", and it varies), so don't chase it — just HALVE the output ceiling on each context-400
  // until it fits. Converges in a few attempts and degrades gracefully (shorter reply) instead of failing the turn.
  let mt = maxTokens;
  for (let attempt = 0; !r.ok && r.status === 400 && mt > 300 && attempt < 5; attempt += 1) {
    if (!/maximum context length/i.test(await r.clone().text().catch(() => ''))) break;
    mt = Math.floor(mt / 2);
    try { r = await fetchChat(LLM, { 'content-type': 'application/json' }, extra => ({ model: model || 'default', messages, max_tokens: mt, ...extra }), model || 'default', 120000); } catch { break; }
  }
  if (!r.ok) return harden({ text: '', usage: null, status: r.status, error: `model "${model || 'default'}" returned ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}` });
  const j = await r.json().catch(() => ({}));
  return harden({ text: j.choices?.[0]?.message?.content || '', usage: j.usage || null });
};
harden(callLLM);

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
