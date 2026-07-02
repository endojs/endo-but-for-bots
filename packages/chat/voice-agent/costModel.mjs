// costModel.mjs — the ONE source of truth for what an inference call costs.
//
// Cost is in µUSD (micro-USD: 1 µUSD = $0.000001). Rates are [inputPerToken,
// outputPerToken] in µUSD/token — which is numerically identical to $/1M tokens
// (e.g. Opus 4.8 at $5/$25 per 1M → [5, 25]). Catalog verified 2026-05-26.
//
// Local gemma (model 'default') is genuinely FREE and is priced [0, 0] — a free local
// turn debits nothing from the purse. Only the real (paid) Anthropic / OpenRouter paths
// are metered. (Inc 1 briefly used a fake non-zero rate to prove the spine; flipped to
// [0, 0] per P1-9 so the free model isn't billed.)

// model/provider key → [inMicroUSDPerTok, outMicroUSDPerTok]
const RATES = {
  'gemma-tinix': [0, 0], // local gemma is genuinely FREE — never bill it (was a fake [1,4] test rate for Inc 1)
  'anthropic:claude-opus-4-8': [5, 25],
  'anthropic:claude-opus-4-7': [5, 25],
  'anthropic:claude-opus-4-6': [5, 25],
  'anthropic:claude-sonnet-4-6': [3, 15],
  'anthropic:claude-haiku-4-5': [1, 5],
  'anthropic:claude-fable-5': [10, 50], // tier above Opus — must be priced or it bills as free
};

// OpenRouter slugs we expose in the model menu ($/1M in/out, approximate). When the
// OpenRouter response carries an authoritative usage.cost we use that instead (see costOf).
const OPENROUTER_RATES = {
  'openai/gpt-4o-mini': [0.15, 0.6],
  'openai/gpt-4o': [2.5, 10],
  'google/gemini-2.0-flash-001': [0.1, 0.4],
  'meta-llama/llama-3.3-70b-instruct': [0.12, 0.3],
  'deepseek/deepseek-chat': [0.28, 0.88],
  'anthropic/claude-3.7-sonnet': [3, 15],
  'moonshotai/kimi-k2.7-code': [0.6, 2.5],
  'anthropic/claude-opus-4': [15, 75],
};

// A display/accounting key for a model id. 'default' and bare local → 'gemma-tinix';
// 'openrouter:<slug>' kept whole; 'claude…'/'anthropic:…' normalized to 'anthropic:…'.
export const providerOf = (model = 'default') => {
  const m = String(model || 'default');
  if (m.startsWith('openrouter:')) return m;
  if (m.startsWith('anthropic:')) return m;
  if (m.startsWith('claude')) return `anthropic:${m}`;
  return 'gemma-tinix';
};
harden(providerOf);

// [in, out] µUSD/token for a model id. Unknown ids fall back to a NON-ZERO rate so an
// unrecognised paid model is never silently billed as free.
export const rateFor = (model = 'default') => {
  const m = String(model || 'default');
  if (m.startsWith('openrouter:')) return OPENROUTER_RATES[m.slice('openrouter:'.length)] || [1, 3];
  const p = providerOf(m);
  if (RATES[p]) return RATES[p];
  return p.startsWith('anthropic:') ? [5, 25] : [0, 0]; // unknown anthropic → opus-priced; unknown local → free (gemma)
};
harden(rateFor);

const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);

// Normalize a provider usage object (OpenAI/gemma/OpenRouter OR Anthropic shape) →
// { inTok, outTok, costUSD|null }. Cache tokens (Anthropic) are charged at the INPUT
// rate for v1 — conservative: this only ever over-bills, never under-bills.
export const normalizeUsage = (usage) => {
  if (!usage || typeof usage !== 'object') return { inTok: 0, outTok: 0, costUSD: null };
  const costUSD = typeof usage.cost === 'number' ? usage.cost : null; // OpenRouter when usage.include
  if ('input_tokens' in usage || 'output_tokens' in usage) { // Anthropic
    const cache = num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
    return { inTok: num(usage.input_tokens) + cache, outTok: num(usage.output_tokens), costUSD };
  }
  return { inTok: num(usage.prompt_tokens), outTok: num(usage.completion_tokens), costUSD }; // OpenAI/gemma/OpenRouter
};
harden(normalizeUsage);

// The price of one inference call, in µUSD (integer). Prefers an authoritative
// usage.cost (USD → µUSD) when present; else priced from the rate table.
export const costOf = (model, usage) => {
  const { inTok, outTok, costUSD } = normalizeUsage(usage);
  if (typeof costUSD === 'number' && costUSD > 0) return Math.round(costUSD * 1e6);
  const [ri, ro] = rateFor(model);
  return Math.round(inTok * ri + outTok * ro);
};
harden(costOf);

// µUSD → a short $ string for display.
export const formatMicroUSD = (micro) => {
  const usd = Math.max(0, num(micro)) / 1e6;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(5)}`;
};
harden(formatMicroUSD);

const prettyModel = (model = 'default') => {
  const m = String(model || 'default');
  if (m === 'default') return 'gemma (local)';
  if (m.startsWith('openrouter:')) return m.slice('openrouter:'.length);
  return m;
};

// The single line we inject into the agent's context so it KNOWS its remaining budget +
// what its current model costs — the (testable) hypothesis being that budget-awareness
// makes the agent spend more deliberately and stop spawning sub-agents it can't fund.
export const budgetLine = (remainingMicro, model = 'default') => {
  const [ri, ro] = rateFor(model);
  const per1k = ((ri + ro) / 2) * 1000; // avg µUSD per 1K tokens
  return `BUDGET: this conversation has ${formatMicroUSD(remainingMicro)} of inference allowance left. Your current model (${prettyModel(model)}) costs about ${formatMicroUSD(per1k)} per 1K tokens. Spend it deliberately — keep turns tight, prefer the cheapest capable model, and do NOT spawn sub-agents you cannot fund. When the allowance reaches zero, work stops until the user tops it up.`;
};
harden(budgetLine);
