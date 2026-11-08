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
Floot reads the account-filtered model catalog under its own credential. Its picker lists the models available to that account. Colon suffixes in OpenRouter model IDs are preserved.

To add OpenRouter to a factory already using an Anthropic API key, rerun its existing setup with two additional options: `FLOOT_OPENROUTER_SECRET_NAME=openrouter-auth` and `FLOOT_OPENROUTER_MODEL=vendor/model`. This publishes an independent OpenRouter route and preserves the provider used by the factory's existing sessions. A factory serving only subscription accounts can be installed with `FLOOT_PROVIDER=none` before the direct pool setup scripts run.

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
