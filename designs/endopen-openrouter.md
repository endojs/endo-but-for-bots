# EndOpen: OpenRouter at the Agentry Boundary

|             |                                              |
|-------------|----------------------------------------------|
| **Created** | 2026-05-15                                   |
| **Updated** | 2026-10-10                                   |
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

An earlier draft of this design added an OpenRouter adapter to Lal's
per-file provider table.
That is no longer the way: Endo's agents are now assembled at the
**Agentry boundary**, so OpenRouter support is specified there and
nowhere else.
[`@endo/agentry`](agentry-agent-builder.md)'s `defineAgent` resolves its
`model` config through `resolveModelProfile`
([`packages/agentry/src/harness/model.js`](../packages/agentry/src/harness/model.js))
into a concrete `@earendil-works/pi-ai` `Model`, and resolves the
provider key through the `Credentials` seam at make time.
Any harness built with `defineAgent` (code-mode presets, a rebuilt lal,
genie, or an operator's own agent) inherits whatever provider reach the
Agentry boundary has, so the gap is closed once, for every agent.

The reach is already most of the way there.
pi-ai `0.79.0` (the version `packages/agentry/package.json` pins) ships
`openrouter` as a built-in registry provider: its generated model table
carries several hundred `openrouter` entries at
`https://openrouter.ai/api/v1`, its OpenAI-completions client honors
OpenRouter's normalized `reasoning` object and per-model routing
preferences, and its env-key table maps `openrouter` to
`OPENROUTER_API_KEY`.
A `"provider/modelId"` model string splits at the *first* slash, so
`model: 'openrouter/anthropic/claude-sonnet-4'` already resolves to
provider `openrouter`, id `anthropic/claude-sonnet-4`.

What remains is narrow:

- **Attribution headers.** pi-ai sends a model's `headers` merged with
  per-call options, and sets no `HTTP-Referer` / `X-Title` for
  OpenRouter.
  Agentry has no config field to supply them.
- **Catalog drift.** pi-ai's table is a generated snapshot.
  A model OpenRouter lists after the snapshot fails with
  `Unknown pi-ai model: openrouter/<id>`.
  The only escape hatch today is an `openai-compatible` profile with
  `baseUrl`, which `resolveModelProfile` builds with provider `'openai'`,
  so the `Credentials` seam looks up the wrong key and the model loses
  its OpenRouter identity.
- **Durable configuration.** The key is resolved from the environment
  (`makeEnvCredentials`).
  A daemon-hosted agent should name its OpenRouter key and default model
  by pet name instead.

## Design

### Phase 1: Document and test the registry path (minimal)

No new adapter.
Pin, with a test in `packages/agentry`, that the existing path works:

```js
import { defineAgent } from '@endo/agentry';

const makeAgent = defineAgent({
  model: 'openrouter/anthropic/claude-sonnet-4',
  instructions: 'You are a helpful agent.',
  tools: [],
});
// Credentials seam: makeEnvCredentials resolves OPENROUTER_API_KEY.
const agent = makeAgent({ credentials });
```

The test asserts that the resolved `Model` has `provider: 'openrouter'`,
`baseUrl: 'https://openrouter.ai/api/v1'`, and the id after the first
slash, and that the maker's `getApiKey('openrouter')` reaches the
`Credentials` seam.
The `@endo/agentry` README gains an OpenRouter example.
That makes the code-mode presets (`makeCodeModeAgent`,
`makeCodeModeGitLoopAgent`) OpenRouter-capable with no further change.

### Phase 2: An `openrouter` arm in `resolveModelProfile`

Extend the profile config with optional `headers` and teach
`resolveModelProfile` an explicit `openrouter` arm, keyed on the
**provider field**, not on URL shape:

1. If `provider === 'openrouter'` and the id is in pi-ai's registry, take
   the registry `Model` (as today) and overlay `headers`.
2. If the id is *not* in the registry, build an OpenAI-completions
   `Model` at `https://openrouter.ai/api/v1` with `provider: 'openrouter'`
   (so the `Credentials` seam still resolves the OpenRouter key) and the
   profile's `cost` / `contextWindow` / `maxTokens` budget overrides,
   instead of throwing.
3. Default the attribution headers to `HTTP-Referer:
   https://github.com/endojs/endo` and `X-Title: Endo` when the profile
   does not supply them.

The arm reuses `buildOpenAICompatibleModel` and lives beside the
existing `ollama` / `openai-compatible` arms; nothing outside
`packages/agentry` learns about OpenRouter.

### Phase 3: Pet-named provider configuration

Today a daemon-hosted agent gets its key from the process environment.
The [`agentry-agent-builder`](agentry-agent-builder.md) § Retained daemon
sessions provisioning policy already names remote credentials only as
host-side pet names whose material stays in the daemon; the same shape
applies to model providers.
The operator fills `provider`, `API key`, `default model`, and the
optional attribution headers once (a form, following the
[`lal-fae-form-provisioning`](lal-fae-form-provisioning.md) pattern), and
the result is a durable model profile referenceable by pet name.
The provisioning host resolves the pet name to a model profile plus a
capability-scoped `Credentials` provider and passes both to the maker,
so the guest never holds the key.

This is a UX and confinement improvement, not a correctness improvement;
gate it behind Phase 2 (the profile shape is what the form fields fill).

## Dependencies

| Design                                | Relationship                                         |
|---------------------------------------|------------------------------------------------------|
| [agentry-agent-builder](agentry-agent-builder.md) | The boundary: `defineAgent` model resolution and the `Credentials` seam |
| [lal-fae-form-provisioning](lal-fae-form-provisioning.md) | Phase 3 borrows the form-based config pattern |
| [endoclaw-network-fetch](endoclaw-network-fetch.md) | OpenRouter calls go through Endo's outbound HTTP capability when capability-confined |

## Phased Implementation

| Phase | What                                  | Size | Notes                                    |
|-------|---------------------------------------|------|------------------------------------------|
| 1     | Registry-path test + README example   | S    | No new code path; pins existing behavior |
| 2     | `openrouter` arm in `resolveModelProfile` | S    | ~60 LOC; headers + off-snapshot models  |
| 3     | Pet-named provider configuration      | M    | Depends on Phase 2 and session provisioning |

Total: about 3 days for Phases 1 and 2 (Phase 1 alone is under a day);
Phase 3 is a separate M-sized follow-on that waits on retained-session
provisioning.

## Open Questions

- **Header values**:
  what should `HTTP-Referer` and `X-Title` be for an Endo daemon?
  OpenCode uses `https://opencode.ai/` and `opencode`.
  Proposal: `https://github.com/endojs/endo` and `Endo`, overridable per
  profile.
  OpenRouter uses the headers to attribute traffic;
  reasonable defaults that identify the project are appropriate.
- **Cost telemetry**:
  OpenRouter returns per-request cost in the response body, and pi-ai
  carries usage on each assistant message.
  The [`endopen-tui-shell`](endopen-tui-shell.md) design proposes a
  status-bar slot that would surface it.
- **Model catalog**:
  OpenRouter exposes `/models` as a JSON catalog.
  The Phase 3 form could fetch it and offer a dropdown rather than a
  free-form model id.
  Whether Phase 2's off-snapshot models should also read context and
  pricing from `/models` (instead of profile overrides) is open.

## Design Decisions

1. **The interface boundary is Agentry, not any one harness.**
   Lal, fae, genie, and the code-mode presets are all meant to be
   `defineAgent(...)` configurations
   ([agentry-agent-builder](agentry-agent-builder.md) § What is the
   Problem Being Solved?).
   A provider added to one harness's private table would have to be
   added again to each of the others; a provider reachable through
   `resolveModelProfile` reaches all of them.
   This design therefore touches no harness package.

2. **Reuse pi-ai's registry provider; do not write an adapter.**
   pi-ai already speaks OpenRouter's dialect (reasoning normalization,
   routing preferences, the env-key mapping).
   A hand-written `fetch` adapter would duplicate that and lose
   streaming, which pi-agent-core's loop already uses.

3. **Dispatch on the provider field, never on URL shape.**
   The earlier draft inferred the provider from the base URL and needed
   an ordering rule (`openrouter.ai` before the generic `/v1` match) to
   avoid misclassifying OpenRouter as generic OpenAI-compatible.
   `resolveModelProfile` already keys registry lookups on `provider`, so
   the Phase 2 arm is keyed the same way and the ordering hazard does
   not arise.

4. **The daemon does not learn about HTTP providers.**
   Provider access happens in the agent's worker, through the `Model`
   the maker binds, gated by whatever outbound HTTP capability that
   worker holds
   (today: ambient fetch;
   in the future: [endoclaw-network-fetch](endoclaw-network-fetch.md)
   with an OpenRouter allowlist entry).

5. **Considered and rejected: routing through the `openai-compatible`
   arm.**
   It works on the wire, but builds the `Model` as provider `'openai'`,
   so key resolution, cost accounting, and pi-ai's OpenRouter-specific
   request shaping all see the wrong provider.
   Phase 2's dedicated arm keeps the identity.

## Verification

- **Registry resolution.** A unit test asserts
  `resolveModelProfile({ model: 'openrouter/anthropic/claude-sonnet-4' })`
  returns a `Model` with `provider: 'openrouter'` and the OpenRouter base
  URL, and that the first-slash split keeps the vendor prefix in the id.
- **Key resolution.** A test asserts a maker built from that definition
  asks the `Credentials` seam for `openrouter`, not `openai`.
- **Off-snapshot models (Phase 2).** A test resolves an id absent from
  pi-ai's table and asserts it yields an `openrouter` `Model` rather
  than throwing.
- **Header injection (Phase 2).** A test drives the resolved model
  against a stub endpoint and asserts the request carries `HTTP-Referer`
  and `X-Title`.

## Related Designs

- [endopen](endopen.md): primary comparative analysis.
- [agentry-agent-builder](agentry-agent-builder.md): the `defineAgent` boundary this design extends.
- [endopi-provider-registry-and-oauth](endopi-provider-registry-and-oauth.md): the broader pi-ai registry and subscription OAuth track.
- [lal-fae-form-provisioning](lal-fae-form-provisioning.md): Phase 3 form pattern.
- [endoclaw-network-fetch](endoclaw-network-fetch.md): outbound HTTP capability story.
- OpenCode reference:
  [`packages/opencode/src/provider/provider.ts`](https://github.com/anomalyco/opencode/blob/d59d9966/packages/opencode/src/provider/provider.ts)
  (`provider.ts`), lines 88 through 119 and 410 through 459.

## Prompt

> opencode ... can work well with openrouter
>
> kriskowal, 2026-05-15

> Coupling to Lal specifically is no longer the way. We would interface
> at the Agentry boundary
>
> kriskowal, review of PR #266
