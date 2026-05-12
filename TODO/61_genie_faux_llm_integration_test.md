# Replace ollama dependency in dev-repl sandbox integration tests with `pi-ai`'s `faux` provider

## Context

`packages/genie/test:integration:dev-repl-sandbox` (and the
daemon-side `test:integration:sandbox-slice`) currently shell out to
the dev-repl with `-m ollama/llama3.2`, then probe the slice from
inside an LLM round-trip.  This works on a developer laptop with
ollama running, but the tests skip cleanly (`SKIP:` log line +
`t.pass()`) when:

- Ollama isn't installed.
- `localhost:11434` isn't listening.
- The configured model isn't pulled.
- Anything in between makes the round-trip flake (the SKIP is
  permissive because we don't want the test suite to block CI on an
  external service).

The skip is so permissive that the TODO/57 audit found real tool
failures hiding behind it: the test exited 0 because the LLM probe
flaked, the tool errors never landed in an assertion, and the
regression sat undiscovered until the operator ran the dev-repl by
hand.

## Plan: use `pi-ai`'s existing `faux` provider

`@mariozechner/pi-ai` already ships a faux provider — see
`node_modules/.../pi-ai/dist/providers/faux.js` and the public
helpers:

```ts
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
  registerFauxProvider,
} from '@mariozechner/pi-ai/providers/faux';
```

`registerFauxProvider({ api, provider, models })` returns a handle
whose `setResponses([…])` queues up the assistant messages the agent
will see on successive turns.  Each step can be either a static
`AssistantMessage` or a factory `(context, opts, state, model) =>
AssistantMessage` so canned scripts can branch on the current call
count or the most recent tool result.

This is exactly the shape the genie agent's `runAgentRound` consumes
— pi-agent-core invokes the registered provider just like any other
provider, so no changes are needed in `agent/index.js`, the
`buildGenieTools` wiring, or the dev-repl loop.

## Tasks

1. [ ] Add a thin helper under `packages/genie/test/_helpers/faux.js`
   (new file) that:
   - Registers a faux provider on first call.
   - Exposes a `scriptedAgent({ steps })` builder that queues the
     `steps` and returns a model-id string (`'faux/script-1'`) the
     dev-repl can take via `-m`.
   - Cleans up via `t.teardown(() => unregister())` so AVA's
     `test.serial` discipline survives parallel files.

2. [ ] Convert `test/dev-repl-sandbox.test.js` to spawn the dev-repl
   with the faux model id instead of `ollama/llama3.2`:
   - The first step emits a single `bash` tool call that probes
     `pwd && uname -a && ls /workspace`.
   - The second step (factory) reads the bash output from the
     conversation context and emits a final assistant text the test
     can grep for.
   - The test asserts the bash result's `cwd` is `/workspace`, the
     `uname` output contains the host kernel, and the workspace
     mount is visible — exactly the probe shape today's ollama-driven
     test claims to check, but now deterministic.

3. [ ] Drop the `SKIP:` fallback for "no ollama / model unreachable".
   The bwrap-unavailable skip stays (`bwrap --version` failure /
   kernel without unprivileged user namespaces) because that's a
   genuine host capability gap.

4. [ ] Mirror the conversion in
   `test/scenarios/sandbox-slice.scenario.js` (daemon path).  The
   daemon scenario also shells through `setup.js`, so the faux
   model id needs to be plumbed through `GENIE_MODEL`.

5. [ ] Verify the test suite still passes when:
   - Ollama is running (no accidental coupling).
   - Ollama is not running (no SKIP, real assertions fire).
   - `bwrap` is missing (test still skips for the right reason).

## Notes

- The faux provider runs entirely in-process, so the tests stay fast
  and deterministic (no network, no model download).
- Because the provider is registered globally with pi-ai's api
  registry, parallel AVA files could trample each other — keep the
  faux-driven tests `test.serial` and unregister between tests, or
  give each test a unique `api` / `provider` name.
- The "canned response" surface is rich enough to test multi-turn
  conversations: the second step's factory can inspect
  `context.messages` to see the prior `toolResult` and branch on it.
  Use this to write probes that drive a sequence of tool calls,
  not just a single round.

## Acceptance

- Both `test:integration:dev-repl-sandbox` and
  `test:integration:sandbox-slice` run without ollama installed.
- The probes inside those tests assert real outcomes (slice's
  `/workspace` bind, host kernel string, etc.) and fail loudly when
  the tool / spawner regresses.
- The TODO/58-style "failure" of an LLM mis-quoting an argv element
  becomes a non-issue in CI because the scripted assistant never
  mis-quotes.
