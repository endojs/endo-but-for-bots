// @ts-check
//
// The `@endo/claude` harness.
//
//   make(powers, context, options) -> inferenceProvider exo   (host-only, NON-passable)
//     inferenceProvider.makeGuestInference(guestFormulaId) -> Promise<inferExo>
//       inferExo.infer(prompt, { model, cancelled }) -> Promise<InferResult>
//
// The formula id is named ONCE at grant time (Design Decision 4): the per-guest
// `infer` exo closes over the resolved facet's broker and carries NO designator,
// so no holder is a confused deputy over other guests. The provider that mints it
// resolves any id against ambient powers and so is host-only and must never be
// passed to a guest (DD8).
//
// Every I/O boundary — resolving the formula id, taking the tools/list snapshot,
// rendering the per-spawn files, and spawning `claude -p` — is an INJECTED seam,
// so the confinement logic is dependency-injected and property-testable with no
// live `claude` and no daemon (§ Package shape, the test/ note).

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, X, q } from '@endo/errors';

import { assertGuestFormulaId } from './formula-id.js';
import {
  pruneAndPinCatalog,
  deriveAllowList,
  KNOWN_BUILTIN_TOOLS,
} from './tool-permissions.js';
import { buildArgv, assertPinnedVersion, PINNED_CLI_VERSION } from './argv.js';
import { buildChildEnv } from './child-env.js';
import { renderMcpConfig, serializeMcpConfig } from './mcp-config.js';
import { renderApiKeyHelperSettings } from './credentials-pool.js';
import { cancelled as cancelledResult, poolExhausted } from './results.js';

/** @import { McpToolDescriptor } from './tool-permissions.js' */
/** @import { McpTransport } from './mcp-config.js' */
/** @import { InferResult } from './results.js' */
/** @import { AcquireResult } from './credentials-pool.js' */

const InferInterface = M.interface('GuestInference', {
  infer: M.call(M.string())
    .optional(
      M.splitRecord(
        {},
        { model: M.string(), cancelled: M.promise() },
      ),
    )
    .returns(M.promise()),
});

const ProviderInterface = M.interface('ClaudeInferenceProvider', {
  makeGuestInference: M.call(M.string()).returns(M.promise()),
});

/**
 * Attach EXACTLY ONE settle handler to a caller-supplied cancel promise and
 * never re-read its `then` (a caller thenable must not settle twice — double kill
 * / double slot-free — nor drive harness code). DD8: `cancelled` is a one-shot
 * signal.
 *
 * @param {unknown} cancelledP
 */
const makeOneShotCancel = cancelledP => {
  let fired = false;
  if (cancelledP && typeof (/** @type {any} */ (cancelledP).then) === 'function') {
    const settle = () => {
      fired = true;
    };
    // One `.then`; both settle paths mean "cancel requested".
    Promise.resolve(cancelledP).then(settle, settle);
  }
  return harden({
    get fired() {
      return fired;
    },
  });
};

/**
 * @typedef {object} Broker
 *   The harness-owned facet broker for ONE guest. It resolved the formula id and
 *   holds the attenuated facet connection; the raw fd is never inherited into the
 *   claude-spawned tree.
 * @property {() => Promise<McpToolDescriptor[]>} toolsList
 *   Take the one `tools/list` snapshot (raw, pre-prune).
 * @property {() => Promise<McpTransport>} transport
 *   How the confined child reaches this broker's adapter (stdio command / http url).
 * @property {() => Promise<void>} [close]
 */

/**
 * @typedef {object} LaunchSpec
 * @property {readonly string[]} argv
 * @property {Readonly<Record<string, string>>} env
 * @property {string} prompt
 * @property {string} sessionTag
 * @property {{ wallClockMs: number, outputByteCap: number, maxTurns: number }} limits
 * @property {unknown} [cancelled]
 */

/**
 * @typedef {object} HarnessOptions
 * @property {string[]} pinnedModels          Model values that may reach `--model`.
 * @property {string} [defaultModel]          Used when `infer` omits `model` (defaults to pinnedModels[0]).
 * @property {string} [serverName]            MCP server key (default `endo`).
 * @property {string} [pinnedCliVersion]      Default `PINNED_CLI_VERSION`.
 * @property {() => Promise<string>} getClaudeVersion  Reads `claude --version`.
 * @property {() => string} mintSessionTag    Unique per spawn (NOT per guest).
 * @property {(args: { sessionTag: string, mcpConfigJson: string, settingsJson: string }) => Promise<SpawnFiles>} prepareSpawnFiles
 * @property {(spec: LaunchSpec) => Promise<InferResult>} launch
 * @property {{ wallClockMs: number, outputByteCap: number, maxTurns: number }} [limits]
 */

/**
 * @typedef {object} SpawnFiles
 * @property {string} mcpConfigPath
 * @property {string} settingsPath
 * @property {string} apiKeyHelperCommand   Harness-fixed helper argv (emits the acquired credential).
 * @property {string} pathValue             The PATH the child sees (scoped to the shim).
 * @property {() => Promise<void>} cleanup   Unlink the per-spawn files (runs on every exit path).
 */

const DEFAULT_LIMITS = harden({
  wallClockMs: 120_000,
  outputByteCap: 4 * 1024 * 1024,
  maxTurns: 16,
});

/**
 * @param {object} powers
 * @param {(formulaId: string) => Promise<Broker>} powers.connectBroker
 * @param {{ acquire: (sessionTag: string) => Promise<AcquireResult> }} powers.pool
 * @param {unknown} _context
 * @param {HarnessOptions} options
 */
export const make = (powers, _context, options) => {
  const { connectBroker, pool } = powers;
  if (typeof connectBroker !== 'function') {
    throw makeError(X`make: powers.connectBroker must be a function`);
  }
  if (!pool || typeof pool.acquire !== 'function') {
    throw makeError(X`make: powers.pool must expose acquire()`);
  }
  const {
    pinnedModels,
    defaultModel,
    serverName = 'endo',
    pinnedCliVersion = PINNED_CLI_VERSION,
    getClaudeVersion,
    mintSessionTag,
    prepareSpawnFiles,
    launch,
    limits = DEFAULT_LIMITS,
  } = options;

  if (!Array.isArray(pinnedModels) || pinnedModels.length === 0) {
    throw makeError(X`make: options.pinnedModels must be a non-empty array`);
  }
  const modelSet = new Set(pinnedModels);
  const resolvedDefaultModel = defaultModel ?? pinnedModels[0];
  if (!modelSet.has(resolvedDefaultModel)) {
    throw makeError(
      X`make: defaultModel ${q(resolvedDefaultModel)} is not in pinnedModels`,
    );
  }
  for (const seam of [getClaudeVersion, mintSessionTag, prepareSpawnFiles, launch]) {
    if (typeof seam !== 'function') {
      throw makeError(X`make: a required harness seam is missing`);
    }
  }

  /**
   * Validate a caller `model` by MEMBERSHIP in the pinned set (not a charset
   * check): a value like `opus --mcp-config '{...}'` would satisfy a charset
   * check yet inject a server definition when swallowed by an adjacent variadic
   * flag. A model outside the set fails closed.
   *
   * @param {string | undefined} model
   */
  const resolveModel = model => {
    if (model === undefined) return resolvedDefaultModel;
    if (!modelSet.has(model)) {
      throw makeError(
        X`model ${q(model)} is not in the pinned model set; refusing to spawn`,
      );
    }
    return model;
  };

  /**
   * The privileged grant-time step. Resolves the formula id to a facet, stands up
   * the harness-owned broker, takes and prunes the one tools/list snapshot, and
   * returns a per-guest `infer` exo closing over that broker.
   *
   * @param {string} guestFormulaId
   */
  const makeGuestInference = async guestFormulaId => {
    // Grant-time validation errors THROW (DD8): they are deployment errors
    // surfaced before any inference runs.
    const formulaId = assertGuestFormulaId(guestFormulaId);
    const broker = await connectBroker(formulaId);
    const rawCatalog = await E(broker).toolsList();
    const pinnedCatalog = pruneAndPinCatalog(rawCatalog);
    // deriveAllowList throws on an empty post-prune catalog (the zero-tool
    // boundary is a hard error, never a silent confinement pass).
    const allowList = deriveAllowList(pinnedCatalog, serverName);

    const inferExo = makeExo('GuestInference', InferInterface, {
      /**
       * @param {string} prompt
       * @param {{ model?: string, cancelled?: unknown }} [opts]
       * @returns {Promise<InferResult>}
       */
      async infer(prompt, opts = {}) {
        const { model, cancelled } = opts;
        // Membership validation is a harness invariant -> throw on violation.
        const resolvedModel = resolveModel(model);

        const sessionTag = mintSessionTag();
        if (typeof sessionTag !== 'string' || sessionTag.length === 0) {
          throw makeError(X`mintSessionTag must return a non-empty string`);
        }

        const cancelToken = makeOneShotCancel(cancelled);

        // Admission: reject-with-a-tag, never block-and-queue.
        const acquired = await pool.acquire(sessionTag);
        if (acquired.type === 'pool-exhausted') {
          return poolExhausted(acquired.retryAfterMs);
        }

        /** @type {SpawnFiles | undefined} */
        let files;
        try {
          // If cancel already fired before we spawn, settle before-spawn.
          await null; // let the one-shot handler run if `cancelled` is settled.
          if (cancelToken.fired) {
            return cancelledResult('before-spawn');
          }

          // Assert the pinned CLI version at call time: an upgraded `claude` on
          // PATH must fail closed until the live confinement test is re-run.
          assertPinnedVersion(await getClaudeVersion(), pinnedCliVersion);

          const transport = await E(broker).transport();
          const mcpConfig = renderMcpConfig({ serverName, transport });
          const mcpConfigJson = serializeMcpConfig(mcpConfig);

          files = await prepareSpawnFiles({
            sessionTag,
            mcpConfigJson,
            // The settings JSON's sole key is the apiKeyHelper; the helper's argv
            // is harness-fixed and filled in by prepareSpawnFiles, which holds
            // the acquired credential out of the confined child's reach.
            settingsJson: JSON.stringify(
              renderApiKeyHelperSettings(
                // A placeholder the file-preparer replaces with the real helper
                // path; kept non-empty so the render validates.
                'endo-claude-apikey-helper',
              ),
            ),
          });

          const argv = buildArgv({
            mcpConfigPath: files.mcpConfigPath,
            settingsPath: files.settingsPath,
            allowList,
            model: resolvedModel,
            maxTurns: limits.maxTurns,
            disallowedTools: KNOWN_BUILTIN_TOOLS,
          });

          const env = buildChildEnv({
            pathValue: files.pathValue,
            sessionTag,
          });

          // The launch seam owns the spawn, the three bounds, stream-json
          // parsing, and mid-stream / after-exit cancellation; it returns a
          // tagged InferResult and never rejects for a per-call outcome.
          const result = await launch({
            argv,
            env,
            prompt,
            sessionTag,
            limits,
            cancelled,
          });
          return result;
        } finally {
          // Return-to-pool and file cleanup run on EVERY exit path: clean
          // success, non-zero exit, parse failure, cancel, or a thrown invariant.
          await acquired.release({ failed: true });
          if (files !== undefined) {
            try {
              await files.cleanup();
            } catch {
              // best-effort; a cleanup failure must not mask the outcome.
            }
          }
        }
      },
    });
    return inferExo;
  };

  // Host-only, NON-passable: this provider resolves ANY formula id against
  // ambient daemon powers (the confused-deputy shape DD4 removes at the leaf), so
  // it must never be handed to a guest. Only the per-guest `infer` exo it mints
  // crosses to a guest.
  return makeExo('ClaudeInferenceProvider', ProviderInterface, {
    makeGuestInference,
  });
};
harden(make);
