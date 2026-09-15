# OpenRouter (initial API backend)

Floot and Fae share an OpenRouter Chat Completions adapter.
It supports tool calls/results, token usage, bounded requests, and explicit API errors.
Floot responses are buffered (one answer delta), not token-streamed.
No subscription login or sandbox is involved: this is a paid API-key backend.
Inference and the endowed Endo tools run through the existing API-provider path.
Sandbox network-policy controls do not apply to this backend.

## Floot

Add the API key as UTF-8 text in the daemon's Secrets UI, for example `openrouter-auth`.
Do not put the key in chat, a provider configuration value, or a shell command.
From the repository, run the normal Floot setup with these non-secret options:

```sh
endo run --UNCONFINED packages/floot/floot-factory-setup.js --powers @agent \
  -E FLOOT_DIR=openrouter-floot \
  -E FLOOT_PROVIDER=openrouter \
  -E FLOOT_MODEL=vendor/model \
  -E FLOOT_AUTH_SECRET_NAME=openrouter-auth
```

Replace `vendor/model` with your chosen tool-capable OpenRouter model ID.
Use a separate `FLOOT_DIR` to preserve an existing Anthropic-backed factory;
each Floot factory currently has one API-provider configuration, alongside its hosted backends.
The picker labels this API backend OpenRouter and lists its configured model.
It does not fetch the full model catalog or advertise reasoning controls in this first pass.
Model variants with a colon suffix are treated as API model IDs, not hosted-backend IDs.
Reusing a factory directory changes its API provider: do not do that for existing sessions
unless you intend to send their history to the new provider.

The secret is re-read each turn, so rotation and revocation use the existing Secrets workflow.
Setup also accepts `OPENROUTER_API_KEY` or `FLOOT_AUTH_TOKEN` from the environment,
but requires successful secret-manager storage rather than falling back to plaintext.
Without an explicit secret name, it uses `<FLOOT_DIR>-openrouter-auth`.

## Fae

In the Create LLM Provider form, use:

- API host: `https://openrouter.ai/api/v1`
- Model: your organization-qualified OpenRouter model ID
- Existing Secrets name: `openrouter-auth`
- API auth token: leave blank

Then provision Fae with that provider's name using the existing `fae-factory-setup.js`.
The provider config stores only `host`, `model`, and `authSecretName`;
setup delegates the selected secret capability, and Fae follows credential rotation each turn.

Reference: [OpenRouter API](https://openrouter.ai/docs/api/reference/overview).
