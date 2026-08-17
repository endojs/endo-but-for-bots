# `@endo/agent-tools`

`@endo/agent-tools` is an embeddable tool and adapter layer for Endo agents.
It owns provider-independent tool records, code-mode evaluation, capability
declarations, and provider bridges.
It is not a complete Pi harness, interactive loop, transcript store, or CLI.

`@endo/agentry` owns the complete Pi harness, including agent construction,
the code-mode preset and prompt assembly, session behavior, eval runners, and
the future packaged CLI.
An external MCP server is a separate consumer of `@endo/agent-tools`.

## One tool, two hosts

The host-independent code-mode surface is the `evaluate` tool.
Its generated capability declarations and provider adapters accompany it.
The same tool can run on either of two hosts.

The in-process host is `makeCompartmentEvaluate`.
It evaluates source in a fresh SES `Compartment`, with no daemon, credentials,
or network authority.
It suits evals, CI, tests, and a standalone MCP demo.
Results live only as long as the process.

The daemon host is `makeDaemonEvaluate`.
It forwards source and lexical capability names through a live powers reference
to a daemon-style host's `evaluate` method.
The daemon host is intended for real agent use and provides durable results,
pet-name storage, resume, mailbox, and remote messaging.
It imports no daemon implementation.

Storage authority is an explicit host concern.
The settled host policy is that an in-process host without a store exposes the
`{ source }` schema, while a supplied store enables the `resultName` parameter.
An in-memory map is sufficient for light tests.
The store hook is named `storeValue(valueOrPromise, nameOrPath)` to match the
daemon Host and Guest interfaces.

```js
import { makeCompartmentEvaluate } from '@endo/agent-tools/code-mode/compartment.js';
import { makeEvaluateTool } from '@endo/agent-tools/code-mode/evaluate-tool.js';

const values = new Map();
const storeValue = async (valueOrPromise, nameOrPath) => {
  const key = Array.isArray(nameOrPath) ? nameOrPath.join('/') : nameOrPath;
  values.set(key, await valueOrPromise);
};
const evaluate = makeCompartmentEvaluate({
  endowments: {},
  storeValue,
});
const tool = makeEvaluateTool(evaluate, [], storeValue);
await tool.invoke({ source: '41 + 1', resultName: 'answer' });
values.get('answer'); // 42
```

The daemon host always advertises `resultName` and forwards it to the daemon's
`evaluate`, where formula capture keeps the named value durable.

The MCP adapter gap remains separate.
This package still does not map the tool record to MCP `outputSchema` or
`structuredContent`; an MCP protocol adapter will own that mapping.

## Layout

| Path | Purpose |
| --- | --- |
| `src/tool.js` | Provider-independent `makeTool` and `ToolRecord`. |
| `src/json-tools/` | Parked JSON wrappers for Git, mounts, filesystem, shell, and HTTP. |
| `src/code-mode/` | Evaluation tool, Compartment host, daemon host, and declaration formatting. |
| `src/code-mode-globals/` | Per-capability global descriptor factories for the local filesystem, Shell, HTTP, Git, and GitRemote, plus the workspace seam helpers. |
| `src/adapters/` | Pi and SmallCaps bridges; MCP, Codex, and Claude Code shapes are planned. |
| `generated/code-mode-globals/` | Checked-in generated declaration artifacts. |

The code-generation extractors currently read the checked-in
`packages/exo-git/src/types.ts` and the platform filesystem guards through raw
relative paths.
Declared package references are the intended long-term shape.

## Exports

The package root exports the parked JSON record makers and their types:

```js
import {
  makeTool,
  makeGitHistoryTool,
  makeGitTool,
  makeGitMountTools,
  makeGitRemoteTool,
  makeMountReadTool,
  makeMountListTool,
  makeMountStatTool,
  makeMountEditTool,
  makeMountFsTools,
  makeShellTool,
  makeHttpTool,
} from '@endo/agent-tools';
```

Scoped imports expose each layer:

```js
import { makeEvaluateTool } from '@endo/agent-tools/code-mode/evaluate-tool.js';
import { makeCompartmentEvaluate } from '@endo/agent-tools/code-mode/compartment.js';
import { makeDaemonEvaluate } from '@endo/agent-tools/code-mode/daemon.js';
import { makeGitGlobal } from '@endo/agent-tools/code-mode-globals/git.js';
import { makeWorkspaceGlobal } from '@endo/agent-tools/code-mode-globals/fs.js';
import {
  makeInMemoryWorkspaceSeam,
  makeNodeWorkspaceSeam,
} from '@endo/agent-tools/code-mode-globals/fs-seams.js';
import { makeGitRemoteGlobal } from '@endo/agent-tools/code-mode-globals/git-remote.js';
import { makeHttpGlobal } from '@endo/agent-tools/code-mode-globals/http.js';
import { makeShellGlobal } from '@endo/agent-tools/code-mode-globals/shell.js';
import { toPiAgentTool } from '@endo/agent-tools/pi';
import { toolResultToSmallcaps } from '@endo/agent-tools/adapters/smallcaps.js';
```

The Pi packages remain optional peer dependencies.
Importing the root or a non-Pi module does not opt a consumer into Pi.

Code-mode global factories describe capabilities already granted by a host.
`makeWorkspaceGlobal` describes the raw daemon mount provisioned for the
repository workspace, while `makeFilesystemGlobal` describes the local
`@endo/platform/fs/extended` adapter used by the standalone seams.
The Shell, HTTP, Git, and GitRemote factories likewise carry no provisioning,
attenuation, credential, or controller authority.

Planned adapter modules have shape only in this release.
The MCP adapter is not implemented, including its `outputSchema` and
`structuredContent` mapping, and Codex and Claude Code adapters are future
provider bridges over the same tool records.

## Choosing a workspace backing

The `workspace` global is one guest-facing name over several host-side
backings.
The host must pair each backing with its matching descriptor: a raw daemon
mount uses `makeWorkspaceGlobal`, while an extended Filesystem uses
`makeFilesystemGlobal`.
When using `makeCodeModeAgent` directly, set `powers.workspaceSurface` to
`'filesystem'` for the latter; the default `'mount'` surface is reserved for a
daemon mount.

| Deployment | Backing | Who mints it | Who binds it |
| --- | --- | --- | --- |
| Compartment evaluate — evals, CI, tests | in-memory | `makeInMemoryWorkspaceSeam()` | the host, as a compartment endowment |
| Compartment evaluate — local development | `node:fs` under a root path | `makeNodeWorkspaceSeam({ rootPath })` | the host, as a compartment endowment |
| Daemon evaluate — real agent use | a daemon mount | the host's provisioning policy | the daemon, under the guest's `workspace` pet name |
| Any host — historical view | a git tree or a read-only attenuation | the host, pre-attenuated | whichever seam above it is handed to |

The two seam helpers mint a backing and the matching descriptor as one pair,
so the declaration a guest reads cannot drift from the authority it was handed:

```js
import { E } from '@endo/eventual-send';
import { makeCompartmentEvaluate } from '@endo/agent-tools/code-mode/compartment.js';
import { makeEvaluateTool } from '@endo/agent-tools/code-mode/evaluate-tool.js';
import { makeNodeWorkspaceSeam } from '@endo/agent-tools/code-mode-globals/fs-seams.js';

const { workspace, global } = makeNodeWorkspaceSeam({ rootPath: '/srv/repo' });
const evaluate = makeCompartmentEvaluate({ endowments: { E, workspace } });
const tool = makeEvaluateTool(evaluate, [global]);
```

The node backing confines every path to `rootPath`, rejecting a symlink whose
`realpath` escapes it, so the guest's reach is the subtree the host names and
nothing above it.

There is deliberately no daemon seam helper here: this package imports no
daemon implementation.
The daemon recipe is to provision a mount and bind it under the guest's
`workspace` pet name:

```js
const mount = await E(host).provideMount(hostPath, petName);
const workspace = mount;
```

The descriptor is `makeWorkspaceGlobal({ name: 'workspace' })`.
The executable form of this recipe belongs to provisioning policy, not to this
package: which host path, which pet name, and which guest may ask for it are
policy decisions `@endo/agent-tools` does not make.

Read-only historical views arrive pre-attenuated and need no separate seam.
`E(git).filesystemAt(ref)` yields a `Filesystem` over a commit's tree, and
`readOnly(fs)` attenuates any `Filesystem` so its mutating methods reject with
`EACCES`.
Bind an extended Filesystem under `workspace` with
`makeFilesystemGlobal({ name: 'workspace' })`.
The verbs it cannot use fail at the capability, which is where authority is
enforced.

## Parked JSON wrappers

The JSON wrappers remain available for hosts that need one call per action.
They are provider-independent but are parked while code mode is the primary
way to compose several capability operations.

```js
import { makeGitTool } from '@endo/agent-tools/json-tools/git.js';
import { makeGitMountTools } from '@endo/agent-tools/json-tools/git-mount.js';
import { makeGitRemoteTool } from '@endo/agent-tools/json-tools/git-remote.js';
import { makeMountFsTools } from '@endo/agent-tools/json-tools/fs.js';
import { makeShellTool } from '@endo/agent-tools/json-tools/shell.js';
import { makeHttpTool } from '@endo/agent-tools/json-tools/http.js';
```

`makeTool` produces a `ToolRecord` with a JSON-schema `parameters`, the same
schema as `inputSchema`, and an `invoke(args)` function.
`toPiAgentTool` maps that record to the optional Pi `AgentTool` contract and
accepts a result renderer.

The SmallCaps renderer is supplied by `adapters/smallcaps.js` so plain-data
completion values preserve BigInts, `undefined`, and sigil-prefixed strings.
Capability-bearing values remain out of band.

## Git remote tools

`makeGitRemoteTool(remoteCap)` is the push tier: the network and credential
layer, exposed only to a host that has granted a `@endo/exo-git` `GitRemote`.
It emits `fetch`, `pull`, and `push` records plus a credential-free `inspect`
that reports the remote's policy bounds, so an agent can read its allowed
refspecs and directions instead of discovering them by rejection.

Every bound is the granted capability's — the endpoint URL, the allowed
directions, the refspecs, and the force/tags/delete flags — and the
policy-bearing `GitRemoteController` stays host-side, never an agent-facing
tool. A read-only `Git` cannot construct a `GitRemote` at all, so the read tier
structurally excludes push.

`push` accepts `forceWithLease`, a 40-character object ID the destination must
still name for the update to land. That is what makes a branch usable as a
transactional ledger: read the tip, compose the update, push against the tip you
read. It requires the `allowForcePush` policy and an explicit `source`, the
destination must be a concrete ref, the all-zeros ID is refused (git reads it as
"this ref must not exist"), and it cannot be combined with `force`.

Each maker names its records after the capability's own methods, so names can
collide across makers: `makeGitRemoteTool` emits `inspect` and `fetch`, which
`makeShellTool` and `makeHttpTool` also emit. A host composing several makers
into one flat tool list must disambiguate them itself; nothing in `makeTool`
prefixes or dedupes.

## Git history tools

`makeGitTool` derives its catalog from the facet named by its `facet` option.
The default writer catalog exposes ordinary read/write operations but no
history rewrite.
A host that deliberately grants a rewriter capability selects
`{ facet: 'rewriter' }` to add `commit` with `options.amend`, `reword`,
`cherryPick`, and `rebase`.
The deprecated `makeGitHistoryTool(gitCap)` remains the explicit, history-only
compatibility inventory.
It emits exactly `commit`, `reword`, `cherryPick`, and `rebase`, in that order,
while projecting the same schemas, descriptions, and runtime guards as those
tools in the canonical rewriter catalog.
It therefore does not repeat the rewriter catalog's read, navigation, or
ordinary branch-edit tools when a host composes the writer and history
inventories.

The JSON rebase tool supports `start` (with required `upstream` and optional
`autosquash`), `continue`, `abort`, and `skip`.
If `start` or `continue` stops for conflicts, inspect status, resolve and stage
the conflicts, and then continue the rebase, skip the stopped commit, or abort.
`checkoutConflict` selects Git index stages rather than stable branch roles:
`ours` is stage 2 and `theirs` is stage 3.
During rebase, Git calls the upstream side `ours` and the commit being replayed
`theirs`, which is inverted from intuitive current/incoming branch wording.
