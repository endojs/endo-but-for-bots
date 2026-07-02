// host-git-mutex.mjs — P2-5. ONE process-wide async mutex serializing every writer to the host git tree.
//
// Several subsystems mutate git under the live worktree concurrently: the self-improver's auto-merge
// (check-then-merge on the base branch), componentGit's commit/fork/revert/writeFile (each component is its
// own repo, driven from triageTick / fork / edit), and componentSync's push (the debounced per-commit push +
// the periodic full sweep). Run unserialized, their `git` invocations collide on `index.lock` (and worktree
// locks), producing sporadic "Unable to create '.../index.lock': File exists" failures. This mutex gives all
// of them ONE gate to acquire before touching the tree, so host-git operations run one at a time.
//
// It is a simple FIFO promise-chain mutex (no timeouts, no reentrancy — callers must not nest acquisitions).

export const makeGitMutex = () => {
  let tail = Promise.resolve();
  // runExclusive(fn) queues fn to run after all prior holders release; resolves/rejects with fn's result.
  const runExclusive = fn => {
    const run = tail.then(() => fn());
    tail = run.then(() => undefined, () => undefined); // keep the chain alive whatever fn does
    return run;
  };
  return harden({ runExclusive });
};
harden(makeGitMutex);

// The process-wide singleton every host-git writer shares by default.
export const hostGitLock = makeGitMutex();
