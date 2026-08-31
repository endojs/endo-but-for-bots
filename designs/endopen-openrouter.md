# EndOpen: OpenRouter Provider for Lal

|             |                                              |
|-------------|----------------------------------------------|
| **Created** | 2026-05-15                                   |
| **Author**  | kriscendobot (prompted by kriskowal)         |
| **Status**  | Not Started                                  |
| **Source**  | [`endopen.md`](endopen.md) § Gap 2           |

## What is the Problem Being Solved?

[OpenRouter](https://openrouter.ai/) is a meta-provider:
one OpenAI-compatible HTTP endpoint, one API key,
and a catalog of ~200 models across Anthropic, OpenAI, Google, Meta,
Mistral, Cohere, xAI, plus dozens of open-weights hosts.
For indie developers it collapses the credential-management problem
("one key for every model") and provides per-model pricing transparency.
OpenCode has first-class OpenRouter support and treats it as a routine
provider
(`provider.ts` line 101 for the SDK loader, line 420 for header injection;
see the Related Designs section below for the source path).

Endo's Lal supports Anthropic, Gemini, Ollama, and llama.cpp
([`packages/lal/providers/index.js`](../packages/lal/providers/index.js)
lines 33 through 65) but has no OpenRouter adapter.
A user who wants to route through OpenRouter today must use the
llama.cpp / OpenAI-compatible adapter and override the URL,
but the headers OpenRouter expects (`HTTP-Referer`, `X-Title`)
are not set, and the dispatch heuristic
(`baseURL.includes('/v1')` in
[`packages/lal/providers/config.js`](../packages/lal/providers/config.js))
classifies it as the generic `'openai-compatible'` kind rather than as a
router-aware endpoint.

The gap is small but operationally salient:
the maintainer named OpenRouter integration specifically.
The fix is a provider file plus a small refactor that introduces a
registry.

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
// Add 'openrouter' to the existing return union
// ('anthropic' | 'gemini' | 'openai-compatible' | 'ollama') and insert
// its check BEFORE the general `/v1` predicate. Ordering is
// load-bearing: OpenRouter's canonical base URL
// (https://openrouter.ai/api/v1) contains `/v1`, so without the
// earlier check it would classify as the existing 'openai-compatible'
// kind. A future reorganization (e.g. alphabetical sort) must preserve
// openrouter-before-openai-compatible.
export const detectProviderKind = baseURL => {
  if (baseURL.includes('openrouter.ai')) {
    return 'openrouter';
  }
  if (baseURL.includes('anthropic.com')) {
    return 'anthropic';
  }
  if (
    baseURL.includes('googleapis.com') ||
    baseURL.includes('generativelanguage')
  ) {
    return 'gemini';
  }
  if (baseURL.includes('/v1')) {
    return 'openai-compatible';
  }
  return 'ollama';
};
```

This reuses the existing kind spelling `'openai-compatible'` and its
existing `.includes('/v1')` predicate verbatim; the only change to the
shipped function is the new `'openrouter'` branch ahead of the `/v1`
check.

**Ordering as a design decision.**
The check for `openrouter.ai` must come before the `/v1` predicate.
OpenRouter's canonical base URL is `https://openrouter.ai/api/v1`,
which contains `/v1`;
a future refactor that sorts the dispatch table alphabetically or by
provider name would silently regress OpenRouter into the existing
`'openai-compatible'` kind.
The Phase 2 registry refactor below preserves the ordering by giving
each entry an explicit `match(baseURL)` predicate that the registry
evaluates in declared order, with router-aware entries first.

Wire into `createProvider` in
[`index.js`](../packages/lal/providers/index.js), as a new branch
*ahead of* the existing `providerKind === 'openai-compatible'` branch
(which stays unchanged and continues to handle llama.cpp and other
`/v1` endpoints):

```js
if (providerKind === 'openrouter') {
  const apiKey = env.LAL_AUTH_TOKEN;
  if (!apiKey) throw Error('LAL_AUTH_TOKEN required for OpenRouter');
  return makeOpenRouterProvider({ apiKey, model });
}
```

This is the minimal cut: ~80 LOC of new code. It adds one branch to
`detectProviderKind` and one to `createProvider` without altering the
existing `'openai-compatible'` branch or its `defaultModels` entry, so
it ships in one PR with no behavior change for existing providers.

### Phase 2: Provider registry refactor

OpenCode's lesson worth borrowing is the **registry shape** at
`provider.ts` lines 88 through 119
(the `BUNDLED_PROVIDERS` map of provider-name to lazy SDK loader)
and lines 410 through 459
(the `customLoaders` dictionary of provider-name to header / option
closure;
see the Related Designs section below for the source path).
The separation is clean:

- **Provider table** says *how* to talk to a given vendor's
  endpoint.
- **Loader table** says *what extra headers / options* a given
  vendor expects.

Lal today merges both:
each provider file has its `chat()` implementation hard-coded.
This works for ~5 providers but starts to thrash at ~15.
The refactor:

1. Define a `Provider` interface as today
   (`{ chat(messages, tools) => { message } }`).
2. Add a `ProviderRegistry` keyed by `providerKind`
   (`'anthropic'`, `'openrouter'`, `'openai-compatible'`, `'gemini'`,
   ...).
3. Each registry entry holds
   `{ make(opts) => Provider, defaultHeaders, defaultModel, defaultBaseURL, match(baseURL) }`.
4. `createProvider(env)` becomes a registry lookup + `make()` invocation;
   the dispatch heuristic moves into the registry as a `match(baseURL)`
   predicate per entry.
   The registry evaluates predicates in declared order, with router-aware
   entries (OpenRouter) listed before catch-all OpenAI-compat predicates
   so that ordering remains explicit at the data-model layer rather than
   implicit in source position.

The refactor is not load-bearing for the OpenRouter feature, but
it sets up the right shape for the next 5 to 10 providers
(Bedrock, Groq, Cohere, xAI, etc. are all OpenAI-compat with header
quirks).

### Phase 3: Provider configuration via form

Today, provider configuration goes through environment variables
(`LAL_HOST`, `LAL_MODEL`, `LAL_AUTH_TOKEN`).
The [`lal-fae-form-provisioning`](lal-fae-form-provisioning.md) design
landed the form-based agent-provisioning shape;
the natural extension is a provider-config form.
The user fills `provider kind`, `API key`, `default model`,
`referrer URL` (for OpenRouter's `HTTP-Referer` header) once,
and the form output becomes a durable provider configuration
referenceable by pet-name.
The Lal worker startup reads the pet-named config and instantiates the
right provider.

This is a UX improvement, not a correctness improvement;
gate it behind Phase 2
(the registry is the data-model that makes the form fields obvious).

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

- **Header values**:
  what should `HTTP-Referer` and `X-Title` be for an Endo daemon?
  OpenCode uses `https://opencode.ai/` and `opencode`.
  Proposal: `https://github.com/endojs/endo` and `Endo` (or
  per-Familiar-instance values via the form).
  The headers are used by OpenRouter to attribute traffic;
  reasonable defaults that identify the project are appropriate.
- **Streaming**:
  OpenRouter supports OpenAI-style SSE streaming.
  Phase 1 punts on this (synchronous, all-at-once);
  Phase 2's registry refactor is the right time to introduce a
  `chatStream()` interface alongside `chat()`.
  Out of scope for the initial cut.
- **Cost telemetry**:
  OpenRouter returns per-request cost in the response body.
  Endo has no UI for this today;
  the [`endopen-tui-shell`](endopen-tui-shell.md) design proposes a
  status-bar slot that would surface it.
- **Model catalog**:
  OpenRouter exposes `/models` as a JSON catalog.
  The lab-FAE form could fetch and offer a dropdown rather than free-form
  `LAL_MODEL`.
  Defer to Phase 3.

## Design Decisions

1. **Minimal cut ships independently of the registry refactor.**
   The feature gap the maintainer named is OpenRouter usability;
   the registry refactor is a follow-on that pays its way in the next
   5 providers.
   Land them as separate PRs.

2. **Lal owns the provider abstraction, not the daemon.**
   The daemon does not learn about HTTP providers;
   the Lal worker does.
   OpenRouter access is from Lal's worker process, gated by whatever
   outbound HTTP capability Lal holds
   (today: ambient fetch;
   in the future: [endoclaw-network-fetch](endoclaw-network-fetch.md)
   with an OpenRouter allowlist entry).

3. **Provider-detection ordering is a load-bearing data-model concern.**
   The `openrouter.ai` predicate must precede the `/v1` predicate, both
   in Phase 1's `detectProviderKind` source order and in Phase 2's
   registry declared order.
   Without the ordering rule, OpenRouter's `https://openrouter.ai/api/v1`
   base URL would match the existing generic `'openai-compatible'` entry
   and silently regress.
   Phase 2's registry encodes the ordering as a `match(baseURL)` per
   entry evaluated in declared order, rather than relying on source
   position.

4. **Considered and rejected: a generic openai-compatible provider.**
   Lal already has `llamacpp.js` as the OpenAI-compatible adapter
   ([`packages/lal/providers/llamacpp.js`](../packages/lal/providers/llamacpp.js)).
   Reusing it for OpenRouter would skip the header-injection story
   and conflate "local OpenAI-compatible" with "router-aware
   OpenAI-compatible".
   Reason for rejection: OpenRouter has provider-specific behavior
   (the headers, the per-request cost field, the model-catalog endpoint)
   that deserves its own file, even when the wire format overlaps.

5. **Considered and rejected (for now): an explicit `providerKind`
   field instead of URL-shape inference.**
   The order-dependent `match(baseURL)` dispatch (Phase 1's
   `detectProviderKind`, carried into Phase 2's declared-order registry)
   infers *which provider* from *what the base URL happens to look
   like*: place-oriented inference that the "openrouter-before-`/v1`"
   ordering rule exists only to compensate for.
   A value-oriented alternative removes the inference entirely: let the
   user or config state `providerKind` directly
   (`'openrouter'`, `'anthropic'`, `'openai-compatible'`, `'gemini'`,
   `'ollama'`), matched on that field with no ordering dependency, so
   "which vendor" is decoupled from "what its URL happens to look like".
   `detectProviderKind` would survive only as a best-effort default when
   the field is omitted.
   Reason it is not the Phase 1/2 default: the shipped config surface is
   URL-first today (`LAL_HOST`), so an explicit-kind field is a config
   migration that belongs with the Phase 3 provider-config form, where
   `providerKind` becomes an explicit form field and the ordering rule
   can retire.
   Until then the ordering rule stands, documented as a known
   place-oriented wart (this decision and Design Decision 3) rather than
   an invisible one.

## Verification

Phase 1's load-bearing claim is the provider-detection *ordering* one:
the `openrouter.ai` predicate must resolve before the generic `/v1`
predicate, or OpenRouter silently misclassifies as
`'openai-compatible'`.
That claim is falsifiable and lands with a check:

- **Detection ordering.** A unit test asserts
  `detectProviderKind('https://openrouter.ai/api/v1')` returns
  `'openrouter'`, not `'openai-compatible'`, and that a plain
  `'https://host/v1'` still returns `'openai-compatible'`. A future
  reordering that regresses OpenRouter fails this test rather than
  shipping silently.
- **Existing-branch preservation.** A test asserts the
  `'openai-compatible'` branch and its
  `defaultModels['openai-compatible']` lookup are unchanged by the new
  `'openrouter'` branch, so llama.cpp and other generic `/v1` endpoints
  still resolve as before.
- **Header injection.** A test drives `makeOpenRouterProvider` against a
  stub endpoint and asserts the request carries `HTTP-Referer` and
  `X-Title`, distinguishing the router-aware path from the generic
  OpenAI-compatible adapter that omits them.

## Related Designs

- [endopen](endopen.md): primary comparative analysis.
- [lal-fae-form-provisioning](lal-fae-form-provisioning.md): Phase 3 piggyback.
- [endoclaw-network-fetch](endoclaw-network-fetch.md): outbound HTTP capability story.
- OpenCode reference:
  [`packages/opencode/src/provider/provider.ts`](https://github.com/anomalyco/opencode/blob/d59d9966/packages/opencode/src/provider/provider.ts)
  (`provider.ts`), lines 88 through 119 and 410 through 459.

## Prompt

> opencode ... can work well with openrouter
>
> kriskowal, 2026-05-15
