# `@endo/agent-tools`

Provider-independent agent tool records for Endo capabilities.

The package helps adapters expose Endo capabilities to LLM or MCP-style tool
callers without giving those callers ambient authority. Each tool record pairs
a JSON Schema with an `invoke(args)` function that validates the named
arguments before dispatching to a capability.

## Exports

```js
import {
  makeTool,
  makeGitTool,
  makeMountListTool,
  makeMountReadTool,
  makeMountWriteTool,
} from '@endo/agent-tools';
```

```ts
import type { ToolRecord, ToolSpec } from '@endo/agent-tools';
```

Subpath exports are also available:

```js
import { makeTool } from '@endo/agent-tools/tool.js';
import { makeGitTool } from '@endo/agent-tools/git-tool.js';
import {
  makeMountListTool,
  makeMountReadTool,
  makeMountWriteTool,
} from '@endo/agent-tools/mount-fs.js';
```

## Tool Records

A tool record has the shape:

```ts
interface ToolRecord {
  name: string;
  description: string;
  parameters: object;
  inputSchema: object;
  invoke(args: Record<string, unknown>): Promise<unknown>;
}
```

`parameters` and `inputSchema` are the same JSON Schema object. Adapters can
use `parameters` for LLM tool definitions and `inputSchema` for MCP tool
definitions.

## Named Arguments

`makeTool` accepts optional positional guards, but callers pass a JSON object.
The schema's `parameters.properties` insertion order defines how those named
properties map back to positional arguments:

```js
const tool = makeTool({
  name: 'commit',
  description: 'Record staged changes as a new commit.',
  parameters: harden({
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The commit message.' },
    },
    required: ['message'],
    additionalProperties: false,
  }),
  argGuards: harden([M.string()]),
  execute: async ({ message }) => E(git).commit(message),
});

await tool.invoke({ message: 'Update docs' });
```

When guards are present, `invoke` rejects unknown argument keys, rejects missing
required arguments declared by the schema, copy-hardens incoming parsed JSON
objects, and validates supplied positional arguments with `mustMatch` before
calling `execute`.

## Git Tools

`makeGitTool(gitCap)` builds tool records over a live `@endo/exo-git` `Git`
capability:

```js
const tools = makeGitTool(git);
```

The current slice exposes:

- `log`
- `diff`
- `status`
- `add`
- `show`
- `commit`
- `branches`
- `createBranch`
- `switchBranch`
- `currentBranch`

`status` returns only JSON-safe row fields: `path`, `index`, `worktree`, and
`renamedFrom` when present. It deliberately omits the capability-bearing
`entry` and `node` fields from the underlying `Git.status()` result.

`add` accepts repo-relative path strings. The tool resolves those paths by
filtering the same `Git.status()` rows and then calls the underlying
capability-bearing `Git.add(entries)` method with the matched entries. This
keeps the staging tool bounded by the granted `Git` capability and avoids
requiring a separate filesystem grant, at the cost of only staging paths that
`status()` reports.

Methods that require remotable arguments or can return live capabilities
directly, such as `restore` and `filesystemAt`, are not included in this slice.
History-rewriting workflows such as `merge` and `rebase` are also deferred.

## Filesystem Tools

`makeMountReadTool(fs)` builds a read-only `mountReadText` tool over an
`@endo/platform/fs/extended` `Filesystem` capability:

```js
import { readOnly } from '@endo/platform/fs/extended';
import { makeMountReadTool } from '@endo/agent-tools/mount-fs.js';

const readTool = makeMountReadTool(readOnly(projectFs));
const content = await readTool.invoke({ path: 'README.md' });
```

The tool reads UTF-8 text by walking the filesystem tree, opening the final
file, and reading a bounded byte range. The supplied `Filesystem` capability
enforces containment, symlink handling, attenuation, subtree scoping, and
revocation. The tool retains a 50k character text cap by default.

`makeMountWriteTool(fs)` builds a `mountWriteText` tool that writes UTF-8 text
to a mount-relative file path, creating the file when absent and truncating
prior contents on overwrite.

`makeMountListTool(fs)` builds a `mountList` tool that lists a mount-relative
directory path and returns only child `name` and `kind` fields. The result does
not expose directory cursor or node capabilities.

## Schema Conformance

JSON Schemas are hand-authored. The package tests compare those schemas with
the runtime `@endo/patterns` guards so schema drift is caught in CI.
