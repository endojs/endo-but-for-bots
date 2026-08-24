// @ts-check
/// <reference types="ses"/>

/** @import { EndoHost } from '@endo/daemon' */
/** @import { EndoCodeModeConnectionFailureObserver, EndoCodeModeProvisionForkOptions, EndoCodeModeProvisionPersistence, EndoCodeModeProvisionResult, ProvisionEndoCodeModeOptions, ReconstructEndoCodeModeOptions } from './code-mode-provisioning-types.js' */

import { makeCancelKit } from '@endo/cancel';
import { makeEndoClient } from '@endo/daemon';
import { makeError, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { whereEndoSock } from '@endo/where';

import { homedir, tmpdir, userInfo } from 'node:os';
import { env, platform } from 'node:process';

import { makeEndoProvisionGlobals } from './code-mode-provision-globals.js';
import { provideEndoCodeModeGuest } from './code-mode-provision-host.js';
import {
  normalizeEndoCodeModeProvisionSpec,
  validateEndoCodeModeProvisionPersistence,
} from './code-mode-provision-policy.js';

/** @param {string | undefined} sockPath */
const selectSockPath = sockPath => {
  if (sockPath !== undefined) return sockPath;
  return whereEndoSock(platform, env, {
    home: homedir(),
    user: userInfo().username,
    temp: tmpdir(),
  });
};

/** @param {EndoCodeModeConnectionFailureObserver} observer */
const makeCapTpOptions = observer =>
  harden({
    /**
     * @param {unknown} error
     * @param {{ kind: 'promise' | 'disconnect' | 'protocol' }} context
     */
    onReject: (error, context) => {
      if (context.kind !== 'promise') {
        observer(error, harden({ kind: context.kind }));
      }
    },
  });

/** @param {unknown} error */
const classifyProvisionError = error => {
  if (
    error instanceof Error &&
    error.message.includes('ENDO_CREDENTIAL_UNAVAILABLE:')
  ) {
    return makeError(X`The configured Git credential is unavailable`, Error, {
      cause: error,
      code: 'ENDO_CREDENTIAL_UNAVAILABLE',
    });
  }
  return error;
};

/**
 * @param {EndoCodeModeProvisionPersistence} persistence
 * @param {string | undefined} sockPath
 * @param {EndoCodeModeConnectionFailureObserver | undefined} onConnectionFailure
 * @param {EndoCodeModeProvisionForkOptions} [forkOptions]
 * @returns {Promise<EndoCodeModeProvisionResult>}
 */
const connectAndProject = async (
  persistence,
  sockPath,
  onConnectionFailure,
  forkOptions,
) => {
  const { cancelled, cancel } = makeCancelKit();
  /** @type {Promise<void> | undefined} */
  let closed;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    cancel(makeError(X`Endo code-mode session closed`));
    await closed?.catch(() => {});
  };
  try {
    const client = await makeEndoClient(
      persistence.guestName.slice(0, 80),
      selectSockPath(sockPath),
      cancelled,
      undefined,
      onConnectionFailure === undefined
        ? undefined
        : makeCapTpOptions(onConnectionFailure),
    );
    closed = client.closed;
    closed.catch(() => {});
    const bootstrap = await client.getBootstrap();
    const host = /** @type {EndoHost} */ (await E(bootstrap).host());
    const guest = await provideEndoCodeModeGuest(
      host,
      persistence,
      forkOptions,
    );
    return harden({
      guest,
      globals: makeEndoProvisionGlobals(persistence),
      persistence,
      cleanup,
    });
  } catch (error) {
    await cleanup();
    throw classifyProvisionError(error);
  }
};

/**
 * Provision or reacquire one named code-mode guest and project its inert
 * lexical declarations.
 *
 * @param {ProvisionEndoCodeModeOptions} options
 * @returns {Promise<EndoCodeModeProvisionResult>}
 */
export const provisionEndoCodeMode = async options => {
  const persistence = await normalizeEndoCodeModeProvisionSpec(options?.spec, {
    harness: options?.harness,
    sessionId: options?.sessionId,
    cwd: options?.cwd,
  });
  return connectAndProject(
    persistence,
    options?.sockPath,
    options?.onConnectionFailure,
  );
};
harden(provisionEndoCodeMode);

/**
 * Reacquire a retained code-mode guest by its small opaque guest name.
 * Pi-specific fork and session context stay in this adapter.
 *
 * @param {ReconstructEndoCodeModeOptions} options
 * @returns {Promise<EndoCodeModeProvisionResult>}
 */
export const reconstructEndoCodeMode = async options => {
  const persistence = await validateEndoCodeModeProvisionPersistence(
    options?.persistence,
  );
  const forkFrom =
    options?.forkFrom === undefined
      ? undefined
      : await validateEndoCodeModeProvisionPersistence(options.forkFrom);
  return connectAndProject(
    persistence,
    options?.sockPath,
    options?.onConnectionFailure,
    forkFrom === undefined ? undefined : { forkFrom },
  );
};
harden(reconstructEndoCodeMode);
