// @ts-check
/* global clearInterval, process, setInterval, setTimeout */

/**
 * Test-only seam for the persist-then-commit window in formulateWithCommit.
 * Production callers leave the default no-op hook in place.
 *
 * Cross-process control (daemon is a child process of the test runner):
 * set `ENDO_FORMULA_COMMIT_HOOK_PATH` to a control file path. The daemon
 * reads that file after durable writes and before name commit:
 * - content starting with `crash` → throw (simulates crash-after-persist)
 * - content starting with `pause` → poll until content becomes `release`
 * - content starting with `reject-before-write` → throw tagged
 *   rejected-before-write after durable writes
 * - content starting with `ambiguous` → throw tagged ambiguous after writes
 *
 * While paused, if `${hookPath}.unpin` appears with a formula id, the
 * registered unpinTransient is invoked without a lock token (tests concurrent
 * unpin serialization against the held commit lock).
 *
 * In-process `setAfterPersistBeforeCommitHook` still works for same-process
 * unit tests of manager internals.
 */

import fs from 'fs';

/** @import { FormulaIdentifier } from './types.js' */

/** @type {() => Promise<void>} */
let afterPersistBeforeCommit = async () => {};

/**
 * @type {((id: FormulaIdentifier) => Promise<void>) | null}
 */
let unpinTransientForTests = null;

/**
 * @type {ReturnType<typeof setInterval> | null}
 */
let pinPollTimer = null;

/**
 * @param {(() => Promise<void>) | undefined} hook
 */
export const setAfterPersistBeforeCommitHook = hook => {
  afterPersistBeforeCommit = hook || (async () => {});
};

/**
 * Register the daemon's unpinTransient so cross-process pause tests can
 * drive concurrent unpin without a lock token.
 *
 * @param {(id: FormulaIdentifier) => Promise<void>} fn
 */
export const setUnpinTransientForTests = fn => {
  unpinTransientForTests = fn;
};

/**
 * Register pinTransient and start a light poll for `${hookPath}.pin` files
 * when ENDO_FORMULA_COMMIT_HOOK_PATH is set.
 *
 * @param {(id: FormulaIdentifier) => void} fn
 */
export const setPinTransientForTests = fn => {
  if (pinPollTimer !== null) {
    clearInterval(pinPollTimer);
    pinPollTimer = null;
  }
  const hookPath = process.env.ENDO_FORMULA_COMMIT_HOOK_PATH;
  if (!hookPath || !fn) {
    return;
  }
  const pinTransient = fn;
  pinPollTimer = setInterval(() => {
    try {
      const pinPath = `${hookPath}.pin`;
      const id = fs.readFileSync(pinPath, 'utf8').trim();
      if (!id) {
        return;
      }
      fs.unlinkSync(pinPath);
      pinTransient(/** @type {FormulaIdentifier} */ (id));
      fs.writeFileSync(`${hookPath}.pin-done`, id, 'utf8');
    } catch {
      // no pin request
    }
  }, 20);
  // Do not keep the daemon alive for the poll alone.
  if (typeof pinPollTimer.unref === 'function') {
    pinPollTimer.unref();
  }
};

/**
 * Poll a control file until it contains a release token or the mode changes.
 *
 * @param {string} hookPath
 * @returns {Promise<void>}
 */
const waitForRelease = async hookPath => {
  const deadline = Date.now() + 30_000;
  let didUnpin = false;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 20));
    // Concurrent-unpin seam: if a companion file names a formula id, unpin
    // without a lock token while the commit still holds the graph lock.
    if (!didUnpin && unpinTransientForTests) {
      const unpinTransient = unpinTransientForTests;
      const unpinPath = `${hookPath}.unpin`;
      try {
        const unpinId = fs.readFileSync(unpinPath, 'utf8').trim();
        if (unpinId) {
          didUnpin = true;
          try {
            fs.writeFileSync(`${hookPath}.unpin-started`, '1', 'utf8');
          } catch {
            // best-effort
          }
          // Fire-and-forget so the pause wait can continue; the exclusive
          // queue holds the unpin until the commit lock releases.
          Promise.resolve()
            .then(() =>
              unpinTransient(/** @type {FormulaIdentifier} */ (unpinId)),
            )
            .then(() => {
              try {
                fs.writeFileSync(`${hookPath}.unpin-done`, '1', 'utf8');
              } catch {
                // best-effort
              }
            })
            .catch(error => {
              try {
                fs.writeFileSync(
                  `${hookPath}.unpin-error`,
                  String(error && error.message ? error.message : error),
                  'utf8',
                );
              } catch {
                // best-effort
              }
            });
        }
      } catch {
        // no unpin file yet
      }
    }
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
  if (text.startsWith('crash')) {
    if (text.includes('-once')) {
      try {
        fs.writeFileSync(hookPath, 'release', 'utf8');
      } catch {
        // best-effort
      }
    }
    throw new Error('injected-crash-after-persist');
  }
  if (text.startsWith('reject-before-write')) {
    if (text.includes('-once')) {
      try {
        fs.writeFileSync(hookPath, 'release', 'utf8');
      } catch {
        // best-effort
      }
    }
    const error = new Error('injected-rejected-before-write');
    // @ts-expect-error test tag
    error.commitOutcome = 'rejected-before-write';
    throw error;
  }
  if (text.startsWith('ambiguous')) {
    if (text.includes('-once')) {
      try {
        fs.writeFileSync(hookPath, 'release', 'utf8');
      } catch {
        // best-effort
      }
    }
    const error = new Error('injected-ambiguous-after-persist');
    // @ts-expect-error test tag
    error.commitOutcome = 'ambiguous';
    throw error;
  }
  if (text.startsWith('pause')) {
    try {
      fs.writeFileSync(`${hookPath}.paused`, '1', 'utf8');
    } catch {
      // best-effort marker
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
