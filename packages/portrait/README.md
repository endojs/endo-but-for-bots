# `@endo/portrait`

Goblins-style manual persistence for Hardened JavaScript: portraits,
persistence environments, and portrait-graph heaps over pluggable
stores, plugging into `@endo/ocapn` through its locator seam.

An object opts in by being an instance of a *persistent exo class*.
Its `init` runs exactly once, ever; on every later process incarnation
the instance is rebuilt from its stored *portrait* (a snapshot of its
state record) by a constructor the host registered in a *persistence
environment* — the sole authority over what code may run at restore.
See `designs/ocapn-persistence.md` at the repository root for the full
design, and Spritely Goblins' Aurie subsystem for the lineage.

```js
import {
  makePersistenceEnv,
  definePersistentExoClass,
  makePersistentHeap,
  makeMemoryPortraitStore,
} from '@endo/portrait';
import { M } from '@endo/patterns';

const env = makePersistenceEnv();

const makeCounter = definePersistentExoClass(
  env,
  'my-app#makeCounter',
  M.interface('Counter', { increment: M.call().returns(M.number()) }),
  (start = 0) => ({ count: start }),
  {
    increment() {
      this.state.count += 1;
      return this.state.count;
    },
  },
);

const store = makeMemoryPortraitStore();
const heap = await makePersistentHeap({
  env,
  store,
  spawnRoots: () => harden({ counter: makeCounter(0) }),
});
heap.roots.counter.increment();
await heap.flush();
// ... process restarts; same env definitions, same store:
// heap.roots.counter now restores with count === 1.
```

What is durable: Passable copy-data state, references to other
persistent instances in the same heap (including cycles), and — with
the `@endo/portrait/ocapn.js` specials codec — OCapN sturdyrefs.
What is deliberately not: live remote references (a portrait error;
the sturdyref is the durable form), unresolved promises (broken on
restore), and in-flight messages.

`heap.turn(fn)` runs `fn` with copy-on-write rollback: if `fn` throws,
every persistent-state mutation it made is reverted, approximating
Goblins' transactional turns for synchronous code.
