# @endo/genie Design Document

## Overview

`@endo/genie` is a Claw-like AI Agent framework designed for the Endo hardened JavaScript project.
It provides a complete system for building autonomous agents with:
- Modular tool system with security constraints
- Memory integration for persistent knowledge
- Heartbeat-based task execution
- System prompt builder for LLM integration
- Workspace management utilities

## Architecture

### Core Components

#### 1. System Builder (`system/index.js`)

The central orchestrator that builds complete system prompts for LLMs by combining:
- **Identity & Soul**: User-provided persona and internal truths
- **Memory Context**: Workspace and project knowledge
- **Tools**: Available tool implementations
- **Workspace Context**: Session and runtime information

**Entry Point**: `systemBuilder(options)` - Returns complete system prompt string

**File Structure**:
```
src/system/
├── index.js                    # Main builder
├── memory-context.js           # Memory file injection
├── workspace-context.js        # Workspace section builder
└── tools-list.js               # Tools documentation builder
```

#### 2. Tools Module (`tools/`)

Extensible tool system with built-in security:

**Available Tools**:
- `memory_get` - Fetch specific lines from memory files
- `memory_search` - Semantic search over memory files
- `readFile` - Read file contents with offset/limit
- `writeFile` - Write content to files
- `editFile` - Replace strings in files
- `webFetch` - Fetch URLs with timeout
- `webSearch` - Search web (DuckDuckGo HTML API)
- `bash` - Execute shell commands with validation

**Security Features**:
- Path traversal prevention
- Code injection prevention
- Dangerous command detection
- Content validation
- Rate limiting support

#### 3. Heartbeat Runner (`heartbeat/index.js`)

Autonomous task executor:
- Loads heartbeat tasks from `HEARTBEAT.md`
- Parses and validates task descriptions
- Executes tasks based on keywords
- Updates task status in heartbeat file

#### 4. Security Module (`security.js`)

Security utilities:
- System prompt suffix generation
- Policy enforcement
- Parameter validation

#### 5. Sandbox slice integration (`main.js` + `tools/sandbox-spawner.js`)

`@endo/genie`'s daemon-hosted entry point (`main.js`) optionally
binds the agent's `bash` / `exec` / `git` tools to a confined POSIX
slice minted by [`@endo/sandbox`](../sandbox/README.md).
The slice is the v1 integration point for
[`PLAN/endo_posix_sandbox.md`](../../PLAN/endo_posix_sandbox.md):
the agent's *workspace* lives inside the slice, but the agent
process itself continues to run inside the daemon worker.

**Capabilities the genie guest receives**

`setup.js` mints two host-side capabilities and introduces them into
the genie guest under fixed pet names:

| Pet name (in guest) | Capability        | Origin                                                 |
| ------------------- | ----------------- | ------------------------------------------------------ |
| `workspace`         | `Mount` cap       | `E(host).provideMount(GENIE_WORKSPACE, 'workspace-mount')` |
| `sandboxes`         | `SandboxFactory`  | `E(host).makeUnconfined('@main', '@endo/sandbox/agent.js', { powersName: '@agent' })` |

Both lookups are guarded with structured-error fallbacks so a partial
rollout (factory present but no workspace mount, or vice versa)
surfaces clearly rather than silently dropping back to direct host
spawning.
Both names are introduced via the host pet namespace so the daemon's
GC pins them across restarts.

**Spawner power swap**

The legacy `bash` / `exec` / `git` tools called `child_process.spawn`
inline.
The slice integration introduced a `Spawner` seam
([`src/tools/spawner.js`](./src/tools/spawner.js)):

- `makeHostSpawner()` — wraps `child_process.spawn`; used by
  `dev-repl.js` and by `main.js` when no factory is present.
- `makeSandboxSpawner({ handle })` — forwards every spawn to
  `E(handle).spawn(argv, opts)`; used by `main.js` when a slice was
  minted.  The adapter normalises `shell: true` to a literal
  `['/bin/sh', '-c', joined]` invocation since the slice has no
  "shell" knob.

`buildGenieTools` accepts an optional `spawner`; the file / memory /
web tools never see this seam — they continue to run daemon-side.

**Lifecycle**

1. `setup.js` runs once on daemon boot (idempotent: guarded by
   `E(host).has(...)` for both `workspace-mount` and
   `sandbox-factory`).
2. `main.js` `runLoop` resolves both capabilities and threads them
   into `spawnAgent`.
3. `spawnAgent` validates `backend` / `network` form fields, probes
   the factory's `listBackends()`, then calls
   `E(sandboxFactory).make({ rootfs: { kind: 'host-bind' },
   mounts: [{ cap: workspaceMount, innerPath: '/workspace',
   mode: 'rw' }], network, cwd: '/workspace', backend })`.
4. The returned `SandboxHandle` is GC-pinned by the agent's closure
   capture for the agent's lifetime.
5. The agent's `cancelledP` triggers `E(slice).dispose()` so the
   bwrap subprocess and scratch upper layer are reclaimed promptly,
   ahead of the daemon's GC sweep.

When `sandboxFactory` is absent, `spawnAgent` skips slice minting
and the command tools fall through to the host spawner.
When `sandboxFactory` is present but slice minting fails,
`spawnAgent` refuses to start the agent — there is no implicit
relaxation to direct host spawn.

**Tool partitioning**

Only `bash` / `exec` / `git` execute inside the slice.
The daemon-side tools (`readFile`, `writeFile`, `editFile`,
`memory_get`, `memory_search`, `webFetch`, `webSearch`) keep using
host `fs.readFile`, FTS5, and the daemon's network stack against the
host workspace path.
The slice's bind-mount lands on the same bytes the daemon-side tools
see, so the two views stay in lockstep — `editFile` from the daemon
and `bash sed -i` from the slice both target one file on disk.

## Design Principles

### 1. Security-First

All tools implement:
- Input validation
- Path traversal prevention
- Code injection prevention
- Dangerous operation detection

### 2. Modular & Extensible

- Tool-based architecture
- Schema validation using `@endo/patterns`
- Easy to add new tools

### 3. Autonomous Execution

- Heartbeat runner for task automation
- Memory integration for knowledge persistence
- Workspace utilities for file management

### 4. Developer-Friendly

- Clear documentation
- Consistent error handling
- Simple API

## Usage Example

```javascript
import { systemBuilder } from './src/system/index.js';
import { HeartbeatRunner } from './src/heartbeat/index.js';

// Build system prompt
const systemPrompt = systemBuilder({
  identity: 'You are an autonomous assistant',
  soul: 'You help developers with best practices',
  memory: './MEMORY.md',
  memoryPath: './memory',
  tools: './src/tools/',
  heartbeatPath: './HEARTBEAT.md',
  disableSuffix: false,
  disablePolicy: false,
  strictPolicy: false,
});

// Execute heartbeat
const heartbeat = new HeartbeatRunner({ heartbeatPath: './HEARTBEAT.md' });
await heartbeat.run();
```

## Tool Schema

All tools use `@endo/patterns` for schema validation:

```javascript
import { M } from '@endo/patterns';

export const exampleTool = {
  schema: M.interface('exampleTool', {
    param1: M.string(),
    param2: M.number().optional(),
    param3: M.boolean().optional(),
  }),

  help: () => `Tool description...`,

  async execute(params) {
    // Tool implementation
    return { success: true, result: ... };
  },
};
```

## Memory System

### File Structure

```
MEMORY.md                  # Main memory file
memory/                    # Directory for indexed memory
├── topic.md               # Topic specific memory
├── YYYY-MM-DD-summary.md  # Summarization of session history from prior day(s)
└── ...
```

### Search Strategy

- Simple substring search (can be upgraded to vector embeddings)
- Searches in `MEMORY.md` and `memory/*.md`
- Returns top `limit` matches

## Heartbeat Format

```markdown
## Current Tasks

- [ ] Review project documentation
- [ ] Analyze security vulnerabilities
- [ ] Update dependencies

## Done Tasks

- [x] Initialize repository
```

## Provider authentication

Genie drives LLM providers through `@earendil-works/pi-ai`, which ships OAuth scaffolding for the three subscription providers a user can log in to with an account they already pay for: Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), and GitHub Copilot.
`makePiAgent` resolves a credential for each request in this order:

1. The local ollama masquerade authenticates with its own sentinel key.
2. When an `oauthStore` is supplied and the model's provider has stored OAuth credentials, the request uses the OAuth access token, refreshed and re-persisted on expiry.
   pi-ai attaches the provider-specific request shape itself: its Anthropic provider detects an OAuth token and adds the Claude Code identity headers, Copilot uses bearer auth, and so on.
3. Otherwise a key-based provider falls back to its environment API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and the like).

The OAuth wiring lives in `src/agent/oauth.js`.
`loginOAuthProvider` runs a provider's login flow (authorization-code with PKCE, or device code) and persists the credentials.
`makeApiKeyResolver` builds the `getApiKey` callback described above.
`applyOAuthModelModifications` applies a provider's credential-derived model rewrites (the GitHub Copilot per-account base URL).

The credential store is an injected capability (the `OAuthStore` interface), not a concrete implementation.
The daemon is expected to back it with an encrypted, formula-graph-resident exo; `makeMemoryOAuthStore` is the in-process reference used by tests and the dev-repl.
`makeGenieAgents` threads one store into every sub-agent (main, heartbeat, observer, reflector) so a subscription model authenticates them all.

Three follow-ups are deferred to the design's *Open questions* rather than resolved here: the encrypted at-rest store shape, the interactive `/login` command UX (mapping the flow callbacks onto readline in the dev-repl and daemon mail in the guest), and the Lal-vs-Genie provider-registry consolidation (whether these providers live under `@endo/genie`, `@endo/lal`, or a shared `@endo/ai` package).

## Future Enhancements

1. **Full Text Search** - use sqlite fts5
2. **Semantic Search** - via vector embeddings (aka RAG)
3. **Tool Chaining** - Sequence tool calls
4. **Conversation Memory** - LLM context management
5. **Rate Limiting** - Tool call throttling
6. **Webhooks** - External integration
7. **Caching** - Response caching

## Testing Strategy

1. Unit tests for each tool
2. Integration tests for system builder
3. End-to-end tests for heartbeat runner
4. Security validation tests

## Contributing

When adding new tools:

1. Define schema using `@endo/patterns`
2. Implement `help()` documentation
3. Add security validations
4. Update `tools/index.js` exports
