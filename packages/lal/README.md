# lal

This `@endo/lal` package is an unconfined `@endo/daemon` plugin that provides
an LLM-powered agent with Endo Guest capabilities.

The LLM agent uses tool calls to interact with the Endo daemon, enabling it to:

- Manage pet names (list, lookup, remove, move, copy)
- Send and receive messages
- Adopt capabilities from messages
- Request capabilities from its host
- Inspect capabilities via their `help()` methods

## Architecture

Lal's agent harness is built on `@endo/genie`'s pi-based agent loop
(`@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`). Each worker is a
single `PiAgent` whose internal message history is the durable transcript
for the worker's lifetime. The Endo capability tool surface (the `help`,
`list`, `lookup`, `send`, `reply`, `evaluate`, `define`, ... family) is
dispatched through a `listTools` / `execTool` pair handed to
`makePiAgent`; tool arguments are SmallCaps-decoded per call so
BigInt-shaped strings (`"+5"`) and `"#undefined"` continue to round-trip
correctly.

`packages/lal/providers/` remains in place as a stable surface for
downstream consumers (jaine, fae). It is no longer used by lal's own
agent loop, which now goes through pi-ai's multi-provider registry.

## Configuration

The agent is configured via environment variables. The legacy
`LAL_HOST` + `LAL_MODEL` + `LAL_AUTH_TOKEN` triple is translated at
worker spawn time into a pi-ai model plus a worker-local API-key
resolver:

| `LAL_HOST` matches                              | pi-ai provider                               |
| ----------------------------------------------- | -------------------------------------------- |
| `anthropic.com`                                 | `anthropic`                                  |
| `generativelanguage.googleapis.com` or `gemini` | `google`                                     |
| `openrouter`                                    | `openrouter`                                 |
| `openai.com`                                    | `openai`                                     |
| `:11434` (default Ollama port)                  | custom Ollama-compatible model               |
| anything else with `/v1`                        | custom OpenAI-compatible model               |
| anything else                                   | custom Ollama-compatible model               |

Use `LAL_AUTH_TOKEN` when the credential should belong to one Lal worker. In
the daemon path, each worker receives its own config object, and that token is
passed to pi-agent-core through a worker-local API-key resolver. It is not
copied into `process.env`, so multiple Lal agents can run in one daemon process
with different providers or API keys.

If `LAL_AUTH_TOKEN` is omitted, pi-ai falls back to its normal process-level
provider environment variables. Common examples are `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, and `OPENROUTER_API_KEY`. These are
useful for one-provider local setups, but every worker in the daemon process
sees the same ambient values.

| Variable         | Description                          | Default                  |
| ---------------- | ------------------------------------ | ------------------------ |
| `LAL_HOST`       | API base URL                         | `http://localhost:11434` |
| `LAL_MODEL`      | Model identifier within the provider | provider-specific        |
| `LAL_AUTH_TOKEN` | API key                              | -                        |

Example configuration files are provided:

- `local.env.example` - Local Ollama instance
- `cloud.env.example` - Remote Ollama with authentication
- `openai.env.example` - OpenAI API
- `opus.env.example` - Anthropic Claude (Opus)

## Usage

```bash
# Source your configuration
source local.env.example

# Start the agent
yarn setup
```

The agent will:

1. Send a configuration form to the host
2. On submission, create a guest profile and start monitoring its inbox
3. Respond to messages using LLM-driven tool calls
4. Send replies back to message senders
