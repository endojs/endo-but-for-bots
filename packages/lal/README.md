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

`LAL_AUTH_TOKEN` is forwarded into `process.env.<PROVIDER>_API_KEY` so
pi-ai's adaptor finds it.

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

### Context compaction

`@endo/lal/providers/index.js` exports `planContextCompaction`,
`summarizeContext`, and `defaultContextCompactionSettings`. The
`ContextCompactionSettings` shape is declared once, in
`providers/context-compaction.js`:

| Setting              | Meaning                                           | Default                    |
| -------------------- | ------------------------------------------------- | -------------------------- |
| `enabled`            | Run automatic compaction; forcing ignores it      | `true`                     |
| `reserveTokens`      | Window held back for the next reply               | `16384`, capped at 30%     |
| `keepRecentTokens`   | Recent context kept verbatim                      | `20000`                    |
| `customInstructions` | Trusted operator focus added to the summary       | none                       |

Automatic compaction runs only when the model's window size and the last
request's token usage are both known, and only when usage exceeds the window
minus the reserve. The 30% cap applies only to the default reserve; an
explicit `reserveTokens` is used as given and fails if it leaves no input
window. Fae and Floot read these settings from `FAE_COMPACTION_*` and
`FLOOT_COMPACTION_*` variables.

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
