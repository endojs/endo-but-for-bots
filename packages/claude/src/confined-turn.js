// @ts-check
/* global process */
// spell-out-exempt: `temp` is the @endo/where platform-info field name.
//
// The confined shape end to end (designs/endo-guest-stdio-mcp.md § How the
// confinement properties change, shape 1; designs/endo-claude.md):
//
//   runConfinedTurn({ formulaId, credential, prompt, model, claudePath,
//                     guestSocketPath })
//
//   harness process (this module)             confined `claude -p --bare`
//   ─────────────────────────────             ───────────────────────────
//   guest socket session (makeEndoClient)     env: PATH, LANG, LC_ALL,
//   └ bootstrap IS the one guest                   ENDO_CLAUDE_SESSION_TAG only
//   broker: that guest's static catalog  ◄──  relay (env -i node relay.mjs)
//   on a 0600 socket in a 0700 dir              stdio ⇄ broker socket
//
// The harness connects to a daemon-issued guest socket
// (`EndoBootstrap.guestBootstrapPath`), whose CapTP bootstrap is the guest
// facet itself, so the harness holds no host. An operator issues that socket
// once and passes its path as `guestSocketPath`; without one, the turn issues it
// over the root socket and closes that root session before the broker starts.
//
// The daemon connection, its socket path, and the formula id stay in the
// harness process. The confined tree is given only the broker socket (pinned
// to the one guest) inside its MCP config, and the credential only through the
// `apiKeyHelper`. The relay is spawned with an empty environment, so nothing
// `claude` holds in its own environment reaches it.
//
// This module is the harness side only. Kernel-level confinement of the
// `claude` tree (the `@endo/claude-sandbox` / `@endo/sandbox` slice that makes
// the daemon socket structurally unreachable) wraps `claudePath`; the slice
// must bind the broker directory and the per-spawn directory, and supply a
// scratch home, since the constructed environment carries no HOME.

import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { makeError, X } from '@endo/errors';
import {
  connectToDaemon,
  connectToGuestBootstrap,
  issueGuestBootstrapPath,
  startGuestBroker,
} from '@endo/agent-mcp-stdio';

import { make } from './harness.js';
import { makeLaunch } from './launch.js';
import { makeSpawnFilesPreparer } from './spawn-files.js';
import { PINNED_CLI_VERSION } from './argv.js';

/** @import { SpawnOptions, ChildProcess } from 'node:child_process' */
/** @import { InferResult } from './claude.types.js' */
/** @import { DaemonConnection, GuestConnection } from '@endo/agent-mcp-stdio' */

/**
 * The default harness connection: a session on `guestSocketPath`, or, when
 * absent, on a guest socket issued for `formulaId` over the root socket
 * (`issue` closes that root session before it returns). A daemon that cannot
 * issue guest sockets gets the root connection (`connectToRoot`) instead, as
 * before guest-scoped bootstraps existed, and `warn` reports that widening to
 * host authority; an explicit `guestSocketPath` never falls back.
 *
 * @param {object} options
 * @param {string} options.formulaId
 * @param {string} [options.guestSocketPath]
 * @param {typeof issueGuestBootstrapPath} [options.issue]
 * @param {typeof connectToGuestBootstrap} [options.connectTo]
 * @param {typeof connectToDaemon} [options.connectToRoot]
 * @param {(message: string) => void} [options.warn] - told when the turn
 *   falls back to the root connection; defaults to standard error.
 * @returns {() => Promise<GuestConnection | DaemonConnection>}
 */
export const makeGuestConnect = ({
  formulaId,
  guestSocketPath,
  issue = issueGuestBootstrapPath,
  connectTo = connectToGuestBootstrap,
  connectToRoot = connectToDaemon,
  warn = message => console.warn(message),
}) => {
  return async () => {
    if (guestSocketPath !== undefined) {
      return connectTo({ socketPath: guestSocketPath });
    }
    const where = {
      env: process.env,
      platform: process.platform,
      info: {
        user: os.userInfo().username,
        home: os.homedir(),
        temp: os.tmpdir(),
      },
    };
    // Only a daemon that serves no guest sockets answers `undefined`; any
    // failure rejects instead, so it cannot widen the harness to the host.
    const socketPath = await issue({ formulaId, ...where });
    if (socketPath === undefined) {
      warn(
        `Endo daemon serves no guest sockets; the confined turn for ${formulaId} connects with host authority`,
      );
      return connectToRoot(where);
    }
    return connectTo({ socketPath });
  };
};
harden(makeGuestConnect);

/**
 * Read `claude --version` (for example `2.1.232 (Claude Code)`) under the
 * constructed PATH only.
 *
 * @param {string} claudePath
 * @param {string} pathValue
 * @returns {Promise<string>}
 */
export const readClaudeVersion = (claudePath, pathValue) =>
  new Promise((resolve, reject) => {
    childProcess.execFile(
      claudePath,
      ['--version'],
      { env: { PATH: pathValue }, timeout: 30_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout).trim().split(/\s+/)[0] ?? '');
      },
    );
  });
harden(readClaudeVersion);

/**
 * @param {string} nodePath
 */
const defaultPathValue = nodePath =>
  [...new Set([path.dirname(nodePath), '/usr/bin', '/bin'])].join(':');

/**
 * Run one confined turn against one guest's tools.
 *
 * Throws for a grant or spawn-refusal error (a malformed formula id, a
 * formula that is not a guest, an unreachable daemon, an empty catalog, a
 * `claude` version other than the pinned one, a model outside the pinned set);
 * every per-turn outcome resolves to a tagged InferResult.
 *
 * @param {object} options
 * @param {string} options.formulaId - the guest's 64-hex formula number.
 * @param {string} options.credential - the credential the `apiKeyHelper`
 *   presents.
 * @param {string} options.prompt - delivered on the child's stdin.
 * @param {string} options.model
 * @param {string} options.claudePath - absolute path of the pinned `claude`.
 * @param {string[]} [options.pinnedModels] - defaults to `[model]`.
 * @param {string} [options.pinnedCliVersion]
 * @param {string} [options.guestSocketPath] - a daemon-issued guest socket for
 *   `formulaId` (`EndoBootstrap.guestBootstrapPath`). When absent, the default
 *   `connect` issues one over this process's `ENDO_SOCK` / default socket.
 * @param {() => Promise<GuestConnection | DaemonConnection>} [options.connect]
 *   opens the harness-owned connection; defaults to a session on the guest
 *   socket, which carries no host.
 * @param {string} [options.version] - reported as the MCP server version.
 * @param {string} [options.parentDir]
 * @param {string} [options.nodePath] - the `node` the relay runs under.
 * @param {string} [options.envCommand] - absolute path of `env`.
 * @param {string} [options.pathValue] - the confined child's PATH.
 * @param {{ wallClockMs: number, outputByteCap: number, maxTurns: number }} [options.limits]
 * @param {Promise<unknown>} [options.cancelled]
 * @param {(chunk: Buffer) => void} [options.onStderr] - the confined child's
 *   stderr, for diagnostics.
 * @param {(command: string, args: readonly string[], options: SpawnOptions) => ChildProcess} [options.spawn]
 * @returns {Promise<InferResult>}
 */
export const runConfinedTurn = async ({
  formulaId,
  credential,
  prompt,
  model,
  claudePath,
  pinnedModels = [model],
  pinnedCliVersion = PINNED_CLI_VERSION,
  guestSocketPath,
  connect = makeGuestConnect({ formulaId, guestSocketPath }),
  version = '0.0.0',
  parentDir = os.tmpdir(),
  nodePath = process.execPath,
  envCommand = '/usr/bin/env',
  pathValue = defaultPathValue(nodePath),
  limits,
  cancelled,
  onStderr,
  spawn = childProcess.spawn,
}) => {
  if (typeof claudePath !== 'string' || !path.isAbsolute(claudePath)) {
    throw makeError(X`runConfinedTurn: claudePath must be absolute`);
  }
  if (typeof credential !== 'string' || credential.length === 0) {
    throw makeError(X`runConfinedTurn: credential must be a non-empty string`);
  }

  const turnDir = await fs.mkdtemp(path.join(parentDir, 'endo-claude-turn-'));
  /** @type {GuestConnection | DaemonConnection | undefined} */
  let connection;
  /** @type {{ close: () => Promise<void> } | undefined} */
  let broker;
  try {
    await fs.chmod(turnDir, 0o700);
    const workDir = path.join(turnDir, 'work');
    await fs.mkdir(workDir, { mode: 0o700 });

    connection = await connect();
    const held = connection;
    // A broker, once started, observes `closed`; on a fail-closed path no
    // broker exists, and closing the session below must not surface as an
    // unhandled rejection.
    Promise.resolve(held.closed).catch(() => {});

    // A one-slot pool over the one credential; the session tag routes the
    // acquired credential to the spawn files and nowhere else.
    /** @type {Map<string, string>} */
    const bySession = new Map();
    const pool = harden({
      /** @param {string} sessionTag */
      acquire: async sessionTag => {
        bySession.set(sessionTag, credential);
        return harden({
          type: /** @type {const} */ ('acquired'),
          subscriptionId: 'credential',
          issued: harden({ materialise: async () => credential }),
          release: async () => {
            bySession.delete(sessionTag);
          },
        });
      },
    });

    let tagCount = 0;
    const provider = make(
      {
        connectBroker: async id => {
          const started = await startGuestBroker({
            connection: held,
            formulaId: id,
            version,
            parentDir: turnDir,
            nodePath,
            envCommand,
          });
          broker = started;
          return started;
        },
        pool,
      },
      undefined,
      {
        pinnedModels,
        defaultModel: model,
        pinnedCliVersion,
        getClaudeVersion: () => readClaudeVersion(claudePath, pathValue),
        mintSessionTag: () => {
          tagCount += 1;
          return `${path.basename(turnDir)}-${tagCount}`;
        },
        prepareSpawnFiles: makeSpawnFilesPreparer({
          parentDir: turnDir,
          pathValue,
          credentialFor: async sessionTag => {
            const found = bySession.get(sessionTag);
            if (found === undefined) {
              throw makeError(X`no credential acquired for this spawn`);
            }
            return found;
          },
        }),
        launch: makeLaunch({ spawn, claudePath, cwd: workDir, onStderr }),
        ...(limits === undefined ? {} : { limits }),
      },
    );

    const inference = await E(provider).makeGuestInference(formulaId);
    return await E(inference).infer(prompt, {
      model,
      ...(cancelled === undefined ? {} : { cancelled }),
    });
  } finally {
    await broker?.close();
    connection?.close();
    await fs.rm(turnDir, { recursive: true, force: true });
  }
};
harden(runConfinedTurn);
