# @endo/host-spawner

The host-side `Spawner` seam, so daemon-side capabilities (notably the Shell
formula in `@endo/daemon`) can reach a shared process-execution engine without
depending on an agent framework. It stands alone: the daemon can wrap
`child_process.spawn` behind this seam without pulling in any agent-host layer
that would depend on `@endo/daemon` in turn.

A `Spawner` is a single-method contract:

```ts
type Spawner = (
  argv: string[],
  options?: SpawnerOptions,
) => Promise<ProcessLike>;
```

`ProcessLike` mirrors `DriverProcess` from `@endo/sandbox`, so a slice's process
handle can drop in behind the same seam. `makeHostSpawner` is the default engine,
wrapping `child_process.spawn` and exposing stdout/stderr as async-iterable byte
streams plus an awaitable `{ code, signal }`. Callers layer their own
timeout / kill / output-accumulation logic on top of the returned handle so that
logic stays uniform across engines.

```js
import { makeHostSpawner } from '@endo/host-spawner';

const spawn = makeHostSpawner({ searchPath: '/usr/bin:/bin', defaultEnv: {} });
const child = await spawn(['echo', 'hello'], { cwd: '/tmp', env: { CI: 'true' } });
```

`makeSandboxSpawner(slice, { outputByteLimit })` is the other engine, and the
one implementation of the slice adapter (`@endo/sandbox/spawner.js`
re-exports it). It runs each spawn inside an `@endo/sandbox` slice (a
`SandboxHandle`) and adapts the slice's process handle to `ProcessLike`. It
refuses `shell: true`, closes stdin, and discloses no remote pid (`pid` is
`0`). The caller's `timeoutMs` becomes the slice's kernel-side timeout;
`maxOutputBytes` does not become a slice limit, so, as on the host, the caller
truncates and drains. The construction-time `outputByteLimit` is the slice's
runaway-output guard. A kill the caller requested settles `wait()` with
`{ code: null, signal }` as a killed host process would, once the slice has
reaped it; every other slice termination, and any containment failure,
rejects `wait()` (and `kill()`) with the slice's own error. The daemon's Shell
formula uses it for `engine: 'sandbox'`.

```js
import { makeSandboxSpawner } from '@endo/host-spawner/src/sandbox-spawner.js';

const slice = await E(sandboxFactory).make({
  rootfs: { kind: 'host-bind' },
  mounts: [{ cap: worktree, innerPath: '/work', mode: 'rw' }],
  network: 'none',
});
const spawn = makeSandboxSpawner(slice);
const child = await spawn(['make', 'test'], { cwd: '/work', timeoutMs: 60_000 });
```

An agent host that already speaks the `Spawner` seam can re-export
`makeHostSpawner` from here, so its own command tools reach the same engine as
the daemon without duplicating the process-execution logic.
