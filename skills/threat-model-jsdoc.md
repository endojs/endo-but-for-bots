# Module-header threat-model JSDoc on ambient-authority attenuators

## When to use

A reviewer asks for a "threat-model" comment on a module that exports an
attenuator taking ambient authority (e.g., a function that takes
`node:fs`, an absolute path, a network socket, a process handle) and
returns a confined capability.
The function narrows ambient authority to a specific capability that
can be safely passed around an ocap system; "factory" misnames this
pattern because the function consumes ambient authority rather than
producing more of it.

The endo monorepo does not have a single canonical example of this
convention.
The closest precedent is
`packages/daemon/src/bus-xs-host-globals.d.ts`, which opens with a doc
comment naming the host that injects the symbols and the failure mode
of tightening the typings.

## What to write

A `/** ... */` block at the top of the module, between the `// @ts-check`
line and the `import` block, answering three questions in three short
paragraphs:

1. **What authority does the capability convey?**
   Be concrete: read, write, recursive remove, network egress, process
   spawn.
   Name the scope: a single path, a subtree, a port range.

2. **Who is meant to hold it?**
   "Host-side", "the daemon process", "trusted tooling".
   Explicitly call out who must *not* hold it: guests, workers, caplets,
   chat-side bots.

3. **What fails if it leaks across the membrane?**
   Frame it as "any holder can ..." so the reader sees the worst case.
   Cross-reference the design doc that articulates the confined route
   (for `@endo/platform/fs/node`, that is
   `designs/platform-fs-daemon-integration.md`).

## Length and voice

- Keep the block under 12 lines per file.
- One sentence per line (the codebase's markdown convention applies to
  doc comments too).
- No em-dashes (per the project rule); use semicolons or split the
  sentence.

## Example shape

```js
// @ts-check

/**
 * Ambient-authority attenuator for a mutable Directory exo backed by an
 * arbitrary absolute filesystem path.
 *
 * The capability returned by `makeDirectory` conveys read, write,
 * rename, copy, and (with an explicit flag) recursive remove authority
 * on the entire subtree rooted at the given path.
 *
 * This attenuator is intended to live entirely on the host side of the
 * daemon membrane.
 * It must never be exposed to a guest, worker, caplet, or chat-side
 * bot; doing so would hand that party ambient filesystem authority to
 * a real subtree of the host process's view of the disk.
 * Confined `Directory` references reach agents only via the `Mount`
 * exo, which applies path clamping and symlink confinement before
 * composing this attenuator.
 * See `designs/platform-fs-daemon-integration.md`.
 */

import fs from 'node:fs';
```

## Pitfalls

- **Don't conflate with the function's `@param` block.**
  The threat-model comment is a *module* header, not a function header.
  It applies to every export from the file.
- **Don't restate the JSDoc `@param` types.**
  Talk about authority and the membrane, not the call signature.
- **Don't drift into design-doc territory.**
  If the comment grows past 12 lines, the right move is to expand the
  design doc and link to it from the comment.

## Origin

PR endojs/endo-but-for-bots#122 panel must-fix, 2026-05-07.
The reviewer asked for module-header threat-model JSDoc on every file
in `packages/platform/src/fs-node/` that exports an attenuator taking
ambient authority (`makeFile`, `makeDirectory`, `makeTreeWriter`,
`makeLocalBlob`, `makeLocalTree`).
A follow-up review on the same PR (comment 3204484622) renamed the
pattern from "ambient-authority factory" to "ambient-authority
attenuator" because the function narrows authority rather than
manufacturing it.
