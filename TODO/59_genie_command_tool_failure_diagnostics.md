# `bash` / `exec` non-zero exits surface as opaque `Command failed with exit code N`

## Context

While investigating TODO/58, every reproducible "failure" we could
provoke from the dev-repl turned out to be either a legitimate
non-zero exit (e.g. `exec` receiving a pipe character as a literal
argv element to `ps`) or a model-side argv mistake — never a bwrap
driver bug.  But the operator (and the model that is trying to
self-correct on the next turn) sees only:

```
✗ failed: Error: Tool execution failed:
  {"content":[{"type":"text","text":"bash execution failed:
   Command failed with exit code 1"}],"details":{}}
```

No stderr, no stdout, no command string.  The drain loop in
`packages/genie/src/tools/command.js` `runProcess` collects both
streams and then throws them on the floor when `exitCode !== 0`:

```js
if (exitCode !== 0) {
  const err = new Error(`Command failed with exit code ${exitCode}`);
  // @ts-expect-error — attach extra fields for callers
  err.code = exitCode;
  throw err;
}
```

That makes a real bug indistinguishable from a model-side typo.

## Tasks

1. [ ] In `runProcess` (`packages/genie/src/tools/command.js`),
   attach the trimmed stderr, stdout, command string, and exit code
   onto the thrown error.  Keep the existing `err.code` field for
   any pre-existing callers that grep for it.

2. [ ] Update the error wrapper in `makeCommandTool.execute` (same
   file) to include the captured stderr (truncated to a sane budget,
   e.g. 2 KiB) in the user-facing message so the model sees:

   ```
   bash execution failed: Command failed with exit code 1
   stderr: ls: cannot access 'foo': No such file or directory
   ```

3. [ ] Mirror the change in any other call sites that build an error
   from a `ProcessLike` exit (search for "Command failed with exit
   code" — there should only be the one).

4. [ ] Add a regression test in
   `packages/genie/test/tools/command.test.js` that:
   - Drives `bash` / `exec` against a deliberate failure (`bash -c
     'echo oops 1>&2; exit 7'`).
   - Asserts the thrown error message contains both the exit code
     and the stderr substring.

5. [ ] Keep the change orthogonal to TODO/60: this task only widens
   the *error* surface.  TODO/60 considers turning non-zero exits
   into a success-shape return so the model can keep going.  Land
   the diagnostic improvement first, even if TODO/60 lands later.

## Acceptance

- `bash` / `exec` failures show stderr + exit code in the dev-repl's
  red `✗ failed:` line and in `chatlog` entries.
- The new regression test fails on `main` and passes after the patch.
- `yarn workspace @endo/genie run test` stays green.
