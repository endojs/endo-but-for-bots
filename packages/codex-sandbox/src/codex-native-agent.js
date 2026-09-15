// @ts-check

/**
 * Codex's owned native sandbox runtime: the same host-only service
 * `@endo/sandbox/native-agent.js` mints for Claude and OpenCode, plus the one
 * thing Codex needs that the shared entry point cannot carry.
 *
 * The Podman driver admits a durable volume mount only on evidence from a
 * trusted kernel-quota observer, and `native-agent.js` takes `null` powers and
 * environment strings alone — there is no slot for an observer capability. So
 * Codex builds its own from configuration, which is all this observer ever
 * needed: a volume root, a filesystem, and the path of the operator-installed
 * quota bridge. Nothing capability-shaped crosses the formula boundary, and the
 * observer stays inside the runtime rather than becoming something a caplet
 * could retain.
 *
 * Constructed with slot-free `null` powers, exactly as the shared entry point
 * is: this service imports no daemon host or scratch authority. `@none` would
 * be a denied-method guest capability, not null.
 *
 * What it returns is the runtime's **factory** facet, not the scope service the
 * shared entry point returns. Codex's attested provisioner builds each slice
 * with `make`, where Claude's and OpenCode's daemon-owned session controllers
 * acquire a scope and call `makeResolved`; moving Codex to scopes is a change to
 * its session model, not to where its runtime is constructed, and the two are
 * worth doing separately. A `null` scratch provider is what makes the factory
 * host-only: capability-based construction is refused at the point of use, which
 * is exactly what the hand-written `noScratch` exo the backend used to pass was
 * for.
 *
 * @module
 */

import { Fail, b, q } from '@endo/errors';
import { makeOwnedNativeService } from '@endo/sandbox/owned-native-service.js';
import { readRuntimeConfig } from '@endo/sandbox/runtime-config.js';
import { makeSandboxRuntime } from '@endo/sandbox/runtime.js';
import { isAbsolute, normalize } from 'node:path';

import { makeCodexVolumeQuotaObserver } from './codex-quota-host.js';

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {string} [fallback]
 */
const absolutePath = (env, name, fallback) => {
  const value = env[name] || fallback;
  (typeof value === 'string' &&
    value.length > 0 &&
    isAbsolute(value) &&
    normalize(value) === value &&
    value !== '/') ||
    Fail`${b(name)} must be a normalized, absolute, non-root path, got ${q(value)}`;
  return /** @type {string} */ (value);
};

/**
 * The runtime's own construction policy plus the quota bridge's placement.
 * Read together so a runtime that cannot observe quotas is refused at
 * construction rather than at the first session's volume admission.
 * @param {Record<string, string | undefined>} env
 */
export const readCodexNativeConfig = env => {
  const runtime = readRuntimeConfig(env);
  return harden({
    ...runtime,
    quota: harden({
      volumeRoot: absolutePath(env, 'ENDO_CODEX_VOLUME_ROOT'),
      filesystem: absolutePath(env, 'ENDO_CODEX_FILESYSTEM'),
      quotaCommand: absolutePath(env, 'ENDO_CODEX_QUOTA_COMMAND'),
      sudoPath: absolutePath(env, 'ENDO_CODEX_SUDO_PATH', '/usr/bin/sudo'),
    }),
  });
};
harden(readCodexNativeConfig);

const makeNative = makeOwnedNativeService({
  readConfig: readCodexNativeConfig,
  /**
   * @param {ReturnType<typeof readCodexNativeConfig>} config
   * @param {null} _input
   * @param {Record<string, string>} env
   */
  makeKit: (config, _input, env) => {
    // Built here, not in open(): the owner retains close() the moment this
    // returns, and a runtime constructed later — inside an await in open() —
    // could be created after a cancellation had already run close(), stranding
    // its ownership marker. The observer is a promise for the same reason; the
    // driver only ever eventual-sends to it.
    const observer = makeCodexVolumeQuotaObserver(config.quota);
    // Never an unhandled rejection: open() below is what reports it.
    void observer.catch(() => {});
    const runtime = makeSandboxRuntime(
      { ...config, env },
      { scratchProvider: null, volumeQuota: observer },
    );
    return harden({
      open: async () => {
        // Refuse a misconfigured quota bridge before the runtime claims its
        // exclusive ownership marker, rather than per session at admission.
        await observer;
        return runtime.open();
      },
      close: runtime.close,
    });
  },
});

/**
 * @param {null | Promise<null>} powers
 * @param {Parameters<typeof makeNative>[1]} context
 * @param {Parameters<typeof makeNative>[2]} [options]
 */
export const make = (powers, context, options) => {
  const validated = Promise.resolve(powers).then(value => {
    value === null || Fail`Codex native sandbox service requires null powers`;
    return null;
  });
  // Configuration can fail before the owner begins waiting for powers.
  void validated.catch(() => {});
  return makeNative(validated, context, options);
};
harden(make);
