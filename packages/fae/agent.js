// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';
import { passableAsJustin, makeMarshal } from '@endo/marshal';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { createProvider } from '@endo/lal/providers/index.js';
import {
  makeConversationTree,
  makeEndoPetstoreBackend,
} from '@endo/conversation-tree';

import { discoverTools, executeTool } from './src/tools.js';
import {
  makeListPetnamesTool,
  makeLookupTool,
  makeStoreTool,
  makeRemoveTool,
  makeAdoptToolTool,
  makeAdoptTool,
  makeSendTool,
  makeReplyTool,
  makeEditMessageTool,
  makeMessageHistoryTool,
  makeListMessagesTool,
  makeDismissTool,
  makeExecTool,
  makeReadChannelTool,
} from './src/tool-makers.js';
import { extractToolCallsFromContent } from './src/extract-tool-calls.js';
import { buildInboxMessageContent } from './src/inbox-message-format.js';
import { formulaIdFromMessageId } from './src/message-id.js';
import { guestSystemPrompt } from './src/system-prompt.js';
import { addAdoptionHintToError } from './src/tool-error-hint.js';
import {
  adoptionRepairMessage,
  emptyResponseRepairMessage,
} from './src/repair-messages.js';

/** Same pattern as isSpecialName in packages/daemon/src/pet-name.js */
const specialNamePattern = /^[A-Z][A-Z0-9-]{0,127}$/;

const m = makeMarshal(undefined, undefined, {
  errorTagging: 'off',
  serializeBodyFormat: 'smallcaps',
});
const decodeSmallcaps = jsonString =>
  m.unserialize({ body: jsonString, slots: [] });

const FaeFactoryInterface = M.interface('FaeFactory', {
  createAgent: M.callWhen(M.string()).optional(M.record()).returns(M.string()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * @typedef {object} ProviderConstructorConfig
 * @property {string} host - LAL host URL.
 * @property {string} model - LAL model identifier.
 * @property {string} authToken - LAL auth token.
 */

/**
 * @typedef {object} InjectedProviderConfig
 * @property {{ chat: (messages: object[], tools: object[]) => Promise<{ message: object }> }} provider - Pre-built provider (e.g. for tests).
 */

/**
 * Spawn a worker loop that follows a guest's inbox and processes messages
 * using the given LLM provider configuration.
 *
 * @param {any} powers - Guest powers (manager's own or a sub-guest's)
 * @param {Promise<object> | object | undefined} context - Context for cancellation
 * @param {ProviderConstructorConfig | InjectedProviderConfig} providerConfig - LLM provider config. Pass `provider` to inject a pre-built provider (e.g. for tests); otherwise host/model/authToken are used to construct one.
 * @param {string} [systemPrompt] - Override system prompt (defaults to guestSystemPrompt)
 * @returns {Promise<void>}
 */
export const spawnWorkerLoop = async (
  powers,
  context,
  providerConfig,
  systemPrompt,
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

  const provider =
    providerConfig.provider ||
    createProvider({
      LAL_HOST: providerConfig.host,
      LAL_MODEL: providerConfig.model,
      LAL_AUTH_TOKEN: providerConfig.authToken,
    });

  /**
   * @param {object[]} messages
   * @param {object[]} toolSchemas
   * @returns {Promise<{message: object}>}
   */
  const chat = (messages, toolSchemas) => provider.chat(messages, toolSchemas);

  const effectivePrompt = systemPrompt || guestSystemPrompt;
  const tree = makeConversationTree(makeEndoPetstoreBackend(powers));

  /**
   * Find or create the root node that carries the system prompt.
   * If the system prompt has changed since the last root was created,
   * start a fresh conversation tree so old messages with stale
   * instructions don't confuse the LLM.
   *
   * @returns {Promise<string>} rootNodeId
   */
  const getOrCreateRoot = async () => {
    const roots = await tree.getRoots();
    if (roots.length > 0) {
      const existingRoot = await tree.getNode(roots[0].id);
      if (existingRoot) {
        const rootMsg = existingRoot.messages[0];
        if (rootMsg && rootMsg.content === effectivePrompt) {
          return roots[0].id;
        }
        // System prompt changed — start fresh
        console.log(
          '[fae] System prompt changed, creating fresh conversation tree',
        );
      }
    }
    const root = await tree.addNode(null, [
      { role: 'system', content: effectivePrompt },
    ]);
    return root.id;
  };

  const rootNodeIdP = getOrCreateRoot();

  // Built-in tools: petname ops + mail (no filesystem tools for guest)
  /** @type {Map<string, object>} */
  const localTools = new Map();
  localTools.set('list', makeListPetnamesTool(powers));
  localTools.set('lookup', makeLookupTool(powers));
  localTools.set('store', makeStoreTool(powers));
  localTools.set('remove', makeRemoveTool(powers));
  localTools.set('adopt', makeAdoptTool(powers));
  localTools.set('adoptTool', makeAdoptToolTool(powers));
  localTools.set('send', makeSendTool(powers));
  // Wrap the reply tool to track whether a reply was sent during
  // the current agentic loop iteration, so we can auto-reply if
  // the LLM outputs content without calling the tool.
  const replyTracker = { sent: false };
  const baseReplyTool = makeReplyTool(powers);
  localTools.set(
    'reply',
    harden({
      schema: () => baseReplyTool.schema(),
      async execute(/** @type {any} */ args) {
        replyTracker.sent = true;
        return baseReplyTool.execute(args);
      },
      help: () => baseReplyTool.help(),
    }),
  );
  localTools.set('listMessages', makeListMessagesTool(powers));
  localTools.set('dismiss', makeDismissTool(powers));
  localTools.set('editMessage', makeEditMessageTool(powers));
  localTools.set('messageHistory', makeMessageHistoryTool(powers));
  localTools.set('exec', makeExecTool(powers));
  localTools.set('readChannel', makeReadChannelTool(powers));

  /**
   * @param {object} toolCall
   * @returns {Record<string, unknown>}
   */
  const decodeToolArgs = toolCall => {
    const { arguments: argsRaw } = /** @type {any} */ (toolCall).function;
    try {
      const jsonString =
        typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw);
      return decodeSmallcaps(jsonString);
    } catch {
      try {
        const jsonString =
          typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw);
        return JSON.parse(jsonString);
      } catch {
        return {};
      }
    }
  };

  /**
   * Process tool calls from the LLM response.
   * Parses JSON arguments and encodes results with passableAsJustin.
   *
   * When `unattemptedEdges` is non-empty, adoption calls (`adopt`,
   * `adoptTool`) in the batch run first; the local pending-edges set
   * is updated as each adoption is attempted, and non-adoption calls
   * are rejected only if pending edges remain.  This lets the model
   * parallel-fire `adoptTool` + `reply` in one turn instead of paying
   * for a second LLM round trip when the same batch covers the only
   * pending edge.  Results are returned in input order so each
   * tool_call_id still pairs with the model's original invocation.
   *
   * @param {object[]} toolCalls
   * @param {Map<string, object>} toolMap
   * @param {{ unattemptedEdges?: Iterable<string> }} [options]
   * @returns {Promise<{ results: object[], attemptedAdoptionEdges: string[] }>}
   */
  const processToolCalls = async (toolCalls, toolMap, options = {}) => {
    /** @type {Set<string>} */
    const pendingEdges = new Set(options.unattemptedEdges ?? []);
    const attemptedAdoptionEdges = new Set();

    /** @type {object[]} */
    const results = new Array(toolCalls.length);

    // Pair each call with its original index, then sort so adoption
    // calls run first within the batch.  `Array.prototype.sort` is
    // stable in modern engines, so non-adoption calls keep their
    // relative order.
    const indexed = toolCalls.map((call, idx) => ({ idx, call }));
    indexed.sort((a, b) => {
      const aKind = ['adopt', 'adoptTool'].includes(
        /** @type {any} */ (a.call).function?.name,
      )
        ? 0
        : 1;
      const bKind = ['adopt', 'adoptTool'].includes(
        /** @type {any} */ (b.call).function?.name,
      )
        ? 0
        : 1;
      return aKind - bKind;
    });

    for (const { idx, call } of indexed) {
      const { name } = /** @type {any} */ (call).function;
      const args = decodeToolArgs(call);
      const isAdoptionCall = ['adopt', 'adoptTool'].includes(name);
      if (isAdoptionCall && typeof args.edgeName === 'string') {
        attemptedAdoptionEdges.add(args.edgeName);
        pendingEdges.delete(args.edgeName);
      }

      console.log(`[tool] ${name}(${passableAsJustin(harden(args), false)})`);
      replyTracker.anyToolCalled = true;

      let result;
      if (!isAdoptionCall && pendingEdges.size > 0) {
        const errorMessage =
          'Attached references must each be adopted or attempted before using other tools.';
        result = harden({ error: errorMessage });
        console.error(`[tool] ${name} error: ${errorMessage}`);
      } else {
        try {
          result = await executeTool(name, args, toolMap);
          console.log(`[tool] ${name} -> ${passableAsJustin(result, false)}`);
        } catch (error) {
          const rawMessage =
            error instanceof Error ? error.message : String(error);
          const errorMessage = addAdoptionHintToError(rawMessage);
          result = harden({ error: errorMessage });
          console.error(`[tool] ${name} error: ${errorMessage}`);
        }
      }

      results[idx] = {
        role: 'tool',
        content: passableAsJustin(result, false),
        tool_call_id: /** @type {any} */ (call).id,
      };
    }

    return harden({
      results,
      attemptedAdoptionEdges: [...attemptedAdoptionEdges],
    });
  };

  /**
   * Run the agentic loop for a single incoming message.
   * Re-discovers tools after any adoptTool call so newly adopted tools
   * are immediately available in the same turn.
   *
   * The context snapshot is rebuilt from the tree on each LLM call so
   * that newly appended nodes are always included.
   *
   * @param {object[]} initialSchemas
   * @param {Map<string, object>} initialToolMap
   * @param {string} leafNodeId - the node to continue from
   * @param {string[]} requiredAdoptionEdges - attachment edge names to attempt
   * @returns {Promise<string>} the final leaf node ID after the loop completes
   */
  const runAgenticLoop = async (
    initialSchemas,
    initialToolMap,
    leafNodeId,
    requiredAdoptionEdges,
  ) => {
    const maxEmptyResponseRetries = 2;
    let currentSchemas = initialSchemas;
    let currentToolMap = initialToolMap;
    let currentLeafId = leafNodeId;
    let emptyResponseRetries = 0;
    let adoptionReminderSent = false;
    const unattemptedAdoptionEdges = new Set(requiredAdoptionEdges);
    /** @type {boolean} */
    let continueLoop = true;
    while (continueLoop) {
      const conversationContext = await tree.getPath(currentLeafId);
      console.log(
        `[fae] context has ${conversationContext.length} messages, sending to LLM`,
      );
      console.log(
        `[fae] chat messages: ${JSON.stringify(conversationContext, null, 2)}`,
      );
      const response = await chat(conversationContext, currentSchemas);

      const { message: responseMessage } = response;
      if (!responseMessage) {
        break;
      }

      const rm = /** @type {any} */ (responseMessage);
      if ((!rm.tool_calls || rm.tool_calls.length === 0) && rm.content) {
        const extracted = extractToolCallsFromContent(rm.content);
        if (extracted.toolCalls) {
          rm.tool_calls = extracted.toolCalls;
          rm.content = extracted.cleanedContent;
        }
      }

      console.log(`[fae] sent: ${JSON.stringify(responseMessage, null, 2)}`);

      const toolCalls = Array.isArray(rm.tool_calls) ? rm.tool_calls : [];
      if (toolCalls.length !== 0) {
        const requiresAdoptionAttempt = unattemptedAdoptionEdges.size > 0;
        const { results: toolResults, attemptedAdoptionEdges } =
          await processToolCalls(toolCalls, currentToolMap, {
            unattemptedEdges: unattemptedAdoptionEdges,
          });
        for (const edgeName of attemptedAdoptionEdges) {
          unattemptedAdoptionEdges.delete(edgeName);
        }
        if (requiresAdoptionAttempt) {
          console.log(
            `[fae] awaiting adoption attempts for: ${[...unattemptedAdoptionEdges].join(', ') || '<none>'}`,
          );
        }
        console.log(
          `[fae] tool results: ${JSON.stringify(toolResults, null, 2)}`,
        );

        // Store the assistant response + tool results as a single tree node.
        const stepNode = await tree.addNode(currentLeafId, [
          responseMessage,
          ...toolResults,
        ]);
        currentLeafId = stepNode.id;

        const adopted = toolCalls.some(
          tc => /** @type {any} */ (tc).function?.name === 'adoptTool',
        );
        const replied = toolCalls.some(
          tc => /** @type {any} */ (tc).function?.name === 'reply',
        );
        if (adopted) {
          const refreshed = await discoverTools(powers, localTools);
          currentSchemas = refreshed.schemas;
          currentToolMap = refreshed.toolMap;
          console.log(
            `[fae] Re-discovered tools after adoption: ${currentSchemas.length} available`,
          );
        }
        if (replied && replyTracker.sent) {
          continueLoop = false;
        }
      } else if (unattemptedAdoptionEdges.size > 0 && !adoptionReminderSent) {
        console.log(
          '[fae] attached references were not adopted; asking model to retry once',
        );
        // These repair injections are harness-level corrections, not real
        // user input. We tag them role:'user' with a "[system]" prefix for
        // portability across chat providers. This could be changed to
        // role:'system' outright, provided the provider layer translates
        // it for Anthropic (which takes system as a top-level param, not
        // a message role).
        const repairNode = await tree.addNode(currentLeafId, [
          responseMessage,
          {
            role: 'user',
            content: adoptionRepairMessage,
          },
        ]);
        currentLeafId = repairNode.id;
        adoptionReminderSent = true;
      } else if (
        !rm.content &&
        !replyTracker.sent &&
        emptyResponseRetries < maxEmptyResponseRetries
      ) {
        console.log(
          `[fae] empty-content response; asking model to continue (${emptyResponseRetries + 1}/${maxEmptyResponseRetries})`,
        );
        // See note above on adoption-repair: role:'user' + "[system]" prefix
        // is a portability hack; could become role:'system' once the
        // provider layer translates for Anthropic.
        const repairNode = await tree.addNode(currentLeafId, [
          responseMessage,
          {
            role: 'user',
            content: emptyResponseRepairMessage,
          },
        ]);
        currentLeafId = repairNode.id;
        emptyResponseRetries += 1;
      } else {
        // Final assistant response — store as a tree node.
        const finalNode = await tree.addNode(currentLeafId, [responseMessage]);
        currentLeafId = finalNode.id;
        continueLoop = false;
        if (rm.content) {
          console.log(`[fae] ${rm.content}`);
        } else if (!replyTracker.sent) {
          console.log('[fae] empty-content fallthrough; no reply sent');
        }
      }
    }
    return currentLeafId;
  };

  /**
   * Initialize: move any introduced tool entries into the tools/ subdirectory.
   * Tools introduced via provideGuest's introducedNames appear at the top level.
   * We detect them by checking for the FaeTool interface (schema, execute, help).
   *
   * Uses `__getMethodNames__()` to filter rather than duck-typing with
   * `.schema()` / `.help()`.  Duck-typing generates a noisy
   * `CapTP <name> exception: TypeError: target has no method "schema"`
   * line in the worker log for every non-FaeTool guest in the
   * namespace (e.g., `llm-provider`, `agent`), since `connection.js`'s
   * default `onReject` fires before our local `catch` swallows the
   * error.  `makeExo` objects expose `__getMethodNames__()` for
   * exactly this kind of interface introspection — see the repo-root
   * `CLAUDE.md` § "CapTP introspection".
   *
   * @returns {Promise<void>}
   */
  const initializeIntroducedTools = async () => {
    try {
      await E(powers).makeDirectory(['tools']);
    } catch {
      // Already exists.
    }

    try {
      const topNames = /** @type {string[]} */ (await E(powers).list());
      for (const name of topNames) {
        if (name !== 'tools' && !specialNamePattern.test(name)) {
          try {
            const entry = await E(powers).lookup([name]);
            const methodNames = /** @type {string[]} */ (
              // eslint-disable-next-line no-underscore-dangle
              await E(entry).__getMethodNames__()
            );
            const isFaeTool = ['schema', 'execute', 'help'].every(method =>
              methodNames.includes(method),
            );
            if (isFaeTool) {
              await E(powers).copy([name], ['tools', name]);
              await E(powers).remove(name);
              console.log(`[fae] Moved introduced tool "${name}" into tools/`);
            }
          } catch {
            // Not introspectable or move failed; leave it alone.
          }
        }
      }
    } catch {
      // list() failed; skip initialization.
    }
  };

  /**
   * Main agent loop: follow messages and process them.
   *
   * @returns {Promise<void>}
   */
  const runAgent = async () => {
    await initializeIntroducedTools();

    await E(powers).send('@host', ['Fae agent ready.'], [], []);

    /** @type {string | undefined} */
    const selfLocator = await E(powers).locate('@self');
    const cancelled = await getCancelled();
    const cancelledSignal = cancelled
      ? cancelled.then(
          () => ({ cancelled: true }),
          () => ({ cancelled: true }),
        )
      : null;

    // Track the most recent leaf across messages so that follow-up
    // messages from the same sender continue the conversation rather
    // than branching from the root (which would lose all context).
    let lastLeafId = await rootNodeIdP;

    /**
     * Track inbound message numbers we have already processed.  Re-emission
     * of the same number indicates the sender called daemon `editMessage`:
     * a partial submission settling, or an amendment of an already-settled
     * message.  We do not rerun the agentic loop for such re-emissions;
     * the agent can call `messageHistory(n)` to retrieve the prior text
     * if it needs to reason about the change.
     * @type {Set<bigint>}
     */
    const seenInboundNumbers = new Set();

    const messageIterator = iterateReader(E(powers).followMessages());
    while (true) {
      const nextMessage = messageIterator.next();
      const raced = cancelledSignal
        ? await Promise.race([
            cancelledSignal,
            nextMessage.then(result => ({ cancelled: false, result })),
          ])
        : { cancelled: false, result: await nextMessage };
      if (raced.cancelled) {
        try {
          await messageIterator.return?.();
        } catch {
          // ignore iterator return errors on cancellation
        }
        break;
      }
      const { value: message, done } = raced.result;
      if (done) {
        break;
      }
      const {
        from: fromId,
        number,
        type,
        strings,
        names,
        done: messageDone = true,
        ids,
      } = /** @type {any} */ (message);

      if (fromId !== selfLocator) {
        const { messageId, replyTo } = /** @type {any} */ (message);

        // Skip partial (in-flight) submissions: wait until the sender
        // marks the message done before spinning up an LLM turn.
        if (messageDone === false) {
          console.log(
            `[fae] Message #${number} is not yet done; deferring until settled`,
          );
          // eslint-disable-next-line no-continue
          continue;
        }

        // Re-emission of a previously-processed number means the sender
        // edited a settled message.  Do not start a new turn; the
        // history is available via the messageHistory tool.
        if (seenInboundNumbers.has(number)) {
          console.log(
            `[fae] Message #${number} was edited after settlement; ` +
              `not rerunning. Use messageHistory(${number}) for the prior text.`,
          );
          // eslint-disable-next-line no-continue
          continue;
        }
        seenInboundNumbers.add(number);

        await rootNodeIdP;

        console.log(`[fae] New message #${number} from ${fromId}`);
        console.log(
          `[fae] inbound envelope: ${JSON.stringify({ type, strings, names, ids, replyTo, messageId }, null, 2)}`,
        );

        // Discover tools (picks up newly adopted tools each turn)
        const { schemas: toolSchemas, toolMap } = await discoverTools(
          powers,
          localTools,
        );

        const probeKind = async id => {
          if (!id) return 'unknown';
          try {
            const ref = await E(powers).lookupById(formulaIdFromMessageId(id));
            try {
              await E(ref).schema();
              return 'tool';
            } catch {
              return 'value';
            }
          } catch {
            return 'unknown';
          }
        };
        const userContent = await buildInboxMessageContent(
          { number, type, strings, names, ids },
          probeKind,
        );
        console.log(`[fae] user prompt:\n${userContent}`);

        // Determine the parent node for this message:
        //  1. If replyTo matches a node in the tree, branch from there
        //  2. Otherwise continue from the last leaf (preserves context)
        let parentId = lastLeafId;
        if (typeof replyTo === 'string') {
          const existingNode = await tree.getNode(replyTo);
          if (existingNode !== null) {
            parentId = replyTo;
          }
        }

        const userNode = await tree.addNode(
          parentId,
          [
            {
              role: 'user',
              content: userContent,
            },
          ],
          { messageId },
        );

        try {
          replyTracker.sent = false;
          lastLeafId = await runAgenticLoop(
            toolSchemas,
            toolMap,
            userNode.id,
            Array.isArray(names) ? names : [],
          );

          // If the LLM produced a final response without calling the reply
          // tool, send the content as a fallback reply so the sender
          // (e.g. a Whylip UI) actually receives it.
          if (!replyTracker.sent) {
            const finalNode = await tree.getNode(lastLeafId);
            if (finalNode) {
              const lastMsg = finalNode.messages[finalNode.messages.length - 1];
              if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content) {
                console.log(
                  '[fae] No reply tool called, sending fallback reply',
                );
                await E(powers).reply(number, [lastMsg.content], [], []);
              }
            }
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error('[fae] LLM error, notifying sender:', errorMessage);
          await E(powers).reply(number, [errorMessage], [], []);
        }
      }
    }
  };

  // Start the worker loop
  await runAgent();
};
harden(spawnWorkerLoop);

// ============================================================================
// Fae Factory — Entry Point
// ============================================================================

const driverSpecifier = new URL('driver.js', import.meta.url).href;

/**
 * Creates a Fae factory that provisions and manages agent instances.
 *
 * Reads `llm-provider` from its petstore for the LLM configuration.
 * Exposes `createAgent(name, options)` for creating new agents, each
 * backed by a driver caplet that can be pinned for restart survival.
 *
 * @param {import('@endo/eventual-send').FarRef<object>} guestPowers
 * @param {Promise<object> | object | undefined} _context
 * @returns {Promise<object>}
 */
// eslint-disable-next-line no-underscore-dangle
export const make = async (guestPowers, _context) => {
  /** @type {any} */
  const powers = guestPowers;

  const hostAgent = await E(powers).lookup('host-agent');

  return makeExo('FaeFactory', FaeFactoryInterface, {
    /**
     * Create a new agent instance with its own guest, driver caplet,
     * and inbox/LLM loop.
     *
     * The driver is a standalone `make-unconfined` formula that holds
     * capability references to the LLM provider config and the agent
     * guest.  When `pin: true`, the driver is written to PINS so
     * `revivePins()` restarts it automatically on daemon reboot.
     *
     * @param {string} name - Unique name for this agent
     * @param {object} [options]
     * @param {string} [options.systemPrompt] - Override system prompt
     * @param {boolean} [options.pin] - Pin the driver to PINS for restart survival
     * @returns {Promise<string>} The agent's profile petname
     */
    async createAgent(name, options = {}) {
      const { systemPrompt, pin } =
        /** @type {{ systemPrompt?: string, pin?: boolean }} */ (options);

      const guestName = name;
      const profileName = `profile-for-${guestName}`;
      const driverHandleName = `${name}-driver-handle`;
      const driverProfileName = `profile-for-${driverHandleName}`;
      const driverResultName = `${name}-driver`;

      if (await E(hostAgent).has(driverResultName)) {
        throw new Error(`Agent "${name}" already exists.`);
      }

      // 1. Create the agent guest (inbox, petstore, tools).
      await E(hostAgent).provideGuest(guestName, {
        agentName: profileName,
      });

      // 2. Create a lightweight driver guest whose namespace will hold
      //    capability references to the provider config and the agent.
      const driverGuest = await E(hostAgent).provideGuest(driverHandleName, {
        agentName: driverProfileName,
      });

      // 3. Write capability references into the driver's namespace.
      const providerLocator = await E(powers).locate('llm-provider');
      await E(driverGuest).storeLocator('llm-provider', providerLocator);

      const agentLocator = await E(hostAgent).locate(profileName);
      await E(driverGuest).storeLocator('agent', agentLocator);

      // 4. Launch the driver caplet.
      await E(hostAgent).makeUnconfined('@main', driverSpecifier, {
        powersName: driverProfileName,
        resultName: driverResultName,
        env: harden({ FAE_SYSTEM_PROMPT: systemPrompt || '' }),
      });

      // 5. Pin the driver so it auto-restarts on daemon reboot.
      if (pin) {
        await E(hostAgent).copy(
          [driverResultName],
          ['@pins', driverResultName],
        );
        console.log(`[fae-factory] Pinned driver "${driverResultName}"`);
      }

      console.log(`[fae-factory] Created agent "${name}"`);
      return profileName;
    },

    /**
     * @param {string} [methodName]
     * @returns {string}
     */
    help(methodName) {
      if (methodName === undefined) {
        return 'Fae factory: creates LLM agent instances bound to a configured LLM provider. Use createAgent(name, { systemPrompt, pin }) to create a new agent.';
      }
      if (methodName === 'createAgent') {
        return 'createAgent(name, { systemPrompt?, pin? }) — Create a new agent with its own guest, driver caplet, and inbox loop. Pass pin: true to survive daemon restarts. Returns the profile petname.';
      }
      return `No documentation for method "${methodName}".`;
    },
  });
};
harden(make);
