// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeLocalTree } from '@endo/platform/fs/node';

import { makePiAgent } from '@endo/agentry/harness';

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
import { openWorkerTranscript, provideTranscriptsMount } from './transcript.js';

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
 * using a pi-agent-core–backed PiAgent.
 *
 * When the harness supplies a `transcript` (see `transcript.js`), the PiAgent
 * is seeded from the resumed session's messages and every completed
 * `user`/`assistant`/`toolResult` message is appended to the session's
 * Pi-compatible JSONL file. The transcript is held only in this closure: the
 * model's tools run on `powers`, which never name the writable mount.
 *
 * @param {any} powers - Guest powers (manager's own or a sub-guest's)
 * @param {Promise<object> | object | null | undefined} context
 * @param {{ LAL_HOST?: string, LAL_MODEL?: string, LAL_AUTH_TOKEN?: string }} workerEnv
 * @param {{ transcript?: Awaited<ReturnType<typeof openWorkerTranscript>> }} [options]
 * @returns {Promise<void>}
 */
export const spawnWorkerLoop = async (
  powers,
  context,
  workerEnv,
  { transcript } = {},
) => {
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
  //   (a) we seed `messages` from the resumed JSONL transcript, if any,
  //   (b) we control the system prompt verbatim (no policy suffix or
  //       security-notes wrapping is applied), and
  //   (c) the per-tool parameter schema lives at the tool boundary,
  //       which lets `@endo/patterns` validation guard inbound args.
  const executeTool = makeExecuteTool(powers);
  const agentTools = tools.map(({ name, summary }) =>
    toAgentTool(name, summary, executeTool),
  );

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
    messages: transcript ? [...transcript.seedMessages] : [],
  });
  if (transcript) {
    transcript.markRecorded(piAgent.state.messages);
  }

  /**
   * Run `record` and log, rather than throw, a transcript write failure: a
   * lost transcript line must not take down the worker.
   *
   * @param {() => Promise<void>} record
   */
  const recordSafely = async record => {
    try {
      await record();
    } catch (error) {
      console.error('[lal] Transcript write failed:', error);
    }
  };

  /**
   * Run one chat round on the PiAgent, forwarding tool-call activity to
   * the console (via `round-runner.js`), and append the round's messages to
   * the transcript.
   *
   * @param {string} prompt - User-role content for this round.
   * @param {{ number?: number | bigint, messageId?: string, replyTo?: string }} [mail]
   *   The inbound mail message that started the round.
   */
  const runOneRound = async (prompt, mail) => {
    if (!transcript) {
      await runRound(piAgent, prompt);
      return;
    }
    if (mail) {
      await recordSafely(() => transcript.recordMail(mail));
    }
    try {
      await runRound(piAgent, prompt);
    } finally {
      await recordSafely(() =>
        transcript.recordMessages(piAgent.state.messages),
      );
    }
  };

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
      ]),
    );

    // Resolve the host agent reference for provideGuest calls.
    const agent = await E(powers).lookup('host-agent');
    const selfLocator = await E(powers).locate('@self');
    const activeWorkers = new Map();

    // The writable transcripts mount stays in the manager's closure. Worker
    // sub-guests are never introduced to it, so model-driven tools cannot
    // tamper with their own history.
    let transcriptsMount;
    try {
      transcriptsMount = await provideTranscriptsMount(agent);
    } catch (error) {
      console.error('[lal] Transcripts mount unavailable:', error);
    }

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

    // Pre-scan existing messages to find our latest form messageId so that
    // old value messages (from prior sessions) that reply to an earlier form
    // are not accidentally matched when the iterator replays history.
    /** @type {string | undefined} */
    let formMessageId;
    const existingMessages = /** @type {any[]} */ (
      await E(powers).listMessages()
    );
    for (const msg of existingMessages) {
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

      if (msg.from === selfLocator && msg.type === 'form') {
        formMessageId = msg.messageId;
      } else if (msg.type === 'value' && msg.replyTo === formMessageId) {
        // Only process value messages that reply to our form.
        try {
          // Resolve the submitted values from the value message.
          const config =
            /** @type {{ name: string, host: string, model: string, authToken: string }} */ (
              await E(powers).lookupById(msg.valueId)
            );

          const { name } = config;

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

            let transcript;
            if (transcriptsMount !== undefined) {
              try {
                transcript = await openWorkerTranscript({
                  mount: transcriptsMount,
                  workerName: name,
                });
                console.log(
                  `[lal] Transcript for "${name}": ${transcript.fileName}`,
                );
              } catch (error) {
                console.error(`[lal] Transcript for "${name}" failed:`, error);
              }
            }

            // Spawn a worker loop for this guest.
            const workerP = spawnWorkerLoop(
              guest,
              null,
              {
                LAL_HOST: config.host,
                LAL_MODEL: config.model,
                LAL_AUTH_TOKEN: config.authToken,
              },
              { transcript },
            );
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
