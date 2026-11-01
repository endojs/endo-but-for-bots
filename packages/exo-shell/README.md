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
typed slots (`string`, lexical `relative-path`), unions of options with
prefix flags, optional flag-value groups, and an optional variadic rest —
matched against the argv before anything spawns. A command-*name* allowlist
cannot attenuate a POSIX command (`find` exposes arbitrary execution through
`-exec`; `sed` has GNU `e`; `awk` has `system()`); the grammar constrains the
argument language instead, so "grant `find`" can genuinely mean
`find <root:relative-path> -name <pattern>` with `-exec` outside the language.

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
        argumentVector: [
          { kind: 'options', optional: true, repeat: true,
            options: ['-r', '-n', '-l', '-i'] },
          { kind: 'literal', value: '--' },
          { kind: 'slot', name: 'pattern', type: 'string' },
          { kind: 'slot', name: 'path', type: 'relative-path' },
          { kind: 'rest', name: 'morePaths', type: 'relative-path' },
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

Slot values can never read as option tokens (no leading `-`). A
`relative-path` slot rejects absolute paths and `..` segments. It does not
follow symlinks and does not claim filesystem confinement. Each grammar renders
to a deterministic usage line —
`grep [-r | -n | -l | -i]... -- <pattern> <path:relative-path>
[<morePaths:relative-path> ...]` — revealed by `inspect()` alongside the
grammars, timeout, and output cap (never the host working directory, env
passlist, or search path).

## Agent-ready grammar examples

A grammar bounds argv; the execution engine bounds what the resulting process
can reach. The following are representative grants, including their residual
authority:

| Command form | Grammar elements | Suitable engine |
| --- | --- | --- |
| `printf '%s\\n' <words>...` | fixed format literal plus `string` rest | Host or sandbox: no path argument or command-evaluation slot |
| `git status --short --branch` | all literal tokens | Sandbox for an untrusted repository: Git still reads repository configuration |
| `cat -- <source> [<more>...]` | `--`, one required `relative-path`, then a `relative-path` rest | Sandbox: a lexical path can name a symlink outside a host worktree |
| `grep [-n \| -l \| -i]... -- <pattern> <path> [<more>...]` | repeatable closed option union, delimiter, string slot, required path plus rest | Sandbox for the same symlink reason |
| `find <root> -type f -name <pattern>` | path slot and fixed predicates | Sandbox; omitting `-exec`, `-ok`, and `-delete` closes those argv-level delegation paths |
| `sha256sum -- <path> [<more>...]` | delimiter, required path plus rest | Sandbox; useful as a read-only, byte-oriented workspace observation |

The copyable record forms live in
[`examples/agent-command-grammars.js`](examples/agent-command-grammars.js), and
the package tests pin both admitted and rejected argument vectors for each.

These are deliberately not agent-ready through a host engine merely because a
grammar can spell them: `node <script>`, `npm`, `make`, interpreters such as
`awk`, GNU `sed` with `e`, `find -exec`, and Git forms that can invoke hooks,
helpers, or transports. Their admitted argv language reaches another evaluator.
A sandbox can bound that evaluator to its filesystem and network profile; a
grammar cannot make the delegation disappear.

### Paths, symlinks, and allowed prefixes

The matcher has no filesystem authority. Consequently it cannot express
"follow this path's symlinks and admit it only if the target is below one of
these prefixes." A token such as `inside/link` matches `relative-path` even when
the host filesystem resolves it to `/outside/secret`.

The sandbox engine supplies the strong form by construction: the process sees a
namespace whose allowed prefixes are the mounted workspace views, so a symlink
cannot resolve to an unmounted host path. A host-engine implementation based on
`realpath` before spawn would still have a check/use race. A future host path
grant would need race-resistant, handle-relative opening and a way to pass the
opened handle to the child; adding a `confined-path` spelling to this grammar
without that mechanism would overstate the boundary.

### Pipelines and redirects

`Shell.exec` accepts one argv and returns buffered text. It does not accept shell
syntax, connect stdin/stdout, redirect files, or perform process substitution.
In particular, `cat` plus the current API is not an object-capability copy:
round-tripping its capped UTF-8 result through a file tool is neither
byte-preserving nor streaming.

Pipeline composition belongs in a separate passable plan, not in the command
grammar. The command grammar answers which argv vectors may run; a future plan
grammar must independently bound topology (stage count, pipes, file inputs,
file outputs, append/replace) and validate every stage against the Shell's
command grammars. All stages built by one Shell would share its private
workspace identity. Cross-Shell composition would be allowed only when the
engine proves the workspace identities equal, or when every stage is declared
and verified to perform no file I/O. Process substitution is a process graph,
not an argv interpolation feature, and should wait for that graph model rather
than smuggling `/bin/sh -c` back into the surface.

With that API, object-capability copy can be expressed as a byte stream from an
attenuated `cat -- <source>` stage to a workspace-file output selected by the
plan. Until the plan and sandbox engine exist, grant the Filesystem capability's
copy/read/write operations instead of presenting shell redirection as confined.

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
user can), and a `relative-path` slot bounds the request, not the child's OS
authority.
Kernel-level confinement comes from running the same capability over a sandbox
spawner; the engine is chosen host-side and is invisible on this surface.

The grammar closes the *request-level* delegation holes a name allowlist left
open, but a grammar whose language still reaches an interpreter (`node
<script:relative-path>` where the agent can also write files, `make` over an
agent-writable Makefile) still delegates. Grant delegation-free grammars, or
rely on the sandbox spawner.
