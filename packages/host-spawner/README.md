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

`makeSandboxSpawner(slice, { outputByteLimit })`, imported from
`@endo/host-spawner/src/sandbox-spawner.js` (its only entry point), is the
other engine: it runs each spawn inside an `@endo/sandbox` slice and is the
daemon Shell's adapter for `engine: 'sandbox'`. Its JSDoc documents how kills,
timeouts, and containment failures settle `wait()`.

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
