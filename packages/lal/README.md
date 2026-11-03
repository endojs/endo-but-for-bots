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

Lal's agent harness is built directly on `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai`.
Each worker is a single `PiAgent` whose internal message history is the
durable transcript for the worker's lifetime.
The Endo capability tool surface (the `help`, `list`, `lookup`, `send`,
`reply`, `evaluate`, `define`, ... family) is dispatched through a
`listTools` / `execTool` pair constructed at worker spawn; tool arguments
are SmallCaps-decoded per call so BigInt-shaped strings (`"+5"`) and
`"#undefined"` continue to round-trip correctly.

`packages/lal/providers/` remains in place as a stable surface for downstream
consumers (jaine, fae).
It is no longer used by lal's own agent loop, which now goes through pi-ai's
multi-provider registry.

## Configuration

The agent is configured via environment variables.
The legacy `LAL_HOST` + `LAL_MODEL` + `LAL_AUTH_TOKEN` triple is translated
at worker spawn time into a pi-ai `provider/modelId` string:

| `LAL_HOST` matches                              | pi-ai provider                               |
| ----------------------------------------------- | -------------------------------------------- |
| `anthropic.com`                                 | `anthropic`                                  |
| `generativelanguage.googleapis.com` or `gemini` | `google`                                     |
| `openrouter`                                    | `openrouter`                                 |
| `openai.com`                                    | `openai`                                     |
| `:11434` (default Ollama port)                  | `ollama` (OpenAI-compatible local endpoint)  |
| anything else with `/v1`                        | `openai` (OpenAI-compatible, e.g. llama.cpp) |

`LAL_AUTH_TOKEN` reaches pi-ai through a `getApiKey` callback, unless the
environment already has a `<PROVIDER>_API_KEY`.

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

- Send a configuration form to the host
- On submission, create a guest profile and start monitoring its inbox
- Respond to messages using LLM-driven tool calls
- Send replies back to message senders

## Switching models mid-session

The host can change a worker's model between rounds by sending it a message
that contains only a `/model` command:

```text
/model                          reports the current model
/model anthropic/<model-id>     switches to a model in pi-ai's registry
/model ollama/<model-id>        switches to a model on the local Ollama
```

The conversation carries forward, and pi-ai adapts earlier turns for the new
provider.
The command does not start an LLM round and is dismissed after the reply.
From any sender other than the worker's host, `/model` is ordinary mail.

The worker's API auth token is only ever sent to the provider and base URL it
was configured for.
A model elsewhere needs its own credential in the daemon's environment, such as
`ANTHROPIC_API_KEY`; without one the switch is refused and the current model
stays selected.
The selection lasts as long as the worker's in-memory transcript, so neither
survives a restart.
