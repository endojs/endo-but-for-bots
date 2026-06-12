# Endo Pi Code-Mode Access Plan

| | |
|---|---|
| **Created** | 2026-06-12 |
| **Status** | Implemented |
| **Scope** | Pi-driven Endo code mode access paths |

## Purpose

We want several ways to run the same Endo code-mode agent loop:

1. A Pi `ExtensionAPI` integration where Pi is the driver, but Endo owns the
   tools, powers, and security boundary.
2. An Endo-hosted flavor that runs Pi from an Endo entry point. It may be
   unconfined initially, with an explicit path to a confined module graph.
3. Programmatic usage for embedding, including a future delegation tool that
   calls another Pi agent with strictly less authority than the caller.

All paths need one shared configuration model for:

- model and provider selection
- API token resolution
- tool selection
- Endo code-mode powers
- read-only versus writable Git authority
- optional result storage and transcript policy

## Plan Assessment

The plan is sound, but the three access paths should not grow three separate
agent implementations. They should share one core factory and differ only in
how they acquire configuration, powers, and user prompts.

Recommended architecture:

- `@endo/agentry/lal-code-mode` remains the low-level execute-only PiAgent
  bridge.
- `@endo/agentry/lal-code-mode-git-loop` remains the first concrete coding
  loop over `workspace` and `git` powers.
- Add a new shared "code-mode runtime config" layer that turns a config record
  plus powers into `{ globals, execute, model, getApiKey, tools }`, where
  `globals` is the internal Compartment binding representation.
- Build the Pi extension, Endo unconfined entry point, and programmatic factory
  on top of that layer.

Key correction to the plan:

- Running Pi inside an Endo Compartment and running an Endo code-mode
  Compartment from Pi are different milestones. The first pass should run the
  Pi library from an unconfined Endo Node caplet, while tool execution happens
  in a SES Compartment with explicit endowments. Moving Pi itself into a
  confined Compartment is a follow-up because Pi and provider SDKs need module
  loading, fetch, timers, crypto, and stream endowments audited as a graph.

Not a blocker:

- The current commit already separates read-only and writable Git prompt types.
  Preserve that direction and thread it through configuration.

## Current Code Context

Relevant code added by the previous pass:

- `packages/agentry/src/code-mode-runtime.js`
  - `gitReadOnlyCodeModeCapabilityType`
  - `gitWritableCodeModeCapabilityType`
- `packages/agentry/src/lal-code-mode.js`
  - execute-only PiAgent bridge
  - typed powers in the system prompt
- `packages/agentry/src/lal-code-mode-git-loop.js`
  - `filesystemCapabilityType`
  - `makeLalCodeModeGitLoopGlobals`
  - `makeLalCodeModeGitLoopAgent`
  - `makeLalCodeModeCompartmentExecute`
- `packages/agentry/test/lal-code-mode.test.js`
  - scripted PiAgent test that edits through `@endo/endo-fs`, stages via
    `git.status()` entry caps, commits, and reads `git.filesystemAt('HEAD~1')`

## Shared Config Shape

Add a single config type in a new module, for example:

```ts
export type CodeModeModelConfig = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  api?: 'openai-completions' | string;
  reasoning?: boolean;
  apiTokenPetName?: string | string[];
  apiTokenEnvVar?: string;
};

export type CodeModePowerConfig = {
  workspace?: unknown;
  workspacePetName?: string;
  git?: unknown;
  gitPetName?: string;
  gitMode?: 'readOnly' | 'readWrite';
  namedPowers?: Array<{
    name: string;
    petName?: string | string[];
    type?: string;
    description?: string;
  }>;
};

export type CodeModeToolConfig = {
  mode?: 'executeOnly';
  include?: readonly ('workspace' | 'git')[];
};

export type CodeModeRuntimeConfig = {
  model: CodeModeModelConfig;
  powers: CodeModePowerConfig;
  tools?: CodeModeToolConfig;
  transcript?: {
    persist?: boolean;
    petName?: string | string[];
  };
};
```

Notes:

- Prefer pet-name lookup for capabilities and tokens in Endo-hosted paths.
- Built-in code-mode capability pet names are also the lexical binding names
  (`workspacePetName: 'repoWorkspace'` produces `repoWorkspace` in the
  Compartment). They must therefore be single JavaScript identifiers.
- Use `namedPowers` for any additional code-mode power. A named power has an
  explicit lexical `name` and can resolve from a pet-name path.
- Do not put raw API token strings in config records, including tests; use
  `apiTokenPetName`, `apiTokenEnvVar`, or an explicit token-provider callback.
- Keep `executeOnly` as the only model-facing tool mode for code mode.
- `gitMode: 'readOnly'` must select `gitReadOnlyCodeModeCapabilityType`.
- `gitMode: 'readWrite'` must select `gitWritableCodeModeCapabilityType`.

## Shared Runtime Factory

Add a module such as `packages/agentry/src/code-mode-runtime.js`.

Responsibilities:

- Normalize `CodeModeRuntimeConfig`.
- Resolve model config into a Pi-compatible model object.
- Resolve API token through explicit precedence:
  1. explicit `getApiKey` token-provider callback
  2. `apiTokenPetName`
  3. `apiTokenEnvVar`
  4. local provider fallback, such as Ollama's development default
- Resolve `workspace` and `git` caps from direct objects or pet names.
- Build typed code-mode power bindings.
- Build `execute` with explicit endowments.
- Return a ready-to-use PiAgent or lower-level parts.

Suggested exports:

```js
export const makeCodeModeRuntime = async ({ config, powers, endowments }) => {
  // returns { agent, model, getApiKey, globals, execute, systemPrompt }
};

export const makeCodeModeAgent = async options => {
  const runtime = await makeCodeModeRuntime(options);
  return runtime.agent;
};
```

The factory should not know about Pi extension commands, Endo setup scripts, or
terminal input loops. It should be embeddable.

## Access Path 1: Pi ExtensionAPI

Goal: Pi is the UX and event driver, but Endo provides all authority.

User-provided sketch:

```js
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

Recommended shape:

```js
export default function endoCodeModeExtension(pi) {
  pi.registerTool({
    name: 'execute',
    description: 'Evaluate JavaScript in Endo code mode with configured caps.',
    parameters: EXECUTE_PARAMETERS,
    async execute(args, ctx) {
      return endoRuntime.execute(args, ctx);
    },
  });

  pi.registerCommand('endo:status', {
    async run(ctx) {
      return endoRuntime.describe();
    },
  });

  pi.on('tool_call', async event => {
    endoRuntime.auditToolCall(event);
  });
}
```

Implementation plan:

1. Add a new subpath for the Pi extension adapter.
   Candidate: `packages/agentry/src/pi-extension.js`.
2. The adapter receives or loads `CodeModeRuntimeConfig`.
3. It registers only the Endo `execute` tool for code mode.
4. It may register commands for configuration, status, and capability
   inspection, but commands must not bypass Endo capability checks.
5. The adapter should never register Pi ambient filesystem or shell tools for
   this mode.

Security invariant:

- If Pi can call a tool, that tool must delegate to Endo code-mode powers or
  another explicit Endo capability. Pi extension APIs are orchestration only,
  not authority.

Open question for the next agent:

- Confirm Pi's real extension packaging, lifecycle, and config APIs before
  choosing file names and exports. The user-provided snippet should be treated
  as representative, not final API documentation.

## Access Path 2: Endo-Hosted Pi

Goal: Start the Pi code-mode loop from Endo.

Initial mode:

- Run as an unconfined Node caplet.
- Construct PiAgent in Node.
- Run code-mode `execute` inside a SES Compartment with explicit endowments.
- Acquire `workspace`, `git`, model config, and token through Endo powers.

Candidate entry point:

```sh
endo run --UNCONFINED packages/agentry/src/code-mode-agent-node.js \
  --powers @agent
```

Candidate `make` entry:

```js
export const make = async (powers, context, options = {}) => {
  const config = await loadConfig({ powers, env: options.env });
  const runtime = await makeCodeModeRuntime({ config, powers });
  return makeCodeModeService({ runtime, context });
};
```

Candidate service methods:

```ts
interface CodeModeService {
  prompt(text: string): Promise<unknown>;
  status(): Promise<object>;
  help(methodName?: string): string;
}
```

Setup script:

- Add a setup helper only after the runtime is stable.
- It can ask the operator for:
  - agent/service name
  - model provider/model/base URL
  - API token pet name or env var
  - workspace pet name
  - Git pet name
  - Git mode: read-only or read-write

Confined follow-up:

1. Identify Pi and provider modules needed at runtime.
2. Build or reuse a Compartment module loader for those modules.
3. Replace ambient Node dependencies with endowments:
   - fetch or provider cap
   - crypto
   - timers
   - streams
   - TextEncoder/TextDecoder
   - console or logger
4. Keep model network authority separate from repository authority.

Security invariant:

- "Unconfined" is a packaging and provider-call concession, not a tool
  authority concession. Repository powers still flow through Endo caps.

## Access Path 3: Programmatic Usage and Delegation

Goal: Allow other Endo code to instantiate or call a code-mode Pi agent.

First pass:

```js
const agent = await makeCodeModeAgent({
  config,
  powers,
  endowments,
});
await agent.prompt('Edit note.txt and commit it.');
await agent.waitForIdle();
```

Future delegation tool:

```ts
interface DelegateAgentToolInput {
  prompt: string;
  modelProfile?: string | string[];
  powers: {
    workspace?: string;
    git?: string;
    gitMode?: 'readOnly' | 'readWrite';
    [powerName: string]: string | string[] | undefined;
  };
}
```

Delegation rules:

- The delegated agent may receive a strict subset of the caller's powers.
- The caller cannot create new authority by naming powers it does not hold.
- The delegated tool-call input cannot provide raw model or token
  configuration.
- The delegated tool-call input can select a caller-held model profile by pet
  name. The profile itself is host-authored data resolved through Endo powers.
- Prefer attenuation helpers:
  - writable Git -> read-only Git
  - writable workspace -> read-only workspace where possible
  - narrowed powers list
- The result should be a serializable summary unless the caller explicitly asks
  to store a capability result under a pet name.

Non-goal for first pass:

- Do not implement autonomous multi-agent scheduling. A single call to a
  subordinate code-mode agent is enough.

## Model and Token Configuration

Use one model resolver for all paths.

Required support:

- local Ollama/OpenAI-compatible endpoint
- OpenAI-compatible hosted endpoints
- pi-ai registry models where available
- explicit token callback

Token resolution should avoid putting secrets into prompts or transcripts.

Suggested precedence:

1. Direct `getApiKey` callback from programmatic caller.
2. `apiTokenPetName`, read via Endo powers.
3. `apiTokenEnvVar`, read only in unconfined Node entry.
4. Local provider fallback, such as Ollama's development default.

When running in a future confined compartment, `apiTokenEnvVar` should be
replaced by an explicit secret capability or token provider cap.

## Tool and Power Configuration

Keep code mode execute-only by default.

The model-facing tool surface:

- `execute({ source, resultName? })`

The code-mode powers available as lexical bindings:

- `E`
- `workspace`
- `git`
- named powers explicitly configured by the runtime

Avoid adding model-facing JSON tools for every filesystem and Git operation in
this code-mode lane. The point of code mode is to keep live caps in lexical
scope so capability-bearing values such as `status()[].entry` can be used
without serializing them across a JSON boundary.

Separate read-only and writable Git:

- Read-only Git powers use `gitReadOnlyCodeModeCapabilityType`.
- Writable Git powers use `gitWritableCodeModeCapabilityType`.
- If both are present, name them clearly:
  - `git` for writable when granted
  - `gitReadOnly` or `historyGit` for attenuated inspection

## Tests to Add

Unit tests:

- Config normalization chooses read-only versus writable Git type.
- Config normalization uses single-identifier workspace/git pet names as the
  code-mode lexical bindings and rejects path pet names for built-in powers.
- Token resolver uses the documented precedence.
- Runtime factory rejects missing workspace/git caps with clear errors.
- Runtime factory never exposes named powers unless configured.

Pi extension adapter tests:

- Registers exactly one code-mode tool named `execute`.
- Registers commands without adding ambient authority.
- Tool calls delegate to Endo runtime.

Endo-hosted tests:

- Unconfined entry constructs service from mocked powers.
- Service prompt routes through the shared runtime.
- Read-only Git mode omits mutation methods from prompt type declarations.

Programmatic/delegation tests:

- Programmatic factory can run the existing scripted Git loop.
- Delegate tool can call a sub-agent with read-only Git.
- Delegate tool can call a sub-agent with writable Git when the caller
  delegates writable Git authority.
- Delegate tool can select a caller-held model profile by pet name.
- Delegate tool rejects power names not resolvable from caller powers.
- Delegate tool cannot upgrade read-only Git to writable Git.

Existing regression to preserve:

- Scripted PiAgent edits temp repo through `@endo/endo-fs`, calls
  `git.status()`, stages via returned entry caps, commits, then reads previous
  contents through `git.filesystemAt('HEAD~1')`.

## Acceptance Criteria

- One shared code-mode runtime config feeds all three access paths.
- Pi extension path can drive Endo `execute` without ambient Pi tools.
- Endo unconfined path can run an interactive prompt loop or service method.
- Programmatic path exposes a stable factory.
- Read-only and writable Git prompt types are selected by config.
- API tokens are not included in system prompts, tool arguments, or transcript
  messages.
- Tests cover the current Git code loop plus config and delegation boundaries.
- README.md explains to consumer how to access each

## Suggested Implementation Order

1. Add `code-mode-runtime` config normalization and factory.
2. Refactor `lal-code-mode-git-loop` to use the shared runtime.
3. Add programmatic tests for model/token/tool/power config.
4. Add Endo unconfined service entry with mocked-powers tests.
5. Add Pi `ExtensionAPI` adapter after checking Pi's actual extension API.
6. Add delegation tool in a separate pass once the factory is stable.
7. Document the future confined Pi module-loader work separately.

## Notes for the Next Agent

- Do not build a standalone terminal CLI as the primary product path.
- Do not add ambient filesystem, shell, or Git tools to the Pi extension.
- Keep `execute` as the model-facing code-mode tool.
- Use live Endo caps inside `execute` for capability-bearing flows.
- Keep `GitRemote` out of this pass unless the user explicitly expands scope.
- Do not commit unless the user asks.

## Implementation Notes

Implemented in `@endo/agentry`:

- Shared runtime/config factory: `@endo/agentry/code-mode-runtime`.
- Programmatic factory: `makeCodeModeRuntime` and `makeCodeModeAgent`.
- Pi ExtensionAPI adapter: `@endo/agentry/pi-extension`.
- Endo-hosted service entry: `@endo/agentry/code-mode-agent-node`.
- Delegation boundary tool: `@endo/agentry/code-mode-delegation`.
- Backwards-compatible Git-loop helper refactored through the shared runtime.
- README coverage for the three access paths and shared config.
- Tests for Git loop regression, model/token/power config, read-only Git
  declarations, Pi extension registration, Endo service prompt routing,
  programmatic construction, token secrecy, and delegation boundaries.
