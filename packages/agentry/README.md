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
- `@endo/agentry/code-mode-provisioning` — the code-mode adapter over a named
  daemon guest, adding connection ownership, lexical declarations, prompt
  globals, and Pi session context.
- `@endo/agentry/endo-code-mode-pi-extension` — a directly loadable Pi extension that binds
  one retained daemon guest to each Pi session and exposes only `evaluate`.

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
  powers: { workspace, git },
});
await agent.prompt('Inspect the current branch.');
await agent.waitForIdle();
```

Git declarations are derived from the recognized live Git facet.
The history-rewrite surface is advertised only when that facet has explicit
history-rewrite authority.

The model-facing tool surface is intentionally one tool:
`evaluate({ source })`, with `resultName` added only when the host supplies
storage authority.
Workspace and Git operations happen inside the Endo Compartment through
lexical caps (`workspace`, `git`, and any configured named powers).
Each lexical cap is either a live local endowment or a daemon guest binding.
Workspace and Git declarations are derived from recognized local posture;
unknown capabilities remain `unknown` and cannot supply their own declaration.

By default a code-mode session has no `@endo/exo-shell` Shell global: the
example above only requests `workspace` and `git`, so no shell binding
appears in the compartment or the prompt. A caller that wants another generic
capability opts in explicitly through the trusted lookup handle:

```js
import { makeCodeModeAgent } from '@endo/agentry/code-mode';

const { agent } = makeCodeModeAgent({
  model,
  powers: {
    workspace,
    git,
    namedPowers: [{ name: 'shell', petName: 'shell' }],
  },
  lookupPowers,
});
await agent.prompt('Inspect the repository status.');
await agent.waitForIdle();
```

The trusted lookup handle supplies the live capability.
Because this generic compatibility path has no local interface recognizer, the
prompt advertises `shell` as an opaque capability (`unknown`) rather than
claiming an independently supplied interface declaration.

The `workspace` and `git` powers are different: their declarations are derived
from the live capability's recognized posture, which is a synchronous check
that a pending lookup cannot satisfy.
Name either of them by pet name instead of passing it inline and the
asynchronous entry point resolves it first:

```js
import { makeCodeModeAgentFromLookup } from '@endo/agentry/code-mode';

const { agent } = await makeCodeModeAgentFromLookup({
  model,
  powers: { workspacePetName: 'workspace', gitPetName: 'git' },
  lookupPowers,
});
```

`resolveCodeModePowers(powers, lookupPowers)` is the same resolution step on
its own, for a caller that assembles the powers record itself.
The synchronous `makeCodeModeAgent` refuses an unresolved lookup for these two
powers rather than minting a grant whose posture nobody has inspected.

Plain-data completion values returned from `evaluate` are encoded for the model
with the SmallCaps renderer from `@endo/agent-tools`, so BigInts and other
non-JSON-native passable values round-trip losslessly. Capability-bearing
results are not serialized; the agent keeps them live inside the Compartment and
stores them under a pet name via `resultName` when storage authority is
configured and the agent needs them across turns.

The complete Pi harness remains in agentry.
The reusable evaluate substrate, capability declarations, and adapters live in
`@endo/agent-tools`.
An external MCP server is a separate consumer of that package.

## Daemon code-mode provisioning

`EndoHost.provideGuest(name, { authority })` owns the host-privileged,
idempotent lifecycle for a retained named guest.
`@endo/agentry/code-mode-provisioning` owns the code-mode conveniences around
that operation: socket discovery, one client per session, cleanup, relative
workspace paths, lexical declarations, and Pi session context.

```js
import { makeDaemonEvaluate } from '@endo/agent-tools/code-mode/daemon.js';
import { makeCodeModeAgent } from '@endo/agentry/code-mode';
import { provisionEndoCodeMode } from '@endo/agentry/code-mode-provisioning';

const session = await provisionEndoCodeMode({
  harness: 'example', // stable harness key for this provisioning consumer
  sessionId: conversationId, // stable across process restarts
  cwd: process.cwd(),
  spec: {
    mount: {
      workspace: {
        path: '.',
        mode: 'readWrite',
        deniedSegments: ['.git', '.env'],
      },
    },
    git: {
      repo: { mount: 'workspace', path: [], mode: 'readWrite' },
    },
    introducedNames: { 'calendar-service': 'calendar' },
  },
});

const { agent } = makeCodeModeAgent({
  model,
  evaluate: makeDaemonEvaluate(session.guest),
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

The code-mode result contains the adapter's opaque retained guest name and
inert prompt projection.
The daemon itself needs no caller-held persistence record: an existing host can
reacquire the guest by lookup or by repeating the same `provideGuest` call.
Pi stores its own fork, recovery, and `piTools` context in its session entry.

`EndoCodeModeProvisionSpec` uses the same singular object-valued authority
categories as the daemon:

- `piTools`: `'preserve'` keeps Pi's currently active standard and extension
  tools active alongside `evaluate`;
- `mount`: named filesystem roots, each complete declaration having `path`,
  `mode`, and optional `deniedSegments`;
- `git`: named Git grants, each `{ mount, path, mode }` selecting a non-bare
  Git worktree by mount-relative path segments;
- `gitRemote`: named remotes, each with an explicit `git` binding reference,
  a distinct Git protocol `name`, a URL, closed remote policy fields, and an
  optional host-side credential pet name or name path; and
- `introducedNames`: a record mapping each single-segment host `Name` to a
  single-segment guest pet name, for example
  `{ 'calendar-service': 'calendar' }`.

The categories are singular because each value is already an object of named
grants.
Every object key becomes the guest lexical binding name, so multiple grants are
multiple keys: `git: { source: {...}, docs: {...} }` gives the guest `source`
and `docs`.

There is no `shell` field: retained provisioning never provisions or includes
a `@endo/exo-shell` Shell global, so `session.globals` above carries only
the policy-derived lexical descriptors. A caller that
wants Shell composes it separately with
`makeShellGlobal` and its own capability, as shown in
[Code mode](#code-mode); omitting it, as this example does, is the opt-out.

Omission grants nothing.
Every mount has an explicit path; relative mount paths resolve against `cwd`
before the daemon validates and retains their canonical roots.
There is no scalar `git` form and no separate filesystem selector, so one field
never carries two meanings.
Agentry follows `provideGuest`'s established introduction behavior: a missing
host source is ignored, and Agentry omits the absent lexical name from generated
globals.
Guest binding names must remain unique across authority categories and
introductions.
`provideGit` builds Git on the selected mount, and the native backend cannot
write outside that mount's posture.
Git remotes therefore require writable Git.
A remote may set `defaultPullRef` to the fully qualified source of one concrete
fetch refspec. When omitted, an unqualified pull uses the first declared
concrete fetch refspec, so declaration order is preserved.
A remote credential is only a host-side pet name or name path; credential
material is never a field in this inert graph.

Named mounts and Git grants extend the same spec to a session that spans more
than one filesystem root.
A common shape is a primary clone beside a linked worktree created by
`git worktree add`:

```
~/src/
  endo/          # primary clone
  endo-pr-958/   # git -C endo worktree add ../endo-pr-958
```

One mount over the shared parent keeps the primary clone's `.git` directory
inside the granted root, so Git can resolve the linked worktree's gitdir, and
each Git grant selects its checkout by mount-relative path with its own
authority mode:

```js
const session = await provisionEndoCodeMode({
  harness: 'example',
  sessionId: conversationId,
  cwd: '/home/user/src',
  spec: {
    mount: {
      src: { path: '.', mode: 'readWrite' },
      docs: { path: './endo/docs', mode: 'readOnly' },
    },
    git: {
      trunk: { mount: 'src', path: ['endo'], mode: 'readOnly' },
      feature: { mount: 'src', path: ['endo-pr-958'], mode: 'readWrite' },
    },
    gitRemote: {
      originCap: {
        git: 'feature',
        name: 'origin',
        url: 'https://github.com/endojs/endo.git',
      },
      mirrorCap: {
        git: 'feature',
        name: 'mirror',
        url: 'https://example.com/endo-mirror.git',
      },
    },
  },
});
```

The object keys become lexical names: the compartment receives two mounts
(`src` and `docs`), two Git capabilities (`trunk` and `feature`), and two
remotes (`originCap` and `mirrorCap`).
A Git grant's authority is capped by its selected mount: writable or
history-rewrite Git requires a writable, guest-bound mount, so a read-only
mount never leaks write authority through Git.
The daemon contract and Agentry adapter have no code-mode lexical defaults.

Agentry derives an opaque guest pet name from its harness and session context.
The host retains the guest's validated authority privately while the guest
receives the same formula IDs under each object-key binding name.
Consequently, daemon evaluation with `resultName` stores the result in the guest
petstore rather than the host petstore.
`cleanup()` closes only the caller's CapTP connection and local operations; it
does not delete the retained formulas or guest.

To resume after disconnect or daemon restart, persist the adapter's
`session.persistence` and pass it to
`reconstructEndoCodeMode({ persistence })`.
The record contains only a schema version and the opaque guest name, not the
authority graph, introduced names, filesystem layout, policy, daemon controller
path, formula identifier, endpoint, live capability, session context, or
credential material.
The host remains the source of truth for canonical policy and rejects changes
or widening on repeated provide.
Credential material is process-local today, so reconstruction after a daemon
restart fails until the named host credential is reprovisioned.

## Pi daemon code mode

The `@endo/agentry/endo-code-mode-pi-extension` extension is the user-facing Pi integration.
Standalone Pi can load it directly, or the thin `endo-pi` launcher can preload
it while forwarding every ordinary Pi argument:

```sh
pi -e ./node_modules/@endo/agentry/endo-code-mode-pi-extension.js \
  --endo-provision='{"mount":{"workspace":{"path":".","mode":"readOnly"}},"git":{"repo":{"mount":"workspace","path":[],"mode":"readOnly"}}}'

endo-pi --endo-provision='{"mount":{"workspace":{"path":".","mode":"readOnly"}}}'
```

`endo-pi` calls Pi's public `main` and does not add a second command framework.
The extension registers one string flag, `--endo-provision`, whose value is an
inert `EndoCodeModeProvisionSpec`, not a live powers object.
An omitted flag or an empty object grants no filesystem, Git, or remote
authority.
Relative `mount.*.path` values resolve from Pi's `cwd`.
It never searches the workspace for an authority-policy file.

The following initial-session examples cover the supported local modes:

```sh
# Read-only review.
endo-pi --endo-provision='{"mount":{"workspace":{"path":".","mode":"readOnly"}},"git":{"repo":{"mount":"workspace","path":[],"mode":"readOnly"}}}'

# Writable files with a separate read-only Git view.
endo-pi --endo-provision='{"mount":{"workspace":{"path":".","mode":"readWrite"}},"git":{"repo":{"mount":"workspace","path":[],"mode":"readOnly"}}}'

# Ordinary writable Git, without amend, reword, or force authority.
endo-pi --endo-provision='{"mount":{"workspace":{"path":".","mode":"readWrite"}},"git":{"repo":{"mount":"workspace","path":[],"mode":"readWrite"}}}'

# Explicit history-rewrite authority.
endo-pi --endo-provision='{"mount":{"workspace":{"path":".","mode":"readWrite"}},"git":{"repo":{"mount":"workspace","path":[],"mode":"historyRewrite"}}}'

# Keep Pi's standard tools active alongside evaluate.
endo-pi --endo-provision='{"piTools":"preserve","mount":{"workspace":{"path":".","mode":"readOnly"}}}'
```

Introductions use one host pet name and one guest pet name.
They deliberately reuse `provideGuest`'s established `introducedNames`
contract: a missing host source is ignored, and reacquisition applies the same
host-name-to-guest-name mapping again.

```sh
# Combine workspace, filesystem, Git, and a named host capability.
# First name the capability in the host's pet store:
endo make packages/cli/demo/counter.js --name counter-service

endo-pi --endo-provision='{
  "mount": { "workspace": { "path": ".", "mode": "readWrite" } },
  "git": { "repo": { "mount": "workspace", "path": [], "mode": "readWrite" } },
  "introducedNames": { "counter-service": "counter" }
}'
```

In this example, `counter` is the guest lexical binding and `counter-service`
is the single-segment host pet name in the connected host namespace.
The JSON is policy data only; it does not execute code or grant the guest a way
to look up other host names.

Named mounts, Git grants, and remotes use the same JSON spec.
Run from the parent directory of sibling checkouts, this grants a read-only
view of the primary clone and a writable linked worktree:

```sh
endo-pi --endo-provision='{
  "mount":{
    "src":{"path":".","mode":"readWrite"},
    "docs":{"path":"./endo/docs","mode":"readOnly"}
  },
  "git":{
    "trunk":{"mount":"src","path":["endo"],"mode":"readOnly"},
    "feature":{"mount":"src","path":["endo-pr-958"],"mode":"readWrite"}
  },
  "gitRemote":{
    "originCap":{"git":"feature","name":"origin","url":"https://github.com/endojs/endo.git"},
    "mirrorCap":{"git":"feature","name":"mirror","url":"https://example.com/endo-mirror.git"}
  }
}'
```

By default, the extension strips all built-in Pi tools, leaving only `evaluate`,
and the code-mode prompt replaces Pi's standard system prompt.
`piTools: 'preserve'` is an opt-in primarily for developers building the
harness, not end users: it re-adds Pi's active standard and extension tools
alongside `evaluate`, while appending the code-mode guidance to the standard
system prompt.
If Endo startup fails, the standard Pi tools remain active and the extension
reports only that code mode is unavailable.

The modes describe separate views, but their effective authority is the union.
For example, writable Git can change worktree files even if the separately
named `workspace` capability is read-only.

A configured remote names only policy and a host-side credential capability:

```sh
endo-pi --endo-provision='{
  "mount":{"workspace":{"path":".","mode":"readWrite"}},
  "git":{"repo":{"mount":"workspace","path":[],"mode":"readWrite"}},
  "gitRemote":{
    "originCap":{
      "git":"repo",
      "name":"origin",
      "url":"https://github.com/endojs/endo.git",
      "allowedDirections":["fetch","push"],
      "allowedBranches":["main"],
      "credential":["credentials","github"]
    }
  }
}'
```

Provision the named credential through a trusted host channel before starting
the session.
Tokens, passwords, authorization headers, credential objects, and embedded URL
credentials must never be placed in JSON, argv, Pi history, logs, formulas, or
model context.
If process-local credential material is unavailable, a trusted TUI or RPC host
may pass a `recoverProvisionFailure` option to
`makeEndoCodeModePiExtension()`.
That hook receives the failure and non-secret persistence record, decides
whether it can recover, and must obtain and reprovision any credential material
through its own non-echoing channel.
The extension retries reconstruction once when the hook returns `true`; the
hook never returns secret material.

On every successful session start, the extension appends its latest versioned,
non-secret persistence record to Pi's custom session entries.
Resume or reload without repeating the flag reuses the exact retained guest and
normalized policy:

```sh
endo-pi --session <session-id>
endo-pi --continue
```

Repeating an equivalent flag is accepted.
A conflicting flag fails with instructions to start a new session or fork;
resume and reload never widen authority.
Forking inherits the normalized policy but derives a fresh retained guest
namespace from the new Pi session id:

```sh
endo-pi --fork <session-id>
```

Session shutdown closes only the extension's local CapTP connection and pending
operations.
The daemon, retained guest, formulas, named evaluation results, and workspace
remain available for a later resume.
If the standard daemon is absent, startup makes one autostart attempt and then
either reconnects or reports how to run `endo start`.

Print and JSON modes use the same daemon lifecycle and the same single
`evaluate` tool:

```sh
endo-pi -p \
  --endo-provision='{"mount":{"workspace":{"path":".","mode":"readOnly"}},"git":{"repo":{"mount":"workspace","path":[],"mode":"readOnly"}}}' \
  'Review the current branch without modifying it.'

endo-pi --mode json \
  --endo-provision='{"mount":{"workspace":{"path":".","mode":"readWrite"}},"git":{"repo":{"mount":"workspace","path":[],"mode":"readOnly"}}}' \
  'Create NOTES.md from the repository README.'
```

In non-interactive modes, stdout remains reserved for Pi's text or JSON event
stream.
Extension diagnostics are structured JSON on stderr, and unavailable remote
credentials terminate before a model turn without printing or persisting a
secret.

The local Compartment evaluator remains useful to package tests and offline
smoke tests.
It is not a selectable product backend for the Pi extension, whose evaluation
always runs through a daemon guest.

## Status

This package is private to the endo monorepo. The API is best-effort stable but
pre-1.0 — breaking changes in this package can land in the same PR as their
workspace consumers.
