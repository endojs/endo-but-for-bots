// @ts-check

/**
 * Test-only seam for the persist-then-commit window in formulateWithCommit.
 * Production callers leave the default no-op hook in place.
 *
 * Cross-process control (daemon is a child process of the test runner):
 * set `ENDO_FORMULA_COMMIT_HOOK_PATH` to a control file path. The daemon
 * reads that file after durable writes and before name commit:
 * - content starting with `crash` → throw (simulates crash-after-persist)
 * - content starting with `pause` → poll until content becomes `release`
 * In-process `setAfterPersistBeforeCommitHook` still works for same-process
 * unit tests of manager internals.
 */

import fs from 'fs';

/** @type {() => Promise<void>} */
let afterPersistBeforeCommit = async () => {};

/**
 * @param {(() => Promise<void>) | undefined} hook
 */
export const setAfterPersistBeforeCommitHook = hook => {
  afterPersistBeforeCommit = hook || (async () => {});
};

/**
 * Poll a control file until it contains a release token or the mode changes.
 *
 * @param {string} hookPath
 * @returns {Promise<void>}
 */
const waitForRelease = async hookPath => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 20));
    let text = '';
    try {
      text = fs.readFileSync(hookPath, 'utf8').trim();
    } catch {
      // Missing file means release (test cleaned up).
      return;
    }
    if (text === 'release' || text.startsWith('release')) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `formula-commit test hook timed out waiting for release at ${hookPath}`,
      );
    }
  }
};

/**
 * Cross-process hook driven by ENDO_FORMULA_COMMIT_HOOK_PATH.
 * Modes:
 * - `crash` / `crash-once`: throw after durable write
 * - `pause` / `pause-once`: block until file content is `release`
 * The `-once` variants clear the control file after first observation so
 * bootstrap or later formulations are not accidentally re-armed.
 *
 * @returns {Promise<void>}
 */
const runEnvFileHook = async () => {
  const hookPath = process.env.ENDO_FORMULA_COMMIT_HOOK_PATH;
  if (!hookPath) {
    return;
  }
  let text = '';
  try {
    text = fs.readFileSync(hookPath, 'utf8').trim();
  } catch {
    return;
  }
  const once = text.endsWith('-once') || text.includes('-once');
  if (text.startsWith('crash')) {
    if (once) {
      try {
        fs.writeFileSync(hookPath, 'release', 'utf8');
      } catch {
        // best-effort
      }
    }
    throw new Error('injected-crash-after-persist');
  }
  if (text.startsWith('pause')) {
    // Signal that the pause was observed so the test can assert sawPause
    // without racing the daemon's first read.
    try {
      fs.writeFileSync(`${hookPath}.paused`, '1', 'utf8');
    } catch {
      // best-effort marker
    }
    if (once) {
      // Leave content as pause until the test writes release; -once only
      // prevents re-arm after release by writing release ourselves only if
      // the test already released. Poll as usual.
    }
    await waitForRelease(hookPath);
  }
};

/**
 * Invoked after formula + provisional name-commit records are durable
 * and before the name-commit callback runs.
 *
 * @returns {Promise<void>}
 */
export const runAfterPersistBeforeCommitHook = async () => {
  await afterPersistBeforeCommit();
  await runEnvFileHook();
};
