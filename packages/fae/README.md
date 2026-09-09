# @endo/fae

An LLM agent manager for Endo. Fae runs as a factory caplet inside the
Endo daemon, creating named agent instances that process inbox messages
via an LLM and adopt tool capabilities at runtime.

## Architecture

Fae uses a three-layer architecture:

1. **LLM Provider Factory** (`llm-provider-factory.js`) — presents a
   form to HOST for configuring LLM providers (API host, model, auth
   token). Stores submitted configs as named values in the host's
   directory.

2. **Fae Factory** (`agent.js` — `make()`) — bound to a named LLM
   provider. Creates agent instances on demand via `createAgent(name,
   options)`. Each agent gets its own guest (inbox, petstore, tools)
   and a driver caplet.

3. **Driver** (`driver.js`) — a standalone caplet per agent that runs
   the inbox/LLM loop (`spawnWorkerLoop`). The driver is constructed
   with two capability references:
   - `llm-provider` — the provider config object
   - `agent` — the agent's EndoGuest (inbox, mail, petstore, tools)

   When pinned to `PINS`, the driver is eagerly re-evaluated on daemon
   restart via `revivePins()`, automatically restarting the inbox loop.

### Restart survival

Agents created with `pin: true` survive `endo restart`. The driver
caplet's formula ID is written to the daemon's `PINS` directory. On
startup, `revivePins()` calls `provide()` on each pinned formula,
which re-imports `driver.js`, calls `make()`, looks up the provider
config and agent guest from the driver's namespace, and restarts
`spawnWorkerLoop`. Unpinned agents are not restored.

## Configuration

Fae uses the same LLM provider configuration as `@endo/lal`.

| Variable | Description | Default |
|----------|-------------|---------|
| `LAL_HOST` | API base URL (Ollama, llama.cpp, or Anthropic) | `http://localhost:11434/v1` |
| `LAL_MODEL` | Model name | `qwen3` (Ollama) or `claude-opus-4-5-20251101` (Anthropic) |
| `LAL_AUTH_TOKEN` | API key (required for Anthropic, optional for local) | - |

Create a `.env` file from the example:

```bash
cp .env.example .env
# Edit .env with your provider details
```

## Setup

### Prerequisites

Build the workspace from the repo root:

```bash
cd ../..
npx corepack yarn install
```

Start the daemon:

```bash
yarn endo purge -f
yarn endo start
```

### Step 1: Provision the LLM provider factory

Creates the `llm-provider-factory` guest and launches its caplet.
The factory presents a form to HOST for submitting provider configs.

```bash
cd packages/fae
yarn setup
```

### Step 2: Submit your LLM provider config

Sources `.env` and submits the provider configuration (host, model,
auth token) via the factory's form:

```bash
yarn create-provider
```

### Step 3: Create the fae factory and default agent

Creates the fae-factory guest bound to the provider, then spawns a
default `"fae"` agent with `pin: true` so it survives restarts:

```bash
yarn setup-factory
```

After this step you have a running `fae` agent listening to its inbox.

### All-in-one alternative

`setup-with-tools` combines the above steps and also creates example
tools (greet, math, timestamp) in the host's inventory:

```bash
yarn setup-with-tools
```

## Creating additional agents

Use the factory to create more agents programmatically:

```js
const factory = await E(host).lookup('fae-factory');

// Pinned agent — survives endo restart
await E(factory).createAgent('researcher', { pin: true });

// Unpinned agent — ephemeral, dies on restart
await E(factory).createAgent('scratchpad', { pin: false });

// Custom system prompt
await E(factory).createAgent('poet', {
  pin: true,
  systemPrompt: 'You are a poet. Respond only in verse.',
});
```

## Tools

### Built-in tools

Every agent has these tools available immediately:

- `list`, `lookup`, `store`, `remove` — petname directory operations
- `send`, `reply`, `listMessages`, `dismiss` — mail operations
- `adoptTool` — adopt a tool capability from an incoming message

### Creating tool caplets

Create example tools (greet, math, timestamp) in the host's inventory:

```bash
yarn setup-tools
```

Create filesystem tools (read-file, write-file, edit, list-dir, glob,
grep, run-command). The root directory defaults to `process.cwd()`:

```bash
yarn setup-fs-tools
# Or with a specific root:
FAE_CWD=/path/to/project yarn setup-fs-tools
```

Send a tool to an agent via the chat UI:

```
@fae Here is a timestamp tool @timestamp-tool
```

Fae will adopt the tool and can use it on subsequent turns.

## Chat UI integration

Start the `@endo/chat` UI in a separate terminal:

```bash
cd packages/chat
yarn dev
```

Open http://localhost:5173. You should see fae's "Fae agent ready."
announcement in the inbox. Send messages with `@fae Hello!`.

### Verifying state

```bash
# List all petnames in the host directory
yarn endo list

# Check fae's inbox
yarn endo inbox --as fae

# List fae's petnames
yarn endo list --as fae
```

### Starting over

```bash
yarn endo purge -f
yarn endo start
```

Then re-run the setup steps above.

## File structure

```
packages/fae/
├── agent.js                  # Factory entry point + spawnWorkerLoop
├── driver.js                 # Driver caplet (inbox loop, pinnable)
├── setup.js                  # Step 1: provision LLM provider factory
├── llm-provider-factory.js   # Provider factory caplet (form → config)
├── submit-provider.js        # Submit provider form programmatically
├── provider-setup.sh         # Step 2: source .env and submit provider
├── fae-factory-setup.js      # Step 3: create fae-factory + default agent
├── setup-tools.js            # Create example tools in host inventory
├── setup-fs-tools.js         # Create filesystem tools (FAE_CWD)
├── setup-with-tools.js       # All-in-one: provider + factory + tools
├── src/
│   ├── extract-tool-calls.js # XML tool call parser
│   ├── fae-tool-interface.js # FaeTool M.interface guard
│   ├── subagent.js           # Delegation registry and subagent tools
│   ├── subagent-host.js      # Agent provisioning, teardown, and the spawner
│   ├── tool-makers.js        # Built-in tool factory functions
│   └── tools.js              # Tool discovery and execution
└── tools/
    ├── greet.js              # Example: greeting generator
    ├── math.js               # Example: arithmetic
    ├── timestamp.js          # Example: current time
    ├── read-file.js          # FaeTool: read files under root
    ├── write-file.js         # FaeTool: write files under root
    ├── edit.js               # FaeTool: edit files by exact-text replacement
    ├── list-dir.js           # FaeTool: list directory under root
    ├── glob.js               # FaeTool: find paths by glob pattern under root
    ├── grep.js               # FaeTool: search file contents by regexp under root
    └── run-command.js        # FaeTool: run shell commands in root
```

## Subagents

An agent may hand a self-contained piece of work to a subagent it converses with
over the daemon mailbox, using `spawnSubagent`, `askSubagent`, and
`stopSubagent`.
The capability that mints subagents is endowed per agent, so withholding it
withholds the tools.
See [SUBAGENTS.md](./SUBAGENTS.md).

## Capability discovery and source reading

`list` takes no arguments and lists petnames, not filesystem entries.
`lookup({ petName })` retrieves a value; it does not accept `method` or `args`.
These tools and `exec` reject unknown named arguments before dispatch.
Floot additionally advertises and validates closed top-level argument envelopes
for every built-in tool, including `store`, `remove`, and `listMessages`.
This does not close nested JSON values or change stored/extra tools' own schemas.
`describeCapability({ petName, method? })` uses CapTP method introspection and
the capability's existing `help(method)` documentation for signatures/examples.
It never invents signatures for undocumented methods.
If a capability only accepts zero-argument `help()`, discovery falls back to its
overview and labels that scope; if documentation fails, callable names remain
available with an explicit unavailable notice.
Invoke a discovered method using `exec` (`endo_exec` in Codex), for example:

```js
const source = await E(powers).lookup('review-source');
return await E(source).help('glob');
```

Prefer `readSources` for bounded source-file reads and literal searches:

```json
{
  "petName": "review-source",
  "items": [
    { "path": ["README.md"], "startLine": 1, "lineCount": 40 },
    { "path": ["src", "agent.js"], "search": "checkpoint" }
  ]
}
```

The petname must already name a mount with `lookup(pathSegments)` returning a
streamable blob; no ambient filesystem or new read/write authority is granted.
Mount confinement, read-only enforcement, and revocation remain authoritative.
Each of at most eight items independently returns `{ index, ok, lines }` or
`{ index, ok: false, error }`, preserving successful reads when another fails.
Lines have 1-based `line` numbers and `text`.
Search is case-sensitive literal substring matching, not a regex or recursive
filesystem scan; use the mount's documented `glob` to discover candidate paths.

Each file scans at most 1 MiB through flow-controlled blob streaming, closing the
reader at the ceiling; a compliant mount supplies bounded chunks.
It returns at most 200 lines and 8,000 text characters per item (defaults: line 1,
80 lines), with `scanTruncated` and `outputTruncated` flags.
The entire serialized response is additionally capped at 48,000 characters,
including JSON escaping, divided evenly across requested items.
This leaves headroom for a second serialization layer in Floot's durable journal;
quote/backslash-heavy sources may therefore return fewer text characters.
A truncated scan is not evidence that a requested range or match does not exist.
Files beyond the scan prefix require another endowed navigation capability;
this tool does not silently fall back to an unbounded whole-file read.
Remote I/O errors are deliberately generic rather than exposing paths, locators,
or arbitrary exception data; invalid arguments retain actionable validation errors.

## Provider credentials

The LLM auth token is held by the daemon's secret manager, not by a pet-store
value.
`llm-provider-factory` puts a submitted token in `@secrets` and records only the
pet name it was bound to; `fae-factory-setup` resolves that name where it is
meaningful — in the user's own inventory — and delegates the resulting
`SecretBlob` capability to the factory, which passes it on to each agent's
driver.
An agent reads the token afresh for every turn, so replacing the bytes
(`SecretAdmin.replaceBase64`) rotates every running agent at once and revoking
the secret stops the next turn rather than merely the next provisioning.
The provider is rebuilt only when the bytes actually change.
A deployment still carrying a plaintext `authToken` in its provider config keeps
working, with a warning: that arrangement cannot be rotated, revoked, or
audited.

Going the other way — replacing a managed secret with a plaintext token — takes
more than re-running setup.
Setup drops the factory's own `llm-auth-secret`, so newly created agents get
none, but every agent already provisioned holds the `SecretBlob` in its own
namespace and the resolver prefers a capability over a config value.
A `SecretBlob` hands its holder the bytes by design, so the way to stop those
agents using the old token is to **revoke the secret**, which is what the secret
manager is for; removing the pet name from the provider config is not a
revocation.
