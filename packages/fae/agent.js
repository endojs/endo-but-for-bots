// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';
import { passableAsJustin, makeMarshal } from '@endo/marshal';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import {
  makeConversationTree,
  makeEndoPetstoreBackend,
} from '@endo/conversation-tree';

import { makeRotatingProvider } from './src/provider-cache.js';
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
import { runAgenticTurn } from './src/turn-engine.js';
import {
  assertAgentName,
  composeSubagentSystemPrompt,
  isSameFormula,
  makeSubagentDelegations,
  makeSubagentTools,
} from './src/subagent.js';
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  provisionFaeAgent,
} from './src/subagent-host.js';
import { AUTH_SECRET_PETNAME } from './src/credentials.js';

/** Same pattern as isSpecialName in packages/daemon/src/pet-name.js */
const specialNamePattern = /^[A-Z][A-Z0-9-]{0,127}$/;
const MAX_TOOL_ROUNDS = 32;

/**
 * Errors whose text this agent wrote itself, and may therefore mail back.
 *
 * A turn's failure is reported to whoever sent the message, and anyone holding
 * a mail handle can send one. A provider's own error text answers a question
 * they should not get to ask — "is this deployment's credential still live?" —
 * in plain English: an expired key comes back as "authentication failed",
 * a spent quota as the provider's 429 detail. Only text this module composed
 * travels; everything else is logged and answered generically.
 */
const senderVisibleErrors = new WeakSet();

/** @param {Error} error */
const senderVisible = error => {
  senderVisibleErrors.add(error);
  return error;
};

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

const guestSystemPrompt = `\
You are Fae, an autonomous agent inside the Endo daemon.

## Rules
1. When a message contains code to run, use exec() to run it. Copy the code \
from the message — do not rewrite or add to it.
2. Channel notifications include ready-to-use exec code. Run it with ONLY \
your conversational reply as the post content. Never post internal \
reasoning, steps, logs, or recaps to a channel.
3. reply() sends a PRIVATE inbox message. It does NOT post to channels.
4. References labeled "(author)" are attributions — do not adopt them.
5. Keep channel posts concise and conversational — one or two sentences.

## Tools
- **exec** — Run JavaScript with powers, E, harden. Use for multi-step tasks.
- **reply** — Private inbox reply to sender by message number.
- **adopt** — Store a message reference under a pet name.
- **list/lookup/store/remove** — Manage your pet name directory.
- **send** — Send unsolicited inbox message to a named agent.
- **adoptTool** — Install a FaeTool capability from a message.
- **dismiss** — Dismiss a handled message.

## Subagents (only when the tools below are listed)

- **spawnSubagent** — Create a helper agent with its own conversation.
- **askSubagent** — Mail it a task and wait for its reply.
- **stopSubagent** — Release it when its work is done.

Delegate work that would otherwise fill your own context, and give the \
subagent everything it needs in the task text — it cannot see your \
conversation. Release each subagent once you have its answer.

You receive messages from other agents and the @host. Use these tools to interact:

- **reply** — Reply to a message by number. The reply is automatically routed \
to the original sender. **Always prefer reply over send** when responding to \
an incoming message.
- **send** — Send a new (unsolicited) message to a named agent (e.g., "@host")
- **listMessages** — List your inbox messages
- **dismiss** — Acknowledge and dismiss a message
- **adoptTool** — Adopt a capability from a message into your tools/ directory

## Petname Directory

You have a persistent directory of named references (petnames):

- **list** — See all stored petnames
- **lookup** — Retrieve a value by petname
- **store** — Persist a JSON value under a petname
- **remove** — Delete a petname

## Adopting Values from Messages

When you receive a message that contains values (the @name references in the \
message text), you should ALWAYS adopt each value before doing anything else. \
Choose your own pet name for it, but remember the edge name the sender used — \
that is how the sender refers to it in the message text.

For tool capabilities, use \`adoptTool\` to install them into your tools/ \
directory. Once adopted, the tool is immediately available — try it right away.

For other values, use the \`adopt\` tool to store them under a pet name in your \
directory. You can then use \`lookup\` to retrieve them later.

Example: if a message says "Here is @counter for you", adopt it:
  adopt(messageNumber, "counter", "my-counter")

## Response Guidelines

- Use tools to accomplish requests. Do not fabricate results.
- For multi-step tasks, break them down and execute step by step.
- If a tool call fails, read the error and try a different approach.
- When done, use **reply** (not send) to respond to the sender with a concise summary.
- Always dismiss messages after handling them.
`;

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
 * @param {object} [options]
 * @param {any} [options.spawner] - A `SubagentSpawner` capability. Present only
 *   for an agent this deployment allows to delegate; its absence is what
 *   withholds the subagent tools.
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [options.timers]
 * @param {string} [options.delegatedPrompt] - Standing instructions written by
 *   this agent's parent, appended to the system prompt rather than replacing
 *   it. See `composeSubagentSystemPrompt`.
 * @param {() => Promise<string>} [options.provideAuthToken] - Reads the auth
 *   token afresh for each turn, so a rotated secret reaches a running agent and
 *   a revoked one stops it. Absent when the caller injected a built provider.
 * @returns {Promise<void>}
 */
export const spawnWorkerLoop = async (
  powers,
  context,
  providerConfig,
  systemPrompt,
  { spawner, timers, provideAuthToken, delegatedPrompt } = {},
) => {
  /**
   * The agent's cancellation promise, boxed.
   *
   * Called, never duck-typed. A caplet's context arrives over CapTP as a
   * *presence* — an empty Far object whose methods are reachable only through
   * `E()` — so `typeof resolvedContext.whenCancelled` is `'undefined'` there
   * however the daemon defined it. Testing for the property answered "this
   * agent has no cancellation signal" for every agent that had one, and the
   * loop could not be stopped short of a daemon restart.
   *
   * Boxed because an async function *adopts* a promise it returns, and
   * `whenCancelled` is typed `() => Promise<never>`: returning it directly
   * would mean `await getCancelled()` never settled.
   *
   * Three events reach the handler and all three mean stop: the agent was
   * cancelled; the connection to the daemon dropped, so the promise rejects
   * as disconnected; or the context does not implement the method, which is a
   * construction bug better surfaced as a stopped loop than as a loop nothing
   * can stop. `packages/sandbox/src/factory.js` makes the same collapse and
   * explains it at length.
   *
   * @returns {Promise<{ promise: Promise<unknown> } | null>}
   */
  const getCancelled = async () => {
    if (!context) return null;
    const resolvedContext = await context;
    if (!resolvedContext) return null;
    return harden({ promise: E(resolvedContext).whenCancelled() });
  };

  // Resolved per turn rather than captured when the loop starts, so a rotated
  // secret reaches an agent that is already running and a revoked one stops
  // its next turn. See `makeRotatingProvider`.
  const currentProvider = makeRotatingProvider({
    config: providerConfig,
    ...(provideAuthToken ? { provideAuthToken } : {}),
  });

  /**
   * The provider a turn runs on, resolved once when the turn starts.
   *
   * Not once per round: a turn may take up to `MAX_TOOL_ROUNDS` provider calls,
   * and reading the secret for each of them would multiply the daemon's audit
   * trail by the model's tool use — burying the retry pattern that trail exists
   * to show, and paying three eventual-sends per round for it. Per turn is the
   * granularity rotation and revocation actually need.
   * @type {any}
   */
  let turnProvider;

  /**
   * @param {object[]} messages
   * @param {object[]} toolSchemas
   * @returns {Promise<{message: object}>}
   */
  const chat = async (messages, toolSchemas) =>
    turnProvider.chat(messages, toolSchemas);

  const effectivePrompt = composeSubagentSystemPrompt(
    systemPrompt || guestSystemPrompt,
    delegatedPrompt,
  );
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
        console.error(
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

  // Delegation is capability-gated: without a spawner there are no subagent
  // tools and `claim` has nothing to match, so the inbox loop below behaves
  // exactly as it did before.
  const delegations = makeSubagentDelegations(
    harden({ powers, ...(timers ? { timers } : {}) }),
  );
  if (spawner) {
    for (const [name, tool] of makeSubagentTools({
      powers,
      spawner,
      delegations,
    })) {
      localTools.set(name, tool);
    }
  }

  /**
   * Process tool calls from the LLM response.
   * Parses JSON arguments and encodes results with passableAsJustin.
   *
   * @param {object[]} toolCalls
   * @param {Map<string, object>} toolMap
   * @returns {Promise<object[]>}
   */
  const processToolCalls = async (toolCalls, toolMap) => {
    /** @type {object[]} */
    const results = [];

    for (const toolCall of toolCalls) {
      const { name, arguments: argsRaw } = /** @type {any} */ (toolCall)
        .function;

      /** @type {Record<string, unknown>} */
      let args;
      try {
        const jsonString =
          typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw);
        args = decodeSmallcaps(jsonString);
      } catch {
        // Smallcaps decoding failed — try plain JSON parse
        try {
          const jsonString =
            typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw);
          args = JSON.parse(jsonString);
        } catch {
          args = {};
        }
      }

      console.log(`[tool] ${name}(${passableAsJustin(harden(args), false)})`);
      replyTracker.anyToolCalled = true;

      let result;
      try {
        result = await executeTool(name, args, toolMap);
        console.log(`[tool] ${name} -> ${passableAsJustin(result, false)}`);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        result = harden({ error: errorMessage });
        console.error(`[tool] ${name} error: ${errorMessage}`);
      }

      results.push({
        role: 'tool',
        content: passableAsJustin(result, false),
        tool_call_id: /** @type {any} */ (toolCall).id,
      });
    }

    return results;
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
   * @returns {Promise<{ answered: boolean, exhausted: boolean, leafId: string, message?: any }>} the turn outcome
   */
  const runAgenticLoop = async (initialSchemas, initialToolMap, leafNodeId) => {
    const firstTools = harden({
      schemas: initialSchemas,
      toolMap: initialToolMap,
    });
    const outcome = await runAgenticTurn({
      leafId: leafNodeId,
      maxRounds: MAX_TOOL_ROUNDS,
      getTools: round =>
        round === 0 ? firstTools : discoverTools(powers, localTools),
      getContext: async currentLeafId => {
        const providerContext = await tree.getPath(currentLeafId);
        console.log(
          `[fae] context has ${providerContext.length} messages, sending to LLM`,
        );
        return providerContext;
      },
      invoke: async (providerContext, tools) => {
        const response = await chat(providerContext, tools.schemas);
        const responseMessage = response.message;
        if (responseMessage) {
          const rm = /** @type {any} */ (responseMessage);
          if ((!rm.tool_calls || rm.tool_calls.length === 0) && rm.content) {
            const extracted = extractToolCallsFromContent(rm.content);
            if (extracted.toolCalls) {
              rm.tool_calls = extracted.toolCalls;
              rm.content = extracted.cleanedContent;
            }
          }
          console.log(
            `[fae] sent: ${JSON.stringify(responseMessage, null, 2)}`,
          );
        }
        return harden({ message: responseMessage });
      },
      getToolCalls: message =>
        Array.isArray(message.tool_calls) ? message.tool_calls : [],
      runTools: async (calls, tools) => {
        const results = await processToolCalls(calls, tools.toolMap);
        console.log(`[fae] tool results: ${JSON.stringify(results, null, 2)}`);
        return results;
      },
      commitStep: async (currentLeafId, message, results) => {
        const node = await tree.addNode(currentLeafId, [message, ...results]);
        return node.id;
      },
      commitFinal: async (currentLeafId, message) => {
        const node = await tree.addNode(currentLeafId, [message]);
        if (message.content) console.log(`[fae] ${message.content}`);
        return node.id;
      },
    });
    return outcome;
  };

  /**
   * Initialize: move any introduced tool entries into the tools/ subdirectory.
   * Tools introduced via provideGuest's introducedNames appear at the top level.
   * We detect them by checking for the FaeTool interface (schema, execute, help).
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
            await E(entry).schema();
            await E(entry).help();
            // Looks like a FaeTool — move it into tools/
            await E(powers).copy([name], ['tools', name]);
            await E(powers).remove(name);
            console.log(`[fae] Moved introduced tool "${name}" into tools/`);
          } catch {
            // Not a FaeTool; leave it alone.
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
      ? cancelled.promise.then(
          () => ({ cancelled: true }),
          reason => {
            // Not being able to *observe* cancellation is a different event
            // from being cancelled, and both stop this loop. Say which: an
            // agent that goes quiet because its context never implemented
            // `whenCancelled` looks exactly like one that was cancelled on
            // purpose, and neither prints anything otherwise — `runAgent`
            // returns normally, so the driver's own `.catch` never fires.
            console.error(
              '[fae] cancellation signal lost; stopping the inbox loop:',
              /** @type {Error} */ (reason)?.message ?? reason,
            );
            return { cancelled: true };
          },
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

    /**
     * Run one inbound message as a turn.
     *
     * Called only from the serial worker below, never from the pump, so a turn
     * that blocks inside `askSubagent` cannot stop the stream that carries its
     * answer.
     *
     * @param {any} message
     */
    const handleMessage = async message => {
      const {
        from: fromId,
        number,
        type,
        strings,
        names,
        messageId,
        replyTo,
      } = message;

      // Read the credential before anything else. A revoked or unreadable
      // secret is a fact about this deployment that no peer should be able to
      // read off a reply, so this failure — like a provider's — is answered
      // generically and logged in full.
      try {
        turnProvider = await currentProvider();
      } catch (error) {
        console.error(
          '[fae] provider unavailable:',
          error instanceof Error ? error.message : String(error),
        );
        await E(powers).reply(
          number,
          ['This agent cannot reach its language model right now.'],
          [],
          [],
        );
        return;
      }

      await rootNodeIdP;

      console.error(`[fae] New message #${number} from ${fromId}`);

      // Discover tools (picks up newly adopted tools each turn)
      const { schemas: toolSchemas, toolMap } = await discoverTools(
        powers,
        localTools,
      );

      let textContent;
      if (type === 'package' && Array.isArray(strings)) {
        const parts = [];
        const namesArray = Array.isArray(names) ? names : [];
        for (let i = 0; i < strings.length; i += 1) {
          parts.push(strings[i]);
          if (i < namesArray.length) {
            parts.push(`@${namesArray[i]}`);
          }
        }
        textContent = parts.join('').trim();
      } else {
        textContent = `(${type || 'unknown'} message)`;
      }

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
            content: `[Inbox message #${number}] ${textContent}\n\nUse reply(messageNumber: ${number}, ...) to respond to this message.`,
          },
        ],
        { messageId },
      );

      try {
        replyTracker.sent = false;
        const outcome = await runAgenticLoop(toolSchemas, toolMap, userNode.id);
        lastLeafId = outcome.leafId;
        if (!outcome.answered) {
          throw senderVisible(
            Error(
              outcome.exhausted
                ? `FAE turn exceeded ${MAX_TOOL_ROUNDS} tool rounds`
                : 'FAE provider returned no assistant message',
            ),
          );
        }

        // If the LLM produced a final response without calling the reply
        // tool, send the content as a fallback reply so the sender
        // (e.g. a Whylip UI) actually receives it.
        if (!replyTracker.sent) {
          const finalNode = await tree.getNode(lastLeafId);
          if (finalNode) {
            const lastMsg = finalNode.messages[finalNode.messages.length - 1];
            if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content) {
              console.error(
                '[fae] No reply tool called, sending fallback reply',
              );
              await E(powers).reply(number, [lastMsg.content], [], []);
            }
          }
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error('[fae] turn failed:', errorMessage);
        await E(powers).reply(
          number,
          [
            error instanceof Error && senderVisibleErrors.has(error)
              ? errorMessage
              : 'This agent could not complete that request. The reason is in its log.',
          ],
          [],
          [],
        );
      }
    };

    // Turns run in a worker beside the pump below, not inside it.
    //
    // `askSubagent` blocks inside a turn until `delegations.claim` observes the
    // subagent's reply, and the only thing that feeds `claim` is the pump. A
    // turn awaited inside the pump therefore waits for a message the pump can
    // no longer read: every ask times out. The queue keeps mail strictly
    // ordered while leaving the pump free to run.
    //
    // It is deliberately unbounded. What it holds is a reference to a message
    // the daemon is holding anyway — Fae never dismisses — and it drains
    // monotonically. Declining past a bound would be worse: the pump reads
    // ahead of the model as fast as the stream yields, so a backlog of mail
    // arriving during one slow turn would be refused wholesale even though the
    // agent goes idle moments later.
    /** @type {any[]} */
    const pendingTurns = [];
    /** @type {(() => void) | undefined} */
    let wakeWorker;
    let pumpEnded = false;
    let stopping = false;

    const wake = () => {
      const notify = wakeWorker;
      wakeWorker = undefined;
      if (notify) notify();
    };

    /** @param {any} message */
    const enqueueTurn = message => {
      pendingTurns.push(message);
      wake();
    };

    const turnWorker = (async () => {
      for (;;) {
        if (stopping) return;
        if (pendingTurns.length === 0) {
          if (pumpEnded) return;
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => {
            wakeWorker = resolve;
          });
          // eslint-disable-next-line no-continue
          continue;
        }
        const message = pendingTurns.shift();
        try {
          // eslint-disable-next-line no-await-in-loop
          await handleMessage(message);
        } catch (error) {
          // `handleMessage` already mails its own failures back to the sender;
          // reaching here means even that failed, and the worker must survive.
          console.error(
            '[fae] turn failed:',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    })();

    const messageIterator = iterateReader(E(powers).followMessages());
    // The tail below runs however this loop leaves — normally, by cancellation,
    // or by a throw from the stream or from `dismiss`. Without it, a pump that
    // died left the worker parked on a wake that would never come, holding
    // every message it had already read and every ask waiting out its timeout.
    try {
      while (true) {
        const nextMessage = messageIterator.next();
        const raced = cancelledSignal
          ? await Promise.race([
              cancelledSignal,
              nextMessage.then(result => ({ cancelled: false, result })),
            ])
          : { cancelled: false, result: await nextMessage };
        if (raced.cancelled) {
          // Queued turns are abandoned rather than drained: cancellation must
          // be prompt, and an in-flight provider call can take minutes.
          stopping = true;
          // Asked to close, never awaited. The reader pump observes a close
          // only *between* pulls, so once it is parked in the source's
          // `next()` on a quiet mailbox this promise never settles — and
          // awaiting it here would hold the `finally` below, leaving every
          // pending ask to wait out its own timeout for a reply that cannot
          // arrive and the worker parked on a wake nobody will send.
          void Promise.resolve(messageIterator.return?.()).catch(
            () => undefined,
          );
          console.error('[fae] inbox loop stopped');
          return;
        }
        const { value: message, done } = raced.result;
        if (done) {
          break;
        }
        const {
          from: fromId,
          number,
          done: messageDone = true,
        } = /** @type {any} */ (message);

        // Offer every message — including this agent's own outbound mail — to
        // the delegation registry before any other routing. It learns a
        // delegation's identity from the echo of the send and consumes the
        // matching reply, which the awaiting `askSubagent` call returns
        // instead.
        const delegated = delegations.claim(message);
        if (delegated.claimed) {
          console.error(
            `[fae] Message #${number} answers a pending subagent ask`,
          );
          // Record it the way a handled message is recorded, so a later edit of
          // the reply does not arrive as if it were a fresh request.
          seenInboundNumbers.add(number);
          // A claimed reply must not survive into the next incarnation: with no
          // ask pending, a replayed reply becomes an ordinary request, this
          // agent answers the subagent, and the subagent answers back — two
          // models in an unbounded exchange. Its attachments were offered to
          // the model in the ask's result, which is the last moment they can be
          // adopted.
          void E(powers)
            .dismiss(number)
            .catch(error => {
              console.error(
                `[fae] could not dismiss claimed reply #${number}:`,
                error instanceof Error ? error.message : String(error),
              );
            });
          // eslint-disable-next-line no-continue
          continue;
        }

        if (!isSameFormula(fromId, selfLocator)) {
          // Skip partial (in-flight) submissions: wait until the sender
          // marks the message done before spinning up an LLM turn.
          if (messageDone === false) {
            console.error(
              `[fae] Message #${number} is not yet done; deferring until settled`,
            );
            // eslint-disable-next-line no-continue
            continue;
          }

          // Re-emission of a previously-processed number means the sender
          // edited a settled message.  Do not start a new turn; the
          // history is available via the messageHistory tool.
          if (seenInboundNumbers.has(number)) {
            console.error(
              `[fae] Message #${number} was edited after settlement; ` +
                `not rerunning. Use messageHistory(${number}) for the prior text.`,
            );
            // eslint-disable-next-line no-continue
            continue;
          }
          seenInboundNumbers.add(number);
          enqueueTurn(message);
        }
      }
    } finally {
      // Nothing can feed `claim` once this loop is out, so an ask that kept
      // waiting would hold the queue open for its whole timeout — up to an
      // hour — for a reply that can no longer arrive.
      pumpEnded = true;
      delegations.close(
        Error(stopping ? 'Fae agent cancelled' : 'Fae agent mailbox closed'),
      );
      wake();
    }

    // The stream ended of its own accord: let the queue drain so a reply that
    // was about to be sent is not dropped.
    await turnWorker;
  };

  // Start the worker loop
  await runAgent();
};
harden(spawnWorkerLoop);

// ============================================================================
// Fae Factory — Entry Point
// ============================================================================

const driverSpecifier = new URL('driver.js', import.meta.url).href;
const spawnerSpecifier = new URL('subagent-spawner.js', import.meta.url).href;

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
     * @param {number} [options.maxSubagentDepth] - Layers of delegation this
     *   agent's tree may reach. 0 withholds the subagent tools entirely.
     * @returns {Promise<string>} The agent's profile petname
     */
    async createAgent(name, options = {}) {
      const { systemPrompt, pin, maxSubagentDepth } =
        /** @type {{ systemPrompt?: string, pin?: boolean, maxSubagentDepth?: number }} */ (
          options
        );
      // Root and subagent names land in one flat host namespace and must parse
      // the same way. In particular a root name may carry no dot, which is
      // what keeps `SUBAGENT_INFIX` a delimiter nobody can forge — two root
      // agents `p` and `p-sub` would otherwise both claim `p-sub-sub-x`, and
      // either could enumerate and tear down the other's subagent.
      assertAgentName(name);
      const maxDepth =
        maxSubagentDepth === undefined
          ? DEFAULT_MAX_SUBAGENT_DEPTH
          : maxSubagentDepth;
      if (!Number.isInteger(maxDepth) || maxDepth < 0) {
        throw new Error('maxSubagentDepth must be a non-negative integer.');
      }

      // The auth token travels as a capability, not as a value: when the
      // factory holds a SecretBlob, every agent it creates gets the same one,
      // so a rotation or revocation reaches all of them at once.
      const hasAuthSecret = await E(powers).has(AUTH_SECRET_PETNAME);
      const { profileName } = await provisionFaeAgent({
        hostAgent,
        name,
        providerLocator: /** @type {string} */ (
          await E(powers).locate('llm-provider')
        ),
        hostAgentLocator: /** @type {string} */ (
          await E(powers).locate('host-agent')
        ),
        ...(hasAuthSecret
          ? {
              authSecretLocator: /** @type {string} */ (
                await E(powers).locate(AUTH_SECRET_PETNAME)
              ),
            }
          : {}),
        driverSpecifier,
        spawnerSpecifier,
        depth: 0,
        maxDepth,
        systemPrompt,
        pin,
      });

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
