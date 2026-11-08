// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop */

// Fae durable streaming sessions for the Endo daemon.
//
// Sessions own their turns on the daemon. Clients observe reply streams
// and may attach presentation capabilities when constructing the factory.
//
// Per-session conversation history lives in the private turn journal, and a single
// pinned factory caplet revives every session on daemon restart.

import { execFile } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';
import { promisify } from 'node:util';

import { Fail } from '@endo/errors';

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import {
  assertSubscriptionResponsesRecipe,
  assertSubscriptionMessagesRecipe,
  planContextCompaction,
  summarizeContext,
} from '@endo/lal/providers/index.js';
import { addUsage, projectUsage } from '@endo/hosted-agent/token-usage.js';
import {
  decodeImageResult,
  imageResultText,
} from '@endo/hosted-agent/image-result.js';
import { DEFAULT_MAX_TOOL_ROUNDS, runAgenticTurn } from './src/turn-engine.js';
import {
  SubagentSpawnerInterface,
  assertSubagentCapabilities,
  assertSubagentName,
  composeSubagentSystemPrompt,
  isSameFormula,
  makeSubagentDelegations,
  DEFAULT_SUBAGENT_LIMITS,
} from './src/subagent.js';
import { widgetPrompt } from './src/widget-prompt.js';

import { makeSubagentAdmission } from './session/subagent-admission.js';
import { makeFactoryOwnership } from './session/factory-ownership.js';
import { readContextTranscript } from './session/context-transcript.js';
import { discoverAccounts } from './session/account-discovery.js';
import { readSessionAccounts } from './session/session-account.js';
import { assertRuntimeConfig } from './session/runtime-config.js';
import {
  assertSessionIdentity,
  isHostedSession,
  providerModelId,
} from './session/session-identity.js';
import { makeSessionRecords } from './session/session-records.js';
import { makePublishTool } from './session/publish-tool.js';
import {
  DEVELOPMENT_BACKENDS,
  DEVELOPMENT_NETWORK_POLICIES,
  environmentPolicies,
  lookupEnvironmentAdmin,
  environmentAdminName,
  provideDevelopmentEnvironment,
  makeDevelopmentTools,
} from './session/development-environment.js';
import { makeProviderConnections } from './session/provider-connections.js';
import { makeSessionTurnSlot } from './session/session-turn-slot.js';
import {
  makeSessionListWatch,
  makeSessionWatch,
} from './session/session-watch.js';
import { makeAccountsWatch } from './session/account-watch.js';
import { recoverUndispatchedTurns } from './session/recover-undispatched.js';
import { makePendingQueue } from './session/pending-queue.js';
import {
  sessionStoragePath,
  prepareSessionStorage,
  makeSessionQueueStorage,
} from './session/session-storage-layout.js';
import {
  validateChatMessage,
  chatMessageText,
} from './session/session-mentions.js';
import { makeSessionAttachments } from './session/session-attachments.js';
import { makeSessionSubmissions } from './session/session-submissions.js';
import {
  PROVIDER_PROMPT_ENVIRONMENT,
  composePresetPrompt,
  normalizePromptContext,
} from './session/system-prompt.js';
import { makeFlootToolRegistry } from './session/tool-registry.js';
import { toolOperationId } from './session/turn-evidence.js';
import { makeTurnJournal } from './session/turn-journal.js';
import {
  projectTranscript,
  transcriptToProviderMessages,
} from './session/transcript-projection.js';
import {
  createPrivateTurnStorage,
  providePrivateTurnStorage,
  providePrivateNetworkStorage,
  retirePrivateTurnStorage,
} from './session/private-turn-storage.js';
import { makeSessionNetworkPolicy } from './session/network-policy.js';
import {
  boundToolOutput,
  MAX_TOOL_OUTPUT_CHARS,
} from './session/tool-output.js';
import { makeContainerMountRegistrar } from './session/container-mounts.js';
import { DEFAULT_TRANSCRIPT_LIMITS } from './session/journal-transcript.js';
import { readFlootWorkloadConfig } from './session/workload-config.js';
import {
  BUILTIN_PRESETS,
  makePresetCatalog,
  sessionPreset,
  presetHasShell,
  withSessionNetwork,
} from './session/preset-catalog.js';

// Direct-provider turns share Fae's finite runaway-loop guard. A round is one
// model response and all of its tool results, not one individual tool call.
// `FLOOT_MAX_TOOL_ROUNDS` overrides the default per deployment. Hosted CLI
// backends run their own loops and never reach this guard.
const AGENT_SHUTDOWN_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);

const withTimeout = async (operation, label) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Error(`${label} timed out`)),
      AGENT_SHUTDOWN_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

// Initialize a fresh, empty directory as a git repository so a daemon git cap
// can be derived from it: provideGit requires an existing worktree, but a new
// scratch mount is just an empty dir. The exo git backend supplies its own
// author identity for the commits it makes; we only pin signing off here (so
// creation doesn't depend on a user-global commit.gpgSign) and seed an empty
// initial commit so the repo has a HEAD on the default branch.
const initGitRepo = async repoRoot => {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  await execFileAsync('git', ['config', '--local', 'commit.gpgsign', 'false'], {
    cwd: repoRoot,
  });
  await execFileAsync('git', ['config', '--local', 'tag.gpgsign', 'false'], {
    cwd: repoRoot,
  });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.email=floot@endo',
      '-c',
      'user.name=Floot',
      'commit',
      '--allow-empty',
      '-m',
      'Initialize workspace',
    ],
    { cwd: repoRoot },
  );
};

/**
 * A writer (same shape as makeReplyChannel's) that buffers a turn's output
 * instead of streaming it, resolving `done` with the final text once the turn
 * ends. Used for inbox/mail turns, whose reply is sent as one buffered message
 * rather than streamed token-by-token.
 *
 * @returns {{ writer: object, done: Promise<{ ok: boolean, text?: string, error?: string }> }}
 */
const makeBufferingWriter = () => {
  let text = '';
  /** @type {(result: { ok: boolean, text?: string, error?: string }) => void} */
  let settle = () => {};
  const done = new Promise(resolve => {
    settle = resolve;
  });
  const writer = harden({
    setPhase: () => {},
    /** @param {string} t */
    delta: t => {
      text += t;
    },
    /** @param {string} t */
    final: t => {
      text = `${t}`;
    },
    toolCall: () => {},
    toolResult: () => {},
    usage: () => {},
    end: () => settle({ ok: true, text }),
    /** @param {unknown} reason */
    abort: reason => settle({ ok: false, error: `${reason}` }),
  });
  return { writer, done };
};

const factoryGuards = harden({
  createSession: M.callWhen(M.record()).returns(M.remotable()),
  getPresetConfiguration: M.callWhen().returns(M.record()),
  savePreset: M.callWhen(M.record(), M.string()).returns(M.record()),
  deletePreset: M.callWhen(M.string(), M.string()).returns(M.record()),
  resetPreset: M.callWhen(M.string(), M.string()).returns(M.record()),
  listSessions: M.callWhen().returns(M.arrayOf(M.record())),
  watchSessions: M.callWhen().returns(M.remotable()),
  watchAccounts: M.callWhen().returns(M.remotable()),
  refreshAccounts: M.callWhen().returns(M.undefined()),
  redeemAccountReset: M.callWhen(M.string())
    .optional(M.splitRecord({}, { creditId: M.string(), replay: M.boolean() }))
    .returns(M.record()),
  abandonAccountReset: M.callWhen(M.string()).returns(M.record()),
  listPresets: M.callWhen().returns(M.arrayOf(M.record())),
  listBackends: M.callWhen().returns(M.arrayOf(M.record())),
  listModels: M.callWhen().optional(M.string()).returns(M.arrayOf(M.record())),
  listModelCatalogs: M.callWhen().returns(M.arrayOf(M.record())),
  getSession: M.callWhen(M.string()).returns(M.remotable()),
  renameSession: M.callWhen(M.string(), M.string()).returns(M.undefined()),
  setSessionUserInitiated: M.callWhen(M.string(), M.boolean()).returns(
    M.undefined(),
  ),
  deleteSession: M.callWhen(M.string()).returns(M.undefined()),
  retireCliSession: M.callWhen(
    M.splitRecord({
      id: M.string(),
      backendId: M.string(),
      parentSessionId: M.string(),
      createdAt: M.number(),
    }),
  ).returns(M.undefined()),
  refreshCredentials: M.callWhen().returns(M.undefined()),
  getAccount: M.callWhen().optional(M.boolean()).returns(M.record()),
  getAccountOracle: M.callWhen().returns(M.remotable()),
  help: M.call().optional(M.string()).returns(M.string()),
});

const MESSAGE_LIMITS = harden({ stringLengthLimit: 100_000_000 });

// The session facet handed to the UI. `startTurn` is synchronous (it hands back
// the turn immediately, before the turn runs), so it is guarded with `M.call`;
// the rest are async (`M.callWhen`). Guards are permissive — the daemon path is
// not runtime-tested here.
const FlootSessionInterface = M.interface('FlootSession', {
  getInfo: M.callWhen().returns(M.record()),
  getExecutionState: M.callWhen().returns(M.record()),
  // Admission must close on delivery, not after callWhen's argument await.
  emergencyStop: M.call().returns(M.promise()),
  resume: M.callWhen().returns(M.record()),
  startTurn: M.call(M.any()).returns(M.remotable()),
  getCurrentTurn: M.callWhen().returns(M.or(M.null(), M.record())),
  watch: M.callWhen().returns(M.remotable()),
  watchRecent: M.callWhen().returns(M.remotable()),
  getHistoryPage: M.callWhen().optional(M.string()).returns(M.record()),
  // A message is whatever a person pasted; the default 100k-character limit
  // on a guarded string would refuse a long log. `startTurn` has none either.
  enqueue: M.callWhen(M.string(MESSAGE_LIMITS)).returns(M.record()),
  enqueueOnce: M.callWhen(M.string(MESSAGE_LIMITS), M.string()).returns(
    M.record(),
  ),
  enqueueMessageOnce: M.callWhen(
    M.record(),
    M.string(),
    M.arrayOf(M.record()),
  ).returns(M.record()),
  getSubmissionReceipt: M.callWhen(
    M.string(MESSAGE_LIMITS),
    M.string(),
    M.arrayOf(M.record()),
  )
    .optional(M.record())
    .returns(M.or(M.null(), M.record())),
  listPending: M.callWhen().returns(M.record()),
  editPending: M.callWhen(M.string(), M.string(MESSAGE_LIMITS)).returns(
    M.undefined(),
  ),
  cancelPending: M.callWhen(M.string()).returns(M.boolean()),
  sendPending: M.callWhen(M.string()).returns(M.undefined()),
  getHistory: M.callWhen().returns(M.any()),
  getTranscript: M.callWhen().returns(M.any()),
  getTurns: M.callWhen().returns(M.any()),
  getArchivedTurns: M.callWhen().returns(M.any()),
  getArchivedTurnsPage: M.callWhen().optional(M.string()).returns(M.record()),
  getTurnContent: M.callWhen(M.record()).returns(
    M.string({ stringLengthLimit: 0x7fff_ffff }),
  ),
  getJournalStatus: M.callWhen().returns(M.any()),
  getNetworkPolicy: M.callWhen().returns(M.any()),
  setNetworkPolicy: M.callWhen(M.string()).returns(M.any()),
  resolveNetworkPolicyRequest: M.callWhen(
    M.string(),
    M.boolean(),
    M.string(),
  ).returns(M.any()),
  resolveTurn: M.callWhen(M.string(), M.string()).returns(M.undefined()),
  getUsage: M.callWhen().returns(M.any()),
  getAccount: M.callWhen().optional(M.boolean()).returns(M.record()),
  help: M.call().optional(M.string()).returns(M.string()),
});

// The prompts themselves are composed in src/system-prompt.js from a standard
// base plus sections chosen by how a session is driven, where its model runs,
// and its preset.

// Catalog of session presets. Each preset declares a set of
// objects to provision (idempotently) into the session guest's petstore the
// first time the session's agent is built. Provisioned objects are referenced
// by the session guest. The development environment additionally keeps its
// private admin rooted on the factory host for explicit native storage cleanup.
// How many distinct serving models one turn records; a router rarely uses
// more than a handful, and the record is for reading.
const MAX_SERVED_BY = 16;
const DEFAULT_PRESET_ID = 'general';
export const getPreset = id =>
  BUILTIN_PRESETS.find(p => p.id === id) ||
  /** @type {(typeof BUILTIN_PRESETS)[number]} */ (
    BUILTIN_PRESETS.find(p => p.id === DEFAULT_PRESET_ID)
  );
harden(getPreset);

// The models selectable for a new session are what each backend's accounts
// list now, read from the provider: the direct provider's under Floot's own
// credential (`getProviderCatalog`), a subscription's from its broker
// (`modelCatalog`). Nothing here names a model. A session that does not pin
// one follows the factory's configured default model (the `model` in the
// `llm-provider` config, or the provider's own fallback).

// Provisioning the RSI shell allocates native state. Check its review grants
// before creating a session, including when a saved voice preset selects RSI.
const hasRsiGrants = async host => {
  const grants = await Promise.all([
    E(host).has('rsi-pull-requests'),
    E(host).has('rsi-review-deploy'),
  ]);
  return grants.every(Boolean);
};

/**
 * Provision the preset's public objects into the session guest's petstore.
 * Development environments additionally retain a private admin on the factory
 * host: their native storage requires manual disposal, not automatic GC.
 * Idempotent publication is checked again on every revival.
 *
 * @param {any} host - the factory's own host powers
 * @param {string[]} agentName - petname (in the host) of the session's guest agent
 * @param {any} sessionGuest - the resolved guest facet (for `has` checks)
 * @param {string} id - session id (used to namespace temporary host petnames)
 * @param {Array<{ kind: string, petName: string, required?: boolean, grantName?: string }>} objects
 * @param {string} [codePath] - absolute host path to the Endo codebase, for the
 *   `code-mount` object kind (read-only). Absent when the daemon host has no
 *   source on disk; such objects are then skipped.
 * @param {string} [networkPolicy] Recorded development environment policy.
 * @param {{ shellTimeoutMs: number, shellOutputBytes: number }} [shellLimits]
 */
const provisionPresetObjects = async (
  host,
  agentName,
  sessionGuest,
  id,
  objects,
  codePath,
  networkPolicy = 'off',
  shellLimits = undefined,
) => {
  for (const obj of objects) {
    const alreadyPresent = await E(sessionGuest).has(obj.petName);
    if (obj.kind === 'rsi-forge') {
      if (!(await E(host).has('rsi-pull-requests')))
        throw Error('RSI requires the Tokyo Forgejo proposal capability');
      await E(host).copy(['rsi-pull-requests'], [...agentName, obj.petName]);
    } else if (obj.kind === 'nixos-admin' || obj.kind === 'workflow-factory') {
      // Copy a grant the setup script stored on this factory host
      // (machine-admin-setup.js) into the guest's petstore: the NixOS
      // machine-admin caplet, or a deploy-workflow connection — a
      // formula-backed, proposal-only facade over one factory
      // (deploy-connection.js), whose `start` returns a run id and whose
      // observation is scoped to that factory's runs. Unlike the other
      // kinds this one is re-copied on every revival: `copy` overwrites, and
      // the setup re-creates the connection caplet each boot, so a revived
      // session follows the grant's current identity. The grant is absent
      // (or retracted) on a daemon without the NixOS controller or the
      // workflow service: a copy the session already holds is kept, a
      // required object with no copy fails session creation loudly, and an
      // optional one is skipped so the session opens without that authority.
      const grantName = obj.grantName || obj.petName;
      if (await E(host).has(grantName)) {
        await E(host).copy([grantName], [...agentName, obj.petName]);
      } else if (alreadyPresent) {
        // Keep the copy: its provider may return, and dropping it would
        // silently narrow a session that already opened with it.
      } else if (obj.required !== false) {
        throw Error(
          `Required preset object "${obj.petName}" needs grant "${grantName}", which this factory host does not hold`,
        );
      } else {
        console.warn(
          `[floot-factory] optional grant "${grantName}" is unavailable; skipping "${obj.petName}" for session ${id}`,
        );
      }
    } else if (obj.kind === 'development-environment') {
      await provideDevelopmentEnvironment({
        host,
        guest: sessionGuest,
        agentName,
        id,
        networkPolicy,
        mountWorkspace: objects.some(item => item.kind === 'git-workspace'),
        ...shellLimits,
      });
    } else if (alreadyPresent) {
      // Idempotent: a revived session already has its provisioned objects.
    } else if (obj.kind === 'git-workspace') {
      // Mint a daemon-managed scratch mount, derive a git cap over it, then move
      // the git cap into the guest's petstore and drop the host-side scratch
      // petname. The git formula keeps the mount alive by reference (daemon GC:
      // git depends on its mount), so the only petstore reference left is the
      // guest's — deleting the session reaps the whole chain (and the scratch
      // dir on disk). Temporary host petnames are namespaced by session id and
      // cleared first in case a prior attempt aborted mid-way.
      const scratchTmp = sessionStoragePath(id, 'scratch-temp');
      const gitTmp = sessionStoragePath(id, 'git-temp');
      for (const tmp of [gitTmp, scratchTmp]) {
        if (await E(host).has(...tmp)) await E(host).remove(...tmp);
      }
      const mount = await E(host).provideScratchMount(scratchTmp);
      // provideGit requires an existing worktree, but a fresh scratch mount is
      // an empty dir — git-init it first. The factory is an unconfined,
      // fully-privileged host caplet, so resolving the host path and running
      // git here is in-bounds; that path never reaches the session guest or the
      // UI (they only ever receive the derived git cap, not its filesystem
      // location).
      const repoRoot = await E(host).provideHostPath(mount);
      await initGitRepo(repoRoot);
      await E(host).provideGit(mount, gitTmp);
      await E(host).move(gitTmp, [...agentName, obj.petName]);
      await E(host).remove(...scratchTmp);
    } else if (obj.kind === 'host-powers') {
      // Copy the factory's own host agent (@agent — the full host powers, not
      // the weaker @self handle) into the guest's petstore, granting the
      // session full daemon control. The host outlives every session, so this
      // only adds a name in the guest; deleting the session drops that name and
      // reaps nothing else.
      await E(host).copy(['@agent'], [...agentName, obj.petName]);
    } else if (obj.kind === 'code-mount') {
      // Mount the Endo codebase read-only so the session can read the source it
      // runs inside. Skip silently when no path was configured (the daemon host
      // may not have the source on disk). The mount points at an EXISTING
      // external directory — unlike a scratch mount it does not own that dir, so
      // GC of the formula when the session is deleted never touches the source.
      // Provide into a session-scoped temp host name (cleared first in case a
      // prior attempt aborted), then move it into the guest's petstore so the
      // guest is the only reference.
      if (!codePath) {
        if (obj.required !== false) {
          throw Error(
            `No code path is configured for required preset object "${obj.petName}"`,
          );
        }
        console.warn(
          `[floot-factory] optional code mount "${obj.petName}" is unavailable for session ${id}`,
        );
      } else {
        const mountTmp = sessionStoragePath(id, 'code-mount-temp');
        if (await E(host).has(...mountTmp)) await E(host).remove(...mountTmp);
        await E(host).provideMount(codePath, mountTmp, { readOnly: true });
        await E(host).move(mountTmp, [...agentName, obj.petName]);
      }
    } else {
      throw Error(`Unknown required preset object kind "${obj.kind}"`);
    }
  }
};

/** Active turns remain on their live stream until settlement publication. */
const activeJournalTurns = new WeakMap();

/**
 * Build a streaming agent over a guest's powers. The returned object exposes
 * `converse(input, writer)`, which journals dialogue and tool evidence, streams the
 * model's reply through `writer` (src/stream.js), and persists the assistant
 * turn so subsequent calls keep context.
 *
 * The user message (`input`) is streamable too: it may be a plain string, or a
 * Far reader yielding transcript-style events (the same wire the audio caplet's
 * `transcribe` emits — `{type:'partial'|'final', text}` with replace semantics,
 * terminated by `end`/`abort`). Either way the message is fully assembled before
 * the LLM call, since Anthropic/Claude need a complete user turn — but the
 * interface accepts the stream now so callers (and a future streaming backend)
 * need not change. This lets the voice Space pipe transcribe()'s reader straight
 * into converse().
 *
 * Unlike fae's `spawnWorkerLoop`, this does NOT follow the inbox; it is driven
 * by direct method calls (the caller owns the loop), which is what lets the
 * reply stream straight back to that caller over CapTP.
 *
 * @param {any} powers - Guest powers (petstore for conversation history)
 * @param {Promise<object> | object | undefined} _context
 * @param {import('./session/runtime-config.js').RuntimeConfig} runtime
 * @param {string} [systemPrompt]
 * @param {object} [options]
 * @param {any} [options.spawner] - A `SubagentSpawner` capability. Absent for a
 *   session at the delegation bound, which withholds the subagent tools.
 * @param {(refresh?: boolean) => Promise<any>} [options.readAccounts] - Current
 *   explicitly published configured accounts; no reset authority.
 * @param {string} [options.modelId] - The model this session runs.
 * @param {string} [options.backendId] - Durable backend selection.
 * @param {string} [options.reasoningEffort] - Pinned reasoning selection.
 * @param {ReturnType<typeof makeSessionAttachments>} [options.attachments] - Private mailbox delivery for structured UI turns.
 * @param {ReturnType<typeof makeTurnJournal>} [options.journal] Shared serialized journal of the session owner.
 * @param {any} options.journalPowers - Explicit journal storage. The caller must
 *   supply private storage not exposed to the session guest. Capability identity
 *   alone does not establish that confinement.
 * @param {number} [options.maxToolRounds] - Provider calls one turn may make
 * @param {typeof DEFAULT_TRANSCRIPT_LIMITS} [options.transcriptLimits] Operator admission budgets.
 * @param {typeof DEFAULT_SUBAGENT_LIMITS} [options.subagentLimits] Operator delegation budgets.
 *   before the tool-step fallback. Defaults to `DEFAULT_MAX_TOOL_ROUNDS`.
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [options.timers]
 * @param {Map<string, any>} [options.extraTools] - Session-specific tools
 *   the factory built (see `makeFlootToolRegistry`).
 * @param {number} [options.contextLength] Exact selected-model catalog reading.
 * @param {boolean} [options.forceCompaction] Acceptance-only trigger.
 * @param {() => Promise<void>} [options.stopEnvironment] Private execution stop barrier, distinct from inference cancellation.
 * @param {(kind: 'turn-started' | 'turn-settled' | 'turn-resolved', detail?: { input: string, from?: string }) => void} [options.onChange]
 *   Told when this session's turn records change, whoever started the turn —
 *   the UI, the mailbox, a queued submission. It is how a view learns that the
 *   transcript moved without asking again on a timer. `turn-started` carries
 *   the turn's input and, for a mail turn, who sent it.
 * @returns {Promise<{
 *   converse: (
 *     input: string | object,
 *     writer: object,
 *     meta?: object,
 *     signal?: AbortSignal,
 *     onStart?: (history: Array<Record<string, any>>) => void,
 *     onBegun?: () => Promise<void>,
 *     references?: import('./session/session-mentions.js').SessionMention[],
 *   ) => Promise<void>,
 *   getHistory: () => Promise<Array<Record<string, any>>>,
 *   getSettledHistory: () => Promise<Array<Record<string, any>>>,
 *   getActivity: () => Promise<{ active: boolean, lastTurnState: string, needsRecovery: boolean }>,
 *   getTranscript: () => Promise<Array<Record<string, any>>>,
 *   getTurns: () => Promise<Array<Record<string, any>>>,
 *   getArchivedTurns: () => Promise<Array<Record<string, any>>>,
 *   getArchivedTurnsPage: (cursor?: string) => Promise<{records: any[], next: string | null}>,
 *   getTurnContent: (ref: { name: string, chars: number }) => Promise<string>,
 *   getJournalStatus: () => Promise<Record<string, any>>,
 *   resolveTurn: (turnId: string, note: string) => Promise<void>,
 *   getUsage: () => Promise<import('@endo/hosted-agent/token-usage.js').TokenUsage & { turns: number, incompleteTurns: number }>,
 *   startInbox: () => void,
 *   assertIdleForReplacement: () => void,
 *   stopForReplacement: () => Promise<void>,
 *   shutdown: (allowBackendQuarantine?: boolean) => Promise<void>,
 * }>}
 */
export const makeStreamingAgent = async (
  powers,
  _context,
  runtime,
  systemPrompt,
  {
    spawner,
    readAccounts,
    modelId,
    backendId,
    reasoningEffort,
    timers,
    maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
    transcriptLimits = DEFAULT_TRANSCRIPT_LIMITS,
    subagentLimits = DEFAULT_SUBAGENT_LIMITS,
    extraTools,
    contextLength,
    forceCompaction = false,
    stopEnvironment,
    journalPowers,
    journal,
    attachments,
    onChange,
  } = { journalPowers: undefined },
) => {
  assertRuntimeConfig(runtime);
  if (journalPowers === undefined || journalPowers === null) {
    throw Error('Explicit journalPowers storage is required');
  }
  const runtimeKind = runtime.kind;
  const provideProvider =
    runtime.kind === 'provider' ? runtime.provideProvider : undefined;
  const recordsOnly = runtimeKind === 'records-only';
  // No implicit migration: reject legacy branches before recovery or backend startup.
  const existingNames = await E(powers).list();
  if (
    existingNames.some(
      name => typeof name === 'string' && name.startsWith('ct-'),
    )
  ) {
    throw Error(
      'Legacy Floot conversation tree requires retirement or export before journal-only recovery',
    );
  }
  /**
   * @param {'turn-started' | 'turn-settled' | 'turn-resolved'} kind
   * @param {{ input: string, from?: string }} [detail]
   */
  const notifyChange = (kind, detail) => {
    if (!onChange) return;
    try {
      onChange(kind, detail);
    } catch (error) {
      // An observer must never be able to fail a turn.
      console.error('[floot-agent] change observer failed:', error);
    }
  };
  /**
   * The provider this turn runs on.
   *
   * Resolved per turn rather than captured at construction: a provider pins the
   * auth token as of the moment it was built, so a session holding one would go
   * on using a rotated — or revoked — credential until the daemon restarted.
   * `refreshCredentials()` drops the factory's cache, and the next turn asks
   * for it again.
   */
  const currentProvider = async () => {
    if (!provideProvider) throw Error('This runtime is not a direct provider');
    return provideProvider();
  };

  // An agent built with no prompt at all was not opened by the Floot space,
  // so nothing reads its replies aloud.
  const effectivePrompt =
    systemPrompt || composePresetPrompt({ presetId: 'general' });
  const turnJournal =
    journal ?? makeTurnJournal(journalPowers, transcriptLimits);
  // Validate persisted evidence before installing a backend or starting inbox work.
  if (runtime.kind === 'records-only') await turnJournal.list();
  else await recoverUndispatchedTurns(turnJournal);
  let activeJournalTurn;
  let completedJournalTurn;
  let activeJournalUsage;
  // The models that served the active turn's rounds, as a provider that
  // routes (OpenRouter) reports them. Recorded with the turn's finish, so a
  // failed turn says which upstream it failed on.
  /** @type {string[]} */
  let activeJournalServedBy = [];
  const assertTurnToolsSettled = async turnId => {
    const turn = await turnJournal.get(turnId);
    if ([...turn.tools, ...turn.activity].some(tool => !tool.settled)) {
      throw Error(
        'Tool outcome unknown; backend completion did not settle every tool call',
      );
    }
  };
  const executingTools = new Set();
  const executeTracked = async operation => {
    const pending = Promise.resolve().then(operation);
    executingTools.add(pending);
    try {
      return await pending;
    } finally {
      executingTools.delete(pending);
    }
  };
  /**
   * Record intent before giving a tool authority and its result or error
   * before returning to the model.
   *
   * @param {{ turnId: string, callId: string, name: string, args: unknown, run: () => unknown }} call
   * @returns {Promise<{ result: unknown } | { error: unknown }>}
   */
  const journaledToolCall = async ({ turnId, callId, name, args, run }) => {
    await turnJournal.append(turnId, {
      type: 'tool-intent',
      callId,
      name: `${name}`,
      args: JSON.stringify(args),
    });
    /** @type {{ result: unknown } | { error: unknown }} */
    let outcome;
    try {
      outcome = { result: boundToolOutput(`${await executeTracked(run)}`) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const bounded = boundToolOutput(
        message,
        MAX_TOOL_OUTPUT_CHARS - 'Error: '.length,
      );
      outcome = { error: bounded === message ? error : Error(bounded) };
    }
    await turnJournal.append(turnId, {
      type: 'tool-result',
      callId,
      failed: 'error' in outcome,
      result:
        'error' in outcome
          ? `Error: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`
          : `${outcome.result}`,
    });
    return outcome;
  };
  const servedByOfTurn = () =>
    activeJournalServedBy.length > 0
      ? { servedBy: harden([...activeJournalServedBy]) }
      : {};

  // Delegation state is per session and lives beside the inbox loop that feeds
  // it: `claim` below is the only reader of the mailbox stream.
  const delegations = makeSubagentDelegations(
    harden({ powers, limits: subagentLimits, ...(timers ? { timers } : {}) }),
  );
  const settledMail = new Set();
  const toolRegistry = makeFlootToolRegistry(powers, {
    settledMail,
    ...(extraTools ? { extraTools } : {}),
    ...(spawner ? { spawner, delegations, subagentLimits } : {}),
    ...(readAccounts
      ? {
          readAccounts: async refresh =>
            harden({
              ...(await readAccounts(refresh)),
              usage: await getUsage(),
            }),
        }
      : {}),
  });

  // Serialize turns: settlement must finish before the next model reads context.
  let turnChain = Promise.resolve();
  let stopped = false;
  let quarantineError;
  let attachmentQuarantineError;
  const cleanupAttachments = async () => {
    try {
      await attachments?.cleanup();
    } catch (error) {
      attachmentQuarantineError = Error(
        `Attachment cleanup failed: ${error.message}`,
        { cause: error },
      );
      // Attachment recovery must never clear an independent containment failure.
      quarantineError ??= attachmentQuarantineError;
      stopInbox();
      throw attachmentQuarantineError;
    }
  };
  const turnControllers = new Set();

  // Assemble the user message. A string is used as-is; a reader is drained
  // (replace semantics — each partial/final carries the full text so far) until
  // it ends, so the complete turn is ready before the (non-streaming) LLM call.
  const resolveUserText = async input => {
    if (typeof input === 'string') return input;
    let text = '';
    for await (const value of iterateReader(input, { buffer: 4 })) {
      if (value?.type === 'end') break;
      if (value?.type === 'partial' || value?.type === 'final') {
        text = `${value.text}`;
      } else if (value?.type === 'abort') {
        throw new Error(value.reason || 'user message aborted');
      }
    }
    return text;
  };

  const runTurnBody = async (
    text,
    writer,
    meta,
    signal,
    turnId,
    attachmentContext = '',
  ) => {
    const turnPrompt = attachmentContext
      ? `${effectivePrompt}\n\n${attachmentContext}`
      : effectivePrompt;
    if (stopped || signal?.aborted) return;
    const inputMessages = [
      { role: 'user', content: `${text}`, ...(meta ? { meta } : {}) },
    ];

    // The current input is always sent, even when history hides a repeated
    // typed receipt. Display deduplication does not alter inference or retries.
    const stagedMessages = [...inputMessages];
    // Publish the ordered prefix before admitting tool effects.
    let transcriptOrdinal = 0;
    /** @type {string[]} Operation IDs for the response awaiting execution. */
    let requestedOperations = [];
    let inputRecorded = false;
    let compactedContext;
    let unseenImages = false;
    let forced = false;
    let lastRequestContext;
    let requestObservationInitialized = false;
    const recordInput = async () => {
      await turnJournal.dispatch(turnId);
      if (signal?.aborted) throw Error('Floot turn aborted');
      if (!inputRecorded) {
        await recordProviderTranscript({
          kind: 'message',
          role: 'user',
          content: text,
        });
        inputRecorded = true;
      }
    };
    /**
     * @param {import('@endo/hosted-agent/transcript-records.js').TranscriptRecord} record
     * @param expectedFrontier
     */
    const recordProviderTranscript = async (
      record,
      expectedFrontier = undefined,
    ) => {
      await turnJournal.recordTranscript(
        turnId,
        `${transcriptOrdinal}`,
        record,
        expectedFrontier,
      );
      transcriptOrdinal += 1;
    };

    // Agentic loop: stream a reply; if it calls tools, run them, persist the
    // assistant turn plus tool results, and loop again until the model returns a
    // plain (spoken) answer. Tools are re-discovered each round so anything the
    // model creates mid-turn (e.g. via exec/store) is immediately callable.
    let finalContent = '';
    // Whether the model produced a plain (toolless) answer. If it never does
    // within maxToolRounds, we send a fallback instead of an empty reply.
    let answered = false;
    // Token usage accumulates across this turn's rounds (each tool round is its
    // own provider call).
    /** @type {import('@endo/hosted-agent/token-usage.js').TokenUsage} */
    let turnUsage = projectUsage(undefined);
    writer.setPhase('thinking');

    const loop = await runAgenticTurn({
      // The shared loop treats this as an opaque accumulator, not a tree ID.
      cursor: turnId,
      maxRounds: maxToolRounds,
      getTools: async () => {
        if (signal?.aborted) throw Error('Floot turn aborted');
        return toolRegistry.snapshot();
      },
      getContext: async (_cursor, tools) => {
        await recordInput();
        // Capture before hydration/summary. The serialized journal writer
        // compares this cut atomically; newer evidence must not be hidden.
        const { frontier, retained } = await turnJournal.readView();
        // Include prior failed/cancelled turns and their known effects, not just
        // successful turns. The active turn's staging stays separate.
        // Model context is not a UI history projection: the latter deliberately
        // carries previews. Hydrate the same full transcript hosted runners use.
        let context;
        if (compactedContext) {
          context = [...compactedContext, ...stagedMessages];
        } else {
          const transcript = await getContextTranscript(turnId);
          const path = transcriptToProviderMessages(
            transcript,
            runtime.providerFormat,
          );
          context = [
            { role: 'system', content: turnPrompt },
            ...path.filter(message => message.role !== 'system'),
            ...stagedMessages,
          ];
          const latest = retained
            .filter(item => item.turnId !== turnId)
            .sort((a, b) => (BigInt(a.turnId) < BigInt(b.turnId) ? -1 : 1))
            .at(-1);
          if (!requestObservationInitialized) {
            lastRequestContext = latest?.usage?.context;
            requestObservationInitialized = true;
          }
        }
        // The previous usage reading predates new image tool results. Let the
        // model inspect them once before a summary may replace them with receipts.
        const plan = unseenImages
          ? undefined
          : planContextCompaction(context, {
              tools: tools.providerSchemas,
              windowTokens: contextLength ?? 0,
              usedTokens: lastRequestContext?.usedTokens ?? 0,
              force: forceCompaction && !forced,
            });
        if (plan) {
          writer.setPhase('compacting context');
          const checkpoint = await summarizeContext(
            plan,
            async messages => {
              const provider = await currentProvider();
              let reported = false;
              const charge = usage => {
                const counts = { ...usage };
                delete counts.context;
                turnUsage = addUsage(turnUsage, counts);
                activeJournalUsage = turnUsage;
              };
              const answer = await provider.chatStream(
                messages,
                [],
                () => {},
                signal,
                usage => {
                  // Summary cost counts, but this is not continuation occupancy.
                  reported = true;
                  charge(usage);
                },
              );
              if (!reported && answer.usage) charge(answer.usage);
              return answer;
            },
            signal,
          );
          if (signal?.aborted) throw Error('Floot turn aborted');
          await recordProviderTranscript(
            {
              kind: 'compaction',
              summary: checkpoint.summary,
              retainedTail: projectTranscript(checkpoint.retained),
            },
            frontier,
          );
          compactedContext = checkpoint.context;
          stagedMessages.splice(0);
          lastRequestContext = undefined;
          forced = true;
          context = compactedContext;
          writer.setPhase('thinking');
        }
        return harden({ cursor: turnId, messages: context });
      },
      invoke: async (context, tools, round) => {
        console.error(
          `[floot] round ${round}: ${context.length} messages, ${tools.providerSchemas.length} tools`,
        );
        let streamed = '';
        let usageReported = false;
        const provider = await currentProvider();
        let answer;
        try {
          await recordInput();
          if (signal?.aborted) throw Error('Floot turn aborted');
          answer = await provider.chatStream(
            context,
            tools.providerSchemas,
            delta => {
              streamed += delta;
              writer.delta(delta);
            },
            signal,
            roundUsage => {
              // Providers can report usage before rejecting an unusable reply.
              // Notifications are incremental; a returned total is fallback only.
              usageReported = true;
              lastRequestContext = roundUsage.context;
              turnUsage = addUsage(turnUsage, roundUsage);
              activeJournalUsage = turnUsage;
            },
          );
          unseenImages = false;
        } catch (error) {
          if (streamed !== '') {
            await recordProviderTranscript({
              kind: 'message',
              role: 'assistant',
              content: streamed,
            });
          }
          // The turn's failure reaches the journal and the view, but this log
          // otherwise ends at the round that was asked for and never says
          // what became of it.
          console.error(
            `[floot] round ${round} ${signal?.aborted ? 'stopped' : 'failed'}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          throw error;
        }
        const { message, usage: roundUsage, servedBy } = answer;
        if (!usageReported) lastRequestContext = roundUsage?.context;
        if (servedBy?.model || servedBy?.provider) {
          // Cut to what the journal accepts: a finish event it refused would
          // leave the turn pending and the session unable to begin another.
          const served = [servedBy.model, servedBy.provider]
            .filter(part => typeof part === 'string' && part !== '')
            .join(' via ')
            .slice(0, 256);
          console.error(`[floot] round ${round} served by ${served}`);
          if (
            served !== '' &&
            !activeJournalServedBy.includes(served) &&
            activeJournalServedBy.length < MAX_SERVED_BY
          ) {
            activeJournalServedBy = [...activeJournalServedBy, served];
          }
        }
        if (roundUsage && !usageReported) {
          // Counts add across rounds; the context reading is the last
          // round's, which is what the window holds now.
          turnUsage = addUsage(turnUsage, roundUsage);
          activeJournalUsage = turnUsage;
        }
        const reply = message || { role: 'assistant', content: streamed };
        const recordedReply = {
          ...reply,
          ...(Array.isArray(reply.tool_calls)
            ? {
                tool_calls: reply.tool_calls.map((call, index) => ({
                  ...call,
                  id: call.id || `floot-synth-${round}-${index}`,
                })),
              }
            : {}),
        };
        const requests = recordedReply.tool_calls ?? [];
        if (
          !Array.isArray(requests) ||
          requests.some(
            call =>
              typeof call.id !== 'string' ||
              !call.id ||
              typeof call.function?.name !== 'string' ||
              !call.function.name,
          )
        ) {
          throw Error('Invalid provider tool call');
        }
        if (new Set(requests.map(call => call.id)).size !== requests.length)
          throw Error(
            'Provider returned a duplicate tool call ID within one response',
          );
        requestedOperations = [];
        for (const record of projectTranscript([recordedReply])) {
          if (record.kind === 'tool-call') {
            requestedOperations.push(
              toolOperationId(turnId, transcriptOrdinal),
            );
          }
          await recordProviderTranscript(record);
        }
        if (signal?.aborted) throw Error('Floot turn aborted');
        return harden({ message: recordedReply });
      },
      getToolCalls: message =>
        Array.isArray(message.tool_calls) ? message.tool_calls : [],
      runTools: async (calls, tools) => {
        if (signal?.aborted) throw Error('Floot turn aborted');
        if (calls.length !== requestedOperations.length)
          throw Error('Provider tool call lacks a durable request');
        writer.setPhase('using tools');
        const runOne = async (call, index) => {
          const operationId = requestedOperations[index];
          const name = call.function?.name;
          let args = {};
          let parseError;
          try {
            args =
              typeof call.function?.arguments === 'string'
                ? JSON.parse(call.function.arguments || '{}')
                : call.function?.arguments || {};
          } catch (error) {
            parseError = error instanceof Error ? error.message : String(error);
          }
          writer.toolCall({
            id: operationId,
            name: `${name}`,
            args: JSON.stringify(args),
          });
          // Unparseable arguments are an outcome the model is told about,
          // journaled like any other failed call rather than skipped.
          const outcome = await journaledToolCall({
            turnId,
            callId: operationId,
            name,
            args,
            run: () => {
              // Intent publication can yield across cancellation. Record its
              // refused outcome without granting the tool execution authority.
              if (signal?.aborted) throw Error('Floot turn aborted');
              if (parseError !== undefined) {
                throw Error(
                  `could not parse tool arguments as JSON (${parseError}). Re-send this tool call with valid JSON arguments.`,
                );
              }
              return tools.execute(name, args);
            },
          });
          const resultText =
            'error' in outcome
              ? `Error: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`
              : outcome.result;
          writer.toolResult({
            id: operationId,
            name: `${name}`,
            result: imageResultText(`${resultText}`),
            failed: 'error' in outcome,
          });
          console.error(
            `[floot] tool ${name} -> ${`${resultText}`.length} chars`,
          );
          return {
            role: 'tool',
            tool_call_id: call.id,
            content: `${resultText}`,
            failed: 'error' in outcome,
          };
        };
        const results = await Promise.all(calls.map(runOne));
        unseenImages ||= results.some(result =>
          decodeImageResult(result.content),
        );
        for (const result of results) {
          await recordProviderTranscript({
            kind: 'tool-result',
            id: result.tool_call_id,
            content: result.content,
            failed: result.failed,
          });
        }
        if (signal?.aborted) throw Error('Floot turn aborted');
        return harden({ normalizedCalls: calls, results });
      },
      commitStep: async (cursor, message, step) => {
        stagedMessages.push(
          { ...message, tool_calls: step.normalizedCalls },
          ...step.results,
        );
        writer.setPhase('thinking');
        return cursor;
      },
      commitFinal: async (cursor, message) => {
        finalContent = message.content || '';
        stagedMessages.push(message);
        return cursor;
      },
    });
    answered = loop.answered;

    if (!answered) {
      // The loop hit maxToolRounds while the model still wanted to call tools,
      // so it never produced a spoken answer. Persist and speak a fallback so the
      // turn ends on a well-formed assistant message instead of an empty reply
      // sitting atop a dangling tool_result.
      finalContent =
        "I wasn't able to finish that within my tool-step limit. Could you narrow it down or try again?";
      stagedMessages.push({ role: 'assistant', content: finalContent });
      await recordProviderTranscript({
        kind: 'message',
        role: 'assistant',
        content: finalContent,
      });
      console.error(
        `[floot] turn hit maxToolRounds (${maxToolRounds}); sent fallback reply`,
      );
    }

    // Journal completion and usage as one fact. Total
    // accounting is a projection, never a prerequisite for recording this turn.
    await assertTurnToolsSettled(turnId);
    if (signal?.aborted) throw Error('Floot turn aborted');
    await turnJournal.completeTranscript(turnId, `${transcriptOrdinal}`);
    // A complete transcript is not yet a successful turn. Cancellation up to
    // admission of the journal finish still records a cancelled turn; once
    // that immutable write is admitted, its completion wins the race.
    if (signal?.aborted) throw Error('Floot turn aborted');
    await turnJournal.append(turnId, {
      type: 'finish',
      state: 'completed',
      output: finalContent,
      usage: turnUsage,
      ...servedByOfTurn(),
    });
    completedJournalTurn = turnId;
    const reportedUsage = await usageToReport();
    if (reportedUsage) writer.usage(reportedUsage);
    writer.final(finalContent);
    writer.end();
  };

  const admissionErrors = new WeakSet();
  const runTurn = async (input, writer, meta, signal, onBegun, references) => {
    const text = await resolveUserText(input);
    try {
      await turnJournal.assertReady();
    } catch (error) {
      // Only this pre-dispatch failure permits the inbox to retry admission.
      // An already-journaled mail turn must never be replayed automatically.
      const admissionError = Error(
        error instanceof Error ? error.message : String(error),
      );
      admissionErrors.add(admissionError);
      throw admissionError;
    }
    const turnId = await turnJournal.begin({
      input: text,
      toolIdentity: 'transcript-ordinal',
      backendId: backendId || runtimeKind,
      modelId: modelId || '',
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(meta?.mail === undefined ? {} : { mail: meta.mail }),
      ...(meta?.message === undefined ? {} : { message: meta.message }),
    });
    activeJournalTurn = turnId;
    activeJournalTurns.set(turnJournal, turnId);
    activeJournalUsage = undefined;
    // Here, not where rounds begin: a turn that fails before its first round
    // must not be recorded as served by the previous turn's models.
    activeJournalServedBy = [];
    let environmentStop;
    let environmentStopFailure;
    const stopOnAbort = () => {
      if (!stopEnvironment || environmentStop) return;
      // Registered only for the active admitted turn, never for a queued
      // cancellation that could stop a different turn's Shell command.
      environmentStop = Promise.resolve()
        .then(stopEnvironment)
        .catch(error => {
          environmentStopFailure = error;
          quarantineError = Error(
            'Development environment cancellation failed; native cleanup remains pending',
          );
          stopInbox();
        });
    };
    if (signal?.aborted) stopOnAbort();
    else signal?.addEventListener('abort', stopOnAbort, { once: true });
    const stoppedEnvironment = async () => {
      await environmentStop;
      if (environmentStopFailure) throw quarantineError;
    };
    notifyChange(
      'turn-started',
      harden({
        input: text,
        ...(typeof meta?.mail?.from === 'string'
          ? { from: meta.mail.from }
          : {}),
      }),
    );
    let attachmentPackage;
    let output = '';
    const observedWriter = {
      ...writer,
      delta(delta) {
        output += delta;
        writer.delta(delta);
      },
      final(value) {
        output = value;
        writer.final(value);
      },
    };
    try {
      if (onBegun) {
        // The journal has the input. Whoever queued it may let go of its
        // copy; that bookkeeping failing is theirs to log, never this turn's
        // to fail. Inside the `try` so the turn still settles whatever it does.
        try {
          await onBegun();
        } catch (error) {
          console.error('[floot-agent] turn-begun observer failed:', error);
        }
      }
      if (signal?.aborted) {
        await stoppedEnvironment();
        await turnJournal.append(turnId, {
          type: 'finish',
          state: 'cancelled',
        });
        return;
      }
      if (references?.length) {
        if (!attachments || !meta?.message)
          throw Error('Structured attachments unavailable');
        attachmentPackage = await attachments.open(
          meta.message,
          references,
          turnId,
          () => {
            if (stopped || signal?.aborted) throw Error('Turn cancelled');
          },
        );
      }
      await runTurnBody(
        text,
        observedWriter,
        meta,
        signal,
        turnId,
        attachmentPackage?.context,
      );
      await stoppedEnvironment();
      if (signal?.aborted && completedJournalTurn !== turnId) {
        await turnJournal.append(turnId, {
          type: 'finish',
          state: 'cancelled',
          output,
          usage: activeJournalUsage,
          ...servedByOfTurn(),
        });
      }
    } catch (error) {
      await environmentStop;
      // A failed journal write fences further calls. Never hide that failure by
      // claiming that an unrecorded tool outcome is safe to retry.
      if (completedJournalTurn !== turnId) {
        await turnJournal.append(turnId, {
          type: 'finish',
          state: environmentStopFailure
            ? 'outcome-unknown'
            : signal?.aborted
              ? 'cancelled'
              : 'failed',
          output,
          error: environmentStopFailure
            ? quarantineError.message
            : error instanceof Error
              ? error.message
              : String(error),
          usage: activeJournalUsage,
          ...servedByOfTurn(),
        });
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', stopOnAbort);
      await environmentStop;
      try {
        await cleanupAttachments();
      } finally {
        activeJournalTurn = undefined;
        activeJournalTurns.delete(turnJournal);
        notifyChange('turn-settled');
      }
    }
  };

  /**
   * Close the inbox loop.
   *
   * Quarantine and shutdown both mean this agent will never take another turn,
   * but the loop is parked in `messages.next()` and would otherwise keep
   * accepting mail: for every message it would call `converse`, drop an
   * unobserved rejection, and mail the quarantine error back to the sender —
   * indefinitely, and with no way to stop it short of a daemon restart.
   * Declared before `converse` so its quarantine path can reach it; the
   * iterator it closes is bound later, which is why this is a function.
   */
  const stopInbox = () => {
    signalInboxStopped();

    wakeMailWorker();

    if (inboxIterator) {
      void Promise.resolve(inboxIterator.return()).catch(() => undefined);
    }
  };

  const converse = (
    input,
    writer,
    meta,
    signal,
    onStart,
    onBegun,
    references,
  ) => {
    if (recordsOnly) {
      const error = Error('Records-only session cannot run turns');
      writer.abort(error.message);
      return Promise.reject(error);
    }
    if (stopped || quarantineError) {
      const error =
        quarantineError || Error('Floot session agent is shutting down');
      writer.abort(error.message);
      return Promise.reject(error);
    }
    const turnController = new AbortController();
    turnControllers.add(turnController);
    const forwardAbort = () => turnController.abort();
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const result = turnChain.then(async () => {
      // Capture recovery history within the execution chain, after earlier mail.
      if (onStart) onStart(await getHistory());
      return stopped
        ? Promise.reject(Error('Floot session agent is shutting down'))
        : runTurn(
            input,
            writer,
            meta,
            turnController.signal,
            onBegun,
            references,
          ).catch(err => {
            // A cancelled turn (`FlootTurn.cancel`, or shutdown) aborts
            // `signal`, tearing down the in-flight provider stream. That's a
            // clean stop, not a failure, and the turn's owner has already
            // closed the reply channel, so swallow it.
            if (turnController.signal.aborted) {
              if (stopped) writer.abort('Floot session agent shut down');
              return;
            }
            // runTurn has no internal catch, so on failure the writer is still
            // unsettled — abort it here or every consumer (UI stream and the mail
            // inbox's turnDone) would hang forever. Rethrow so callers still see it.
            writer.abort(err instanceof Error ? err.message : String(err));
            throw err;
          });
    });
    const releaseTurn = () => {
      signal?.removeEventListener('abort', forwardAbort);
      turnControllers.delete(turnController);
      if (stopped) writer.abort('Floot session agent shut down');
    };
    result.then(releaseTurn, releaseTurn);
    // Keep the chain alive even if a turn rejects.
    turnChain = result.catch(() => {});
    return result;
  };

  // Inbox loop: a session is also addressable by mail. We follow the guest's
  // inbox and feed each incoming message through the SAME turn machinery as
  // converse() (so mail and UI turns share one conversation thread and are
  // serialized by turnChain), then send the reply back as one buffered mail
  // message via reply(). Streaming-over-mail is a later phase; for now the
  // reply is the assembled final text.
  let inboxStarted = false;
  let inboxIterator;
  let inboxLoop = Promise.resolve();
  /**
   * Settles when this agent stops, so the pump can leave without waiting for
   * the mailbox to say something.
   *
   * `inboxIterator.return()` is not enough: the reader pump awaits a
   * synchronization node only *between* pulls, so once it is parked in the
   * source's `next()` on a quiet mailbox it never observes the close, and the
   * cancel hangs with it. Racing the read against this is what lets a session
   * with nothing in its inbox shut down promptly instead of timing out.
   */
  let signalInboxStopped = () => {};
  const inboxStopped = new Promise(resolve => {
    signalInboxStopped = resolve;
  });
  const waitForJournalReadiness = async () => {
    try {
      await turnJournal.assertReady();
    } catch {
      // An uncertain write poisons this incarnation. Operator resolution
      // cannot repair it; leave mail pending until shutdown and revival.
      await inboxStopped;
    }
  };
  /** Wakes the mail worker; rebound when a pump starts. */
  let wakeMailWorker = () => {};
  const startInbox = () => {
    if (recordsOnly) return;
    if (inboxStarted || stopped) return;
    inboxStarted = true;
    inboxLoop = (async () => {
      const selfLocator = await E(powers).locate('@self');
      const messages = iterateReader(E(powers).followMessages());
      inboxIterator = messages;
      if (stopped) {
        await messages.return();
        return;
      }
      // followMessages can deliver the same message twice: its initial drain
      // iterates a *live* Map that our own reply() mutates (so the iterator
      // re-yields the freshly-added reply), and that reply is also republished
      // to the topic the drain later consumes. Process each number once, or the
      // second dismiss() of an already-removed message throws and kills the loop.
      const handled = new Set();
      // A mail turn is run by the worker below rather than awaited in the loop.
      //
      // `askSubagent` blocks inside a turn until `delegations.claim` observes
      // the subagent's reply, and the only reader that feeds `claim` is this
      // loop. Awaiting the turn here therefore waits on a message the loop can
      // no longer read: every ask from a mail-triggered turn times out.
      //
      // The queue is deliberately unbounded. What it holds is a reference to a
      // message the daemon is holding anyway, and it drains monotonically.
      // Declining past a bound would be worse: `followMessages` first drains
      // the whole live mailbox, far faster than the model answers, so a
      // backlog — a restart with unread mail, say — would be refused wholesale
      // even though the session goes idle moments later.
      /** @type {Array<{ number: any, text: string, fromName: any }>} */
      const pendingMail = [];
      /** @type {(() => void) | undefined} */
      let parkedWorker;
      let pumpEnded = false;
      const wakeMail = () => {
        const notify = parkedWorker;
        parkedWorker = undefined;
        if (notify) notify();
      };
      // Reachable from `stopInbox`, so a shutdown releases a parked worker
      // rather than depending on the pump to notice.
      wakeMailWorker = wakeMail;

      /**
       * Dismissal is bookkeeping, and `followMessages` can re-deliver a number
       * whose message this loop already removed. Letting that throw would kill
       * the pump — and with it delegation for the rest of the session.
       *
       * @param {any} messageNumber
       */
      const dismissQuietly = async messageNumber =>
        E(powers)
          .dismiss(messageNumber)
          .catch(error => {
            console.error(
              `[floot] could not dismiss message #${messageNumber}:`,
              error instanceof Error ? error.message : String(error),
            );
          });

      const mailWorker = (async () => {
        for (;;) {
          if (pendingMail.length === 0) {
            if (pumpEnded || stopped) return;

            await new Promise(resolve => {
              parkedWorker = resolve;
            });
            // eslint-disable-next-line no-continue
            continue;
          }
          const { number, text, fromName, type } = /** @type {any} */ (
            pendingMail.shift()
          );
          try {
            // Keep queued mail intact if this journal incarnation is poisoned.
            await waitForJournalReadiness();
            if (stopped || quarantineError) return;
            const { writer, done: turnDone } = makeBufferingWriter();
            // Route through converse so the turn joins turnChain and shares
            // context. Tag the turn as mail so getHistory can mark it (and the
            // UI can show the sender) rather than render it like local input.
            // The turn's outcome is read from the writer, so the promise itself
            // is deliberately unused — but it must still be observed, or a turn
            // that rejects before reaching the writer becomes an unhandled
            // rejection in the daemon worker.
            const turnP = converse(text, writer, {
              mail: {
                from: fromName,
                ...(type === 'request' || type === 'form'
                  ? { messageNumber: String(number) }
                  : {}),
              },
            }).then(
              () => undefined,
              error =>
                harden({
                  ok: false,
                  error: `${error?.message || error}`,
                  admissionBlocked: admissionErrors.has(error),
                }),
            );
            // Raced, not simply awaited: `runTurn` has early exits that return
            // *successfully* without settling the writer, and only
            // `releaseTurn`'s shutdown-time abort rescues them. A turn
            // controller aborted for any other reason would park this worker
            // on `turnDone` for good, so the second racer has to be a terminal
            // value rather than a hand-off back to `turnDone`. On every normal
            // path `writer.end()` runs before the turn resolves, so `turnDone`
            // wins and this never fires.

            const result = await Promise.race([
              turnDone,
              turnP.then(
                outcome =>
                  outcome ||
                  harden({
                    ok: false,
                    error: 'turn ended without settling its reply',
                  }),
              ),
            ]);
            // A turn that finished is answered and dismissed whatever else is
            // happening: its history is committed and the model was paid for.
            // Only a turn shutdown aborted is left in the inbox, for the next
            // incarnation. Typed incoming mail is already recorded, and its
            // message number deduplicates the receipt on replay.
            if (!result.ok && stopped) return;
            const failedTurn = !result.ok ? await turnP : undefined;
            if (!result.ok && failedTurn?.admissionBlocked) {
              // Admission never dispatched this task. Requeue even if recovery
              // completed meanwhile; never answer/dismiss unperformed work.
              pendingMail.unshift({ number, text, fromName, type });
              // eslint-disable-next-line no-continue
              continue;
            }
            const replyText = result.ok
              ? result.text || ''
              : `Error: ${result.error}`;

            if (type === 'request' || type === 'form') {
              if (
                !settledMail.delete(String(number)) &&
                !(await E(powers).has(`workflow-settled-${number}`))
              ) {
                // A provider failure is not a typed rejection. Preserve the
                // request for recovery; its incoming text is already durable.
                // Preserve unanswered forms for recovery or the operator too.
                // eslint-disable-next-line no-continue
                if (!result.ok || type === 'form') continue;
                await E(powers).reject(
                  number,
                  'Agent ended the turn without a typed answer',
                );
              }
            } else {
              await E(powers).reply(number, [replyText], [], []);
            }
            // Dismiss after handling so the message leaves the inbox and is not
            // reprocessed when followMessages replays on the next daemon
            // restart. Bookkeeping, like the pump's: a failure here must not
            // be reported as "could not complete mail turn", which the turn
            // plainly did.

            await dismissQuietly(number);
          } catch (error) {
            console.error(
              `[floot] could not complete mail turn #${number}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      })();
      // Raced against the stop signal on every pull: the reader pump observes a
      // close only *between* pulls, so a session whose mailbox has gone quiet
      // cannot be cancelled through the iterator alone. Derived once — inside
      // the loop it would append a reaction per message to a promise that stays
      // pending for the session's whole life.
      const whenStopped = inboxStopped.then(() =>
        harden({ value: undefined, done: true }),
      );
      // The tail below runs however this loop leaves — normally, by shutdown,
      // or by a throw. Without it, a pump that died left the worker parked on a
      // wake that would never come, holding every message it had already read.
      try {
        for (;;) {
          const next = await Promise.race([messages.next(), whenStopped]);
          const { value: message, done } = next;
          if (done) break;
          const {
            from: fromId,
            number,
            type,
            strings,
            names,
            done: messageDone = true,
          } = message;
          if (handled.has(number)) {
            // eslint-disable-next-line no-continue
            continue;
          }
          // A sender may reveal a message progressively and settle it later with
          // `editMessage`; the daemon re-emits the settled revision under the
          // same number. Marking the partial handled would swallow that revision
          // — including a subagent's reply, which `claim` deliberately refuses
          // while it is still partial — and would answer a half-written message.
          if (messageDone === false) {
            // eslint-disable-next-line no-continue
            continue;
          }
          handled.add(number);
          // The admitted UI turn owns this package through tool settlement.
          // It must not be dismissed or dispatched by the ordinary inbox.
          // eslint-disable-next-line no-continue
          if (attachments?.owns(message.messageId)) continue;
          // Offer every message — this session's own outbound mail included —
          // to the delegation registry first. It learns a delegation's identity
          // from the echo of the send and consumes the matching reply, which
          // the awaiting `askSubagent` call returns instead of this loop
          // turning it into a conversation (and replying to it, which with a
          // subagent would be an unbounded exchange).
          if (delegations.claim(message).claimed) {
            // Dismissed like every other message this loop handles. Leaving it
            // would mean that after a restart — when no ask is pending — the
            // reply replays as an ordinary message, this session answers it,
            // and the subagent answers back: two models in an unbounded
            // exchange. The cost is that a reply's attachments are not
            // retained, which `askSubagent` says plainly.
            await dismissQuietly(number);
            // eslint-disable-next-line no-continue
            continue;
          }
          // Skip our own outbound messages echoed back into the inbox.
          // Compare formulas, not locator strings: `locate` decorates with the
          // transport hints currently published by `@nets` while a message's
          // `from` is always hint-free, so a daemon with network addresses
          // would fail string equality and answer its own mail.
          if (isSameFormula(fromId, selfLocator)) {
            await dismissQuietly(number);
            // eslint-disable-next-line no-continue
            continue;
          }

          // An unmatched reply is an observation, not a fresh request. In
          // particular, a delegation may have ended or its owner restarted.
          // Turning its late reply into a model turn and replying again makes
          // two agents (or two error handlers) converse without a requester.
          // Keep the message and its capability attachments in the mailbox for
          // explicit inspection/adoption. Only pending delegations above may
          // consume a reply automatically, including after an inbox restart.
          if (message.replyTo !== undefined) {
            console.error(
              `[floot] unclaimed reply #${number} retained for explicit handling`,
            );
            // eslint-disable-next-line no-continue
            continue;
          }

          let text;
          if (type === 'package' && Array.isArray(strings)) {
            const parts = [];
            const namesArray = Array.isArray(names) ? names : [];
            for (let i = 0; i < strings.length; i += 1) {
              parts.push(strings[i]);
              if (i < namesArray.length) parts.push(`@${namesArray[i]}`);
            }
            text = parts.join('').trim();
            // This message is dismissed once this turn ends, so any attached
            // object must be adopted now. Tell the model the message number
            // and edge names so it can call adopt within this same turn.
            if (namesArray.length) {
              const edges = namesArray.map(n => `"${n}"`).join(', ');
              text += `\n\n(System: message #${number} attaches object(s) with edge name(s) ${edges}. To keep any of them, call the adopt tool with message number ${number} and the edge name during this turn — the message is dismissed afterward.)`;
            }
          } else if (type === 'request' || type === 'form') {
            text = `[Inbox ${type} #${number}] ${message.description}\n\n${
              type === 'request'
                ? `Answer with resolveRequest(messageNumber: "${number}", value: ...), or rejectRequest. A prose reply does not answer this request.`
                : `Answer with submitForm(messageNumber: "${number}", values: ...). Fields: ${message.fields.map(field => field.name).join(', ')}.`
            }`;
          } else {
            text = `(${type || 'unknown'} message)`;
          }

          // Resolve a friendly sender name for the history entry: the
          // petname(s) this guest has for the sender, falling back to the
          // locator. The reply is sent to the same sender by message number.
          let fromName;
          try {
            const senderNames = await E(powers).reverseLocate(fromId);
            fromName =
              Array.isArray(senderNames) && senderNames.length
                ? senderNames[0]
                : fromId;
          } catch {
            fromName = fromId;
          }

          if (stopped || quarantineError) break;
          pendingMail.push({ number, text, fromName, type });
          wakeMail();
        }
      } finally {
        // Nothing can feed `claim` once this loop is out — and nothing restarts
        // it — so an ask that kept waiting would hold the queue open for its
        // whole timeout, five minutes by default, for a reply that can no
        // longer arrive. The reason names the cause, because a session whose
        // pump died of something transient goes on answering the UI while
        // delegation is permanently gone, and an opaque error there would
        // connect to nothing in the log.
        pumpEnded = true;
        delegations.close(
          Error(
            'Floot session inbox loop ended; delegation is unavailable until the session is recreated',
          ),
        );
        wakeMail();
      }
      // Let queued replies finish before the loop resolves, so a shutdown that
      // awaits `inboxLoop` waits for mail this session already answered.
      await mailWorker;
    })().catch(error => {
      if (stopped) return;
      // Deliberately not resetting `inboxStarted`: nothing calls `startInbox`
      // twice, and a second pump would race a permanently-resolved
      // `inboxStopped` and a closed delegation registry. The session keeps
      // serving the UI; what it has lost is mail and delegation, which is what
      // this says.
      console.error(
        '[floot] inbox loop ended in error; this session no longer receives mail or delegates:',
        error instanceof Error ? error.message : String(error),
      );
    });
  };

  const shutdownAgent = async (allowBackendQuarantine = false) => {
    stopped = true;
    for (const controller of turnControllers) controller.abort();
    // Release the pump and any parked worker before awaiting either. The
    // iterator's own `return()` cannot do it: the reader pump observes a close
    // only between pulls, so a session whose mailbox is quiet would otherwise
    // sit here until the shutdown timeout.
    // `stopInbox` already asked the iterator to close and fired the stop
    // signal the pump races against. Its `return()` is deliberately *not*
    // awaited here: the reader pump observes a close only between pulls, so on
    // a quiet mailbox that promise never settles and would hold this shutdown
    // to its timeout even though the loop it guards has already left.
    stopInbox();
    const closing = [turnChain, inboxLoop];
    const settled = await withTimeout(
      Promise.allSettled(closing),
      'Floot session agent shutdown',
    );
    const failures = /** @type {PromiseRejectedResult[]} */ (settled)
      .filter(result => result.status === 'rejected')
      .map(result => result.reason);
    try {
      await attachments?.cleanup();
      if (quarantineError === attachmentQuarantineError)
        quarantineError = undefined;
      attachmentQuarantineError = undefined;
    } catch (error) {
      failures.push(error);
    }
    if (runtime.kind === 'provider') {
      try {
        await runtime.disposeProvider?.();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Floot session agent shutdown failed');
    }
    if (quarantineError && !allowBackendQuarantine) throw quarantineError;
  };

  // Replay the conversation for UI repaint: user prompts, the assistant's spoken
  // answers, and each tool call paired with its result so tool activity survives
  // a refresh. The system prompt (root) is omitted.

  const {
    getHistory,
    getSettledHistory,
    getTranscript,
    getTurns,
    getArchivedTurns,
    getArchivedTurnsPage,
    getTurnContent,
    getJournalStatus,
    getUsage,
  } = makeSessionRecords(turnJournal, () => activeJournalTurn);

  const getContextTranscript = async excludeTurnId =>
    readContextTranscript(turnJournal, excludeTurnId, {
      omitIncompleteImages: runtimeKind === 'provider',
    });

  /**
   * What a status indicator needs, without the records themselves.
   */
  const getActivity = async () => {
    /** @type {any[]} */
    const turns = await turnJournal.list();
    const last = turns.at(-1);
    return harden({
      active: Boolean(activeJournalTurn),
      lastTurnState: `${last?.state || ''}`,
      // Old unknown effects remain evidence, not a current session fault.
      needsRecovery: Boolean(quarantineError),
    });
  };
  const resolveTurn = (turnId, note) =>
    turnChain.then(async () => {
      if (activeJournalTurn || executingTools.size)
        throw Error('Cannot resolve an active Floot turn or unsettled tool');
      await turnJournal.resolve(turnId, note);
      notifyChange('turn-resolved');
    });

  /**
   * The usage a finished turn tells its view: what getUsage() answers, so the
   * figure does not drop at the end of a turn because an earlier one did not
   * complete. The turn is already journaled as completed when this runs, so
   * it may neither fail nor wait for long — a journal that cannot be read is
   * a reason to skip this display update, not to abort a reply or invent totals.
   */
  const usageToReport = async () => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    try {
      return await Promise.race([
        getUsage(),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(undefined), 5000);
        }),
      ]);
    } catch (error) {
      console.error(
        '[floot] could not total the session’s usage; skipping display update:',
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  // A network policy decision and a rebind both replace the incarnation, and
  // neither may do so beneath live work.
  const assertIdleForReplacement = () => {
    if (turnControllers.size || executingTools.size || activeJournalTurn)
      throw Error(
        'Cannot replace the session incarnation while session work is active',
      );
  };

  return harden({
    converse,
    getHistory,
    getSettledHistory,
    getActivity,
    getTranscript,
    getTurns,
    getArchivedTurns,
    getArchivedTurnsPage,
    getTurnContent,
    getJournalStatus,
    resolveTurn,
    getUsage,
    startInbox,
    shutdown: shutdownAgent,
    assertIdleForReplacement,
    stopForReplacement: () => {
      assertIdleForReplacement();
      return shutdownAgent();
    },
  });
};
harden(makeStreamingAgent);

// ============================================================================
// Floot Factory — entry point (mirrors fae's factory recipe)
// ============================================================================

// Registry snapshots live in the factory guest's own petstore. Legacy names
// are recognized only to reject an unsupported namespace, never imported.
const REGISTRY_PREFIX = 'floot-sessions-v1-';
/**
 * Snapshots retained, including the newest. One is enough for correctness — the
 * newest complete snapshot is the record — and a handful gives an operator
 * something to fall back on if the newest turns out to be unreadable.
 */
const REGISTRY_JOURNAL_DEPTH = 4;

const newSessionId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The Floot factory — a single long-lived, pinned caplet that owns every chat
 * session. The UI references ONLY this factory; it never sees a guest.
 *
 * Each session is, internally, its own EndoGuest (isolated petstore for tool
 * endowments and its inbox). That a session
 * "is a guest" is an implementation detail hidden behind opaque session facets
 * (Far objects with `startTurn(input) -> FlootTurn` and `getHistory()`). The
 * factory operates each session guest's petstore directly via an in-process
 * `makeStreamingAgent`, so there is exactly one pin (the factory) rather than a
 * pin per session.
 *
 * Persistence is daemon-only: the session registry lives in the factory's own
 * petstore (REGISTRY_PREFIX snapshots), and each session's controls and history
 * live together in its factory-owned private directory. On restart the daemon
 * revives the pinned factory, which restores eligible session inboxes without
 * replaying turns (provideGuest is idempotent).
 *
 * IMPORTANT (reincarnation constraint, same as the fae/driver caplets): make()
 * must return synchronously WITHOUT awaiting remote references on its powers
 * host, or it deadlocks with the provision chain creating this very formula.
 * So the provider, registry, and per-session guests are all resolved lazily.
 *
 * @param {import('@endo/eventual-send').FarRef<object>} hostPowers
 * @param {Promise<object> | object | undefined} _context
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {object}
 */
/**
 * The system prompt a new session runs under.
 *
 * A caller of the public `createSession` speaks with the operator's own
 * authority, so a prompt it supplies replaces the preset's.
 *
 * A *delegated* session's prompt is composed instead. The parent model writes
 * the child's instructions, while the preset still decides which objects the
 * child gets — so substituting would let a model spawn a session with its own
 * tools and none of the operator's standing instructions. That is a way around
 * them, not a way to delegate.
 *
 * @param {object} options
 * @param {string} options.presetPrompt
 * @param {string} [options.requestedPrompt]
 * @param {boolean} [options.delegated]
 * @returns {string}
 */
export const composeSessionSystemPrompt = ({
  presetPrompt,
  requestedPrompt,
  delegated = false,
}) => {
  if (delegated)
    return composeSubagentSystemPrompt(presetPrompt, requestedPrompt, true);
  return requestedPrompt ? `${requestedPrompt}` : presetPrompt;
};
harden(composeSessionSystemPrompt);

/**
 * Construct a durable Fae session factory with explicit host authorities.
 * @param {any} hostPowers
 * @param {any} [context]
 * @param {{ env?: Record<string, string>, fetch?: typeof globalThis.fetch }} [options]
 * @param {{ drain: () => Promise<void>, introduction: (spoken:boolean)=>string, factoryHelp:string, help:Record<string,string>, guards:Record<string,any>, turnView:any, methods:(facets:any)=>Record<string,any> }} [presentation]
 */
export const make = async (
  hostPowers,
  context,
  { env, fetch: fetchAuthority = globalThis.fetch } = {},
  presentation = undefined,
) => {
  const ownership = makeFactoryOwnership();
  const factoryInterface = M.interface('FaeSessionFactory', {
    ...factoryGuards,
    ...presentation?.guards,
  });
  const makeOwnedExo = (name, iface, methods) =>
    makeExo(name, iface, ownership.methods(methods));
  /** @type {any} */
  const powers = hostPowers;
  // Absolute host path to the Endo codebase, mounted read-only into full-control
  // sessions (see the `code-mount` preset object). Resolved by the setup script
  // and passed through env; empty when the daemon host has no source on disk.
  const codePath = env?.FLOOT_CODE_PATH || undefined;
  const workload = readFlootWorkloadConfig(env ?? {});

  // The factory runs with its own host powers, so it provisions session guests
  // directly — no introduced `host-agent` reference (that rehydrates as a
  // mail-only Handle after a restart, leaving provideGuest/locate unavailable on
  // revived sessions). `powers` here is the factory's own host.
  const getHost = () => powers;
  const presetCatalog = makePresetCatalog(powers);

  const connections = makeProviderConnections({
    powers,
    ownership,
    fetchAuthority,
    workload,
  });
  const { getProviderConfig, apiProvider, readCatalogs } = connections;

  // Runtime container-mount attach registrar
  // (designs/runtime-container-fs-mount.md): validates guest-chosen /mnt/
  // paths, proves cap possession against the session guest's own petstore,
  // persists ref-counted attach records in this factory's petstore, and drives
  // the sandbox client's bind set. The privileged 9P bridging runs in a
  // separate provider holding the fs-mounter and root-host authority
  // (@endo/claude-sandbox's container-mount-bridge.js, or a session
  // provisioner that mixed its two methods in); a deployment with no such
  // provider simply leaves attach unavailable, with a clear error.
  const containerMountRegistrar = makeContainerMountRegistrar({
    powers,
    getBridgeProvider: async () => {
      const providerName =
        env?.FLOOT_CONTAINER_MOUNT_BRIDGE || 'container-mount-bridge';
      if (!(await E(powers).has(providerName))) return undefined;
      const provider = await E(powers).lookup(providerName);
      try {
        // Introspect rather than duck-type: a failed CapTP call per method
        // is noise, and a provider without the pair cannot bridge anyway.
        // eslint-disable-next-line no-underscore-dangle
        const methods = await E(provider).__getMethodNames__();
        if (methods.includes('provideContainerMountBridge')) {
          return provider;
        }
      } catch {
        // A provider without introspection cannot be checked, so it is not
        // one this registrar knows how to drive.
      }
      return undefined;
    },
  });

  // Keep the old destroy facet available until the explicit cutover cleanup
  // finishes. Only destruction may use a retired CLI owner.
  const retiredSessionOwner = async backendId => {
    if (!['codex', 'claude', 'opencode'].includes(backendId))
      throw Error(`Unknown retired harness "${backendId}"`);
    const names = [
      `${backendId}-backend`,
      ...(env?.FLOOT_BACKEND_FACTORIES || '')
        .split(',')
        .map(name => name.trim())
        .filter(Boolean),
    ];
    for (const name of new Set(names)) {
      if (await E(powers).has(name)) {
        const owner = await E(powers).lookup(name);
        const descriptor = await E(owner).describe();
        if (descriptor.id === backendId) return owner;
      }
    }
    throw Error(`Retired harness "${backendId}" is unavailable for cleanup`);
  };

  // The account oracle is an operator-endowed, read-only capability: it answers
  // what plan this deployment is on and how much quota is left, and it cannot
  // reach the credential it describes. Absent by default — a deployment that
  // has provisioned none simply has no `accountStatus` tool and a factory whose
  // `getAccount()` reports that nothing is available.
  const accountOracleName = env?.FLOOT_ACCOUNT_ORACLE || 'account-oracle';
  /** @type {Promise<any> | undefined} */
  let accountOracleP;
  const getAccountOracle = () => {
    if (!accountOracleP) {
      accountOracleP = (async () => {
        if (!(await E(powers).has(accountOracleName))) {
          // Do not cache the absence. An oracle is provisioned by re-running
          // setup, which binds the name without restarting this caplet, and a
          // remembered `undefined` would withhold `accountStatus` from every
          // session for the life of the daemon.
          accountOracleP = undefined;
          return undefined;
        }
        return E(powers).lookup(accountOracleName);
      })().catch(error => {
        accountOracleP = undefined;
        throw error;
      });
    }
    return accountOracleP;
  };
  // Setup publishes exact oracle/admin identities independently of adapters.
  const accountsWatch = makeAccountsWatch({
    listOracles: () => discoverAccounts(powers),
  });

  // The shared static asset server, an operator-endowed capability the hosted
  // setup binds into this factory's profile so a new-project session can
  // publish its workspace. Resolved on every publish, never cached: the
  // binding runs late in ENDO_EXTRA (after the factory itself is provisioned
  // or revived), so a lookup can legitimately miss on a fresh boot, and each
  // start re-mints the server, so a presence held across that would be dead.
  const assetServerName = env?.FLOOT_ASSET_SERVER || 'asset-server';
  const getAssetServer = async () => {
    try {
      if (await E(powers).has(assetServerName)) {
        const assetServer = await E(powers).lookup(assetServerName);
        return assetServer;
      }
    } catch {
      // Not resolvable (yet); the next publish looks again.
    }
    return undefined;
  };

  // Per-session bounded workspace publishers. A publication is the session's
  // and is recorded in its registry entry; it is released when the session is
  // deleted, by the session's tool instance if this incarnation built one and
  // from the record if it did not (a stopped session has no agent).
  /** @type {Map<string, { revoke: () => Promise<void> }>} */
  const publishers = new Map();
  const stopPublisher = async id => {
    const publisher = publishers.get(id);
    if (publisher) {
      await publisher.revoke();
      publishers.delete(id);

      publishChains.delete(id);
      return;
    }
    // No tool instance in this incarnation: release from the record.

    await loadRegistry();

    const entry = (registry || []).find(session => session.id === id);
    if (!entry?.publication) return;
    const assetServer = await getAssetServer();
    if (!assetServer) {
      throw Error(
        `no asset server is bound, so the published route of session ${id} (label "floot session ${id}") could not be released`,
      );
    }
    await E(assetServer).release(entry.publication.id);
  };
  // One publish chain per session, not per tool instance: a rebuilt agent
  // has a new tool while a call on the old one may still be settling, and two
  // chains would each find no publication, each serve, and record only one.
  /** @type {Map<string, Promise<unknown>>} */
  const publishChains = new Map();
  /**
   * @param {string} id
   * @returns {<T>(thunk: () => Promise<T>) => Promise<T>}
   */
  const serializePublishing = id => thunk => {
    const next = (publishChains.get(id) || Promise.resolve()).then(
      thunk,
      thunk,
    );
    publishChains.set(
      id,
      next.catch(() => {}),
    );
    return next;
  };
  /**
   * A preset with a workspace provides a bounded publication tool. Check
   * asset server availability when the tool is called.
   *
   * @param {string} id
   * @param {any} sessionGuest
   * @param {{ id: string, templateId: string, objects: Array<{ kind: string, petName: string }> }} preset
   * @returns {Promise<Map<string, any>>}
   */
  const buildExtraTools = async (id, sessionGuest, preset) => {
    const tools = presetHasShell(preset)
      ? makeDevelopmentTools(await E(sessionGuest).lookup('shell'))
      : new Map();
    // A fresh agent replaces the tool instance and nothing else: the
    // publication belongs to the session, is recorded with it, and is served
    // by the asset server whether or not any tool instance exists. It ends
    // when the session is deleted (`stopPublisher`).
    const workspaceObject = preset.objects.find(
      object => object.kind === 'git-workspace',
    );
    if (!workspaceObject) return tools;
    const publishTool = makePublishTool({
      getAssetServer,
      getWorkspace: async () => {
        if (await E(sessionGuest).has(workspaceObject.petName)) {
          return E(sessionGuest).lookup(workspaceObject.petName);
        }
        return undefined;
      },
      loadPublication: async () => {
        await loadRegistry();

        return (registry || []).find(session => session.id === id)?.publication;
      },
      savePublication: async publication => {
        await loadRegistry();
        // Read, modify and write the live array with no await between, like
        // every other registry writer: one captured across the await can be
        // a rebound, stale array, and the write would be lost.

        const live = registry;
        /** @type {number} */
        const index = (live || []).findIndex(session => session.id === id);
        if (index < 0 || !live) throw Error('Unknown Floot session');
        const { publication: _previous, ...rest } = live[index];
        live[index] = harden(
          publication ? { ...rest, publication } : { ...rest },
        );
        await saveRegistry();
      },
      serialize: serializePublishing(id),
      label: `floot session ${id}`,
    });
    publishers.set(id, { revoke: publishTool.revoke });
    tools.set('publishWorkspace', publishTool);
    return tools;
  };

  /**
   * The model id a session's usage is priced against.
   *
   * An unpinned session — the default — records no model and follows the
   * factory's configured one, so asking `entry.modelId` alone yields `''` and
   * nothing can be priced. Both the `accountStatus` tool and the session
   * facet's `getAccount` must answer the same way, or a user gets a cost from
   * the model and a blank from the UI panel beside it.
   *
   * @param {any} entry
   * @returns {Promise<string>}
   */
  const sessionModelId = async entry => {
    if (isHostedSession(entry)) {
      return providerModelId(entry.backendId, entry.modelId);
    }
    if (entry?.modelId) return entry.modelId;
    try {
      return `${(await getProviderConfig()).model || ''}`;
    } catch {
      // Pricing is a nicety; a session that cannot read its provider config has
      // a larger problem, and it will surface on its next turn.
      return '';
    }
  };

  const openRecords = async id => {
    const storage = await providePrivateTurnStorage(getHost(), id);
    const journal = makeTurnJournal(storage, workload.transcriptLimits);
    return {
      storage,
      journal,
      reader: makeSessionRecords(journal, () =>
        activeJournalTurns.get(journal),
      ),
    };
  };
  /** @type {Map<string,ReturnType<typeof openRecords>>} */
  const privateJournals = new Map();
  const sessionRecords = id => {
    let store = privateJournals.get(id);
    if (!store) {
      store = openRecords(id);
      privateJournals.set(id, store);
      const opening = store;
      void opening.catch(() => {
        if (privateJournals.get(id) === opening) privateJournals.delete(id);
      });
    }
    return store;
  };
  const closeRecords = async id => {
    const store = privateJournals.get(id);
    if (!store) return;
    const { storage } = await store;
    await E(storage).close();
    if (privateJournals.get(id) === store) privateJournals.delete(id);
  };

  // In-memory session registry, mirrored to the factory's petstore. Loaded
  // lazily so make() never awaits.
  /** @type {Array<{ id: string, title: string, createdAt: number, userInitiated?: boolean, presetId?: string, presetSnapshot?: any, systemPrompt: string, backendId: string, modelId: string, reasoningEffort?: string, subscription?: string, lifecycle?: string, executionState?: string, publication?: { id: string, url?: string, pending?: boolean } }> | undefined} */
  let registry;
  let registryLoadP;
  let registrySequence = 0n;
  const loadRegistry = () => {
    if (registry) return Promise.resolve(registry);
    if (!registryLoadP) {
      registryLoadP = (async () => {
        const names = await E(powers).list();
        const journalNames = (Array.isArray(names) ? names : [])
          .filter(
            name =>
              typeof name === 'string' &&
              name.startsWith(REGISTRY_PREFIX) &&
              /^[0-9]{20}$/.test(name.slice(REGISTRY_PREFIX.length)),
          )
          .sort();
        if (journalNames.length > 0) {
          const latestName = journalNames.at(-1);
          const stored = await E(powers).lookup(latestName);
          if (
            stored?.version !== 1 ||
            !Array.isArray(stored.sessions) ||
            typeof stored.sequence !== 'bigint' ||
            latestName !==
              `${REGISTRY_PREFIX}${`${stored.sequence}`.padStart(20, '0')}`
          ) {
            throw Error('Floot lifecycle registry journal is corrupt');
          }
          for (const entry of stored.sessions) {
            assertSessionIdentity(entry);
            if (entry.contextLength !== undefined) {
              (apiProvider(entry.backendId) &&
                typeof entry.contextLength === 'number' &&
                Number.isInteger(entry.contextLength) &&
                Number(entry.contextLength) > 0 &&
                Number(entry.contextLength) <= 0xffff_ffff) ||
                Fail`Invalid retained provider context window`;
            }
            if (['fae-codex', 'fae-claude'].includes(entry.backendId)) {
              (entry.backendId === 'fae-claude'
                ? assertSubscriptionMessagesRecipe
                : assertSubscriptionResponsesRecipe)(entry.inferenceRecipe);
              (entry.inferenceRecipe.model === entry.modelId &&
                (entry.inferenceRecipe.reasoningEffort || '') ===
                  (entry.reasoningEffort || '')) ||
                Fail`Floot inference recipe differs from session identity`;
            } else
              !Object.hasOwn(entry, 'inferenceRecipe') ||
                Fail`Unexpected Floot inference recipe`;
            if (
              typeof entry.systemPrompt !== 'string' ||
              entry.systemPrompt.trim() === ''
            ) {
              throw Error(
                'Floot session lacks a captured system prompt; retire legacy sessions with the previous release',
              );
            }
          }
          registry = [...stored.sessions];
          registrySequence = stored.sequence + 1n;
        } else if (
          (Array.isArray(names) ? names : []).some(name =>
            ['floot-sessions', 'floot-sessions-backup'].includes(name),
          )
        ) {
          // Do not silently expose an empty registry over unrecognized state.
          // A valid modern snapshot wins over inert legacy roots above.
          throw Error(
            'Floot legacy registry is unsupported; use a fresh factory',
          );
        } else {
          registry = [];
        }
        return registry;
      })().catch(error => {
        registryLoadP = undefined;
        throw error;
      });
    }
    return registryLoadP;
  };
  // Serialize append-only lifecycle snapshots. Every registry version has a
  // unique name, so a crash leaves either the previous complete snapshot or the
  // next complete snapshot; it can never erase the sole recovery record.
  let registryWrite = Promise.resolve();
  const saveRegistry = () => {
    // Every lifecycle change comes through here, so this is where the session
    // list's viewers hear of it. Told at once rather than after the write:
    // the list they are shown is the registry in memory, the same one
    // `listSessions` reads.

    touchSessionList();
    const result = registryWrite.then(async () => {
      const sequence = registrySequence;
      // Reserve the name before the remote write: a rejected acknowledgement
      // does not prove that storeValue failed to commit. Later saves must use
      // a new name rather than colliding forever with that uncertain snapshot.
      registrySequence += 1n;
      const name = `${REGISTRY_PREFIX}${`${sequence}`.padStart(20, '0')}`;
      await E(powers).storeValue(
        harden({
          version: 1,
          sequence,
          sessions: harden([...(registry || [])]),
        }),
        name,
      );
      // Append-only was never meant to be unbounded: every lifecycle
      // transition wrote a snapshot and nothing removed one, so the factory
      // host's pet store accumulated a full copy of the session array per
      // operation and every cold start listed and sorted all of them. Trim
      // only after the new snapshot is durable, so the journal is never
      // momentarily empty, and keep a few behind it so a snapshot that turns
      // out to be unreadable is not the only record.
      if (sequence >= BigInt(REGISTRY_JOURNAL_DEPTH)) {
        const oldest = sequence - BigInt(REGISTRY_JOURNAL_DEPTH);
        // Retry every obsolete name, including a removal whose acknowledgement
        // failed in an earlier incarnation. Never revive old snapshot payloads.
        const staleNames = (await E(powers).list()).filter(
          staleName =>
            /^floot-sessions-v1-\d{20}$/.test(staleName) &&
            BigInt(staleName.slice(REGISTRY_PREFIX.length)) <= oldest,
        );
        for (const staleName of staleNames) {
          await E(powers)
            .remove(staleName)
            .catch(error => {
              console.error('[floot-factory] registry pruning failed:', error);
            });
        }
      }
    });
    // Preserve rejection for the caller while keeping later writes possible
    // and recording failures even when callers discard their promise.
    registryWrite = result.catch(error => {
      console.error('[floot-factory] session registry save failed:', error);
    });
    return ownership.track(result);
  };

  // ── What views are told ────────────────────────────────────────────────────
  // A view subscribes (`session.watch()`, `factory.watchSessions()`) instead of
  // asking again on a timer; see src/session-watch.js. The maps below are the
  // parts of a session's state that are cheap to read synchronously, which is
  // what lets a snapshot be taken in the same step that registers its viewer.
  /** @type {Map<string, ReturnType<typeof makeSessionTurnSlot>>} */
  const turnSlots = new Map();
  /** @type {Map<string, ReturnType<typeof makeSessionWatch> & {watchRecent: () => Promise<object>}>} */
  const sessionWatches = new Map();
  /** @type {Map<string, ReturnType<typeof makeSessionSubmissions>>} */
  const submissions = new Map();
  // Sessions whose agent is running a turn of any origin — UI, mail, queue —
  // each with that turn's own record, so a late "settled" clears only its own.
  /** @type {Map<string, { input: string, from?: string }>} */
  const workingSessions = new Map();
  /** @type {Map<string, { lastTurnState: string, needsRecovery: boolean }>} */
  const lastTurns = new Map();
  // Reads of a session's last turn can finish out of order; only the latest
  // one asked for is kept.
  /** @type {Map<string, number>} */
  const lastTurnReads = new Map();
  // Sessions whose agent could not be built. The reason is in the log; here
  // it only colours the circle.
  /** @type {Set<string>} */
  const revivalFailures = new Set();
  // The record a viewer is shown for a turn in flight: display text and the
  // turn, never the history promise the slot also carries. Keyed by the slot's
  // own entry so the same turn is always the same record (the watch compares
  // by identity).
  /** @type {WeakMap<object, object>} */
  const turnViews = new WeakMap();
  const turnViewOf = id => {
    const current = turnSlots.get(id)?.getCurrent();
    if (!current) return null;
    let view = turnViews.get(current);
    if (!view) {
      view = harden({
        input: current.input,
        turn: current.turn,
        ...(current.pendingId ? { pendingId: current.pendingId } : {}),
      });
      turnViews.set(current, view);
    }
    return view;
  };
  /**
   * What a session's status circle shows.
   */
  /**
   * @param {{ id: string, lifecycle?: string, executionState?: string }} entry
   * @returns {'passive' | 'working' | 'error'}
   */
  const activityOf = entry => {
    const { id } = entry;
    const lifecycle = entry.lifecycle || 'ready';
    // Being made or being removed is work in progress, not a fault.
    if (lifecycle === 'creating' || lifecycle === 'deleting') return 'working';
    if (lifecycle !== 'ready') return 'error';
    if (turnSlots.get(id)?.getCurrent() || workingSessions.has(id))
      return 'working';
    // A stopped session is at rest by the operator's own hand. Its last turn
    // is not read at start (a stopped session is not revived), so judging it
    // by that turn would show one thing before a restart and another after.
    if (entry.executionState && entry.executionState !== 'running')
      return 'passive';
    if (revivalFailures.has(id)) return 'error';
    const last = lastTurns.get(id);
    if (last && (last.needsRecovery || last.lastTurnState === 'failed'))
      return 'error';
    return 'passive';
  };
  // The model an unpinned provider session resolves to right now. Read once
  // per listing rather than per session.
  const configuredProviderModel = async () => {
    try {
      return `${(await getProviderConfig()).model || ''}`;
    } catch {
      return '';
    }
  };
  /**
   * @param {any} entry
   * @param {string} providerModel see `configuredProviderModel`
   */
  const projectSessionEntry = (entry, providerModel) => {
    const {
      id,
      title,
      createdAt,
      presetId,
      backendId,
      modelId,
      reasoningEffort,
      lifecycle,
      parentSessionId,
      subagentName,
    } = entry;
    return harden({
      id,
      title,
      createdAt,
      presetId: presetId || DEFAULT_PRESET_ID,
      model: isHostedSession(entry)
        ? providerModelId(backendId, modelId)
        : modelId,
      backendId,
      modelId,
      // What the session runs, pinned or not: an unpinned provider session
      // resolves to the configured model at each turn, so this is as of now.
      effectiveModelId:
        modelId || (isHostedSession(entry) ? '' : providerModel),
      reasoningEffort: reasoningEffort || '',
      // Which of its backend's subscriptions the session uses: `auto`, or the
      // id it was pinned to when it was created.
      subscription: entry.subscription || 'auto',
      lifecycle: lifecycle || 'ready',
      // Legacy roots default to visible; dedicated workflow sessions opt out.
      // A delegate is never a user-initiated conversation.
      userInitiated: !parentSessionId && entry.userInitiated !== false,
      // Parentage remains available for operator inspection of the tree.
      parentSessionId: parentSessionId || '',
      subagentName: subagentName || '',
      activity: activityOf(entry),
      // Submissions waiting their turn (see `submissionsFor`), so a list can
      // say a session has messages held for the user without opening it.
      pendingCount: submissions.get(id)?.read().entries.length || 0,
    });
  };
  const projectSessions = async () => {
    await loadRegistry();
    const providerModel = await configuredProviderModel();
    return (registry || []).map(entry =>
      projectSessionEntry(entry, providerModel),
    );
  };
  const sessionListWatch = makeSessionListWatch(projectSessions);
  const touchSessionList = () => sessionListWatch.touch();
  /**
   * @param {string} id
   * @param {'transcript' | 'network' | 'usage' | 'journal'} [kind]
   */
  const touchSession = (id, kind) => {
    sessionWatches.get(id)?.touch(kind);
    touchSessionList();
  };
  /**
   * @param {string} id
   * @param {{ getActivity: () => Promise<{ lastTurnState: string, needsRecovery: boolean }> }} agent
   */
  const refreshLastTurn = async (id, agent) => {
    const read = (lastTurnReads.get(id) || 0) + 1;
    lastTurnReads.set(id, read);
    try {
      const { lastTurnState, needsRecovery } = await agent.getActivity();
      // Not a later read's business, and not a deleted session's.
      if (
        lastTurnReads.get(id) !== read ||
        !(registry || []).some(session => session.id === id)
      )
        return;
      lastTurns.set(id, { lastTurnState, needsRecovery });
      touchSessionList();
    } catch {
      // The circle keeps what it last showed.
    }
  };

  // Per-session in-process streaming agent, built lazily over the session
  // guest's powers. provideGuest is idempotent, so this both creates a fresh
  // session guest and revives an existing one after a restart.
  /** @type {Map<string, Promise<any>>} */
  const agents = new Map();
  /**
   * A rejected construction is not evidence that no agent was returned: its
   * final shutdown may have failed. Cleanup can retry that exact agent, while
   * ordinary acquisition continues to receive the cached rejection.
   * @type {WeakMap<Promise<any>, { agent: Awaited<ReturnType<typeof makeStreamingAgent>> | undefined }>}
   */
  const failedConstructions = new WeakMap();
  /** @param {Promise<any>} pending */
  const agentForCleanup = pending =>
    pending.catch(error => {
      if (!failedConstructions.has(pending)) throw error;
      return failedConstructions.get(pending)?.agent;
    });
  const stopFences = new Set();
  const retirementFences = new Set();
  const stopFlights = new Map();
  const resumeTokens = new Map();
  const creatingIds = new Set();
  // Synchronous allocation makes concurrent IDs distinct even if the clock
  // and random prefix repeat. Durable namespaces still guard reincarnations.
  let creationOrdinal = 0n;
  // Retain this fence after an uncertain first registry write. Only revival
  // from a durable snapshot may recover that creation in another incarnation.
  const publicationFences = new Set();
  const assertPublished = id => {
    if (publicationFences.has(id))
      throw Error(
        'Session initial registry publication is pending or uncertain',
      );
  };
  const assertSessionAdmission = id => {
    ownership.assertOpen();
    if (retirementFences.has(id)) throw Error('Session retirement in progress');
    assertPublished(id);
    const entry = (registry || []).find(session => session.id === id);
    if (
      stopFences.has(id) ||
      ['deleting', 'error'].includes(entry?.lifecycle) ||
      (entry?.executionState && entry.executionState !== 'running')
    )
      throw Error(
        'Session is stopped or stopping; explicitly resume it in Settings',
      );
  };
  const setExecutionState = async (id, executionState) => {
    const index = (registry || []).findIndex(session => session.id === id);
    if (index < 0 || !registry) throw Error('Unknown Floot session');
    registry[index] = harden({ ...registry[index], executionState });
    touchSession(id);
    await saveRegistry();
  };
  /**
   * One projection for the call and for the subscription, so they cannot
   * disagree.
   *
   * @param {string} id
   * @param {{ executionState?: string, backendId: string, presetId?: string } | undefined} entry
   */
  const projectExecution = (id, entry) => {
    // A resume fences the session while it publishes permission to run, so
    // the fence alone would read as "stopping" on the way from stopped to
    // running. Until the resume lets go it is still stopped.
    let state = entry?.executionState || 'running';
    if (resumeTokens.has(id)) state = 'stopped';
    else if (stopFences.has(id)) state = 'stopping';
    return harden({
      state,
      supported:
        !isHostedSession(entry) && presetHasShell(sessionPreset(entry)),
    });
  };
  const executionState = async id =>
    projectExecution(id, await assertSessionReady(id));
  const emergencyStop = id => {
    const existing = stopFlights.get(id);
    if (existing) return existing;
    // Fence synchronously, before persistence, inbox shutdown, or native calls.
    stopFences.add(id);
    resumeTokens.delete(id);
    touchSession(id);
    // Whatever is queued waits for the user, even after a resume: resuming
    // never replays a prompt, queued or not.
    void submissionsFor(id)
      .holdForStop()
      .catch(error => {
        console.error('[floot-factory] could not hold the queue:', error);
      });
    const stopping = (async () => {
      const entry = await assertSessionReady(id);
      if (isHostedSession(entry) || !presetHasShell(sessionPreset(entry))) {
        stopFences.delete(id);
        throw Error('This backend has no hosted sandbox to stop');
      }
      const failures = [];
      const attempt = async operation => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      // Persistence failure must not prevent withdrawing live authority.
      const intent = attempt(() => setExecutionState(id, 'stopping'));
      const pending = agents.get(id);
      const shutdown = pending
        ? agentForCleanup(pending).then(agent => agent?.shutdown(true))
        : undefined;
      // Final shutdown retries after native stop releases blocked readers.
      void shutdown?.catch(() => undefined);
      const stopNative = async () => {
        const environment = await developmentAdmin(id);
        if (environment) await E(environment).stop();
      };
      await attempt(stopNative);
      // Observe late acquisition before claiming completion. The admission
      // fence prevents new acquisitions and the second stop covers late ones.
      const agent = pending ? await agentForCleanup(pending) : undefined;
      await attempt(stopNative);
      if (agent) await attempt(() => agent.shutdown(true));
      await intent;
      if (failures.length)
        throw new AggregateError(
          failures,
          'Session stop incomplete; retry in Settings',
        );
      await setExecutionState(id, 'stopped');
      stopFences.delete(id);
      return executionState(id);
    })().finally(() => {
      stopFlights.delete(id);
      touchSession(id);
    });
    stopFlights.set(id, stopping);
    return stopping;
  };
  const resumeSession = async id => {
    const entry = await assertSessionReady(id);
    if (
      stopFlights.has(id) ||
      stopFences.has(id) ||
      entry.executionState === 'stopping'
    )
      throw Error('Finish emergency stop before resuming');
    if (entry.executionState !== 'stopped') return executionState(id);
    // Keep the exact stopped incarnation fenced until its private storage
    // acknowledges closure. An idle record reader does not own an agent.
    const observer = agents.get(id);
    const token = harden({});
    resumeTokens.set(id, token);
    stopFences.add(id);
    const assertCurrentResume = () => {
      ownership.assertOpen();
      if (resumeTokens.get(id) !== token)
        throw Error('Resume superseded by emergency stop');
    };
    let publishing = false;
    try {
      const agent = await observer;
      assertCurrentResume();
      await agent?.shutdown(true);
      assertCurrentResume();
      // Snapshot exact facets, not a live Map iterator. A superseding stop
      // and later resume must not let this continuation close their successor.
      await closeRecords(id);
      assertCurrentResume();
      publishing = true;
      await setExecutionState(id, 'running');
      assertCurrentResume();
      resumeTokens.delete(id);
      if (agents.get(id) === observer) agents.delete(id);
      stopFences.delete(id);
    } catch (error) {
      if (resumeTokens.get(id) === token) {
        resumeTokens.delete(id);
        // Before publication the durable state remains stopped. A failed
        // publication may have committed: keep its stop fence for explicit
        // emergency-stop recovery instead of guessing that it did not.
        if (!publishing) stopFences.delete(id);
        touchSession(id);
      }
      throw error;
    }
    touchSession(id, 'transcript');
    await getAgent(id);
    void submissions.get(id)?.pump();
    return executionState(id);
  };
  const networkControllers = new Map();
  const networkStorages = new Map();
  // Sessions whose incarnation is being replaced: a network policy change or
  // a rebind stops the old one and provisions the next.
  const incarnationChanges = new Set();
  const developmentAdmin = async id => {
    const entry = (await loadRegistry()).find(item => item.id === id);
    return presetHasShell(sessionPreset(entry))
      ? lookupEnvironmentAdmin(getHost(), id, { checkGuest: true })
      : undefined;
  };
  const networkController = id => {
    if (!networkControllers.has(id)) {
      const storage = providePrivateNetworkStorage(getHost(), id);
      // E sends below observe failures; do not leave a rejected open unhandled.
      void storage.catch(() => {});
      networkStorages.set(id, storage);
      networkControllers.set(
        id,
        makeSessionNetworkPolicy({
          host: storage,
          id,
          onChange: () => touchSession(id, 'network'),
          supported: async () => {
            const entry = (await loadRegistry()).find(item => item.id === id);
            if (!entry) throw Error('Unknown Floot session');
            const preset = sessionPreset(entry);
            if (!presetHasShell(preset)) return [];
            return preset.shellNetworkPolicies || DEVELOPMENT_NETWORK_POLICIES;
          },
          prepare: async () => {
            const admin = await developmentAdmin(id);
            if (admin) await E(admin).stop();
            await stopIncarnation(id);
          },
          change: async policy => {
            const admin = await developmentAdmin(id);
            if (admin) await E(admin).setNetworkPolicy(policy);
            await releaseIncarnation(id);
          },
        }),
      );
    }
    return networkControllers.get(id);
  };
  /**
   * Stop a session's incarnation and release what the factory holds of it,
   * so the next `getAgent` provisions afresh. A network policy change runs
   * the two halves around its durable transition intent; a rebind runs them
   * together.
   * @param {string} id
   */
  const stopIncarnation = async id => {
    const pending = agents.get(id);
    if (pending) await (await pending).stopForReplacement();
  };
  /** @param {string} id */
  const releaseIncarnation = async id => {
    // changeIncarnation fences all acquisition while the old agent and native
    // resources drain. Close its storage before dropping that agent: failed
    // or uncertain closure must not admit a fresh writer. This releases only
    // in-memory handles, not the durable namespace needed by the replacement.
    await closeRecords(id);
    agents.delete(id);
  };
  const changeIncarnation = async (id, operation) => {
    assertSessionAdmission(id);
    if (incarnationChanges.has(id))
      throw Error('Session incarnation change already in progress');
    incarnationChanges.add(id);
    let result;
    try {
      const pending = agents.get(id);
      if (pending) (await pending).assertIdleForReplacement();
      result = await operation(networkController(id));
    } finally {
      incarnationChanges.delete(id);
      // A submission that waited out the change may run now — whether the
      // change succeeded or not: either way the session admits work again.
      void submissions.get(id)?.pump();
    }
    // Mail-only sessions must resume without depending on a UI history read.
    await getAgent(id);
    return result;
  };
  const getAgent = (id, { observeOnly = false } = {}) => {
    ownership.assertOpen();
    assertPublished(id);
    const recorded = (registry || []).find(session => session.id === id);
    if (
      !recorded ||
      !['ready', 'creating'].includes(recorded.lifecycle || 'ready')
    )
      throw Error(
        `Session "${id}" cannot open an incarnation during or after deletion`,
      );
    if (isHostedSession(recorded))
      throw Error('This session used a retired harness');
    if (!observeOnly) assertSessionAdmission(id);
    if (resumeTokens.has(id)) throw Error('Session resume in progress');
    if (incarnationChanges.has(id))
      throw Error('Session incarnation change in progress');
    let agentP = agents.get(id);
    if (!agentP) {
      if (observeOnly && stopFlights.has(id))
        throw Error(
          'Session cleanup is in progress; retry reading records after it settles',
        );
      /** @type {{ input: string, from?: string } | undefined} */
      let runningTurn;
      /** @type {Awaited<ReturnType<typeof providePrivateTurnStorage>> | undefined} */
      let journalPowers;
      /** @type {Awaited<ReturnType<typeof makeStreamingAgent>> | undefined} */
      let constructedAgent;
      let ownedProvider;
      agentP = (async () => {
        const host = getHost();
        await prepareSessionStorage(host, id);
        const store = await sessionRecords(id);
        journalPowers = store.storage;
        const network = networkController(id);
        const networkPolicy = await network.forTurn();
        const handleName = sessionStoragePath(id, 'handle');
        const agentName = sessionStoragePath(id, 'guest');
        // provideGuest revives by handle. Never let a missing handle silently
        // replace a retained guest (or accept a handle without its control facet).
        if (
          (await E(host).has(...handleName)) !==
          (await E(host).has(...agentName))
        )
          throw Error(
            'Session guest/handle publication is incomplete; retain resources for recovery',
          );
        // provideGuest is idempotent (create-or-revive). The petname we pass
        // (and provideGuest's return value) bind to the guest's *handle* — a
        // mail-only facet that, after a restart, has none of the petstore/mail
        // control methods. So we pass an explicit agentName and look the
        // controlling *agent* up by that name to get the full guest facet for
        // the session's powers (the same agent fae runs its driver against).
        await E(host).provideGuest(handleName, { agentName });
        const sessionGuest = await E(host).lookup(agentName);
        // Introduce the user to the session under the petname "user" so the
        // agent can mail them directly (send/reply target "user"). The factory
        // host's own "@host" is the user — the @agent that provisioned the
        // factory — so copy it into the guest's petstore. A session's own
        // "@host" is this factory host, not the user, which is why a plain
        // send("@host") never reaches them. Idempotent: skip if already present
        // (the guest's petstore survives restarts).
        try {
          if (!(await E(sessionGuest).has('user'))) {
            await E(host).copy(['@host'], [...agentName, 'user']);
          }
        } catch (err) {
          console.warn(
            `[floot-factory] could not register "user" for session ${id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
        // Resolve the session's preset to pick its system prompt and provision
        // its objects. The prompt was snapshotted into the registry at creation
        // (so catalog edits don't retroactively change live sessions); the
        // authority recipe is also snapshotted: edits never grant new powers
        // to a retained session or its later delegates.
        await loadRegistry();
        const entry = (registry || []).find(s => s.id === id);
        const suspended =
          stopFences.has(id) ||
          (entry?.executionState && entry.executionState !== 'running');
        if (suspended && !observeOnly) assertSessionAdmission(id);
        const preset = sessionPreset(entry);
        const sessionPrompt = entry.systemPrompt;
        await provisionPresetObjects(
          host,
          agentName,
          sessionGuest,
          id,
          preset.objects,
          codePath,
          networkPolicy,
          {
            shellTimeoutMs: workload.shellTimeoutMs,
            shellOutputBytes: workload.shellOutputBytes,
          },
        );
        for (const endowment of preset.endowments) {
          if (!(await E(sessionGuest).has(endowment.petName)))
            await E(sessionGuest).storeValue(
              endowment.value,
              endowment.petName,
            );
        }
        // Shells and workspace tools are selected by the preset.
        /** @type {Map<string, any>} */
        let extraTools = new Map();
        try {
          extraTools = await buildExtraTools(id, sessionGuest, preset);
          if (networkPolicy !== undefined) {
            extraTools.set(
              'getSandboxNetworkPolicy',
              harden({
                schema: () =>
                  harden({
                    type: 'function',
                    function: {
                      name: 'getSandboxNetworkPolicy',
                      description:
                        'Read the sandbox network policy and pending operator request. Does not change permissions.',
                      parameters: {
                        type: 'object',
                        properties: {},
                        additionalProperties: false,
                      },
                    },
                  }),
                execute: async args => {
                  if (!args || Object.keys(args).length)
                    throw Error('Expected empty arguments');
                  return JSON.stringify(await network.get());
                },
                help: () =>
                  'getSandboxNetworkPolicy({}) reads configured network policy and any pending approval request.',
              }),
            );
            extraTools.set(
              'requestNetworkPolicyChange',
              harden({
                schema: () =>
                  harden({
                    type: 'function',
                    function: {
                      name: 'requestNetworkPolicyChange',
                      description:
                        'Request operator approval to change sandbox network access. This does not grant access. Finish your turn and wait for approval; never bypass the current policy. Public internet means HTTP/HTTPS only; Endo capability authority is separate.',
                      parameters: {
                        type: 'object',
                        properties: {
                          policy: {
                            type: 'string',
                            enum: ['off', 'public-internet'],
                          },
                          reason: { type: 'string' },
                        },
                        required: ['policy', 'reason'],
                        additionalProperties: false,
                      },
                    },
                  }),
                execute: async args => {
                  if (
                    !args ||
                    Object.keys(args).sort().join(',') !== 'policy,reason'
                  )
                    throw Error('Provide exactly policy and reason');
                  return JSON.stringify(
                    await network.request(args.policy, args.reason),
                  );
                },
                help: () =>
                  'requestNetworkPolicyChange({policy:"public-internet",reason:"Download Rust dependencies"}) requests approval only. Finish the turn; an operator approves or denies while idle.',
              }),
            );
          }
        } catch (error) {
          if (presetHasShell(preset)) throw error;
          console.error(
            `[floot-factory] could not build extra tools for session ${id}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
        // Build (or reuse) the backend for this session's pinned model; an
        // unpinned session follows the factory's configured default.
        /** @type {import('./session/runtime-config.js').RuntimeConfig} */
        const agentConfig = suspended
          ? { kind: 'records-only' }
          : connections.open(entry, id);
        ownedProvider = agentConfig.disposeProvider;

        // A session may delegate only while its own depth leaves room. The
        // spawner is rebuilt on every revival rather than persisted, so the
        // durable record of the tree is the session registry alone.
        const sessionDepth = Number(entry?.subagentDepth) || 0;
        const agent = await makeStreamingAgent(
          sessionGuest,
          undefined,
          agentConfig,
          sessionPrompt,
          harden({
            maxToolRounds,
            transcriptLimits: workload.transcriptLimits,
            subagentLimits: workload.subagentLimits,
            journalPowers,
            journal: store.journal,
            attachments: makeSessionAttachments(host, sessionGuest, id),
            backendId: entry.backendId,
            modelId: await sessionModelId(entry),
            contextLength:
              entry.inferenceRecipe?.contextLength ?? entry.contextLength,
            forceCompaction: env?.FLOOT_FORCE_COMPACTION === 'true',
            ...(presetHasShell(preset)
              ? {
                  stopEnvironment: async () => {
                    const admin = await lookupEnvironmentAdmin(host, id, {
                      required: true,
                    });
                    await E(admin).stop();
                  },
                }
              : {}),
            reasoningEffort: entry?.reasoningEffort || '',
            onChange: (kind, detail) => {
              const watch = sessionWatches.get(id);
              if (kind === 'turn-started') {
                // This turn's own record: the settle below clears only the
                // turn it belongs to, never one a later incarnation started.
                runningTurn = harden({ input: '', ...detail });
                if (agents.get(id) === agentP) {
                  workingSessions.set(id, runningTurn);
                }
                watch?.touch('journal');
                touchSessionList();
                return;
              }
              const settled = runningTurn;
              if (kind === 'turn-settled') runningTurn = undefined;
              // The session's own viewers hear at once. The list waits until
              // the new last turn has been read, so a failed turn's circle
              // goes working → error without showing passive in between.
              watch?.touch('transcript');
              watch?.touch('usage');
              watch?.touch('journal');
              void agentP
                .then(built => refreshLastTurn(id, built))
                .finally(() => {
                  if (settled && workingSessions.get(id) === settled) {
                    workingSessions.delete(id);
                    sessionWatches.get(id)?.touch();
                  }
                  touchSessionList();
                });
            },
            ...(extraTools.size > 0 ? { extraTools } : {}),
            ...(sessionDepth < maxSubagentDepth
              ? { spawner: makeSessionSpawner(id, sessionDepth + 1) }
              : {}),
            readAccounts: async refresh => {
              const current = await assertSessionReady(id);
              return readSessionAccounts(powers, current, refresh);
            },
          }),
        );
        constructedAgent = agent;
        // Each session is addressable by mail: start following its inbox.
        if (ownership.isClosed() || suspended || stopFences.has(id))
          await agent.shutdown(true);
        else agent.startInbox();
        revivalFailures.delete(id);
        void refreshLastTurn(id, agent);
        return agent;
      })().catch(async error => {
        // Keep this construction cached through rollback so another request
        // cannot open a successor while its old resources are still closing.
        failedConstructions.set(agentP, { agent: constructedAgent });
        workingSessions.delete(id);
        if (!observeOnly) {
          revivalFailures.add(id);
          touchSessionList();
        }
        try {
          if (constructedAgent) await constructedAgent.shutdown(true);
          else await ownedProvider?.();
          if (journalPowers) {
            await closeRecords(id);
          }
        } catch (cleanupError) {
          // Retain the failed promise and exact owners. Explicit cleanup can
          // retry them; an ordinary observation must not install a new writer.
          throw new AggregateError(
            [error, cleanupError],
            `Floot session ${id} setup and hosted-backend rollback failed`,
            { cause: cleanupError },
          );
        }
        if (agents.get(id) === agentP) agents.delete(id);
        throw error;
      });
      agents.set(id, ownership.track(agentP));
    }
    return agentP;
  };

  // Opaque session facet handed to the UI. It exposes a streaming conversation
  // and a history replay, but never reveals the backing guest.
  /** @type {Map<string, object>} */
  const facets = new Map();
  const assertSessionReady = async id => {
    await loadRegistry();
    assertPublished(id);
    const entry = (registry || []).find(session => session.id === id);
    if (!entry) throw Error(`Unknown session "${id}".`);
    if ((entry.lifecycle || 'ready') !== 'ready') {
      throw Error(
        `Session "${id}" is not operable while lifecycle is ${entry.lifecycle}`,
      );
    }
    return entry;
  };
  const turnSlotFor = id => {
    let slot = turnSlots.get(id);
    if (!slot) {
      slot = makeSessionTurnSlot(
        async (input, writer, signal, setHistory, options) => {
          await assertSessionReady(id);
          const agent = await getAgent(id);
          await agent.converse(
            input,
            writer,
            options.message ? harden({ message: options.message }) : undefined,
            signal,
            setHistory,
            options.onBegun,
            options.mentions,
          );
        },
        () => {
          touchSession(id);
          // The slot emptied (or filled): the head of the queue may run now.
          void submissions.get(id)?.pump();
        },
        presentation?.turnView,
      );
      turnSlots.set(id, slot);
    }
    return slot;
  };
  // A session's submissions that are waiting their turn: a durable queue and
  // the pump that starts its head (src/pending-queue.js,
  // src/session-submissions.js). Held here, not in a page, so a message sent
  // behind a running turn outlives the tab that sent it.
  const submissionsFor = id => {
    let entry = submissions.get(id);
    if (!entry) {
      entry = makeSessionSubmissions({
        queue: makePendingQueue({
          host: makeSessionQueueStorage(getHost(), id),
          id,
          onChange: () => touchSession(id),
        }),
        getCurrentTurn: () => turnSlots.get(id)?.getCurrent() || null,
        // Why the session admits no work right now. Transient: the pump is
        // run again from wherever one of these can change.
        refusal: () => {
          if (ownership.isClosed())
            return 'Floot factory incarnation is closed';
          const registered = (registry || []).find(item => item.id === id);
          if (!registered) return 'Unknown session';
          if (retirementFences.has(id)) return 'Session retirement in progress';
          if ((registered.lifecycle || 'ready') !== 'ready')
            return `Session is ${registered.lifecycle}`;
          if (
            stopFences.has(id) ||
            (registered.executionState &&
              registered.executionState !== 'running')
          )
            return 'Session is stopped or stopping';
          if (incarnationChanges.has(id))
            return 'Session incarnation change in progress';
          return '';
        },
        startTurn: (text, options) => {
          assertSessionAdmission(id);
          return turnSlotFor(id).start(text, options);
        },
        onChange: () => touchSession(id),
      });
      submissions.set(id, entry);
    }
    return entry;
  };
  const readSession = async (id, read) => {
    await assertSessionReady(id);
    if (resumeTokens.has(id)) throw Error('Session resume in progress');
    if (stopFlights.has(id))
      throw Error('Session is stopped or stopping; retry reading records');
    if (incarnationChanges.has(id))
      throw Error('Session incarnation change in progress');
    const { reader } = await sessionRecords(id);
    const result = await read(reader);
    await assertSessionReady(id);
    return result;
  };
  const sessionWatchFor = id => {
    let watch = sessionWatches.get(id);
    if (!watch) {
      const makeWatch = recent =>
        makeSessionWatch({
          loadTranscript: () =>
            readSession(id, reader =>
              recent ? reader.getHistoryPage() : reader.getSettledHistory(),
            ),
          deferUsage: recent,
          readTurn: () => turnViewOf(id),
          readRunning: () => workingSessions.get(id) || null,
          // Not `submissionsFor`: a sync running after the session was deleted
          // must not bring its queue back.
          readPending: () =>
            submissions.get(id)?.read() || harden({ entries: [], hold: null }),
          readExecution: () => {
            const entry = (registry || []).find(session => session.id === id);
            return projectExecution(id, entry);
          },
          loadNetwork: () => networkController(id).get(),
          loadUsage: () => readSession(id, reader => reader.getUsage()),
        });
      const full = makeWatch(false);
      const recent = makeWatch(true);
      watch = harden({
        watch: full.watch,
        watchRecent: recent.watch,
        touch: kind => {
          full.touch(kind);
          recent.touch(kind);
        },
        end: () => {
          full.end();
          recent.end();
        },
      });
      sessionWatches.set(id, watch);
    }
    return watch;
  };
  const getFacet = id => {
    let facet = facets.get(id);
    if (!facet) {
      const turns = turnSlotFor(id);
      facet = makeOwnedExo('FlootSession', FlootSessionInterface, {
        getExecutionState: () => executionState(id),
        emergencyStop: () => emergencyStop(id),
        resume: () => resumeSession(id),
        async getInfo() {
          const entry = await assertSessionReady(id);
          return harden({
            id,
            title: entry?.title || '',
            createdAt: entry?.createdAt || 0,
            presetId: entry?.presetId || DEFAULT_PRESET_ID,
            model: isHostedSession(entry)
              ? providerModelId(entry.backendId, entry.modelId)
              : entry.modelId,
            backendId: entry.backendId,
            modelId: entry.modelId,
            effectiveModelId:
              entry.modelId ||
              (isHostedSession(entry) ? '' : await configuredProviderModel()),
            reasoningEffort: entry?.reasoningEffort || '',
            subscription: entry?.subscription || 'auto',
            lifecycle: entry?.lifecycle || 'ready',
          });
        },
        /**
         * Start a turn and hand back a handle to it. The daemon owns the turn:
         * it drains the reply channel locally and persists the result, so a
         * caller that stops observing — an unmounted component, a closed tab, a
         * dropped gateway — does not stop the work. Only `cancel()` does.
         *
         * This is the same authority the inbox path already has: a mail turn
         * runs against a daemon-side buffering writer and nobody's disconnect
         * can end it. Handing the reply channel itself to the browser gave the
         * UI turn a weaker guarantee than the mail turn, which is backwards.
         *
         * @param {string | object} input
         * @returns {object} a FlootTurn
         */
        startTurn(input) {
          assertSessionAdmission(id);
          return turns.start(input);
        },
        async getCurrentTurn() {
          await assertSessionReady(id);
          const current = turns.getCurrent();
          if (!current) return null;
          return current;
        },
        /**
         * Subscribe to this session: a snapshot of its settled transcript, the
         * turn in flight, queued submissions, execution state and network
         * policy, then an event whenever one of them changes — whoever changed
         * it. Closing the stream detaches this viewer only.
         */
        async watch() {
          await assertSessionReady(id);
          // Read the queue first, so the snapshot says what is waiting.
          await submissionsFor(id).ready();
          return sessionWatchFor(id).watch();
        },
        async watchRecent() {
          await assertSessionReady(id);
          await submissionsFor(id).ready();
          return sessionWatchFor(id).watchRecent();
        },
        /**
         * Accept a message. It becomes a turn at once if nothing is ahead of
         * it, and otherwise waits here — durably, whether or not the caller
         * stays connected — and runs when its turn comes. Returns `{ id }`,
         * the id the queue and the eventual turn (`turn.pendingId`) carry.
         *
         * @param {string} text
         */
        async enqueue(text) {
          await assertSessionReady(id);
          assertSessionAdmission(id);
          return submissionsFor(id).submit(text);
        },
        async enqueueOnce(text, requestId) {
          await assertSessionReady(id);
          assertSessionAdmission(id);
          return submissionsFor(id).submit(text, requestId);
        },
        async enqueueMessageOnce(message, requestId, mentions) {
          await assertSessionReady(id);
          assertSessionAdmission(id);
          message = validateChatMessage(message);
          return submissionsFor(id).submit(
            chatMessageText(message),
            requestId,
            mentions,
            message,
          );
        },
        async getSubmissionReceipt(text, requestId, manifest, message) {
          await assertSessionReady(id);
          return submissionsFor(id).receipt(text, requestId, manifest, message);
        },
        async listPending() {
          await assertSessionReady(id);
          const entry = submissionsFor(id);
          await entry.ready();
          return entry.read();
        },
        async editPending(entryId, text) {
          await assertSessionReady(id);
          await submissionsFor(id).edit(entryId, text);
        },
        async cancelPending(entryId) {
          await assertSessionReady(id);
          return submissionsFor(id).cancel(entryId);
        },
        /**
         * "Send this now": releases a held queue, sends an interrupted
         * message again, and — for the head of the queue only — cuts the
         * running turn short so it can start.
         *
         * @param {string} entryId
         */
        async sendPending(entryId) {
          await assertSessionReady(id);
          assertSessionAdmission(id);
          const { cancelCurrent } = await submissionsFor(id).sendNow(entryId);
          const current = turns.getCurrent();
          // Never the message's own turn, should it have started meanwhile.
          if (cancelCurrent && current && current.pendingId !== entryId)
            await E(current.turn).cancel();
        },
        getHistory: () => readSession(id, reader => reader.getHistory()),
        getHistoryPage: before =>
          readSession(id, reader => reader.getHistoryPage(before)),
        getTranscript: () => readSession(id, reader => reader.getTranscript()),
        getTurns: () => readSession(id, reader => reader.getTurns()),
        getArchivedTurns: () =>
          readSession(id, reader => reader.getArchivedTurns()),
        getArchivedTurnsPage: cursor =>
          readSession(id, reader => reader.getArchivedTurnsPage(cursor)),
        getTurnContent: ref =>
          readSession(id, reader => reader.getTurnContent(ref)),
        getJournalStatus: () =>
          readSession(id, reader => reader.getJournalStatus()),
        async getNetworkPolicy() {
          await assertSessionReady(id);
          return networkController(id).get();
        },
        async setNetworkPolicy(policy) {
          await assertSessionReady(id);
          if (turns.getCurrent())
            throw Error(
              'Cancel or finish the active turn before changing network policy',
            );
          return changeIncarnation(id, controller => controller.set(policy));
        },
        async resolveNetworkPolicyRequest(requestId, approve, note) {
          await assertSessionReady(id);
          if (turns.getCurrent())
            throw Error(
              'Cancel or finish the active turn before deciding a network request',
            );
          return changeIncarnation(id, controller =>
            controller.resolve(requestId, approve, note),
          );
        },
        async resolveTurn(turnId, note) {
          await assertSessionReady(id);
          if (turns.getCurrent())
            throw Error('Cannot resolve while a turn is active');
          await (
            await getAgent(id, { observeOnly: true })
          ).resolveTurn(turnId, note);
        },
        getUsage: () => readSession(id, reader => reader.getUsage()),
        /**
         * Explicit configured accounts, not attribution of past usage.
         * Session totals have no per-account billing provenance.
         *
         * @param {boolean} [refresh]
         */
        async getAccount(refresh) {
          const entry = await assertSessionReady(id);
          const accounts = await readSessionAccounts(powers, entry, refresh);
          await assertSessionReady(id);
          const existing = privateJournals.get(id);
          const usage = existing
            ? await (await existing).reader.getUsage()
            : undefined;
          await assertSessionReady(id);
          return harden({
            ...accounts,
            ...(usage === undefined
              ? {
                  usageUnavailable:
                    'Session is not open; account inspection does not open an agent or acquire a backend.',
                }
              : { usage }),
          });
        },
        help(methodName) {
          if (methodName === 'widgets') return widgetPrompt;
          if (methodName === 'emergencyStop')
            return 'emergencyStop() — Fence new work, withdraw hosted sandbox authority and await native cleanup. Keeps records and workspace. Failures remain stopping and retryable; remote effects may still finish.';
          if (methodName === 'resume')
            return 'resume() — After completed emergency stop, explicitly permit a fresh incarnation. Never replays a prompt.';
          if (methodName === 'getNetworkPolicy')
            return 'getNetworkPolicy() — Report enforced backend support, configured off/public-internet policy, and pending requests. Null policy is not proof of off enforcement.';
          if (methodName === 'setNetworkPolicy')
            return 'setNetworkPolicy(policy) — Operator-only idle-session policy change. Stops old sandbox before the next generation. Public mode permits public HTTP/HTTPS uploads and downloads.';
          if (methodName === 'resolveNetworkPolicyRequest')
            return 'resolveNetworkPolicyRequest(id, approve, note) — Operator-only idle decision for an exact pending request. A model request alone grants nothing.';
          if (methodName === 'getSubmissionReceipt')
            return 'getSubmissionReceipt(text, requestId, manifest, message?) — Recover an acknowledgement without resolving source inventory names. Manifest contains the originally persisted {path, identity} pairs. Returns {id} for an accepted matching request, or null if unknown; never starts work or releases restart holds.';
          if (methodName === 'enqueueMessageOnce')
            return 'enqueueMessageOnce({strings,names}, requestId, references) — Queue a structured Chat message with captured {path,identity,value} attachments. The admitted turn receives a real Endo package and may adopt or adoptTool its references. Unadopted attachments are dismissed after the turn. Reuse the same request ID, message and references on retry; getSubmissionReceipt recovers an accepted send without resolving changed source names.';
          if (methodName === 'enqueueOnce')
            return 'enqueueOnce(text, requestId) — Durable duplicate-safe enqueue. Generate requestId as Date.now() + a hyphen + crypto.randomUUID() before sending, persist it with the draft, and reuse it only for retries of the same text. Receipts survive dispatch and restart for 24 hours; expired IDs are rejected, never submitted again. A duplicate does not release queue restart holds. Requires an updated Floot host.';
          if (methodName === 'enqueue')
            return 'enqueue(text) — Accept a message and return { id }. It becomes a turn at once if nothing is ahead of it; otherwise it waits in the session’s durable queue, whether or not the caller stays connected, and runs when its turn comes. The turn it becomes carries the same id as turn.pendingId. Dispatch is at most once: a message the service was sending when it restarted comes back "interrupted" and is never sent again on its own. A queue that comes back from a restart non-empty, a refused turn, or an emergency stop holds the queue until sendPending() or a new enqueue(). Prefer this to startTurn() for anything a person typed.';
          if (methodName === 'listPending')
            return 'listPending() — { entries: [{ id, text, createdAt, state: "queued" | "dispatching" | "interrupted" }], hold: { reason, message } | null }. The same record watch() publishes as "pending".';
          if (methodName === 'editPending')
            return 'editPending(id, text) — Rewrite a queued message. Refused once it is being sent.';
          if (methodName === 'cancelPending')
            return 'cancelPending(id) — Drop a queued message; true if it was there. Refused once it is being sent.';
          if (methodName === 'sendPending')
            return 'sendPending(id) — Send this now: release a held queue, send an interrupted message again, and, for the head of the queue only, cancel the running turn so it can start.';
          if (methodName === 'watchRecent')
            return 'watchRecent() — Watch a bounded window of settled turns plus live session events. Transcript deltas refer to turn groups {id, receipt?, messages}. The transcript’s before cursor opens the preceding history page.';
          if (methodName === 'getHistoryPage')
            return 'getHistoryPage(before?) — Read up to 32 settled turns in chronological order from private session records. Returns {turns, before}; pass before to read older turns until it is null. Repeated mail receipts can span pages. Reading history does not open an agent.';
          if (methodName === 'watch')
            return 'watch() — For paged history, use watchRecent() and getHistoryPage(). watch() opens a disposable stream of this session’s state; subscribe rather than polling getHistory(). First { type: "snapshot", transcript, transcriptError?, turn, running, pending, execution, network, usage, journalVersion }, where transcript is { version, base: 0, keep: 0, append: messages } or null when it could not be read (transcriptError says why; it is retried). Then one event per change: "transcript" { version, base, keep, append } — keep the first `keep` messages you hold and append the rest; `base` is the version it follows, and an event whose base is not the version you hold means you missed one: reopen. Settled turns only: a running turn is rendered from turn.watch(). "transcript-error" { message }; "turn" { turn: { input, turn, pendingId? } | null } for the UI turn in flight; "running" { running: { input, from? } | null } for whatever the agent is running, including mail turns, which have no UI turn handle; "pending" { pending: { entries, hold } }; "execution"; "network"; "usage"; "journal" { version } (turn records changed: re-read getTurns() if you show them); and "end" when the session is deleted. A turn already in flight when you subscribe is in the snapshot, not in a later "turn" event. Open the stream promptly: a reader not opened within two minutes is closed, and a stream that finishes without "end" (or an event whose base you do not hold) means subscribe again. Closing the stream detaches this viewer only.';
          if (methodName === 'getTurns')
            return 'getTurns() — Durable turn records, including state, Endo tool intents/results, observed native activity, partial usage, `servedBy` (the models a routing provider reports having served the turn’s rounds), errors, and explicit resolutions. Text fields longer than a preview carry a `<field>Ref` for getTurnContent. Settled turns beyond the retained window are in getArchivedTurns.';
          if (methodName === 'getArchivedTurns')
            return 'getArchivedTurns() — All archived settled turn records in archive publication order; materializes the full archive. Prefer getArchivedTurnsPage() for bounded chunk reads.';
          if (methodName === 'getArchivedTurnsPage')
            return 'getArchivedTurnsPage(cursor?) — One committed archive chunk, { records, next }; pass next unchanged until null. Omit cursor to capture a fresh archive boundary. Pages are in publication order, not necessarily turn-ID order. Cursors survive reconstruction of this journal, not deletion/replacement; they confer no authority. Reads do not hydrate full text references. A chunk bounds turn count, not total bytes or lifetime model context.';
          if (methodName === 'getTurnContent')
            return 'getTurnContent(ref) — The full text a turn record refers to by a `<field>Ref` ({ name, chars }).';
          if (methodName === 'getJournalStatus')
            return 'getJournalStatus() — Journal event count, retained and archived turn counts, and storage isolation profile. Private storage excludes ordinary guests, not administrators with factory-host authority.';
          if (methodName === 'resolveTurn')
            return 'resolveTurn(turnId, note) — On an idle session, acknowledge an unknown outcome after independently checking external effects. Preserves evidence and never replays work.';
          return 'Fae session (see help("widgets") for interactive replies): startTurn(input) returns a turn — getStatus(), watch() for a disposable view stream, cancel(), whenFinished() — that runs on the daemon whether or not anyone is watching; getCurrentTurn() recovers { input, turn, history } or null; one UI turn may be outstanding; watchRecent() and getHistoryPage() provide paged history and live updates; watch() subscribes to the session’s state (see help("watch")) — prefer it to calling getHistory() on a timer; enqueue(text) queues a message durably and runs it in turn (see help("enqueue")), with listPending(), editPending(), cancelPending() and sendPending(); getHistory() replays the conversation; getUsage() returns cumulative { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens, reasoningOutputTokens, turns, incompleteTurns, context? } — the five counts are disjoint (a token is in exactly one) and include turns that failed or were stopped, which `incompleteTurns` counts, while `turns` counts completed ones; `context` is { usedTokens, windowTokens }, what the last model request put in the model’s window and the window’s size (0 when the backend does not say), also published by watch() as "usage"; getAccount(refresh?) returns configured accounts and quotas, discovery completeness, and optional unattributed usage for an already-open session (otherwise usageUnavailable); it does not open a backend, identify the payer, or estimate aggregate cost; getInfo() returns { id, title, createdAt }.';
        },
      });
      facets.set(id, facet);
    }
    return facet;
  };

  const cleanupSessionResources = async (
    entry,
    { terminal = false, preserveGuest = false } = {},
  ) => {
    const { id } = entry;
    const hasStorage = await prepareSessionStorage(getHost(), id);
    const environmentAdmin = await developmentAdmin(id);
    const failures = [];
    const agentP = agents.get(id);
    if (agentP) {
      try {
        const agent = await agentForCleanup(agentP);
        // A hosted backend's admin/factory termination below is the
        // authoritative barrier for a quarantined native turn. Allow cleanup
        // to reach it; provider-only sessions still fail closed here.
        // Abort the turn before stop can reopen Shell admission. Observe and
        // drain both promises: the stop releases an outstanding native tool,
        // while shutdown drains its durable outcome before guest retirement.
        const stopped = await Promise.allSettled([
          agent?.shutdown(isHostedSession(entry)),
          environmentAdmin && E(environmentAdmin).stop(),
        ]);
        const failed = stopped.filter(result => result.status === 'rejected');
        if (failed.length)
          throw new AggregateError(
            failed.map(result => result.reason),
            'Session shutdown failed',
          );
      } catch (error) {
        // Do not tear down the guest beneath live turn or inbox activity.
        throw new AggregateError(
          [error],
          `Floot session ${id} agent did not stop`,
          { cause: error },
        );
      }
    } else if (environmentAdmin) {
      await E(environmentAdmin).stop();
    }
    if (isHostedSession(entry)) {
      // Creating recovery also stops by stable ID, preserving any native state
      // provisioned before its ready snapshot was acknowledged.
      // Termination is a stop: it releases the slice, the mount, and the
      // lease and keeps the workspace and Codex state. Deletion removes those
      // through the factory's idempotent destroy, which first stops any
      // instance it still runs — so it also reaches a backend instance whose
      // admin facet died with an earlier incarnation of this factory. Not
      // while termination is refusing, though: a session with an unsettled
      // Endo tool call stays intact for the lifecycle retry.
      if (failures.length === 0) {
        try {
          const owner = await retiredSessionOwner(entry.backendId);
          if (preserveGuest && !terminal)
            await E(owner).stop(harden({ sessionId: id }));
          else await E(owner).destroy(harden({ sessionId: id }));
        } catch (error) {
          failures.push(error);
        }
      }
    }

    // A hosted/CLI teardown failure can mean a host-side Endo tool call is
    // still settling. Keep the session guest and its capabilities alive until
    // backend termination succeeds on a later lifecycle retry.
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Floot session ${id} backend did not fully clean up`,
      );
    }
    // Drop this session's container-mount attach references
    // (designs/runtime-container-fs-mount.md); a last reference releases its
    // 9P bridge and host mount name. Runs after the backend teardown above,
    // so no container still binds the mountpoints being released. Failing to
    // release a bridge must not strand the session record — the registrar
    // logs which key was orphaned, and the records are gone either way.
    try {
      await containerMountRegistrar.releaseSession(id);
    } catch (error) {
      console.error(
        `[floot-factory] could not release container mounts for ${id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    // Release any published workspace URL before the guest that owns the
    // workspace goes. A release that fails is a failed deletion: the registry
    // entry holds the only copy of the route's id, and the asset server
    // retains the workspace for as long as the route stands, so dropping the
    // entry now would leave a deleted session's files published with nobody
    // able to release them. Kept as a failure, the deletion is retried at the
    // next start.
    try {
      await stopPublisher(id);
    } catch (error) {
      console.error(
        `[floot-factory] published route of session ${id} was not released:`,
        error instanceof Error ? error.message : String(error),
      );
      failures.push(error);
    }
    // The queue's record goes with the session, like the rest of what it
    // owned. A record that cannot be removed is a failed deletion, retried at
    // the next start, rather than a stray message outliving its session.
    try {
      await submissionsFor(id).destroy();
    } catch (error) {
      failures.push(error);
    }
    // A stop preserves the environment's owned native storage for revival.
    // Terminal deletion must dispose it before dropping the private admin.
    if (terminal && environmentAdmin) await E(environmentAdmin).dispose();
    const host = getHost();
    // Interrupted initial provisioning may already have published a Shell and
    // workspace into a complete guest. After all writers have stopped, retain
    // that guest so revival reuses its resources; consuming its shell staging
    // alias made its private admin alone insufficient to reconstruct them.
    const keepGuest =
      !terminal &&
      preserveGuest &&
      hasStorage &&
      (await E(host).has(...sessionStoragePath(id, 'handle'))) &&
      (await E(host).has(...sessionStoragePath(id, 'guest')));
    for (const name of hasStorage && !keepGuest
      ? [sessionStoragePath(id, 'handle'), sessionStoragePath(id, 'guest')]
      : []) {
      try {
        if (await E(host).has(...name)) {
          await E(host).remove(...name);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Floot session ${id} resources did not fully clean up`,
      );
    }
    submissions.delete(id);
    agents.delete(id);
    facets.delete(id);
    // Whoever is still watching is told the session is gone.
    sessionWatches.get(id)?.end();
    sessionWatches.delete(id);
    turnSlots.delete(id);
    workingSessions.delete(id);
    lastTurns.delete(id);
    lastTurnReads.delete(id);
    revivalFailures.delete(id);
  };

  const finishSessionDeletion = async id => {
    const entry = (registry || []).find(session => session.id === id);
    if (!entry) return;
    // Creation rollback can arrive after a failed lifecycle write. Before
    // removing its schema, make terminal intent durable: `creating` would
    // otherwise attempt to rebuild this namespace on the next incarnation.
    const index = (registry || []).findIndex(session => session.id === id);
    /** @type {any[]} */ (registry)[index] = harden({
      ...entry,
      lifecycle: 'deleting',
    });
    const terminalIntent = await saveRegistry().then(
      () => ({}),
      error => ({ error }),
    );
    try {
      // Still stop live work if intent publication failed during creation
      // rollback. Ordinary cleanup preserves the journal needed by a durable
      // `creating` entry; only namespace retirement requires this acknowledgement.
      await networkControllers.get(id)?.close();
      await cleanupSessionResources(entry, {
        terminal: !('error' in terminalIntent),
      });
      if ('error' in terminalIntent) throw terminalIntent.error;
      await closeRecords(id);
      const networkStorage = networkStorages.get(id);
      if (networkStorage) await E(networkStorage).close();
      // These facets were stopped above; only terminal deletion releases their
      // durable roots. Incarnation replacement must retain them for revival.
      for (const name of (await prepareSessionStorage(getHost(), id))
        ? [
            environmentAdminName(id),
            sessionStoragePath(id, 'environment-shell'),
          ]
        : []) {
        if (await E(getHost()).has(...name)) await E(getHost()).remove(...name);
      }
      await retirePrivateTurnStorage(getHost(), id);
      networkStorages.delete(id);
      networkControllers.delete(id);
    } catch (error) {
      const current = (registry || []).findIndex(session => session.id === id);
      if (current >= 0) {
        const currentEntry = /** @type {any[]} */ (registry)[current];
        /** @type {any[]} */ (registry)[current] = harden({
          ...currentEntry,
          lifecycle: 'error',
        });
        await saveRegistry();
      }
      throw error;
    }
    registry = (registry || []).filter(session => session.id !== id);
    await saveRegistry();
    console.error(`[floot-factory] Deleted session "${id}"`);
  };

  /**
   * Create one session: its registry entry, its guest, and its running inbox
   * loop. Shared by the factory's public `createSession` and by the subagent
   * spawner, so a subagent session is an ordinary session that records which
   * session asked for it.
   *
   * @param {Record<string, any>} options
   * @param inheritedInferenceRecipe
   * @param inheritedPreset
   * @returns {Promise<string>} the new session id
   */
  const provisionSession = async (
    options,
    inheritedInferenceRecipe = undefined,
    inheritedPreset = undefined,
  ) => {
    if (
      options.systemPrompt !== undefined &&
      (typeof options.systemPrompt !== 'string' ||
        options.systemPrompt.trim() === '')
    ) {
      throw Error('createSession systemPrompt must be a nonblank string');
    }
    if (Object.hasOwn(options, 'model')) {
      throw Error(
        'createSession option "model" is unsupported; use backendId and modelId',
      );
    }
    if (
      options.userInitiated !== undefined &&
      typeof options.userInitiated !== 'boolean'
    ) {
      throw Error('createSession userInitiated must be a boolean');
    }
    await loadRegistry();
    const availablePolicies = await environmentPolicies(getHost());
    const hasRunner = availablePolicies.length > 0;
    const savedPreset =
      inheritedPreset ||
      (options.presetId
        ? await presetCatalog.get(options.presetId)
        : availablePolicies.includes('public-internet') ||
            options.networkPolicy !== undefined
          ? await presetCatalog.get(DEFAULT_PRESET_ID)
          : await presetCatalog.offline());
    const policy =
      options.networkPolicy ??
      (options.parentSessionId ? 'off' : savedPreset.networkPolicy || 'off');
    if (savedPreset.templateId === 'rsi' && !(await hasRsiGrants(getHost())))
      throw Error(
        'RSI requires its pull request and reviewed deployment grants',
      );
    const requested = withSessionNetwork(savedPreset, policy);
    const shellNetworkPolicies = availablePolicies.filter(
      value =>
        !options.parentSessionId ||
        !savedPreset.shellNetworkPolicies ||
        savedPreset.shellNetworkPolicies.includes(value),
    );
    const preset = presetHasShell(requested)
      ? harden({ ...requested, shellNetworkPolicies })
      : requested;
    if (
      options.backendId === undefined &&
      options.modelId === undefined &&
      preset.backendId
    ) {
      options = {
        ...options,
        backendId: preset.backendId,
        modelId: preset.modelId,
        reasoningEffort:
          options.reasoningEffort === undefined
            ? preset.reasoningEffort || undefined
            : options.reasoningEffort,
      };
    }
    if (presetHasShell(preset)) {
      if (!DEVELOPMENT_BACKENDS.includes(options.backendId || 'provider'))
        throw Error(
          'The development preset requires a configured Fae inference provider',
        );
      if (!hasRunner)
        throw Error(
          'No development environment runner is configured; choose internet off or Chat only',
        );
    }
    if (
      policy === 'public-internet' &&
      !shellNetworkPolicies.includes(policy)
    ) {
      throw Error('Public internet is disabled on this environment runner');
    }
    const id = `${newSessionId()}-${creationOrdinal.toString(36)}`;
    creationOrdinal += 1n;
    const { parentSessionId, subagentName, subagentDepth } = options;
    const delegationFields =
      parentSessionId === undefined
        ? {}
        : {
            parentSessionId: `${parentSessionId}`,
            subagentName: `${subagentName}`,
            subagentDepth: Number(subagentDepth),
          };
    const { backendId, modelId, inferenceRecipe, contextLength } =
      await connections.select(options, inheritedInferenceRecipe);
    const promptEnvironment = PROVIDER_PROMPT_ENVIRONMENT;
    // Snapshot the preset's id and prompt so later catalog edits don't change
    // a live session. The object set and explicit capabilities are captured
    // with it for revival and delegation. A model is pinned
    // only when the caller chose a known one; otherwise the session follows
    // the factory's configured default model.
    //
    // Only a root session whose replies are spoken receives voice instructions.
    const delegated = parentSessionId !== undefined;
    const promptContext = normalizePromptContext({
      environment: promptEnvironment,
      spoken: !delegated && options.spoken === true,
      containerMounts: false,
    });
    const sessionPrompt = composeSessionSystemPrompt({
      presetPrompt: [
        composePresetPrompt({
          presetId: preset.templateId,
          objects: preset.objects,
          context: promptContext,
          introduction: presentation?.introduction(promptContext.spoken),
        }),
        preset.instructions,
      ]
        .filter(Boolean)
        .join('\n\n'),
      requestedPrompt: options.systemPrompt,
      delegated,
    });
    if (typeof sessionPrompt !== 'string' || sessionPrompt.trim() === '') {
      throw Error('Floot session requires a captured nonblank system prompt');
    }
    const entry = harden({
      id,
      title: options.title || 'New chat',
      createdAt: Date.now(),
      userInitiated: !delegated && options.userInitiated === true,
      presetId: preset.id,
      presetSnapshot: preset,
      systemPrompt: sessionPrompt,
      // Creation context is descriptive metadata, not a migration recipe.
      promptContext,
      lifecycle: 'creating',
      ...delegationFields,
      backendId,
      modelId,
      ...(inferenceRecipe ? { inferenceRecipe } : {}),
      ...(contextLength === undefined ? {} : { contextLength }),
      ...(!apiProvider(backendId)
        ? {
            ...(options.reasoningEffort
              ? { reasoningEffort: `${options.reasoningEffort}` }
              : {}),
            ...(options.subscription && options.subscription !== 'auto'
              ? { subscription: `${options.subscription}` }
              : {}),
          }
        : {}),
    });
    assertSessionIdentity(entry);
    // Claim the ID before asynchronous namespace checks. Petstore writes are
    // not compare-and-swap, so random IDs alone cannot serialize collisions.
    if (creatingIds.has(id) || (registry || []).some(item => item.id === id))
      throw Error('Session ID already exists');
    creatingIds.add(id);
    try {
      const host = getHost();
      if (
        (await E(host).has(`session-${id}`)) ||
        (await E(host).has(`session-agent-${id}`))
      )
        throw Error('Session guest bindings already exist');
      await createPrivateTurnStorage(host, id);
      publicationFences.add(id);
      /** @type {any[]} */ (registry).push(entry);
      await saveRegistry();
      publicationFences.delete(id);
    } finally {
      creatingIds.delete(id);
    }
    // Build the agent now so the new session immediately follows its inbox
    // (addressable by mail without waiting for a first UI turn) and its
    // preset objects are provisioned up front.
    try {
      if (presetHasShell(preset)) {
        // Record the operator's choice before any backend generation is built.
        await networkController(id).set(policy);
      }
      await getAgent(id);
      const index = /** @type {any[]} */ (registry).findIndex(
        session => session.id === id,
      );
      const currentEntry = /** @type {any[]} */ (registry)[index];
      /** @type {any[]} */ (registry)[index] = harden({
        ...currentEntry,
        lifecycle: 'ready',
      });
      await saveRegistry();
    } catch (error) {
      const failed = (registry || []).findIndex(session => session.id === id);
      if (failed >= 0) {
        const failedEntry = /** @type {any[]} */ (registry)[failed];
        /** @type {any[]} */ (registry)[failed] = harden({
          ...failedEntry,
          lifecycle: 'error',
        });
      }
      // Recording the failure must not be able to skip the rollback: by this
      // point `getAgent` may have started the session's inbox loop, and only
      // `cleanupSessionResources` can stop it. Observe the write's outcome and
      // report it alongside, rather than letting it escape the catch.
      const markFailure = await saveRegistry().then(
        () => undefined,
        markError => markError,
      );
      // The agent deliberately stays in the map. `cleanupSessionResources`
      // shuts it down before removing the guest's pet names; dropping the
      // reference first would tear the guest out from under a live inbox loop
      // with nothing left that could ever stop it.
      try {
        await finishSessionDeletion(id);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError, ...(markFailure ? [markFailure] : [])],
          `Floot session ${id} creation and rollback failed`,
          { cause: cleanupError },
        );
      }
      if (markFailure) {
        throw new AggregateError(
          [error, markFailure],
          `Floot session ${id} creation failed and the failure could not be recorded`,
          { cause: markFailure },
        );
      }
      throw error;
    }
    console.error(
      `[floot-factory] Created session "${id}" (preset "${preset.id}", backend "${entry.backendId}", model "${entry.modelId}")`,
    );
    return id;
  };

  /**
   * Delete one session and, depth-first, every subagent session beneath it. A
   * subagent that outlived its parent would keep an inbox loop (and a hosted
   * backend slice) alive with nobody left to read its replies.
   *
   * @param {string} id
   * @param {() => void} [beforeFence] Validate a maintenance deletion against the current registry.
   * @returns {Promise<void>}
   */
  const releaseSession = async (id, beforeFence = undefined) => {
    await loadRegistry();
    assertPublished(id);
    const index = (registry || []).findIndex(session => session.id === id);
    if (index === -1) throw Error(`Unknown session "${id}".`);
    beforeFence?.();
    // Fence the parent before any await or recursive teardown. In-flight
    // spawns must roll back; later spawns cannot enter a deleting subtree.
    /** @type {any[]} */ (registry)[index] = harden({
      .../** @type {any[]} */ (registry)[index],
      lifecycle: 'deleting',
    });
    await saveRegistry();
    await subagentAdmission.waitForChildren(id);
    const children = (registry || []).filter(
      session => session.parentSessionId === id,
    );
    for (const child of children) {
      await releaseSession(child.id);
    }
    await finishSessionDeletion(id);
  };

  // Layers of delegation a session tree may reach. 0 withholds the subagent
  // tools from every session.
  const maxSubagentDepth = workload.maxSubagentDepth;
  const subagentAdmission = makeSubagentAdmission({
    getSessions: () => registry || [],
    maxSubagents: workload.maxSubagents,
    maxDepth: maxSubagentDepth,
  });

  // Provider calls one turn may make before the tool-step fallback. Read once
  // here, where a bad value is a deployment error the operator sees at
  // provisioning, rather than per session where it would surface as a failed
  // turn much later.
  const maxToolRounds = workload.maxToolRounds;

  /**
   * The whole of the authority a session gets over the factory: create, list,
   * and release sessions recorded as its own subagents. It cannot name, reach,
   * or delete any other session, and it never sees a session guest — the
   * locator it returns is the subagent's mail handle, which is exactly what
   * the parent needs to converse with it and nothing more.
   *
   * @param {string} parentId
   * @param {number} depth - Delegation depth of the subagents it creates.
   */
  const makeSessionSpawner = (parentId, depth) => {
    const listSubagents = async () => {
      await loadRegistry();
      return (registry || []).filter(
        session => session.parentSessionId === parentId,
      );
    };
    return makeOwnedExo('SubagentSpawner', SubagentSpawnerInterface, {
      /**
       * @param {string} name
       * @param {{ systemPrompt?: string, capabilities?: import('./src/subagent.js').SubagentCapability[] }} [options]
       */
      async spawn(name, options = {}) {
        assertSubagentName(name);
        const { systemPrompt: childPrompt, capabilities = [] } = options;
        assertSubagentCapabilities(capabilities);
        if (
          childPrompt !== undefined &&
          (typeof childPrompt !== 'string' ||
            childPrompt.length > workload.subagentLimits.maxTaskChars)
        ) {
          throw Error(
            `Subagent system prompt must be a string of at most ${workload.subagentLimits.maxTaskChars} characters`,
          );
        }
        await loadRegistry();
        assertSessionAdmission(parentId);
        const reservation = subagentAdmission.reserve(parentId, name, depth);
        try {
          const parent = (registry || []).find(
            session => session.id === parentId,
          );
          if (!parent) throw Error('Parent session no longer exists');
          // A subagent runs on the same backend and model as its parent: it is
          // extra context, not a way to reach a backend this session was not
          // provisioned for.
          const inheritedModel = {
            backendId: parent.backendId,
            modelId: parent.modelId,
            ...(parent.reasoningEffort
              ? { reasoningEffort: parent.reasoningEffort }
              : {}),
            // And on the same subscription: a session pinned to one must
            // not have its delegates drain another.
            ...(parent.subscription
              ? { subscription: parent.subscription }
              : {}),
          };
          const childId = await provisionSession(
            {
              title: `${parent?.title || 'Session'} / ${name}`,
              presetId: parent?.presetId,
              ...inheritedModel,
              networkPolicy: await networkController(parentId).forTurn(),
              ...(childPrompt ? { systemPrompt: childPrompt } : {}),
              parentSessionId: parentId,
              subagentName: name,
              subagentDepth: depth,
            },
            parent.inferenceRecipe,
            sessionPreset(parent),
          );
          try {
            reservation.assertParent();
            const child = await E(getHost()).lookup(
              sessionStoragePath(childId, 'guest'),
            );
            for (const capability of capabilities) {
              !(await E(child).has(capability.name)) ||
                Fail`Subagent inventory name ${capability.name} already exists`;
            }
            for (const capability of capabilities) {
              await E(child).storeValue(capability.value, capability.name);
            }
            const locator = await E(getHost()).locate(
              ...sessionStoragePath(childId, 'handle'),
            );
            reservation.assertParent();
            return harden({ name, locator });
          } catch (error) {
            try {
              await releaseSession(childId);
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                'Subagent capability introduction and cleanup failed',
                { cause: error },
              );
            }
            throw error;
          }
        } finally {
          reservation.release();
        }
      },

      /** @param {string} name */
      async stop(name) {
        assertSubagentName(name);
        await null;
        const entry = (await listSubagents()).find(
          session => session.subagentName === name,
        );
        if (!entry) throw Error(`No subagent named "${name}".`);
        await releaseSession(entry.id);
      },

      async list() {
        await null;
        const names = (await listSubagents())
          .map(session => `${session.subagentName}`)
          .sort();
        return harden(names);
      },

      /** @param {string} [methodName]  */
      help(methodName) {
        if (methodName === 'spawn') {
          return 'spawn(name, { systemPrompt?, capabilities?: [{ name, value }] }) — Create a subagent with its own inventory, install only explicit capabilities, and return { name, locator }. All descendants share one tree budget; delegate distinct tasks, never recursive fact checking.';
        }
        if (methodName === 'stop') {
          return 'stop(name) — Delete a subagent session and every session beneath it.';
        }
        if (methodName === 'list') {
          return 'list() — Names of this session’s live subagents.';
        }
        return 'Subagent spawner: create, list, and release sessions recorded as subagents of one parent session.';
      },
    });
  };

  // Revive every session's inbox loop after a restart, without blocking make()
  // (the reincarnation-deadlock constraint forbids awaiting remote refs here).
  // Fire-and-forget: load the registry and build each agent, which starts its
  // inbox loop. New sessions start their loops in getAgent at creation time.
  const startAllInboxes = async () => {
    await loadRegistry();
    ownership.assertOpen();
    // A crash can leave a deletion fence above still-live descendants. Finish
    // the entire subtree before reviving any inbox, not just the fenced row.
    const failedCleanup = new Set();
    const cleanupEntries = (registry || []).filter(
      s => !isHostedSession(s) && ['deleting', 'error'].includes(s.lifecycle),
    );
    for (const s of cleanupEntries) {
      if ((registry || []).some(entry => entry.id === s.id)) {
        try {
          await releaseSession(s.id);
        } catch (error) {
          failedCleanup.add(s.id);
          console.error(
            `[floot-factory] cleanup recovery failed for session-${s.id}:`,
            error,
          );
        }
      }
    }
    const reg = registry || [];
    // A failed teardown retains its records for retry, but cannot restart work.
    for (;;) {
      const size = failedCleanup.size;
      for (const s of reg) {
        if (failedCleanup.has(s.parentSessionId)) failedCleanup.add(s.id);
      }
      if (size === failedCleanup.size) break;
    }
    for (const s of reg.filter(
      entry => !failedCleanup.has(entry.id) && !isHostedSession(entry),
    )) {
      // Read each queue, so the list can say which sessions have messages
      // held over from before the restart. Nothing is dispatched: a queue
      // that comes back non-empty is held until the user sends.
      if ((s.lifecycle || 'ready') === 'ready') {
        void ownership
          .track(submissionsFor(s.id).ready())
          .then(touchSessionList, error => {
            console.error(
              `[floot-factory] could not read the queue of session-${s.id}:`,
              error instanceof Error ? error.message : String(error),
            );
          });
      }
      if (
        (!s.lifecycle || s.lifecycle === 'ready') &&
        (s.executionState === 'stopping' || s.executionState === 'stopped')
      ) {
        if (s.executionState === 'stopping') {
          void ownership.track(emergencyStop(s.id)).catch(error => {
            console.error(
              '[floot-factory] emergency stop recovery incomplete:',
              error,
            );
          });
        }
      } else {
        const recoverCreating = async () => {
          if (s.lifecycle === 'creating') {
            // Halt the incomplete transaction before reopening its resources.
            // A complete guest owns its already-published workspace and Shell;
            // retaining that pair avoids losing them while its admin survives.
            await cleanupSessionResources(s, { preserveGuest: true });
          }
          return getAgent(s.id);
        };
        ownership
          .track(
            recoverCreating().then(async () => {
              if (s.lifecycle === 'creating') {
                /** @type {number} */
                const index = reg.findIndex(entry => entry.id === s.id);
                if (index >= 0) {
                  reg[index] = harden({ ...reg[index], lifecycle: 'ready' });
                  await saveRegistry();
                }
              }
            }),
          )
          .catch(error => {
            console.warn(
              `[floot-factory] could not start inbox for session-${s.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
    }
  };
  let disposal;
  const disposeFactory = () => {
    ownership.fence();
    disposal ??= (async () => {
      const failures = [];
      const attempt = async operation => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      const submissionClosures = [...submissions.values()].map(entry =>
        entry.close(),
      );
      const accountClosure = accountsWatch.close();
      void Promise.resolve(accountClosure).catch(() => {});
      for (const flight of submissionClosures) void flight.catch(() => {});
      const stopResources = () =>
        Promise.all([
          ...[...agents.values()].map(pending =>
            attempt(async () => {
              const agent = await agentForCleanup(pending);
              if (agent) await agent.shutdown();
            }),
          ),
        ]);
      // Interrupt consumers before waiting for callers which depend on them.
      await stopResources();
      await attempt(() => ownership.drain());
      // Admitted catalog construction is settled before this final snapshot.
      // Retired owners stay tracked while their already-admitted reads drain.
      await connections.close(attempt);
      // Admitted construction can acquire a resource after the first snapshot.
      await stopResources();
      await Promise.all(
        submissionClosures.map(flight => attempt(() => flight)),
      );
      await Promise.all(
        [...submissions.values()].map(entry => attempt(() => entry.close())),
      );
      await Promise.all(
        [...networkControllers.values()].map(controller =>
          attempt(() => controller.close()),
        ),
      );
      await Promise.all(
        [...networkStorages.values()].map(storage =>
          attempt(() => E(storage).close()),
        ),
      );
      await Promise.all(
        [...privateJournals.keys()].map(id => attempt(() => closeRecords(id))),
      );
      await attempt(() =>
        Promise.all([
          registryWrite,
          presentation?.drain(),
          presetCatalog.whenIdle(),
          ...publishChains.values(),
        ]),
      );
      for (const watch of sessionWatches.values()) watch.end();
      sessionListWatch.end();
      await attempt(() => accountClosure);
      if (failures.length)
        throw new AggregateError(failures, 'Floot factory disposal failed');
    })();
    return disposal;
  };
  if (context !== undefined) {
    await E(context).addDisposalHook(
      Far('FlootFactoryDisposal', disposeFactory),
    );
  }
  ownership.assertOpen();
  ownership.track(startAllInboxes()).catch(error => {
    console.error(
      '[floot-factory] inbox revival error:',
      error instanceof Error ? error.message : String(error),
    );
  });

  return makeOwnedExo('FlootFactory', factoryInterface, {
    ...presentation?.methods({
      presetCatalog,
      createFromPreset: async (preset, options) =>
        getFacet(
          await provisionSession(
            { ...options, presetId: preset.id },
            undefined,
            preset,
          ),
        ),
    }),
    async getPresetConfiguration() {
      return presetCatalog.read();
    },
    async savePreset(preset, revision) {
      return presetCatalog.save(preset, revision);
    },
    async deletePreset(id, revision) {
      return presetCatalog.remove(id, revision);
    },
    async resetPreset(id, revision) {
      return presetCatalog.reset(id, revision);
    },

    async createSession(options) {
      // The delegation fields are minted by the spawner, never accepted from a
      // caller: a session that claimed another's parentage would join that
      // parent's subagent list and become stoppable by it.
      const {
        parentSessionId: _parentSessionId,
        subagentName: _subagentName,
        subagentDepth: _subagentDepth,
        ...publicOptions
      } = options;
      return getFacet(await provisionSession(publicOptions));
    },

    /**
     * @returns {Promise<Array<{ id: string, title: string, createdAt: number, presetId: string, model: string, backendId: string, modelId: string, reasoningEffort: string, lifecycle: string, userInitiated: boolean, parentSessionId: string, subagentName: string, effectiveModelId: string, activity: 'passive' | 'working' | 'error', pendingCount: number }>>}
     */
    async listSessions() {
      return harden(await projectSessions());
    },

    /**
     * Subscribe to the session list: a snapshot, then `session` for each one
     * added or changed (its title, its lifecycle, what its status circle
     * shows) and `removed` for each one deleted.
     */
    async watchSessions() {
      return sessionListWatch.watch();
    },

    /**
     * What the accounts behind the backends have left, now and whenever it
     * changes. Subscribing asks no provider anything.
     */
    async watchAccounts() {
      return accountsWatch.watch();
    },

    /** Ask each account's provider once, because a person asked. */
    async refreshAccounts() {
      await accountsWatch.refresh();
    },

    /**
     * Spend one banked rate-limit reset of an account, because a person
     * pressed the button. No tool and no ordinary session reaches this.
     *
     * @param {string} key The account's `key` from `watchAccounts()`.
     * @param {{ creditId?: string, replay?: boolean }} [options] Which credit
     *   (the soonest to expire if none); `replay` asks again about the
     *   unconfirmed redeem and never starts one.
     */
    async redeemAccountReset(key, options = {}) {
      return accountsWatch.redeemReset(key, options);
    },

    /**
     * Give an unconfirmed redeem up. A person's decision too: a redeem made
     * afterwards spends another credit if this one had been accepted.
     *
     * @param {string} key
     */
    async abandonAccountReset(key) {
      return accountsWatch.abandonReset(key);
    },

    /**
     * @returns {Promise<Array<{ id: string, title: string, description: string, backendIds?: readonly string[], supportedNetworkPolicies?: readonly string[] }>>}
     */
    async listPresets() {
      const availablePolicies = await environmentPolicies(getHost());
      const configured = availablePolicies.length > 0;
      const rsi = configured && (await hasRsiGrants(getHost()));
      return harden(
        (await presetCatalog.read()).presets
          .filter(
            preset =>
              (!presetHasShell(preset) || configured) &&
              (preset.templateId !== 'rsi' || rsi),
          )
          .map(
            ({
              id,
              title,
              description,
              templateId,
              backendId,
              modelId,
              reasoningEffort,
              networkPolicy,
              objects,
            }) => ({
              id,
              title,
              description,
              templateId,
              backendId,
              modelId,
              reasoningEffort,
              networkPolicy,
              ...(presetHasShell({ objects })
                ? { backendIds: DEVELOPMENT_BACKENDS }
                : {}),
              supportedNetworkPolicies:
                configured && templateId !== 'chat-only'
                  ? availablePolicies
                  : ['off'],
            }),
          ),
      );
    },

    listBackends: connections.list,

    /**
     * The selectable models for a new session: what each backend's accounts
     * list now. `default` marks the model an unpinned session runs (the
     * direct provider's configured model, when its account lists it); a
     * backend-scoped listing keeps the provider's own default marker.
     * `subscriptionIds` are the accounts of the model's backend that list it.
     *
     * @param {string} [backendId]
     * @returns {Promise<Array<{ id: string, selectionId: string, backendId: string, modelId: string, title: string, description: string, default: boolean, defaultReasoningEffort: string | null, reasoningEfforts: string[], subscriptionIds: string[] }>>}
     */
    async listModels(backendId) {
      return (await readCatalogs(backendId)).models;
    },

    /**
     * How each backend's discovery stands: per account, whether its catalog
     * is current, stale, unavailable or unsupported, when it was read, and
     * how many models it lists. A picker shows this beside the models, so an
     * empty list is never mistaken for a working backend with nothing to
     * offer.
     */
    async listModelCatalogs() {
      return (await readCatalogs()).catalogs;
    },

    /**
     * @param {string} id
     * @returns {Promise<object>} the session facet
     */
    async getSession(id) {
      await assertSessionReady(id);
      return getFacet(id);
    },

    /**
     * @param {string} id
     * @param {string} title
     */
    async renameSession(id, title) {
      await loadRegistry();
      assertPublished(id);
      const reg = registry || [];
      const idx = reg.findIndex(s => s.id === id);
      if (idx === -1) throw new Error(`Unknown session "${id}".`);
      // Entries are hardened, so replace rather than mutate in place.
      reg[idx] = harden({ ...reg[idx], title });
      await saveRegistry();
    },

    /**
     * Correct the provenance of an existing session without changing its work
     * or authority. Delegates always remain outside the user's session list.
     *
     * @param {string} id
     * @param {boolean} userInitiated
     */
    async setSessionUserInitiated(id, userInitiated) {
      await loadRegistry();
      assertPublished(id);
      const reg = registry || [];
      const idx = reg.findIndex(s => s.id === id);
      if (idx === -1) throw new Error(`Unknown session "${id}".`);
      reg[idx] = harden({ ...reg[idx], userInitiated });
      await saveRegistry();
    },

    /**
     * @param {string} id
     */
    async deleteSession(id) {
      await releaseSession(id);
    },

    async retireCliSession(expected) {
      const { id } = expected;
      await loadRegistry();
      const check = () => {
        const rows = registry || [];
        const entry = rows.find(row => row.id === id);
        if (
          !entry ||
          entry.backendId !== expected.backendId ||
          (entry.parentSessionId || '') !== expected.parentSessionId ||
          entry.createdAt !== expected.createdAt
        )
          throw Error('Session identity changed');
        const seen = new Set();
        let row = entry;
        while (!['codex', 'claude', 'opencode'].includes(row.backendId)) {
          if (!row.parentSessionId || seen.has(row.id))
            throw Error('Session outside retired subtree');
          seen.add(row.id);
          row = rows.find(item => item.id === row.parentSessionId);
          if (!row) throw Error('Missing session parent');
        }
        if (rows.some(item => item.parentSessionId === id))
          throw Error('Retire children first');
        if (
          turnSlots.get(id)?.getCurrent() ||
          workingSessions.has(id) ||
          !['ready', 'error', 'deleting'].includes(entry.lifecycle || 'ready')
        )
          throw Error('Session still working');
      };
      ownership.assertOpen();
      check();
      if (retirementFences.has(id))
        throw Error('Session retirement in progress');
      retirementFences.add(id);
      try {
        await subagentAdmission.waitForChildren(id);
        const submissionsState = submissionsFor(id);
        await submissionsState.ready();
        const checkIdle = () => {
          check();
          const { hold, entries } = submissionsState.read();
          if (entries.length || hold?.reason === 'unavailable')
            throw Error(
              'Cannot retire session with pending or unreadable submissions',
            );
        };
        checkIdle();
        // Mail enters the running agent independently of its public session
        // facet. Closing an idle inbox before the durable deletion write also
        // catches work that was admitted during the queue read.
        const pending = agents.get(id);
        if (pending) {
          const agent = await agentForCleanup(pending);
          await agent?.stopForReplacement();
        }
        await releaseSession(id, checkIdle);
      } finally {
        retirementFences.delete(id);
      }
    },

    /**
     * Drop the memoized provider config and the providers built from it.
     *
     * A rotation (`SecretAdmin.replaceBase64`) or a revocation needs no help:
     * a turn re-reads the secret and the provider cache is keyed on the bytes,
     * so it reaches every open session by itself. What this is for is a change
     * to the *config* — a different host, provider kind, or default model
     * bound at `llm-provider` — which is read once and would otherwise need a
     * daemon restart. Sessions on a hosted backend are unaffected either way:
     * their credentials belong to the backend, not to Floot.
     */
    async refreshCredentials() {
      connections.refresh();
      // An unpinned session's `effectiveModelId` is read from that config.
      touchSessionList();
      console.error(
        '[floot-factory] Dropped the cached provider config; the next turn re-reads it.',
      );
    },

    /**
     * The subscription plan, rate limits, and price list behind this
     * deployment's credential, as capability-free data.
     *
     * Every section carries `observedAt` and a `source` of observed, declared,
     * remembered, or unavailable, so a caller can tell a measurement from an
     * assertion. Counts are bigints — a published quota is a natural number
     * whose range is the provider's to choose.
     *
     * @param {boolean} [refresh] - Re-read the provider before answering.
     */
    async getAccount(refresh) {
      const oracle = await getAccountOracle();
      if (!oracle) {
        return harden({
          available: false,
          reason: `No account oracle is bound to "${accountOracleName}". Provision one to report plan and rate limits.`,
        });
      }
      if (refresh) await E(oracle).refresh();
      const [plan, rateLimits, rateCard] = await Promise.all([
        E(oracle).getPlan(),
        E(oracle).getRateLimits(),
        E(oracle).getRateCard(),
      ]);
      return harden({ available: true, plan, rateLimits, rateCard });
    },

    /**
     * The oracle itself, for a caller that wants to hold it — a monitor, or an
     * agent that should be able to check its own quota. It is read-only and has
     * no path to the credential, which is why handing it out is safe where
     * handing out the factory would not be.
     */
    async getAccountOracle() {
      const oracle = await getAccountOracle();
      if (!oracle) {
        throw Error(
          `No account oracle is bound to "${accountOracleName}" in this factory.`,
        );
      }
      return oracle;
    },

    /**
     * @param {string} [methodName]
     * @returns {string}
     */
    help(methodName) {
      if (methodName === undefined) {
        const extraHelp = presentation?.factoryHelp || '';
        return `Fae session factory: createSession({title,presetId,backendId,modelId,reasoningEffort,systemPrompt,networkPolicy,userInitiated}) -> session facet; listSessions() includes backend/model/reasoning/lifecycle/activity metadata; watchSessions() subscribes to that list; watchAccounts() subscribes to what each backend’s account has left; refreshAccounts(); redeemAccountReset(key, options?); abandonAccountReset(key); listBackends(); listModels(backendId?); listModelCatalogs(); listPresets(); getPresetConfiguration()/savePreset(preset,revision)/deletePreset(id,revision)/resetPreset(id,revision); getSession(id); renameSession(id,title); deleteSession(id); setSessionUserInitiated(id,boolean); refreshCredentials(); getAccount(refresh?); getAccountOracle(); Session facets expose startTurn() -> turn, getCurrentTurn() -> { input, turn, history } | null, watch(), getHistory(), getUsage(), and getInfo().${extraHelp}`;
      }
      const docs = {
        createSession:
          'createSession(options) — Create an isolated session. Options can select title, presetId, backendId, modelId, reasoningEffort, networkPolicy ("off" or "public-internet", enforced by the preset’s attached Podman shell; omission uses the selected preset), subscription (automatic pooling), systemPrompt (replaces the preset’s), and userInitiated (defaults to false; the UI passes true for conversations the user starts). The preset’s system prompt is composed once, here, for the backend the session runs on, and kept for the session’s life. Returns its opaque facet.',
        listBackends:
          'listBackends() — Return configured Fae inference providers with their durable backend IDs, provider IDs, and display names.',
        listSessions:
          'listSessions() — Return metadata [{id, title, createdAt, presetId, model, backendId, modelId, effectiveModelId, reasoningEffort, subscription, lifecycle, activity, pendingCount}] for all sessions, including workflow participants and subagents. `userInitiated` is false for internal sessions; the UI lists only user-initiated roots. `subscription` is "auto" or the id the session was pinned to. `effectiveModelId` is the pinned model, or for an unpinned provider session the configured model as of now (empty for a hosted session that pins none); `activity` is passive | working | error; `pendingCount` is how many submissions wait their turn.',
        getPresetConfiguration:
          'getPresetConfiguration() — Return {revision, voicePresetId, presets}. Presets include templateId, instructions, model defaults, generated objects, and explicitly granted endowments. Treat returned capabilities as authority, not display data.',
        savePreset:
          'savePreset(preset, revision) — Create or edit a preset using the last-read revision. Additional endowments are explicit {petName, sourcePath, value} object capabilities. Changes affect only future sessions and never rewrite existing sessions or their delegated authority. Stale revisions fail; reload before retrying.',
        deletePreset:
          'deletePreset(id, revision) — Delete a custom preset. Built-ins and the selected voice preset cannot be deleted. Existing sessions keep their snapshots.',
        resetPreset:
          'resetPreset(id, revision) — Restore a built-in preset for future sessions.',
        listPresets:
          'listPresets() — Return the available session presets [{id, title, description}].',
        listModels:
          'listModels(backendId?) — Return the models each backend’s accounts list now, read from the provider, with compound selection ids, supported reasoning efforts and the accounts (`subscriptionIds`) listing each; no argument returns every backend’s models flattened.',
        listModelCatalogs:
          'listModelCatalogs() — Return each backend’s discovery state per account: current, stale, unavailable or unsupported, when it was read, and how many models it lists.',
        getSession: 'getSession(id) — Return the session facet for an id.',
        watchAccounts:
          'watchAccounts() — A disposable stream of { type: "accounts", accounts }: now, and whenever any account changes, coalesced to the newest. One account per backend that has an account oracle: { backendId, title, plan: { planId, title, state, source }, windows: [{ windowId ("primary" short, "secondary" long), title, usedPercent, resetsAt, windowSeconds, limit, used, remaining }], limitReached, credits: { balance, hasCredits, unlimited } | null, resetCredits: { availableCount, credits } | null, reset: { pending, last } | null (present where a banked reset can be redeemed; pending is a redeem whose answer is not known), source (observed | declared | remembered | unavailable), observedAt }. A window whose resetsAt has passed is empty again, whatever usedPercent says. Readings arrive with inference responses; subscribing asks no provider anything.',
        redeemAccountReset:
          'redeemAccountReset(key, { creditId?, replay? }?) — Spend one banked rate-limit reset of the account with that key (from watchAccounts()), the named credit or the one that expires soonest. For a person who pressed the button; nothing calls this on its own, and a credit is scarce. Answers { outcome: reset | nothingToReset | noCredit | alreadyRedeemed | refused | redeemed, creditId, replayed, pending }. If the answer is lost the account shows reset.pending and a new redeem is refused; { replay: true } asks again with the same stored key, which cannot spend a second credit and never starts a redeem of its own.',
        abandonAccountReset:
          'abandonAccountReset(key) — Give that account’s unconfirmed redeem up, when the provider will never say. A redeem made afterwards spends another credit if the abandoned one had been accepted. Answers { pending, last }.',
        refreshAccounts:
          'refreshAccounts() — Ask each account’s provider once for its current figures. For a person who pressed refresh; nothing calls this on a timer.',
        watchSessions:
          'watchSessions() — A disposable stream of the session list: { type: "snapshot", sessions }, then { type: "session", session } for each session added or changed (including its `activity`: passive | working | error) and { type: "removed", id }. Subscribe rather than calling listSessions() on a timer.',
        setSessionUserInitiated:
          'setSessionUserInitiated(id, boolean) — Record whether a session was initiated by the user. Set false for dedicated workflow participants; this updates the UI list without stopping or deleting the session. Delegates remain hidden regardless.',
        renameSession: 'renameSession(id, title) — Rename a session.',
        deleteSession:
          'deleteSession(id) — Delete a session, its backing guest, and every subagent session beneath it.',
        refreshCredentials:
          'refreshCredentials() — Re-read the `llm-provider` config on the next turn. A rotated or revoked secret needs no call: a turn reads it afresh.',
        getAccount:
          'getAccount(refresh?) — { available, plan, rateLimits, rateCard }. Each section carries observedAt and a source of observed | declared | remembered | unavailable; counts are bigints, and null means the provider does not publish that figure.',
        getAccountOracle:
          'getAccountOracle() — The read-only HostedAccount capability itself, for a holder that should be able to check plan and quota without reaching the credential.',
      };
      return (
        presentation?.help?.[methodName] ||
        docs[methodName] ||
        `No documentation for method "${methodName}".`
      );
    },
  });
};
harden(make);
