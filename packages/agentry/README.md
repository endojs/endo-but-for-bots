# @endo/agentry

Shared infrastructure for building agentic harnesses across endo packages.

The package is intended to grow as a small library of capabilities that more
than one agent harness in the monorepo needs.
Each surface is opt-in via its own subpath export.

## Public exports

The package root `@endo/agentry` exports `defineAgent`, the model-resolution
functions `resolveModel`, `resolveModelProfile`, `resolveModelString`,
`buildOllamaModel`, and `defineModels`, and the credential functions
`getAmbientEnv`, `makeEnvCredentials`, and `makeApiKeyGetter`.
It also exports the shared Pi builder `makePiAgent`.

The `@endo/agentry/define-agent` subpath exports `defineAgent(config)`.
It returns a maker function: the powerless definition is the closure, and
calling the returned maker with a powers handle is the powered stage.

The `@endo/agentry/harness` subpath exports the same model, credential, and Pi
builder functions for consumers that want to make the harness seams explicit.
`@endo/lal` imports these directly.

The `@endo/agentry/code-mode` subpath exports the generic Pi code-mode maker
`makeCodeModeAgent`, the host-independent setup function `prepareCodeMode`, and
the prompt helper `makeCodeModeSystemPrompt`.
Preparation keeps execution host and access authority as independent choices:

```js
import {
  makeCodeModeAgent,
  prepareCodeMode,
} from '@endo/agentry/code-mode';

const setup = await prepareCodeMode({
  host: { kind: 'inProcess' },
  powers: { workspace, git },
  access: 'inspect',
});

const { agent } = makeCodeModeAgent({ model, ...setup });
```

The returned `{ evaluate, globals }` is host-neutral.
The maker does not acquire repository resources or infer authority; it consumes
the evaluator and matching global descriptors produced by trusted preparation.

The reusable tool and host story is documented in
[`@endo/agent-tools`'s One tool, two hosts section](../agent-tools/README.md#one-tool-two-hosts).
Agentry remains the complete Pi harness and owns the packaged interactive CLI.
`@endo/agent-tools` supplies the scoped Pi tool layer and future MCP adapters.

The `@endo/agentry/eval` and `@endo/agentry/edit-text` subpaths expose the
shared eval harness and pure text-editing helpers respectively.
Eval scenario agents are internal fixtures and are not public presets.

## defineAgent

`defineAgent(config)` returns a **maker function**. The powerless definition —
the resolved model, the system instructions, and the model-facing tool surface —
is captured in the maker's closure and holds no powers. Calling the maker with a
powers handle is the powered stage:

```js
import { defineAgent } from '@endo/agentry';

const makeAgent = defineAgent({
  model: 'sonnet', // a profile id, or a concrete pi-ai Model
  instructions: 'You are a helpful agent.',
  tools: [/* model-facing AgentTools */],
});

const agent = makeAgent(/* powers? */);
await agent.prompt('Hello.');
await agent.waitForIdle();
```

Config is scoped to `{ model, instructions, tools, endow }`. The `endow` hook
derives the powered tool surface and credential resolver from the live powers at
construction time, so the powerless definition never holds a capability.
Importing `@endo/agentry/harness` performs **no** provider registration as a
side effect; instead the harness registers pi-ai's built-in providers lazily, on
first model resolution, so a registry model resolves without any caller-side
setup:

```js
import { defineAgent } from '@endo/agentry';

const makeAgent = defineAgent({
  model: 'anthropic/claude-opus-4-5-20251101',
});
```

`actions`/`skills`/`cwd` are deferred.

## Credential seam

`@endo/agentry/harness` exports `makeEnvCredentials`, the harness's single choke
point for reading secrets. `get(name)` resolves a key out of the ambient process
environment (the default) or a caller-supplied record. Every consumer resolves
secrets through `.get()`, so swapping the env-backed provider for a
capability-scoped secret store is a local change.

## Code mode

Code mode is just an agent whose one tool is `evaluate`.
`prepareCodeMode` realizes the requested access on the selected host, and
`makeCodeModeAgent` remains the one generic code-mode constructor.

For an in-process eval or test, pass already-minted live powers directly:

```js
import {
  makeCodeModeAgent,
  prepareCodeMode,
} from '@endo/agentry/code-mode';

const setup = await prepareCodeMode({
  host: { kind: 'inProcess' },
  powers: { workspace, git },
  access: 'inspect',
});

const { agent } = makeCodeModeAgent({
  model,
  ...setup,
});
await agent.prompt('Inspect the current branch.');
await agent.waitForIdle();
```

Direct powers are process-local endowments.
They are ephemeral unless the caller supplies an existing storage hook.
An in-process host may also receive a `powers` lookup object and pet-name
bindings for already-minted capabilities.

For daemon-hosted evaluation, pass the live daemon powers reference.
The trusted daemon provisioner may clone a remote repository and mint the
requested repository authority:

```js
import {
  makeCodeModeAgent,
  prepareCodeMode,
} from '@endo/agentry/code-mode';

const setup = await prepareCodeMode({
  host: { kind: 'daemon', powers: daemonPowers },
  repository: { remoteUrl },
  access: 'edit',
});

const { agent } = makeCodeModeAgent({ model, ...setup });
```

Daemon powers are daemon-owned and resolved by pet name during evaluation.
Callers can alternatively provide already-minted daemon capabilities or their
pet names as `powers.workspace` and `powers.git`.
The trusted daemon boundary validates their authority, derives any required
attenuation, stores the resulting pet-name bindings, and attests the matching
global descriptors before `makeDaemonEvaluate` forwards guest source.

The access presets have the same meaning on both hosts:

- `inspect` derives read-only Git and Filesystem capabilities and advertises
  declarations that omit their mutating methods.
- `edit` requires ordinary writable workspace and Git authority without
  history-rewrite authority.
- `rewriteHistory` additionally requires Git authority explicitly minted for
  history rewriting.

Preparation may narrow existing authority, but never widens a supplied
attenuated capability.
An unknown or remote-shaped posture is not treated as proof of write authority,
so `edit` and `rewriteHistory` fail clearly unless trusted host preparation can
mint the requested authority.
The history-rewrite surface advertises the elevated `gitHistory` declarations,
including amend and reword operations.

A remote URL is trusted setup data, not a power granted to evaluated code.
Clone controllers, credentials, raw host paths, and ambient network authority
remain host-only.
Daemon setup can use durable host services, while direct test setup performs no
network operation and requires no daemon or credentials.

Additional named powers may be supplied as `powers.namedPowers`.
`inspect` currently attenuates the registered repository powers, `workspace`
and `git`; other named powers remain unchanged and are described as such.
Callers must not interpret `inspect` as universal attenuation of arbitrary
capabilities.
Future power types can join the setup contract with their own trusted
attenuators and descriptor factories.

The model-facing tool surface is intentionally one tool:
`evaluate({ source, resultName? })`. Workspace and Git operations happen inside
the Endo Compartment through lexical caps (`workspace`, `git`, and any
configured named powers).
The lexical globals are advertised to the model with generated TypeScript
declarations that match the authority prepared for the session.
The model can also discover a capability's runtime surface via
`E(cap).__getMethodNames__()`.
A descriptor guides the model but grants no authority; live capabilities and
their guards remain the enforcement boundary.

Plain-data completion values returned from `evaluate` are encoded for the model
with the SmallCaps renderer from `@endo/agent-tools`, so BigInts and other
non-JSON-native passable values round-trip losslessly. Capability-bearing
results are not serialized; the agent keeps them live inside the Compartment and
stores them under a pet name via `resultName` when it needs them across turns.

The complete Pi harness remains in agentry.
The reusable evaluate substrate, capability declarations, and adapters live in
`@endo/agent-tools`.
An external MCP server is a separate consumer of that package.

## Status

This package is private to the endo monorepo. The API is best-effort stable but
pre-1.0 — breaking changes in this package can land in the same PR as their
workspace consumers.
