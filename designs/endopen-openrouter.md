# EndOpen: OpenRouter Provider for Lal

|             |                                              |
|-------------|----------------------------------------------|
| **Created** | 2026-05-15                                   |
| **Author**  | kriscendobot (prompted by kriskowal)         |
| **Status**  | Not Started                                  |
| **Source**  | [`endopen.md`](endopen.md) § Gap 2           |

## What is the Problem Being Solved?

[OpenRouter](https://openrouter.ai/) is a meta-provider: one
OpenAI-compatible HTTP endpoint, one API key, and a catalog of ~200
models across Anthropic, OpenAI, Google, Meta, Mistral, Cohere,
xAI, plus dozens of open-weights hosts. For indie developers it
collapses the credential-management problem ("one key for every
model") and provides per-model pricing transparency. OpenCode has
first-class OpenRouter support and treats it as a routine provider
([`packages/opencode/src/provider/provider.ts`](../../external/opencode/packages/opencode/src/provider/provider.ts)
line 101 for the SDK loader; line 420 for header injection).

Endo's Lal supports Anthropic, Gemini, Ollama, and llama.cpp
([`packages/lal/providers/index.js`](../packages/lal/providers/index.js)
lines 33 through 65) but has no OpenRouter adapter. A user who wants
to route through OpenRouter today must use the llama.cpp / OpenAI-
compatible adapter and override the URL, but the headers OpenRouter
expects (`HTTP-Referer`, `X-Title`) are not set, and the dispatch
heuristic (`baseURL.includes('/v1')` in
[`packages/lal/providers/config.js`](../packages/lal/providers/config.js))
classifies it as llama.cpp rather than as a router-aware endpoint.

The gap is small but operationally salient: the maintainer named
OpenRouter integration specifically. The fix is a provider file
plus a small refactor that introduces a registry.

## Design

### Phase 1: Drop-in OpenRouter provider (minimal)

Add `packages/lal/providers/openrouter.js`:

```js
// @ts-check

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';
const REFERER = 'https://endo.example/'; // configurable
const TITLE = 'Endo';

/**
 * @param {{ apiKey: string, model?: string, baseURL?: string, referer?: string, title?: string }} opts
 */
export const makeOpenRouterProvider = ({
  apiKey,
  model = DEFAULT_MODEL,
  baseURL = DEFAULT_BASE,
  referer = REFERER,
  title = TITLE,
}) => {
  const chat = async (messages, tools) => {
    const body = harden({
      model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    });
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': referer,
        'X-Title': title,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw Error(`OpenRouter ${res.status}: ${await res.text()}`);
    }
    const json = await res.json();
    return harden({ message: json.choices[0].message });
  };
  return harden({ chat });
};
harden(makeOpenRouterProvider);
```

Extend `detectProviderKind` in
[`config.js`](../packages/lal/providers/config.js):

```js
export const detectProviderKind = (baseURL) => {
  if (baseURL.includes('openrouter.ai')) return 'openrouter';
  if (baseURL.includes('anthropic.com')) return 'anthropic';
  if (baseURL.includes('googleapis.com')) return 'gemini';
  if (baseURL.endsWith('/v1')) return 'llamacpp';
  return 'ollama';
};
```

Wire into `createProvider` in
[`index.js`](../packages/lal/providers/index.js):

```js
if (providerKind === 'openrouter') {
  const apiKey = env.LAL_AUTH_TOKEN;
  if (!apiKey) throw Error('LAL_AUTH_TOKEN required for OpenRouter');
  return makeOpenRouterProvider({ apiKey, model });
}
```

This is the minimal cut: ~80 LOC of new code, no breaking changes,
ships in one PR.

### Phase 2: Provider registry refactor

OpenCode's lesson worth borrowing is the **registry shape** at
[`packages/opencode/src/provider/provider.ts`](../../external/opencode/packages/opencode/src/provider/provider.ts)
lines 88 through 119 (the `BUNDLED_PROVIDERS` map of provider-name
to lazy SDK loader) and lines 410 through 459 (the `customLoaders`
dictionary of provider-name to header / option closure). The
separation is clean:

- **Provider table** says *how* to talk to a given vendor's
  endpoint.
- **Loader table** says *what extra headers / options* a given
  vendor expects.

Lal today merges both: each provider file has its `chat()`
implementation hard-coded. This works for ~5 providers but starts
to thrash at ~15. The refactor:

1. Define a `Provider` interface as today (`{ chat(messages, tools) => { message } }`).
2. Add a `ProviderRegistry` keyed by `providerKind` (`'anthropic'`, `'openrouter'`, `'openai'`, `'gemini'`, …).
3. Each registry entry holds `{ make(opts) => Provider, defaultHeaders, defaultModel, defaultBaseURL }`.
4. `createProvider(env)` becomes a registry lookup + `make()` invocation; the dispatch heuristic moves into the registry (a `match(baseURL)` predicate per entry).

The refactor is not load-bearing for the OpenRouter feature, but
it sets up the right shape for the next 5 to 10 providers (Bedrock,
Groq, Cohere, xAI, etc. are all OpenAI-compat with header quirks).

### Phase 3: Provider configuration via form

Today, provider configuration goes through environment variables
(`LAL_HOST`, `LAL_MODEL`, `LAL_AUTH_TOKEN`). The
[`lal-fae-form-provisioning`](lal-fae-form-provisioning.md) design
landed the form-based agent-provisioning shape; the natural
extension is a provider-config form: the user fills `provider kind`,
`API key`, `default model`, `referrer URL` (for OpenRouter's
`HTTP-Referer` header) once, and the form output becomes a
durable provider configuration referenceable by pet-name. The Lal
worker startup reads the pet-named config and instantiates the
right provider.

This is a UX improvement, not a correctness improvement; gate it
behind Phase 2 (the registry is the data-model that makes the form
fields obvious).

## Dependencies

| Design                                | Relationship                                         |
|---------------------------------------|------------------------------------------------------|
| [lal-fae-form-provisioning](lal-fae-form-provisioning.md) | Phase 3 piggybacks on the form-based config pattern |
| [endoclaw-network-fetch](endoclaw-network-fetch.md) | OpenRouter calls go through Endo's outbound HTTP capability when capability-confined |

## Phased Implementation

| Phase | What                                  | Size | Notes                                    |
|-------|---------------------------------------|------|------------------------------------------|
| 1     | OpenRouter provider file + heuristic  | S    | ~80 LOC, no breaking change              |
| 2     | Provider registry refactor            | M    | Pre-work for Bedrock / Groq / xAI later  |
| 3     | Form-based provider config            | M    | Depends on phase 2; UX improvement       |

Total: 2-3 weeks if all three land in sequence; Phase 1 alone is 1
day.

## Open Questions

- **Header values**: what should `HTTP-Referer` and `X-Title` be for an Endo daemon? OpenCode uses `https://opencode.ai/` and `opencode`. Proposal: `https://github.com/endojs/endo` and `Endo` (or per-Familiar-instance values via the form). The headers are used by OpenRouter to attribute traffic; reasonable defaults that identify the project are appropriate.
- **Streaming**: OpenRouter supports OpenAI-style SSE streaming. Phase 1 punts on this (synchronous, all-at-once); Phase 2's registry refactor is the right time to introduce a `chatStream()` interface alongside `chat()`. Out of scope for the initial cut.
- **Cost telemetry**: OpenRouter returns per-request cost in the response body. Endo has no UI for this today; the [`endopen-tui-shell`](endopen-tui-shell.md) design proposes a status-bar slot that would surface it.
- **Model catalog**: OpenRouter exposes `/models` as a JSON catalog. The lab-FAE form could fetch and offer a dropdown rather than free-form `LAL_MODEL`. Defer to Phase 3.

## Design Decisions

1. **Minimal cut ships independently of the registry refactor.** The
   feature gap the maintainer named is OpenRouter usability; the
   registry refactor is a follow-on that pays its way in the next
   5 providers. Land them as separate PRs.

2. **Lal owns the provider abstraction, not the daemon.** The
   daemon does not learn about HTTP providers; the Lal worker
   does. OpenRouter access is from Lal's worker process, gated
   by whatever outbound HTTP capability Lal holds (today: ambient
   fetch; in the future:
   [endoclaw-network-fetch](endoclaw-network-fetch.md) with an
   OpenRouter allowlist entry).

3. **Considered and rejected: a generic openai-compatible provider.**
   Lal already has `llamacpp.js` as the OpenAI-compatible adapter
   ([`packages/lal/providers/llamacpp.js`](../packages/lal/providers/llamacpp.js)).
   Reusing it for OpenRouter would skip the header-injection story
   and conflate "local OpenAI-compatible" with "router-aware OpenAI-compatible".
   Reason for rejection: OpenRouter has provider-specific behavior
   (the headers, the per-request cost field, the model-catalog
   endpoint) that deserves its own file, even when the wire format
   overlaps.

## Related Designs

- [endopen](endopen.md) — primary comparative analysis.
- [lal-fae-form-provisioning](lal-fae-form-provisioning.md) — Phase 3 piggyback.
- [endoclaw-network-fetch](endoclaw-network-fetch.md) — outbound HTTP capability story.
- OpenCode reference: [`packages/opencode/src/provider/provider.ts`](../../external/opencode/packages/opencode/src/provider/provider.ts) lines 88-119, 410-459.

## Prompt

> opencode … can work well with openrouter
>
> kriskowal, 2026-05-15
