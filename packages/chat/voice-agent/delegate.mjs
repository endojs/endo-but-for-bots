// delegate.mjs — break a task off to a LARGER agent (Opus, via the Anthropic
// Messages API) while preserving the confinement invariant.
//
// The crucial point: the sub-agent is a bigger BRAIN, not a bigger AUTHORITY.
// Its tools are EXACTLY the attenuated `toolbox` it is handed — the intersection
// of the delegator's powers and the powers it asked to grant. There is no tool
// name Opus can emit to reach a power outside that bundle. "Correct by lexical
// construction" survives the jump from gemma to Opus: a stochastic model of any
// size can only invoke the caps in front of it.
import fsp from 'node:fs/promises';

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.DELEGATE_MODEL || 'claude-opus-4-8';
const MAX_STEPS = 8; // default tool-use budget; an editing executor (read→implement→write-test→run-test→fix) needs more — see maxSteps param.

// Load ANTHROPIC_API_KEY from the env, falling back to ~/.env (the service runs
// with the key exported, but tests / one-offs may not).
let cachedKey;
const apiKey = async () => {
  if (cachedKey !== undefined) return cachedKey;
  if (process.env.ANTHROPIC_API_KEY) { cachedKey = process.env.ANTHROPIC_API_KEY; return cachedKey; }
  try {
    const env = await fsp.readFile('/home/dan/.env', 'utf8');
    const m = env.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/m);
    cachedKey = m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { cachedKey = null; }
  return cachedKey;
};

// Map our manifest entries → Anthropic tool schema. Args are described as
// strings in the manifest; we model every arg as a free string/any property.
const toAnthropicTools = manifest => manifest.map(t => ({
  name: t.name,
  description: t.description + (t.reversible ? ' (abortable)' : ''),
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(Object.keys(t.args || {}).map(k => [k, { type: 'string', description: String(t.args[k]) }])),
    required: [],
  },
}));

// runOpusDelegate({ prompt, toolbox, manifest, grantedPowers, signal }) →
//   { answer, toolsUsed, model, granted }  (or { error } on failure)
export const runOpusDelegate = async ({ prompt, toolbox, manifest, grantedPowers = [], signal, maxTokens = 16000, maxSteps = MAX_STEPS } = {}) => {
  const key = await apiKey();
  if (!key) return { error: 'no ANTHROPIC_API_KEY available' };
  const tools = toAnthropicTools(manifest);
  const system = [
    'You are a capable task-running sub-agent delegated a job by dan\'s field agent.',
    'You may ONLY act through the tools provided — that is your entire authority.',
    grantedPowers.length ? `You were granted these powers: ${grantedPowers.join(', ')}.` : 'You were granted NO tools — answer from reasoning alone.',
    'Do the task, then give a concise final answer. Do not claim to have done anything you did not do via a tool.',
  ].join(' ');
  const messages = [{ role: 'user', content: String(prompt || '') }];
  const toolsUsed = [];
  // Increment 0: accumulate token usage across the delegate's steps so the metered seam
  // can price the (paid) Opus path. (Request body sends no temperature/top_p/thinking, so
  // it is already adaptive-thinking-compatible on claude-opus-4-8 — no 400 risk here.)
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) return { answer: '(delegation cancelled)', toolsUsed, cancelled: true };
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, tools, messages }),
        signal,
      });
    } catch (e) { if (signal?.aborted) return { answer: '(delegation cancelled)', toolsUsed, cancelled: true }; return { error: `anthropic fetch: ${e.message}` }; }
    if (!res.ok) return { error: `anthropic ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    if (data.usage) { for (const k of Object.keys(usage)) usage[k] += Number(data.usage[k]) || 0; }
    const content = Array.isArray(data.content) ? data.content : [];
    messages.push({ role: 'assistant', content });

    const toolUses = content.filter(c => c.type === 'tool_use');
    if (data.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const answer = content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      return { answer: answer || '(no answer)', toolsUsed, model: MODEL, granted: grantedPowers, usage };
    }

    // dispatch each requested tool ONLY into the attenuated bundle.
    const results = [];
    for (const tu of toolUses) {
      const cap = toolbox[tu.name]; // ← THE CONFINEMENT: only bundle names resolve
      if (!cap) { results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `no such tool "${tu.name}" — you may only use: ${manifest.map(m => m.name).join(', ') || '(none)'}` }); continue; }
      try {
        const out = await cap.run(tu.input || {}, signal);
        toolsUsed.push({ name: tu.name, args: tu.input });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 4000) });
      } catch (e) {
        if (signal?.aborted) return { answer: '(delegation cancelled)', toolsUsed, cancelled: true };
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: String(e.message || e) });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: '(reached delegation step limit)', toolsUsed, model: MODEL, granted: grantedPowers, usage };
};
harden(runOpusDelegate);

// A plain (tool-less) Opus completion — for a STRONG single judgment (e.g. the dietician's
// dietary-safety verdict) rather than a tool-using loop. Returns the text, or null when no
// key / error so the caller can fall back to the local model.
export const opusComplete = async ({ system = '', prompt = '', maxTokens = 900, signal } = {}) => {
  const key = await apiKey();
  if (!key) return null;
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: String(prompt || '') }] }),
      signal,
    });
    if (!res.ok) return null;
    const d = await res.json();
    return (Array.isArray(d.content) ? d.content : []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim() || null;
  } catch { return null; }
};
harden(opusComplete);

// ── makeMeteredOpusDelegate — the wired seam: an Opus delegate that bills the purse ──
//
// runOpusDelegate is the BARE delegate (it just reports cumulative `usage`). This is the
// place that WIRES it into makeMeteredDelegate (meter.mjs) so a delegated (Opus) turn is
// metered against the chat purse EXACTLY like callLLM is via makeMeteredLLM:
//   • REFUSE before any paid Opus call when the purse can't cover the floor →
//     throws INFERENCE_BUDGET_EXHAUSTED (deterministic; never routes exhaustion through
//     the model), and
//   • on success DEBIT the actual usage-priced cost, accumulating per-provider spend.
//
// makeMeteredOpusDelegate({ purse, perProvider, model }) → a delegate(args) with the SAME
// signature/shape as runOpusDelegate, plus { cost, remaining }. Without a purse it is a
// no-op pass-through to runOpusDelegate (free / unmetered contexts — tests, no-budget runs).
import { makeMeteredDelegate } from './meter.mjs';

export const makeMeteredOpusDelegate = ({ purse, perProvider = {}, model = MODEL } = {}) => {
  if (!purse) return harden((args = {}) => runOpusDelegate(args)); // unmetered pass-through
  return makeMeteredDelegate({ delegate: args => runOpusDelegate(args), purse, perProvider, model });
};
harden(makeMeteredOpusDelegate);
