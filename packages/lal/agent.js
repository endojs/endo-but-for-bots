// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeLocalTree } from '@endo/platform/fs/node';

import { makePiAgent } from '@endo/agentry/harness';
import { discoverCapabilityTools } from '@endo/agent-tools/discover.js';
import { toPiAgentTool } from '@endo/agent-tools/pi';

import { systemPrompt } from './prompts/system.js';
import { tools } from './tools/index.js';
import { makeExecuteTool, toAgentTool } from './tool-dispatch.js';
import {
  resolveModelString,
  resolveModel,
  makeWorkerCredentials,
  makeWorkerGetApiKey,
} from './model-resolution.js';
import { runRound } from './round-runner.js';
import { runInboxLoop } from './inbox-loop.js';

/** @import { FarRef } from '@endo/eventual-send' */
/** @import { GuestPowers, LalContext } from './agent.types.js' */

// pi-ai's built-in API providers (anthropic, openai, google, openrouter,
// mistral, deepseek, groq, xai, github-copilot, and ~20 others) are registered
// lazily by the harness on first model resolution, so `getModel(provider,
// modelId)` lookups succeed for any caller-supplied "provider/modelId" string
// without an explicit registration call here: the worker's `resolveModel`
// (re-exported from `@endo/agentry/harness`) self-registers before its first
// registry lookup. Ollama is *not* in this registry; lal handles "ollama/<id>"
// specially in `resolveModel` by constructing a custom Model that points at a
// local OpenAI-compatible Ollama endpoint.

// ============================================================================
// Interface Definition
// ============================================================================

const LalInterface = M.interface('Lal', {
  help: M.call().optional(M.string()).returns(M.string()),
});

// ============================================================================
// Worker Loop
// ============================================================================

/**
 * Spawn a worker loop that follows a guest's inbox and processes messages
 * using a pi-agent-core–backed PiAgent. The PiAgent's internal message
 * state is the durable transcript for the worker's lifetime; cross-restart
 * conversation continuity is intentionally not preserved by this migration
 * (see the PR body's *Memory migration* section).
 *
 * @param {any} powers - Guest powers (manager's own or a sub-guest's)
 * @param {Promise<object> | object | null | undefined} context
 * @param {{ LAL_HOST?: string, LAL_MODEL?: string, LAL_AUTH_TOKEN?: string }} workerEnv
 * @returns {Promise<void>}
 */
export const spawnWorkerLoop = async (powers, context, workerEnv) => {
  const getCancelled = async () => {
    if (!context) return null;
    const resolvedContext = await context;
    if (!resolvedContext) return null;
    if (typeof resolvedContext.whenCancelled === 'function') {
      return E(resolvedContext).whenCancelled();
    }
    if (resolvedContext.cancelled) {
      return resolvedContext.cancelled;
    }
    return null;
  };

  // Resolve the model string for pi-ai. lal historically selected a provider
  // from LAL_HOST and a model from LAL_MODEL. The pi-ai registry takes a
  // single "provider/modelId" string instead; we keep accepting the legacy
  // LAL_* variables and translate them.
  const model = resolveModelString(workerEnv);

  // Bind the tool dispatcher to this guest's powers, then build the
  // AgentTool array pi-agent-core consumes directly. We build the PiAgent via
  // `@endo/agentry/harness`'s `makePiAgent` (which owns the shared
  // `initialState` shape, the user/assistant/toolResult `convertToLlm` filter,
  // the `reasoning ? 'medium' : 'off'` thinking default, and
  // `toolExecution: 'sequential'`) so that
  //   (a) we are free to seed `messages` from prior transcripts when
  //       cross-restart continuity lands (see PR body),
  //   (b) we control the system prompt verbatim (no policy suffix or
  //       security-notes wrapping is applied), and
  //   (c) the per-tool parameter schema lives at the tool boundary,
  //       which lets `@endo/patterns` validation guard inbound args.
  const executeTool = makeExecuteTool(powers);
  const agentTools = tools.map(({ name, summary }) =>
    toAgentTool(name, summary, executeTool),
  );

  // Dynamic capability discovery (daemon-agent-tools Phase 4): register the
  // filesystem / shell / git tools this guest's *granted* capabilities afford,
  // looked up by their canonical pet names (`fs`, `shell`, `git`) and bridged
  // into pi-agent-core `AgentTool`s. A capability that was not granted
  // contributes no tools, so the worker advertises exactly the coding authority
  // it holds. A name already served by a static tool wins, so discovery only
  // ever adds. Discovery failure must not sink the worker.
  const staticToolNames = new Set(agentTools.map(t => t.name));
  try {
    const capabilityRecords = await discoverCapabilityTools(powers);
    for (const record of capabilityRecords) {
      if (!staticToolNames.has(record.name)) {
        agentTools.push(toPiAgentTool(record));
        staticToolNames.add(record.name);
      }
    }
  } catch (error) {
    console.error(
      `[lal] Capability tool discovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const resolvedModel = await resolveModel(model);
  const isOllama = resolvedModel.name?.startsWith('ollama/');

  // The worker's API key is resolved through the read-only `Credentials` seam
  // and handed to pi-agent-core via a `getApiKey` callback — no ambient-env
  // mutation. An ollama model keeps the harmless 'ollama' sentinel; any other
  // provider takes a pre-existing real `<PROVIDER>_API_KEY` over the worker's
  // LAL_AUTH_TOKEN (see `makeWorkerGetApiKey`).
  const credentials = makeWorkerCredentials();
  const getApiKey = makeWorkerGetApiKey(
    credentials,
    workerEnv.LAL_AUTH_TOKEN,
    isOllama,
  );

  const piAgent = makePiAgent({
    systemPrompt,
    model: resolvedModel,
    tools: agentTools,
    getApiKey,
  });

  /**
   * Run one chat round on the PiAgent, forwarding tool-call activity to
   * the console (via `round-runner.js`).
   *
   * @param {string} prompt - User-role content for this round.
   */
  const runOneRound = prompt => runRound(piAgent, prompt);

  await runInboxLoop({ powers, getCancelled, runOneRound });
};
harden(spawnWorkerLoop);

// ============================================================================
// Manager / Entry Point
// ============================================================================

/**
 * Creates a Lal agent manager.
 *
 * Sends a configuration form to HOST on startup. Each form submission
 * creates a new guest profile and spawns a worker loop for it.
 *
 * @param {FarRef<GuestPowers>} guestPowers - Guest powers from the Endo daemon
 * @param {Promise<LalContext> | LalContext | undefined} _context - Context for cancellation support
 * @returns {object} The Lal exo object
 */
export const make = (guestPowers, _context) => {
  /** @type {any} */
  const powers = guestPowers;

  // Send the configuration form to HOST for adding agents.
  const runManager = async () => {
    await E(powers).form(
      '@host',
      'Add an agent',
      harden([
        { name: 'name', label: 'Agent name' },
        {
          name: 'host',
          label: 'API host',
          default: 'http://localhost:11434/v1',
          example: 'https://api.anthropic.com for Anthropic',
        },
        {
          name: 'model',
          label: 'Model name',
          default: 'qwen3',
          example: 'claude-sonnet-4-6-20250514 for Anthropic',
        },
        {
          name: 'authToken',
          label: 'API auth token',
          default: 'ollama',
          example: 'sk-ant-... for Anthropic',
          secret: true,
        },
        {
          name: 'projectPath',
          label:
            'Project directory (optional, required for coding capabilities)',
          default: '',
          example: '/home/user/project',
        },
        {
          name: 'capabilities',
          label: 'Coding capabilities (comma-separated: fs, shell, git)',
          default: '',
          example: 'fs,shell,git',
        },
      ]),
    );

    // Resolve the host agent reference for provideGuest calls.
    const agent = await E(powers).lookup('host-agent');
    const selfLocator = await E(powers).locate('@self');
    const activeWorkers = new Map();

    // Check in the primer directory as a content-addressed readable-tree.
    // Stored once in the host namespace; each sub-guest gets a reference.
    const primerDirPath = new URL('./primer', import.meta.url).pathname;
    const localPrimerTree = makeLocalTree(primerDirPath);
    await E(agent).storeTree(localPrimerTree, 'lal-primer');
    const primerTreeId = await E(agent).identify('lal-primer');
    console.log(`[lal] Primer tree checked in (${primerTreeId})`);

    /**
     * Ensure the sub-guest has a `primer` reference.
     * @param {any} guest
     */
    const provisionPrimer = async guest => {
      const hasPrimer = await E(guest).has('primer');
      if (!hasPrimer) {
        await E(guest).storeIdentifier('primer', primerTreeId);
        console.log('[lal] Primer provisioned for guest');
      }
    };

    // Default confinement for a form-granted Shell: an allowlist of common
    // build / VCS / inspection commands, a one-minute wall clock, and a 1 MiB
    // output cap. Arguments are always passed argv-style (never a shell
    // string), so the allowlist is the enforceable boundary. Widening it is a
    // deliberate authority decision (daemon-agent-tools Design Decision 4).
    const defaultShellPolicy = harden({
      allowedCommands: [
        'node',
        'npm',
        'npx',
        'yarn',
        'git',
        'make',
        'python',
        'python3',
        'pip',
        'grep',
        'find',
        'sed',
        'awk',
        'cat',
        'ls',
      ],
      timeoutMs: 60_000,
      maxOutputBytes: 1_048_576,
    });

    /**
     * Grant the coding capabilities the form requested into the sub-guest's
     * namespace under the canonical discovery names (`fs`, `shell`, `git`), so
     * the guest's startup tool discovery (daemon-agent-tools Phase 4) registers
     * exactly the tools it now affords. A single writable mount over the
     * project directory backs all three; each grant is idempotent so a restart
     * re-uses the existing caps rather than re-minting.
     *
     * @param {any} guest
     * @param {string} agentName
     * @param {string[]} requestedCaps - Subset of `['fs', 'shell', 'git']`.
     * @param {string} projectPath - Absolute path to the project directory.
     */
    const provisionCapabilities = async (
      guest,
      agentName,
      requestedCaps,
      projectPath,
    ) => {
      if (requestedCaps.length === 0) {
        return;
      }
      if (!projectPath) {
        throw new Error(
          'A project directory is required to grant coding capabilities.',
        );
      }

      // One writable mount over the project directory, shared by fs / git /
      // shell. Minted under a scoped name in the host namespace, then
      // referenced into the guest by identifier.
      const mountName = `${agentName}-project-mount`;
      const mount = (await E(agent).has(mountName))
        ? await E(agent).lookup(mountName)
        : await E(agent).provideMount(projectPath, mountName);

      if (requestedCaps.includes('fs') && !(await E(guest).has('fs'))) {
        const mountId = await E(agent).identify(mountName);
        await E(guest).storeIdentifier('fs', mountId);
      }

      if (requestedCaps.includes('git') && !(await E(guest).has('git'))) {
        const gitName = `${agentName}-git`;
        if (!(await E(agent).has(gitName))) {
          await E(agent).provideGit(mount, gitName);
        }
        const gitId = await E(agent).identify(gitName);
        await E(guest).storeIdentifier('git', gitId);
      }

      if (requestedCaps.includes('shell') && !(await E(guest).has('shell'))) {
        const shellName = `${agentName}-shell`;
        if (!(await E(agent).has(shellName))) {
          await E(agent).provideShell(mount, shellName, defaultShellPolicy);
        }
        const shellId = await E(agent).identify(shellName);
        await E(guest).storeIdentifier('shell', shellId);
      }

      console.log(
        `[lal] Provisioned capabilities [${requestedCaps.join(', ')}] for "${agentName}"`,
      );
    };

    // Pre-scan existing messages to find our latest form messageId so that
    // old value messages (from prior sessions) that reply to an earlier form
    // are not accidentally matched when the iterator replays history.
    /** @type {string | undefined} */
    let formMessageId;
    const existingMessages = /** @type {any[]} */ (
      await E(powers).listMessages()
    );
    for (const msg of existingMessages) {
      // eslint-disable-next-line @endo/restrict-comparison-operands
      if (msg.from === selfLocator && msg.type === 'form') {
        formMessageId = msg.messageId;
      }
    }

    const messageIterator = iterateReader(E(powers).followMessages());
    while (true) {
      const { value: message, done } = await messageIterator.next();
      if (done) break;

      const msg = /** @type {any} */ (message);

      // Capture the form's messageId from our own outbound message.
      // eslint-disable-next-line @endo/restrict-comparison-operands
      if (msg.from === selfLocator && msg.type === 'form') {
        formMessageId = msg.messageId;
      } else if (
        msg.type === 'value' &&
        // eslint-disable-next-line @endo/restrict-comparison-operands
        msg.replyTo === formMessageId
      ) {
        // Only process value messages that reply to our form.
        try {
          // Resolve the submitted values from the value message.
          const config =
            /** @type {{ name: string, host: string, model: string, authToken: string, projectPath?: string, capabilities?: string }} */ (
              await E(powers).lookupById(msg.valueId)
            );

          const { name } = config;
          const projectPath = (config.projectPath || '').trim();
          const requestedCaps = (config.capabilities || '')
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);

          if (activeWorkers.has(name)) {
            // A worker is already running for this name.
            await E(powers).reply(
              msg.number,
              [`Agent "${name}" already exists.`],
              [],
              [],
            );
          } else {
            // Create the guest profile via the host agent.
            // provideGuest returns the full EndoGuest (not the handle).
            // Guard with has() so restart re-uses the existing guest;
            // re-running provideGuest on an existing name throws
            // "Formula already exists".
            let guest;
            if (await E(agent).has(name)) {
              guest = await E(agent).lookup(name);
            } else {
              guest = await E(agent).provideGuest(name, {
                agentName: `profile-for-${name}`,
              });
            }

            // Ensure the sub-guest has the primer directory.
            await provisionPrimer(guest);

            // Grant any requested coding capabilities into the guest so its
            // startup tool discovery registers the corresponding tools.
            const unknownCaps = requestedCaps.filter(
              c => !['fs', 'shell', 'git'].includes(c),
            );
            if (unknownCaps.length > 0) {
              throw new Error(
                `Unknown capabilities: ${unknownCaps.join(', ')}. ` +
                  `Supported: fs, shell, git.`,
              );
            }
            await provisionCapabilities(
              guest,
              name,
              requestedCaps,
              projectPath,
            );

            // Spawn a worker loop for this guest.
            const workerP = spawnWorkerLoop(guest, null, {
              LAL_HOST: config.host,
              LAL_MODEL: config.model,
              LAL_AUTH_TOKEN: config.authToken,
            });
            activeWorkers.set(name, workerP);
            workerP.catch(error => {
              console.error(`[lal] Worker "${name}" error:`, error);
              activeWorkers.delete(name);
            });

            await E(powers).reply(
              msg.number,
              [`Agent "${name}" is now running.`],
              [],
              [],
            );
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error('[lal] Form submission error:', errorMessage);
          try {
            await E(powers).reply(
              msg.number,
              [`Error creating agent: ${errorMessage}`],
              [],
              [],
            );
          } catch {
            // Best-effort reply.
          }
        }
      }
    }
  };

  runManager().catch(error => {
    console.error('[lal] Manager error:', error);
  });

  return makeExo('Lal', LalInterface, {
    /**
     * @param {string} [methodName]
     * @returns {string}
     */
    help(methodName) {
      if (methodName === undefined) {
        return 'Lal agent manager. Submit the configuration form to add agents.';
      }
      return `No documentation for method "${methodName}".`;
    },
  });
};
