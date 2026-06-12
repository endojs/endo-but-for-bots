# @endo/agentry

Shared infrastructure for building agentic harnesses across endo packages.

The package is intended to grow as a small library of capabilities that more
than one agent harness in the monorepo needs.
Each surface is opt-in via its own subpath export.

## Current surfaces

- `@endo/agentry/code-mode-runtime` — shared Endo code-mode runtime factory
  for execute-only Pi agents. It resolves model/provider config, token
  callbacks, workspace and Git caps, read-only versus writable Git prompt
  declarations, and explicit Compartment endowments.
- `@endo/agentry/pi-extension` — Pi `ExtensionAPI` adapter that registers only
  the Endo-backed `execute` tool plus inspection commands. Pi drives events;
  Endo powers remain the only repository authority.
- `@endo/agentry/code-mode-agent-node` — initial Endo-hosted Node caplet entry.
  It can run unconfined for provider SDK access while repository caps still
  come from Endo powers.
- `@endo/agentry/code-mode-delegation` — factory for a delegation tool that
  starts a subordinate code-mode agent with caller-held workspace/Git powers
  and rejects read-only to writable Git upgrades.
- `@endo/agentry/lal-code-mode` and
  `@endo/agentry/lal-code-mode-git-loop` — lower-level execute-only bridge and
  backwards-compatible Git-loop helper built on the shared runtime.

## Endo Code Mode

All access paths share one configuration record:

```js
const config = {
  model: {
    provider: 'ollama',
    model: 'qwen3',
    baseUrl: 'http://localhost:11434',
    apiTokenEnvVar: 'OLLAMA_API_KEY',
  },
  powers: {
    workspacePetName: 'workspace',
    gitPetName: 'git',
    gitMode: 'readOnly', // or 'readWrite'
  },
  tools: { mode: 'executeOnly', include: ['workspace', 'git'] },
};
```

Programmatic usage:

```js
import { makeCodeModeRuntime } from '@endo/agentry/code-mode-runtime';

const runtime = makeCodeModeRuntime({ config, powers });
await runtime.agent.prompt('Inspect the current branch.');
await runtime.agent.waitForIdle();
```

Pi extension usage:

```js
import endoCodeModeExtension from '@endo/agentry/pi-extension';

export default pi => endoCodeModeExtension(pi, { config, powers });
```

Endo-hosted service usage:

```js
import { make } from '@endo/agentry/code-mode-agent-node';

export { make };
```

Environment variables for the unconfined Node entry include
`ENDO_CODE_MODE_PROVIDER`, `ENDO_CODE_MODE_MODEL`,
`ENDO_CODE_MODE_BASE_URL`, `ENDO_CODE_MODE_API_TOKEN_ENV`,
`ENDO_CODE_MODE_WORKSPACE`, `ENDO_CODE_MODE_GIT`, and
`ENDO_CODE_MODE_GIT_MODE`.

The model-facing tool surface is intentionally one tool:
`execute({ source, resultName? })`. Workspace and Git operations happen inside
the Endo Compartment through lexical caps (`workspace`, `git`, and any
configured named powers). API tokens are resolved by callbacks, pet names, or
environment variables and are not inserted into prompts or tool arguments.

## Intended buckets (not yet populated)

- captp helpers — generic CapTP tool-translation utilities, once a clear
  duplicate pattern emerges across the harnesses.
- prompt snippets — reusable building blocks for system prompts.
- provider mocks — shared mocks for `@mariozechner/pi-agent-core` and
  related provider adapters.

## Status

This package is private to the endo monorepo. The API is best-effort stable but
pre-1.0 — breaking changes in this package can land in the same PR as their
workspace consumers.
