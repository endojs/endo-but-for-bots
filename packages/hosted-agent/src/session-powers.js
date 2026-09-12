// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/**
 * Exact, already resolved dependencies stored by the host before construction.
 * This active execution bundle must never contain the session client or serve
 * as passive recovery metadata: reading it revives its capability references.
 * @typedef {object} SessionPowers
 * @property {{ provideMount: (path: string, name: string, options: Record<string, unknown>) => Promise<unknown>, remove: (name: string) => Promise<unknown> }} agent
 * @property {object} sandboxFactory
 * @property {object} fsMounter
 * @property {object} filesystem
 * @property {object | null} [configFilesystem]
 * @property {object | null} [credentials]
 * @property {object | null} [mcpMount]
 * @property {{ provideSessionMount: (id: string) => Promise<unknown>, removeSession: (id: string) => Promise<unknown> } | null} [stateProvider]
 * @property {string} [sessionId] - Required when a state provider is supplied.
 * @property {readonly { mountPoint: string, mountName: string }[]} mounts
 */

/**
 * Share the host-side session attenuation across CLI adapters. The client gets
 * only selected resources and mount registration for exact path/name pairs.
 * It cannot look up arbitrary host names or obtain the host agent itself.
 * @param {SessionPowers} powers
 */
export const makeSessionPowers = powers => {
  const {
    agent,
    sandboxFactory,
    fsMounter,
    filesystem,
    configFilesystem = null,
    credentials = null,
    mcpMount = null,
    stateProvider = null,
    sessionId,
  } = powers;
  const mounts = harden(
    powers.mounts.map(({ mountPoint, mountName }) => ({
      mountPoint,
      mountName,
    })),
  );
  /** @param {string | undefined} requested */
  const assertSession = requested => {
    requested === undefined ||
      requested === sessionId ||
      Fail`Session state provider is restricted to its approved session`;
  };
  const makeState = () => {
    if (stateProvider === null) return null;
    const id = sessionId || Fail`Session state provider requires a session ID`;
    return makeExo(
      'HostedSessionState',
      M.interface('HostedSessionState', {
        provideSessionMount: M.call().optional(M.string()).returns(M.promise()),
        removeSession: M.call().optional(M.string()).returns(M.promise()),
      }),
      {
        /** @param {string} [requested] */
        provideSessionMount: requested => {
          assertSession(requested);
          return E(stateProvider).provideSessionMount(id);
        },
        /** @param {string} [requested] */
        removeSession: requested => {
          assertSession(requested);
          return E(stateProvider).removeSession(id);
        },
      },
    );
  };
  const sessionState = makeState();
  return makeExo(
    'HostedSessionPowers',
    M.interface('HostedSessionPowers', {
      sandboxFactory: M.call().returns(M.any()),
      fsMounter: M.call().returns(M.any()),
      filesystem: M.call().returns(M.any()),
      configFilesystem: M.call().returns(M.any()),
      credentials: M.call().returns(M.any()),
      mcpMount: M.call().returns(M.any()),
      stateProvider: M.call().returns(M.any()),
      provideMount: M.call(M.string(), M.string())
        .optional(M.splitRecord({}, { readOnly: M.boolean() }, {}))
        .returns(M.promise()),
      removeMount: M.call().returns(M.promise()),
      help: M.call().returns(M.string()),
    }),
    {
      sandboxFactory: () => sandboxFactory,
      fsMounter: () => fsMounter,
      filesystem: () => filesystem,
      configFilesystem: () => configFilesystem,
      credentials: () => credentials,
      mcpMount: () => mcpMount,
      stateProvider: () => sessionState,
      provideMount: (path, name, options = {}) => {
        mounts.some(
          ({ mountPoint, mountName }) =>
            mountPoint === path && mountName === name,
        ) ||
          Fail`Mount registration is restricted to this session's path/name pairs`;
        return E(agent).provideMount(
          path,
          name,
          harden(
            options.readOnly === undefined
              ? {}
              : { readOnly: options.readOnly },
          ),
        );
      },
      // Every result is returned so the cleanup owner can retain failed name
      // removals. Rejection of one removal must not prevent the others.
      removeMount: () =>
        Promise.allSettled(
          mounts.map(({ mountName }) => E(agent).remove(mountName)),
        ),
      help: () =>
        'HostedSessionPowers: selected resource accessors, exact session mount registration/removal, and session-scoped state. No host lookup.',
    },
  );
};
harden(makeSessionPowers);

/**
 * Static daemon entrypoint. The host persists the exact dependency bundle with
 * storeValue, then supplies that formula as powers to makeUnconfined.
 * @param {SessionPowers | Promise<SessionPowers>} powers
 */
export const make = async powers => {
  const resolved = await powers;
  return makeSessionPowers(resolved);
};
harden(make);
