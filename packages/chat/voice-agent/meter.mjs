// meter.mjs — the prepaid toll on inference. Wraps the bare callLLM with a per-chat
// purse so EVERY model call is metered against a finite allowance. This is the single
// place µUSD leaves a conversation's purse, and the structural answer to the Bluesky
// trigger (recursive sub-agents "farting subagents everywhere" → runaway cost): an
// agent cannot spend inference it cannot pay for — the loop halts instead of recursing.
//
// makeMeteredLLM({ callLLM, purse, perProvider }) → an llm(messages, model) that:
//   1. REFUSES before calling the model when the purse is empty — deterministic, NO
//      model spend (dan: never route exhaustion through the model itself):
//        → { exhausted: true, remaining, text: '' }
//   2. otherwise calls the model, prices the real usage, debits the purse, and returns:
//        → { text, usage, cost, remaining, provider }
//
// `perProvider` (optional) accumulates per-provider spend for the turn (caller-owned).
import { costOf, providerOf } from './costModel.mjs';

export const makeMeteredLLM = ({ callLLM, purse, perProvider = {} }) => {
  const llm = async (messages, model = 'default') => {
    if (!purse.canAfford(1)) return harden({ exhausted: true, remaining: purse.balance(), text: '' });
    const out = await callLLM(messages, model); // { text, usage } | { error }
    if (out && out.error) return harden({ error: out.error, status: out.status, text: '', remaining: purse.balance() }); // provider error → surface it, don't charge
    const cost = costOf(model, out && out.usage);
    purse.debit(cost);
    const provider = providerOf(model);
    perProvider[provider] = (perProvider[provider] || 0) + cost;
    return harden({ text: (out && out.text) || '', usage: (out && out.usage) || null, cost, remaining: purse.balance(), provider });
  };
  return harden(llm);
};
harden(makeMeteredLLM);

// ── makeMeteredDelegate — the prepaid toll on a DELEGATED (Opus) turn ────────────
//
// Delegation (delegate.mjs: runOpusDelegate / opusComplete) breaks a task off to a
// LARGER, PAID brain. Unlike makeMeteredLLM (which meters a single bare callLLM), a
// delegate runs a whole tool-using LOOP and reports its CUMULATIVE token `usage` only
// when it returns. So we cannot price-per-call; instead we:
//   1. QUOTE A FLOOR before spending — the minimum credible cost of one Opus turn.
//      If the purse cannot afford that floor it is UNFUNDED → we THROW
//      `INFERENCE_BUDGET_EXHAUSTED` (an Error with .code) BEFORE any paid call. The
//      delegation halts deterministically — never route exhaustion through the model.
//   2. run the delegate, then DEBIT THE ACTUAL cost computed from the returned usage
//      (the real delta), accumulating per-provider spend. A provider `error` is
//      surfaced without charging.
//
// makeMeteredDelegate({ delegate, purse, perProvider, model, floorTokens }) → a
//   metered(args) with the SAME shape as the wrapped delegate, plus { cost, remaining }.

// A delegate turn that reports zero usage still cost at least one round-trip of Opus
// thinking; this floor is the minimum µUSD we insist the purse can cover up-front.
const FLOOR_INPUT_TOKENS = 200;   // a non-trivial system+prompt
const FLOOR_OUTPUT_TOKENS = 100;  // at least a short answer

// Construct the BUDGET-EXHAUSTED error (carries a stable .code for callers to catch).
export const inferenceBudgetExhausted = (need, have) => {
  const e = new Error(`INFERENCE_BUDGET_EXHAUSTED: delegated turn needs at least ${need} µUSD but purse has ${have} µUSD`);
  e.code = 'INFERENCE_BUDGET_EXHAUSTED';
  e.need = need; e.have = have;
  return e;
};
harden(inferenceBudgetExhausted);

export const makeMeteredDelegate = ({
  delegate,                 // runOpusDelegate (or any { ...; usage } -> result, or { error })
  purse,
  perProvider = {},
  model = 'claude-opus-4-8',
  floorTokens = { input_tokens: FLOOR_INPUT_TOKENS, output_tokens: FLOOR_OUTPUT_TOKENS },
} = {}) => {
  const provider = providerOf(model);
  const floor = Math.max(1, costOf(model, floorTokens)); // µUSD the purse MUST be able to cover
  const metered = async (args = {}) => {
    // 1. QUOTE THE FLOOR — refuse BEFORE any paid Opus call when unfunded.
    if (!purse.canAfford(floor)) throw inferenceBudgetExhausted(floor, purse.balance());
    // 2. run the (paid) delegate.
    const out = await delegate(args);
    // provider/transport error → surface it, DON'T charge.
    if (out && out.error) return harden({ ...out, cost: 0, remaining: purse.balance() });
    // 3. DEBIT THE ACTUAL cost from the returned cumulative usage.
    const cost = costOf(model, out && out.usage);
    purse.debit(cost);
    perProvider[provider] = (perProvider[provider] || 0) + cost;
    return harden({ ...out, cost, remaining: purse.balance() });
  };
  return harden(metered);
};
harden(makeMeteredDelegate);
