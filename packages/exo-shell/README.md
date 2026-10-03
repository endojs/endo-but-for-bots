# @endo/exo-shell

Remotable exo glue and interface guard for an `EndoShell` capability: a
writable-mount-scoped, grammar-bounded, argv-only command executor. Portable
across SES realms; pair it with `@endo/host-spawner` (or a sandbox spawner) for
the process-execution engine.

This is the portable half of the Shell capability, mirroring how `@endo/exo-git`
is the portable half of the Git capability (`makeGit`) and `@endo/git` supplies
the Node-side backend. `makeShell` takes a working directory, a formula-owned
policy, and an injected `Spawner`; the daemon (`@endo/daemon`) constructs the
host spawner and mints the exo through its `provideShell` formula.

## Command grammars, not command names

The unit of grant is a **command grammar**: a passable (copyable pass-style
data) expression describing the accepted argument strings — fixed literals,
typed slots (`string`, worktree-relative `path`), unions of options with
prefix flags, optional flag-value groups, and an optional variadic rest —
matched against the argv before anything spawns. A command-*name* allowlist
cannot attenuate a POSIX command (`find` exposes arbitrary execution through
`-exec`; `sed` has GNU `e`; `awk` has `system()`); the grammar constrains the
argument language instead, so "grant `find`" can genuinely mean
`find <root:path> -name <pattern>` with `-exec` outside the language.

```js
import { makeShell } from '@endo/exo-shell';
import { makeHostSpawner } from '@endo/host-spawner';

const shell = makeShell({
  cwd: '/repo',
  policy: {
    commands: [
      {
        program: 'grep',
        description: 'Search the worktree for a fixed pattern',
        args: [
          { kind: 'options', optional: true, repeat: true,
            options: ['-r', '-n', '-l', '-i'] },
          { kind: 'literal', value: '--' },
          { kind: 'slot', name: 'pattern', type: 'string' },
          { kind: 'rest', name: 'paths', type: 'path' },
        ],
      },
    ],
    timeoutMs: 60_000,
    maxOutputBytes: 1_048_576,
    env: { CI: 'true' }, // explicit passlist; nothing inherited
  },
  spawner: makeHostSpawner({ searchPath: process.env.PATH, defaultEnv: {} }),
});

const { stdout } = await shell.exec('grep', ['-r', '--', 'TODO', 'src']);
```

Slot values can never read as option tokens (no leading `-`), and `path`
slots are confined lexically to the worktree (no absolute path, no `..`
segment). Each grammar renders to a deterministic usage line —
`grep [-r | -n | -l | -i]... -- <pattern> [<paths:path> ...]` — revealed by
`inspect()` alongside the grammars, the timeout, and the output cap (never the
host working directory, env passlist, or search path).

## Attenuation

`shell.attenuate(commands, { timeoutMs? })` derives a narrower `Shell`: the
derived capability accepts only argvs its own grammars match **and** delegates
to its parent, whose grammars are checked again — intersection by conjunction,
so a derived shell can only narrow, and no grammar-inclusion proof is ever
needed. Attenuation chains, `timeoutMs` only shrinks along the chain, and
self-attenuation is safe to expose to a guest.

The exo enforces the guest-facing bounds: grammar-match-before-spawn, argv
arrays only (no shell string / interpolation), the policy's sanitized
environment, a per-stream output cap with a `truncated` flag, and a timeout
that a per-call value may only *narrow*.

## The honest boundary

Under the host spawner, a `Shell` bounds *which argument vectors* start a
child and *with what* env, cwd, timeout, and output budget. A started child is
still an ordinary host process (a granted `grep` can read `~/.ssh` if the OS
user can), and a `path` slot bounds the request, not the child's OS authority.
Kernel-level confinement comes from running the same capability over a sandbox
spawner; the engine is chosen host-side and is invisible on this surface.

The grammar closes the *request-level* delegation holes a name allowlist left
open, but a grammar whose language still reaches an interpreter (`node
<script:path>` where the agent can also write files, `make` over an
agent-writable Makefile) still delegates. Grant delegation-free grammars, or
rely on the sandbox spawner.
