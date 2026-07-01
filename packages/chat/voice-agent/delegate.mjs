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

import { HOST_ENV_FILE } from './field-config.mjs';

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.DELEGATE_MODEL || 'claude-opus-4-8';
const MAX_STEPS = 8; // default tool-use budget; an editing executor (read→implement→write-test→run-test→fix) needs more — see maxSteps param.

// Load ANTHROPIC_API_KEY from the env, falling back to the host env file (the service
// runs with the key exported, but tests / one-offs may not).
let cachedKey;
const apiKey = async () => {
  if (cachedKey !== undefined) return cachedKey;
  if (process.env.ANTHROPIC_API_KEY) { cachedKey = process.env.ANTHROPIC_API_KEY; return cachedKey; }
  try {
    const env = await fsp.readFile(HOST_ENV_FILE, 'utf8');
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

// ── composeDelegateProposal — the "spin up an attenuated agent" scoper ────────────
//
// When the entry agent wants to act via delegateTask/spawnSpecialist, it normally
// composes an APPROVAL PROMPT ("I can spin up an attenuated agent with: X. Approve
// it from this chat.") so dan can review the sub-agent before it runs. But asking
// approval to spin up a REDUNDANT sub-agent is friction with no security payoff:
// if the request needs a SINGLE low-risk, NON-destructive power that the CALLING
// agent ALREADY HOLDS itself, delegating adds no authority the caller lacks and
// removes none it has — so there is nothing to review. In that case skip the
// approval-prompt path and signal DIRECT EXECUTION, so the caller just does it.
//
// A power is "low-risk / directly-executable" only when it is read-only / additive
// with no write/destructive verb: today that is exactly `research` and `web`.
// Anything else — host, home, images, notes-writes, meta powers, etc. — or a
// MULTI-power request, still routes through the approval prompt.

// The allow-list of powers safe to auto-execute (read-only, non-destructive).
export const LOW_RISK_POWERS = harden(new Set(['research', 'web']));

// Powers that are inherently destructive / high-authority — never auto-execute
// even singly (host = arbitrary shell, home = filesystem writes, etc.).
export const DESTRUCTIVE_POWERS = harden(new Set(['host', 'home']));

const isLowRiskPower = p => LOW_RISK_POWERS.has(String(p || '').trim());

// composeDelegateProposal({ proposals, powers, callerPowers }) →
//   • { directExec: true, powers } — when it is a SINGLE low-risk power the caller
//     already holds → caller should execute immediately (NO approval prompt text).
//   • { directExec: false, message, powers } — otherwise → `message` is the
//     approval-prompt text to show (proposals + "I can spin up an attenuated agent…").
//
// `callerPowers` is the set/array of powers the CALLING agent itself holds; when
// omitted we conservatively assume the caller holds the low-risk power (the common
// case: the entry agent holds web/research), so a single low-risk power still
// short-circuits. If the caller does NOT hold the requested power, we fall back to
// the approval prompt (there is a real grant to review).
export const composeDelegateProposal = ({ proposals = '', powers = [], callerPowers } = {}) => {
  const reqPowers = (Array.isArray(powers) ? powers : [powers]).map(p => String(p || '').trim()).filter(Boolean);
  const base = String(proposals || '');
  const approvalMessage = reqPowers.length
    ? base + `\n\n— To act on this, I can spin up an attenuated agent with: ${reqPowers.join(', ')}. Approve it from this chat.`
    : base;

  const single = reqPowers.length === 1 ? reqPowers[0] : null;
  const hasDestructive = reqPowers.some(p => DESTRUCTIVE_POWERS.has(p) || !isLowRiskPower(p));

  // The caller "already holds" the power: if callerPowers given, require membership;
  // if omitted, assume yes for a low-risk power (the entry agent typically holds web/research).
  const callerHolds = single != null && (
    callerPowers == null
      ? true
      : (callerPowers instanceof Set ? callerPowers.has(single) : Array.isArray(callerPowers) && callerPowers.includes(single))
  );

  if (single != null && isLowRiskPower(single) && !hasDestructive && callerHolds) {
    // A single low-risk, non-destructive power the caller already holds → no
    // redundant sub-agent to approve. Signal direct execution.
    return harden({ directExec: true, powers: reqPowers, message: base });
  }
  return harden({ directExec: false, message: approvalMessage, powers: reqPowers });
};
harden(composeDelegateProposal);
