# @endo/agentry

Shared infrastructure for building agentic harnesses across endo packages.

The package is intended to grow as a small library of capabilities that more
than one agent harness in the monorepo needs.
Each surface is opt-in via its own subpath export.

## Current surfaces

- `@endo/agentry` (root) — `defineAgent` plus the harness primitives
  (the credential seam, model resolution, and the pi-agent builder).
- `@endo/agentry/define-agent` — `defineAgent(config)`, which returns a maker
  function: the powerless definition is the closure, and calling the returned
  maker with a powers handle is the powered stage.
- `@endo/agentry/harness` — the code-mode-independent primitives the harness is
  built from: `makeEnvCredentials` (the single reader of `process.env`),
  `resolveModel`/`defineModels`, and `makePiAgent`. `@endo/lal` imports these
  directly.
- `@endo/agentry/code-mode` — the complete Pi code-mode preset and prompt
  assembly (`makeCodeModeAgent`, `makeCodeModeGitLoopAgent`), built on
  `defineAgent` and `@endo/agent-tools`.
- `@endo/agentry/code-mode-provisioning` — Pi-independent translation from a
  plain provisioning policy to a retained daemon guest, matching lexical
  global descriptors, and non-secret reconstruction data.

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

Code mode is just an agent whose one tool is `evaluate`. `makeCodeModeAgent` is
the code-mode preset of `defineAgent`:

```js
import { makeCodeModeAgent } from '@endo/agentry/code-mode';

const { agent } = makeCodeModeAgent({
  model,
  powers: { workspace, git, gitMode: 'historyRewrite' },
});
await agent.prompt('Inspect the current branch.');
await agent.waitForIdle();
```

`gitMode` is `'readOnly'`, `'readWrite'` (the default), or
`'historyRewrite'`.
The history-rewrite mode requires a Git capability minted with explicit
history-rewrite authority and advertises the elevated `gitHistory` surface,
including amend and reword operations.

The model-facing tool surface is intentionally one tool:
`evaluate({ source, resultName? })`. Workspace and Git operations happen inside
the Endo Compartment through lexical caps (`workspace`, `git`, and any
configured named powers).
The prompt carries generated TypeScript declarations selected for the granted
capability mode; `E(cap).__getMethodNames__()` remains the fallback for methods
outside a declaration.

Plain-data completion values returned from `evaluate` are encoded for the model
with the SmallCaps renderer from `@endo/agent-tools`, so BigInts and other
non-JSON-native passable values round-trip losslessly. Capability-bearing
results are not serialized; the agent keeps them live inside the Compartment and
stores them under a pet name via `resultName` when it needs them across turns.

The complete Pi harness remains in agentry.
The reusable evaluate substrate, capability declarations, and adapters live in
`@endo/agent-tools`.
An external MCP server is a separate consumer of that package.

## Daemon code-mode provisioning

`@endo/agentry/code-mode-provisioning` owns the host-privileged lifecycle that
maps inert session policy into daemon capabilities.
It is independent of Pi and can feed any code-mode loop that accepts an
`evaluate` implementation and lexical global descriptors.

```js
import { makeDaemonEvaluate } from '@endo/agent-tools/code-mode/daemon.js';
import { makeCodeModeAgent } from '@endo/agentry/code-mode';
import { provisionEndoCodeMode } from '@endo/agentry/code-mode-provisioning';

const session = await provisionEndoCodeMode({
  sessionId: conversationId, // stable across process restarts
  cwd: process.cwd(),
  spec: {
    workspace: { path: '.', deniedSegments: ['.git', '.env'] },
    fs: 'readOnly',
    git: 'readWrite',
  },
});

const { agent } = makeCodeModeAgent({
  model,
  evaluate: makeDaemonEvaluate(session.powers),
  globals: session.globals,
});

// Save this plain record, not the guest or any daemon capability.
await saveSession(session.persistence);

try {
  await agent.prompt('Inspect the repository status.');
  await agent.waitForIdle();
} finally {
  await session.cleanup();
}
```

The `EndoProvisionSpec` fields are optional grants:

- `fs`: `'readOnly'` or `'readWrite'`;
- `git`: `'readOnly'`, `'readWrite'`, or `'historyRewrite'`; and
- `gitRemotes`: remote policies using the daemon's current Git-remote options.

Omission grants nothing.
When either `fs` or `git` is present, `workspace.path` defaults to `cwd`.
Filesystem and Git are selected independently, but writable Git necessarily
writes the same working tree at the OS level, so a writable Git mode
(`readWrite` or `historyRewrite`) requires a writable filesystem grant;
`fs: 'readOnly'` combined with a writable Git mode is rejected at
provisioning time, and the daemon rejects the same combination independently
if it is ever reached directly.
Git remotes therefore require writable Git.
A remote credential is only a host-side pet name; tokens, passwords, embedded
URL credentials, and secret-shaped fields are rejected.

Provisioning derives deterministic controller aliases and retained guest handle
and agent paths from `sessionId`.
The host retains those aliases while the guest receives the same formula IDs as
the simple pet names `workspace`, `git`, and each remote name.
Consequently, daemon evaluation with `resultName` stores the result in the guest
petstore rather than the host petstore.
`cleanup()` closes only the caller's CapTP connection and local operations; it
does not delete the retained formulas or guest.

To resume after disconnect or daemon restart, persist `session.persistence` and
pass it to `reconstructEndoCodeMode({ persistence })`.
The versioned record contains only the retained guest pet-name path, canonical
workspace path, and normalized non-secret policy.
It excludes capabilities, formula IDs, daemon endpoints, credential material,
and host authority, and reconstruction rejects policy changes or widening.
Credential material is process-local today, so reconstruction after a daemon
restart reports `EndoCredentialUnavailableError` until the named host credential
is reprovisioned.

## Status

This package is private to the endo monorepo. The API is best-effort stable but
pre-1.0 — breaking changes in this package can land in the same PR as their
workspace consumers.
