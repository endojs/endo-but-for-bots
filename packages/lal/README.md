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

## Context compaction

A long conversation would eventually outgrow the model's context window, so a
worker compacts it: older messages are replaced by one structured summary, and
recent messages stay verbatim. Each summary builds on the previous one, so a long
session holds a single summary.

Compaction runs automatically when the context comes within `reserveTokens` of
the window, both before a round and between the tool calls of a long one. If the
provider still reports a context overflow, the worker compacts and retries the
round once.

The host can also send the worker `/compact`, optionally followed by instructions
that focus the summary, such as `/compact preserve the bug hunt`. From any other
sender, `/compact` is ordinary mail for the LLM.

| Variable                            | Description                                 | Default |
| ----------------------------------- | ------------------------------------------- | ------- |
| `LAL_COMPACTION_ENABLED`            | Compact automatically (`true` or `false`)   | `true`  |
| `LAL_COMPACTION_RESERVE_TOKENS`     | Reserved for the model's response           | `16384` |
| `LAL_COMPACTION_KEEP_RECENT_TOKENS` | Recent context kept verbatim                | `20000` |
| `LAL_COMPACTION_INSTRUCTIONS`       | Instructions added to every summary request | -       |

These are read from the daemon's environment when a worker starts. On a small
window, the worker reduces the reserve to at most half the window and the kept
context to at most half of what remains, so that compaction can free space.

Compaction is lossy, and elided messages are not yet saved anywhere: the
transcript lives only in the worker's memory. The mail itself remains in the
daemon, where `messageHistory` can read it. The design is
[endopi-iterative-compaction](../../designs/endopi-iterative-compaction.md).

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
