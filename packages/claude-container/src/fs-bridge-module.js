// @ts-check
/* global process */

import { E } from '@endo/eventual-send';

import { makeFsBridge9p } from '@endo/9p-server';
import { withCachedReads, makeMemoryCas } from '@endo/endo-fs';

const DEFAULT_CAS_CAPACITY = 256;

// The factory introduces the workspace FS into our scoped guest's
// namespace under this fixed name; we look it up here and nothing
// else. The bridge has no other reason to enumerate or address
// anything in host's petstore. See `claude-container-factory.js`
// `provideGuest(... introducedNames: { [fsName]: 'fs' } ...)`.
const FS_INTRODUCED_NAME = 'fs';

/**
 * Per-session 9P bridge caplet. The factory provisions one of these
 * per Create Claude Container submission via `makeUnconfined` on a
 * scoped guest profile whose namespace contains exactly one binding:
 * the workspace FS, under the fixed pet name `fs`.
 *
 * On daemon restart, the formula reincarnates: `make()` is called
 * again with the same `env`, the same scoped powers re-resolve the
 * FS, and the 9P server re-binds the same `FS_SOCKET_PATH`. The
 * orchestrator session (and its QEMU process) survives daemon
 * restarts on its own (`@endo/claude-orch` journals state to
 * `$CLAUDE_ORCH_STATE_PATH`), so reattach across restarts is
 * automatic — the guest's mount disconnects briefly when the UDS
 * goes away and reconnects when the bridge re-binds.
 *
 * The resolved FS is wrapped with `@endo/endo-fs`'s `withCachedReads`
 * by default, backed by an LRU-bounded in-memory CAS. The FS sits on
 * the far side of a CapTP link, so every uncached read costs a round
 * trip; the hash-keyed cache lets the bridge serve repeat reads of
 * unchanged files with zero RTT (see `@endo/endo-fs/README.md` and
 * `cached-fs.js`). Set `FS_CACHE=off` to bypass for FS views that
 * compute snapshot hashes expensively (e.g. backings without a
 * pre-computed digest path), accepting the per-read RTT instead.
 *
 * Expected env:
 *   FS_SOCKET_PATH     Absolute UDS path matching the orchestrator
 *                      session's `fsSocketPath`. The bridge unlinks
 *                      any stale node before listening so reincarnation
 *                      after an unclean shutdown is safe.
 *   FS_CACHE           Optional. `off` disables the CAS-backed read
 *                      cache. Default `on`.
 *   FS_CACHE_CAPACITY  Optional. Positive integer; LRU entry bound on
 *                      the in-memory CAS. Default 256.
 *
 * Powers: a scoped guest profile minted by the factory whose only
 * pet name is `'fs'`. We don't and shouldn't get `@agent`.
 *
 * @param {import('@endo/eventual-send').FarRef<any>} powers
 * @param {Promise<object> | object | undefined} _context
 * @param {object} [contextWrapper]
 * @returns {Promise<object>}
 */
export const make = async (powers, _context, contextWrapper = {}) => {
  const env = contextWrapper.env ?? process.env;
  const socketPath = env.FS_SOCKET_PATH;

  if (!socketPath) {
    throw new Error('fs-bridge-module: FS_SOCKET_PATH required.');
  }

  const fs = await E(powers).lookup(FS_INTRODUCED_NAME);
  if (!fs) {
    throw new Error(
      `fs-bridge-module: scoped powers missing introduced name '${FS_INTRODUCED_NAME}'`,
    );
  }

  const cacheMode = (env.FS_CACHE ?? 'on').toLowerCase();
  let effectiveFs = fs;
  if (cacheMode !== 'off') {
    const capRaw = env.FS_CACHE_CAPACITY;
    let capacity = DEFAULT_CAS_CAPACITY;
    if (capRaw !== undefined && capRaw !== '') {
      const parsed = Number(capRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
          `fs-bridge-module: FS_CACHE_CAPACITY must be a positive integer, got ${JSON.stringify(capRaw)}`,
        );
      }
      capacity = parsed;
    }
    effectiveFs = withCachedReads(fs, makeMemoryCas({ capacity }));
  }

  const bridge = makeFsBridge9p({ fs: effectiveFs, socketPath });
  // Start eagerly so reincarnation is self-healing: by the time `make`
  // resolves, the UDS is listening at the original path.
  await E(bridge).start();
  return bridge;
};
harden(make);
