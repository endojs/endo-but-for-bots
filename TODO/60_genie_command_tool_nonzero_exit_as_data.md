# Reconsider whether `bash` / `exec` non-zero exits should be data, not a thrown error

## Context

`makeCommandTool` (`packages/genie/src/tools/command.js`) throws on
any non-zero exit code, which is incongruent with how command-line
tools actually behave:

- `grep foo bar.txt` exits 1 when there is no match — a perfectly
  legitimate "no, the file does not contain foo" result.
- `test -f /some/path` exits 1 when the path does not exist — a
  yes/no question the model expects to ask.
- `find . -name … | head` will fail SIGPIPE-style when `head` closes
  early.
- `diff a b` exits 1 when the files differ, exits 2 on a real error.
- A successful `make check` may exit non-zero on a test failure that
  the model should be able to inspect.

The tool's return shape already includes `exitCode` (currently always
`0` because the tool throws otherwise — wasted field).  The model
asks the question, the tool throws, and the model gets nothing back
to reason about except an opaque "Command failed with exit code N"
sentence.

This is the root of most of the TODO/58 "failures": the model picked
a strategy that legitimately exits non-zero, but the result it sees
back looks like a tool failure rather than a result.

## Proposal

Stop throwing on non-zero exits in `runProcess`.  Always return:

```ts
{
  success: boolean,    // exitCode === 0
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  path?: string,
}
```

Throw only when the spawner itself failed (bwrap reject, slice
torn down, signal terminated the child before it could exit cleanly,
program-not-found in non-shell mode).  The existing
`Tool execution failed: …` wrapper continues to fire for those.

## Tasks

1. [ ] Decide whether this is a semantic change we want.  Discuss
   with the operator before landing — the schema already advertises
   `success` and `exitCode`, so this is closer to "honour the
   contract" than a breaking change, but the agent's system prompt
   currently nudges the model to treat any thrown error as failure.

2. [ ] If yes: in `runProcess`, drop the "throw on non-zero" branch
   and just populate the return record with `success: exitCode === 0`.
   Keep the timeout-kill branch as a throw (`name + ' timed out…'`
   is still an error, not a result).

3. [ ] Update the system prompt / tool description to mention that
   the tool returns the exit code and that non-zero exits are
   reported as data.  Without this nudge most models will keep
   panicking at the sight of `success: false`.

4. [ ] Add regression tests:
   - `grep foo /etc/hostname` returns `{ success: false, exitCode: 1 }`
     rather than throwing.
   - A genuinely missing program still throws (program-not-found
     surfaces from the spawner before `runProcess` sees a process).
   - A timeout still throws (`Command timed out after …`).

5. [ ] Land TODO/59 first so the thrown-path's diagnostics are usable
   when this task surfaces a *real* error.

## Open questions

- Does the heartbeat / observer agent rely on the thrown-error shape
  for any of its bookkeeping?  Search for `try { … await tool …`
  patterns and audit.
- Should `bash` and `exec` differ?  `exec` is contractually argv-
  shaped and its caller can reasonably treat exit 1 as failure; only
  `bash` returns data the model is expected to interpret directly.
  Probably uniform — both should report exit codes as data — but
  document the asymmetry if we split.
