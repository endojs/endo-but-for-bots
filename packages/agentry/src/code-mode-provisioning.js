// @ts-check
/// <reference types="ses"/>

/** @import { EndoHost } from '@endo/daemon' */
/** @import { EndoConnectionFailureObserver, EndoProvisionForkOptions, EndoProvisionPersistence, EndoProvisionResult, ProvisionEndoCodeModeOptions, ReconstructEndoCodeModeOptions } from './code-mode-provisioning-types.js' */

import { makeCancelKit } from '@endo/cancel';
import { makeEndoClient } from '@endo/daemon';
import { makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { whereEndoSock } from '@endo/where';

import { homedir, tmpdir, userInfo } from 'node:os';
import { env, platform } from 'node:process';

import { makeEndoProvisionGrants } from './code-mode-provision-globals.js';
import { codeModeGrantGlobals } from './code-mode-grants.js';
import {
  normalizeEndoProvisionSpec,
  validateEndoProvisionPersistence,
} from './code-mode-provision-policy.js';
import { realizeEndoProvisionOnHost } from './code-mode-provision-host.js';

/**
 * @param {string | undefined} sockPath
 * @returns {string}
 */
const selectSockPath = sockPath => {
  if (sockPath !== undefined) {
    if (typeof sockPath !== 'string' || sockPath.length === 0) {
      throw makeError(X`${q('sockPath')} must be a non-empty string`);
    }
    if (sockPath.includes('\0')) {
      throw makeError(X`${q('sockPath')} must not contain NUL bytes`);
    }
    return sockPath;
  }
  const user = userInfo().username;
  return whereEndoSock(platform, env, {
    home: homedir(),
    user,
    temp: tmpdir(),
  });
};

/**
 * Build the scoped CapTP presentation policy used by code-mode hosts.
 * Promise-delivered application failures remain owned by their awaiting
 * caller; only connection failures cross this host-owned observer boundary.
 *
 * Exported for focused policy tests, but intentionally omitted from the
 * package's public provisioning thunk.
 *
 * @param {EndoConnectionFailureObserver} onConnectionFailure
 */
export const makeCodeModeCapTpOptions = onConnectionFailure =>
  harden({
    /**
     * @param {unknown} error
     * @param {{ kind: 'promise' | 'disconnect' | 'protocol' }} context
     */
    onReject: (error, context) => {
      if (context.kind === 'promise') {
        return;
      }
      onConnectionFailure(error, harden({ kind: context.kind }));
    },
  });
harden(makeCodeModeCapTpOptions);

/**
 * @param {EndoProvisionPersistence} persistence
 * @param {string | undefined} sockPath
 * @param {EndoConnectionFailureObserver | undefined} onConnectionFailure
 * @param {EndoProvisionForkOptions} [forkOptions]
 * @returns {Promise<EndoProvisionResult>}
 */
const connectAndRealize = async (
  persistence,
  sockPath,
  onConnectionFailure,
  forkOptions,
) => {
  await null;
  const { cancelled, cancel } = makeCancelKit();
  /** @type {Promise<void> | undefined} */
  let closed;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    cancel(makeError(X`Code-mode provisioning session closed`));
    await closed?.catch(() => {});
  };

  try {
    const harness = persistence.guestHandlePath[1];
    const sessionKey = persistence.guestHandlePath[2];
    const capTpOptions =
      onConnectionFailure === undefined
        ? undefined
        : makeCodeModeCapTpOptions(onConnectionFailure);
    const client = await makeEndoClient(
      `code-mode-${harness}-${sessionKey.slice('session-'.length, 'session-'.length + 12)}`,
      selectSockPath(sockPath),
      cancelled,
      undefined,
      capTpOptions,
    );
    closed = client.closed;
    closed.catch(() => {});
    const bootstrap = await client.getBootstrap();
    const host = /** @type {EndoHost} */ (await E(bootstrap).host());
    const guest = await realizeEndoProvisionOnHost(
      host,
      persistence,
      forkOptions,
    );
    const grants = await makeEndoProvisionGrants(guest, persistence);
    return harden({
      powers: guest,
      grants,
      // Compatibility projection only.  All runtime and prompt consumers use
      // `grants`; this field cannot be supplied by callers or persisted.
      globals: codeModeGrantGlobals(grants),
      persistence,
      cleanup,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
};

/**
 * Provision or recover one deterministic retained daemon guest from inert
 * caller policy. Filesystem and Git grants are selected independently, but a
 * writable Git grant requires a writable filesystem grant: the native Git
 * backend writes the same working tree at the OS level, so a read-only
 * filesystem view cannot coexist with writable Git.
 *
 * @param {ProvisionEndoCodeModeOptions} options
 * @returns {Promise<EndoProvisionResult>}
 */
export const provisionEndoCodeMode = async options => {
  const persistence = await normalizeEndoProvisionSpec(options?.spec, {
    harness: options?.harness,
    sessionId: options?.sessionId,
    cwd: options?.cwd,
  });
  return connectAndRealize(
    persistence,
    options?.sockPath,
    options?.onConnectionFailure,
  );
};
harden(provisionEndoCodeMode);

/**
 * Reconnect to a retained guest from its normalized, non-secret persistence
 * record. A host-retained copy of the original record is compared before any
 * capability is reused, so descriptor tampering cannot widen authority.
 *
 * @param {ReconstructEndoCodeModeOptions} options
 * @returns {Promise<EndoProvisionResult>}
 */
export const reconstructEndoCodeMode = async options => {
  const persistence = await validateEndoProvisionPersistence(
    options?.persistence,
  );
  return connectAndRealize(
    persistence,
    options?.sockPath,
    options?.onConnectionFailure,
    options?.forkFrom === undefined
      ? undefined
      : { forkFrom: options.forkFrom },
  );
};
harden(reconstructEndoCodeMode);
