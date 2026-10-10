// @ts-check

// Shared, non-test helpers for the suites that build a real git repository
// under a temp directory and delete it in an AVA teardown.  Named with a
// leading underscore, this directory's convention for a module that is not
// itself a test.

import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Remove a fixture repository's directory, tolerating a git process that
 * is still writing into it.
 *
 * A packing process writes its `.tmp-*-pack` files directly into
 * `.git/objects/pack`.  One that outlives the test body can create an entry
 * there after the recursive delete has walked that directory, and the delete
 * then fails with `ENOTEMPTY`, failing a test whose body passed (#1136).
 * Node retries specifically on that error when asked to; by default it does
 * not retry at all.  The backoff is linear, so ten retries wait out up to
 * 2.75s of a packing process — the budget matters for a repository the
 * daemon cloned itself, which `quiesceGitMaintenance` never saw.
 *
 * @param {string} root
 * @returns {Promise<void>}
 */
export const removeRepoTree = root =>
  rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
harden(removeRepoTree);

/**
 * Keep git from leaving background work behind in a fixture repository.
 *
 * `commit`, `rebase` and `fetch` all end by running
 * `git maintenance run --auto`, whose packing detaches by default and so
 * keeps running after the command that started it has returned.  Which
 * tasks that run performs, and which key detaches it, both vary by git
 * version — on git 2.43 the run is `gc` alone and detaches per
 * `gc.autoDetach`, while 2.48 and later add `maintenance.autoDetach`, which
 * falls back to `gc.autoDetach` when unset.  So pin the three knobs rather
 * than reason from one version's behavior:
 *
 * - `maintenance.auto=false` keeps the run from being forked at all,
 *   whatever it would have gone on to do.  Measured on git 2.43, this is
 *   the key that takes `git rebase --continue` from two `maintenance run
 *   --auto` invocations to none; `gc.auto=0` leaves both in place.
 * - `gc.autoDetach=false` keeps any run that does happen in the foreground,
 *   so it cannot outlive the command that started it.
 * - `gc.auto=0` disables the packing heuristic itself, which also covers a
 *   direct `git gc --auto`.
 *
 * A repository the daemon clones for itself never passes through here;
 * `removeRepoTree` is what covers that one.
 *
 * @param {string} cwd A worktree root or bare repository directory.
 * @returns {Promise<void>}
 */
export const quiesceGitMaintenance = async cwd => {
  await execFileAsync(
    'git',
    ['config', '--local', 'maintenance.auto', 'false'],
    { cwd },
  );
  await execFileAsync('git', ['config', '--local', 'gc.autoDetach', 'false'], {
    cwd,
  });
  await execFileAsync('git', ['config', '--local', 'gc.auto', '0'], { cwd });
};
harden(quiesceGitMaintenance);
