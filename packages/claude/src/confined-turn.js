// @ts-check
/* global process */
// spell-out-exempt: `temp` is the @endo/where platform-info field name.
//
// The confined shape end to end (designs/endo-guest-stdio-mcp.md § How the
// confinement properties change, shape 1; designs/endo-claude.md):
//
//   runConfinedTurn({ formulaId, credential, prompt, model, claudePath })
//
//   harness process (this module)             confined `claude -p --bare`
//   ─────────────────────────────             ───────────────────────────
//   daemon connection (makeEndoClient)        env: PATH, LANG, LC_ALL,
//   └ lookupById(formulaId) → one guest            ENDO_CLAUDE_SESSION_TAG only
//   broker: that guest's static catalog  ◄──  relay (env -i node relay.mjs)
//   on a 0600 socket in a 0700 dir              stdio ⇄ broker socket
//
// The daemon connection, its socket path, and the formula id stay in the
// harness process. The confined tree is given only the broker socket (pinned
// to the one guest) inside its MCP config, and the credential only through the
// `apiKeyHelper`. The relay is spawned with an empty environment, so nothing
// `claude` holds in its own environment reaches it.
//
// With `sandbox`, `claude` runs inside the `bwrap` slice of `bwrap-slice.js`,
// which binds the broker directory and that spawn's files directory, supplies
// a scratch HOME, and leaves the daemon socket without a path. The caller must
// choose: `sandbox: false` leaves the confinement to the harness-side shape
// alone, and omitting `sandbox` is an error, so the slice is never dropped
// silently.

import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { makeError, X } from '@endo/errors';
import {
  connectToDaemon,
  startGuestBroker,
  RELAY_PATH,
} from '@endo/agent-mcp-stdio';

import { make } from './harness.js';
import { makeLaunch } from './launch.js';
import { makeSpawnFilesPreparer } from './spawn-files.js';
import { makeBwrapSpawn, resolveSystemMounts } from './bwrap-slice.js';
import { PINNED_CLI_VERSION } from './argv.js';

/** @import { SpawnOptions, ChildProcess } from 'node:child_process' */
/** @import { InferResult } from './claude.types.js' */
/** @import { DaemonConnection } from '@endo/agent-mcp-stdio' */
/** @import { SliceMount } from './claude.types.js' */

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
 * @param {() => Promise<DaemonConnection>} [options.connect] - opens the
 *   harness-owned daemon connection; defaults to the ordinary Endo client over
 *   this process's `ENDO_SOCK` / default socket.
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
 * @param {{ bwrapPath: string, home?: string, systemMounts?: ReadonlyArray<SliceMount> } | false} options.sandbox
 *   - required: run `claude` inside the `bwrap` slice, where `bwrapPath` is
 *   absolute, `home` is the scratch HOME inside it, and `systemMounts`
 *   defaults to this host's `resolveSystemMounts()`; or `false` to run
 *   `claude` unconfined, which only a prompt no guest can influence may use.
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
  connect = () =>
    connectToDaemon({
      env: process.env,
      platform: process.platform,
      info: {
        user: os.userInfo().username,
        home: os.homedir(),
        temp: os.tmpdir(),
      },
    }),
  version = '0.0.0',
  parentDir = os.tmpdir(),
  nodePath = process.execPath,
  envCommand = '/usr/bin/env',
  pathValue = defaultPathValue(nodePath),
  limits,
  cancelled,
  onStderr,
  spawn = childProcess.spawn,
  sandbox,
}) => {
  if (typeof claudePath !== 'string' || !path.isAbsolute(claudePath)) {
    throw makeError(X`runConfinedTurn: claudePath must be absolute`);
  }
  if (sandbox !== false && typeof sandbox?.bwrapPath !== 'string') {
    throw makeError(
      X`runConfinedTurn: sandbox must be { bwrapPath } or an explicit false`,
    );
  }
  if (typeof credential !== 'string' || credential.length === 0) {
    throw makeError(X`runConfinedTurn: credential must be a non-empty string`);
  }

  const turnDir = await fs.mkdtemp(path.join(parentDir, 'endo-claude-turn-'));
  /** @type {DaemonConnection | undefined} */
  let connection;
  /** @type {{ socketPath: string, close: () => Promise<void> } | undefined} */
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

    const prepareSpawnFiles = makeSpawnFilesPreparer({
      parentDir: turnDir,
      pathValue,
      credentialFor: async sessionTag => {
        const found = bySession.get(sessionTag);
        if (found === undefined) {
          throw makeError(X`no credential acquired for this spawn`);
        }
        return found;
      },
    });

    const unsandboxedLaunch = makeLaunch({
      spawn,
      claudePath,
      cwd: workDir,
      onStderr,
    });
    /** @type {ReturnType<typeof makeLaunch>} */
    let launch = unsandboxedLaunch;
    if (sandbox !== false) {
      const systemMounts =
        sandbox.systemMounts ?? (await resolveSystemMounts());
      // Inside the slice `claude` is run by its real path, so a symlinked
      // install (`/usr/local/bin/claude -> .../cli.js`) still resolves its
      // siblings from the installation directory it is granted. Only a
      // package directory (one holding `package.json`) is granted whole; a
      // binary in a shared directory such as `/usr/local/bin` is granted alone.
      // Narrower grants are not viable: the package loads modules, vendored
      // binaries, and WebAssembly lazily by paths only known at run time, and
      // that set changes between `claude` releases. The grant is read-only and
      // holds only the package's own files, none of the daemon's state.
      const realClaudePath = await fs.realpath(claudePath);
      const claudeDirectory = path.dirname(realClaudePath);
      const isPackageDirectory = await fs
        .access(path.join(claudeDirectory, 'package.json'))
        .then(
          () => true,
          () => false,
        );
      const claudeGrant = isPackageDirectory ? claudeDirectory : realClaudePath;
      const toolPaths = [claudeGrant, nodePath, envCommand];
      launch = async spec => {
        // The spawn files (`--settings`, `--mcp-config`) share one directory.
        const settingsIndex = spec.argv.indexOf('--settings');
        const settingsPath =
          settingsIndex < 0 ? undefined : spec.argv[settingsIndex + 1];
        if (broker === undefined || settingsPath === undefined) {
          throw makeError(X`sandbox: no broker or spawn files for this spawn`);
        }
        return makeLaunch({
          spawn: makeBwrapSpawn({
            spawn,
            bwrapPath: sandbox.bwrapPath,
            systemMounts,
            readOnlyPaths: [
              ...toolPaths,
              RELAY_PATH,
              path.dirname(broker.socketPath),
              path.dirname(settingsPath),
            ],
            writablePaths: [workDir],
            home: sandbox.home,
          }),
          claudePath: realClaudePath,
          cwd: workDir,
          onStderr,
        })(spec);
      };
    }

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
        prepareSpawnFiles,
        launch,
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
