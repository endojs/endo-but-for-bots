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
    const out = await callLLM(messages, model); // { text, usage }
    const cost = costOf(model, out && out.usage);
    purse.debit(cost);
    const provider = providerOf(model);
    perProvider[provider] = (perProvider[provider] || 0) + cost;
    return harden({ text: (out && out.text) || '', usage: (out && out.usage) || null, cost, remaining: purse.balance(), provider });
  };
  return harden(llm);
};
harden(makeMeteredLLM);
