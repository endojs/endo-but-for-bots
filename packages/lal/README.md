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

## Skills

An agent that holds the pet name `agent-skills` has
[Agent Skills](../skills/README.md). The name designates a directory of
read-only mounts, one per skill source, which `endo-skills-setup
<agent-name>` writes. Lal loads the skills each time the agent starts and
lists up to 200 of them in its system prompt (name, description, and a
pet-name location such as `agent-skills/10-user/my-skill/SKILL.md`). The
model reads a skill with `readText("agent-skills/10-user/my-skill",
"SKILL.md")`. When an entry is added to or removed from `agent-skills`,
the list is reloaded and applies from the next round. Edits inside a
mounted directory apply at the next start.

A message that starts with `/skill:<name> [args]` runs a round with the
skill's current body in place of the message, followed by the arguments.
This works for skills marked `disable-model-invocation`, which are not
listed in the prompt. An unknown name gets an error reply and no round.

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
