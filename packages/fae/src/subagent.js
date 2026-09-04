// @ts-check

/* global setTimeout, clearTimeout */

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';
import { parseLocator } from '@endo/daemon/locator.js';

/**
 * @typedef {import('./tool-makers.js').ToolSchema} ToolSchema
 * @typedef {import('./tool-makers.js').FaeTool} FaeTool
 */

/** The parent's pet-store directory holding one entry per live subagent. */
export const SUBAGENT_DIRECTORY = 'subagents';

/**
 * Infix that makes a subagent's names in the factory host derivable from its
 * parent's: agent `p`'s subagent `x` is the host agent `p.sub.x`.
 *
 * The delimiter is a character an agent name may not contain, which is what
 * makes the parse unambiguous. A hyphenated infix could not be: a name is
 * allowed to contain hyphens, so `p-sub-` and `q-sub-` could produce the same
 * host name from different parents — root agents `p` and `p-sub` both claimed
 * `p-sub-sub-x`, and one could enumerate, count, and *tear down* the other's
 * subagent. Every escape of that shape needs the delimiter to appear inside a
 * name, and none can.
 *
 * A dot is a legal pet name character (`isValidName` bars only `/`, `@`, NUL,
 * and the names `.` and `..`), and `agentNamePattern` bars it from a name.
 */
export const SUBAGENT_INFIX = '.sub.';

/** Suffixes appended to an agent's name for the formulas it owns. */
export const DRIVER_SUFFIX = '-driver';
export const SPAWNER_SUFFIX = '-spawner';
export const HANDLE_SUFFIX = '-handle';

/**
 * Endings a subagent name may not have.
 *
 * `-driver` and `-spawner` are appended to an agent's own name, so a subagent
 * named `x-driver` would take the host name sibling `x`'s driver caplet
 * already holds, and enumeration would report a driver as if it were an agent.
 * `-handle` is appended one level further in (to a driver or spawner result
 * name) and so collides with nothing today; it is reserved because the naming
 * scheme is derived by concatenation, and a name that reads like part of that
 * scheme is one collision away from being part of it.
 */
export const reservedSubagentSuffixes = harden([
  DRIVER_SUFFIX,
  SPAWNER_SUFFIX,
  HANDLE_SUFFIX,
]);

/**
 * Agent names become pet names in the host directory and segments of the
 * derived names beneath them, so they are restricted to a shape that is
 * unambiguous in both and never collides with a special name. In particular
 * they carry no dot, which is what makes `SUBAGENT_INFIX` a delimiter rather
 * than a substring anyone can forge.
 *
 * The length bound is generous because a root agent's name is chosen by an
 * operator or a script, not typed: the fae smoke harness derives one from a
 * test title and a model id and runs to about fifty characters.
 *
 * It is also what bounds delegation depth against the pet-name limit. The
 * longest name derived from an agent is `profile-for-<name>-spawner-handle`,
 * 27 characters of decoration, and each level of delegation adds
 * `.sub.<name>`, 68 more. At 255 characters — `isValidName`'s cap — that
 * admits two levels; `DEFAULT_MAX_SUBAGENT_DEPTH` is 1. A deployment raising
 * the depth bound past 2 with maximal names would have `provideGuest` reject
 * a name mid-build.
 */
export const agentNamePattern = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Assert the shape shared by every agent name, root or subagent.
 *
 * A root agent is named by whoever set the deployment up and a subagent by a
 * model, but both land in one flat host namespace, so both must parse the same
 * way.
 *
 * @param {unknown} name
 * @returns {string}
 */
export const assertAgentName = name => {
  (typeof name === 'string' && agentNamePattern.test(name)) ||
    Fail`Agent name ${q(name)} must match ${q(agentNamePattern.source)}`;
  return /** @type {string} */ (name);
};
harden(assertAgentName);

const MIN_ASK_TIMEOUT_SECONDS = 1;
const MAX_ASK_TIMEOUT_SECONDS = 3600;
const DEFAULT_ASK_TIMEOUT_SECONDS = 300;
const MAX_TASK_LENGTH = 32_768;
const MAX_ANSWER_LENGTH = 262_144;

/**
 * Timed-out asks whose reply is still worth intercepting if it turns up.
 *
 * Bounded because nothing prunes the set otherwise; past the bound the oldest
 * abandoned ask is forgotten and a very late reply to it lands in the inbox as
 * ordinary mail.
 */
const MAX_ABANDONED_ASKS = 32;

/**
 * @param {unknown} name
 * @returns {string}
 */
export const assertSubagentName = name => {
  const text = assertAgentName(name);
  for (const suffix of reservedSubagentSuffixes) {
    !text.endsWith(suffix) ||
      Fail`Subagent name ${q(text)} must not end with ${q(suffix)}, which names a formula an agent owns`;
  }
  return text;
};
harden(assertSubagentName);

/**
 * Compare two locators by the formula they name.
 *
 * A locator produced by `locate()` carries the transport hints resolved from
 * `@nets` at the moment of the call, while the `from`/`to` locators stamped
 * onto a mailbox message are always hint-free. String equality between the two
 * therefore fails on any daemon that has network addresses configured, even
 * though both name the same formula. Identity is the `{ number, node }` pair.
 *
 * @param {unknown} leftLocator
 * @param {unknown} rightLocator
 * @returns {boolean}
 */
export const isSameFormula = (leftLocator, rightLocator) => {
  if (typeof leftLocator !== 'string' || typeof rightLocator !== 'string') {
    return false;
  }
  try {
    const left = parseLocator(leftLocator);
    const right = parseLocator(rightLocator);
    return left.number === right.number && left.node === right.node;
  } catch {
    return false;
  }
};
harden(isSameFormula);

/**
 * Render a package message's interleaved strings and edge names the way both
 * harnesses show an inbox message to their model.
 *
 * @param {any} message
 * @returns {string}
 */
export const messageText = message => {
  const { type, strings, names } = message || {};
  if (type !== 'package' || !Array.isArray(strings)) {
    return `(${type || 'unknown'} message)`;
  }
  const edgeNames = Array.isArray(names) ? names : [];
  const parts = [];
  for (let i = 0; i < strings.length; i += 1) {
    parts.push(strings[i]);
    if (i < edgeNames.length) {
      parts.push(`@${edgeNames[i]}`);
    }
  }
  return parts.join('').trim();
};
harden(messageText);

/**
 * The standing instructions a subagent runs under.
 *
 * The parent *model* writes `delegatedPrompt`, and the subagent gets the same
 * tools any agent of this harness gets — so substituting it for the standing
 * prompt would let a model acquire its own capabilities under instructions it
 * authored, which is a way around the deployment's instructions rather than a
 * way to delegate. It is appended instead.
 *
 * @param {string} basePrompt
 * @param {string} [delegatedPrompt]
 * @returns {string}
 */
export const composeSubagentSystemPrompt = (basePrompt, delegatedPrompt) => {
  if (!delegatedPrompt) return basePrompt;
  return [
    basePrompt,
    '---',
    'You are a subagent. Your parent agent gave you these standing ' +
      'instructions, which do not replace anything above:',
    `${delegatedPrompt}`,
  ].join('\n\n');
};
harden(composeSubagentSystemPrompt);

/** The authority a parent agent needs to acquire and release subagents. */
export const SubagentSpawnerInterface = M.interface('SubagentSpawner', {
  spawn: M.callWhen(M.string()).optional(M.record()).returns(M.record()),
  stop: M.callWhen(M.string()).returns(M.undefined()),
  list: M.callWhen().returns(M.arrayOf(M.string())),
  help: M.call().optional(M.string()).returns(M.string()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(SubagentSpawnerInterface);

/**
 * @typedef {object} PendingDelegation
 * @property {string} name
 * @property {string} recipient - Locator for the subagent's handle.
 * @property {string} text - The exact single string sent, used to distinguish
 *   this delegation from any other mail to the same subagent.
 * @property {string | undefined} outboundId - `messageId` of the delegation,
 *   learned when the daemon echoes it into this agent's own mailbox.
 * @property {(answer: { text: string, number: bigint, edgeNames: string[] }) => void} settle
 * @property {(reason: Error) => void} fail - Give up on this ask without
 *   waiting out its timer, used when the mailbox that would answer it closes.
 * @property {boolean} settled - Whether this delegation has been resolved one
 *   way or the other — answered, or failed by `close` — so the ask's `finally`
 *   knows not to record its id as an abandoned one.
 */

/**
 * Correlate blocking mailbox round-trips with spawned subagents.
 *
 * The daemon posts every message a guest sends into that guest's own mailbox
 * as well as the recipient's, and publishes both to the same ordered topic. A
 * parent's single `followMessages` loop therefore observes its own outbound
 * delegation strictly before any reply to it, which is what lets `claim`
 * learn the delegation's `messageId` from the echo and then match the reply by
 * `replyTo` — exactly, and without putting a correlation token in the text the
 * subagent reads.
 *
 * The inbox loop owns the stream, so it must offer *every* message to `claim`
 * before its own routing; `claim` reports whether the message was consumed as
 * a delegation reply and must not be turned into a conversation turn.
 *
 * @param {object} options
 * @param {any} options.powers - The parent agent's guest powers.
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [options.timers]
 */
export const makeSubagentDelegations = ({
  powers,
  timers = { setTimeout, clearTimeout },
}) => {
  /** @type {Map<string, PendingDelegation>} */
  const pendingByName = new Map();
  /** @type {Map<string, PendingDelegation>} */
  const pendingByOutboundId = new Map();
  /**
   * Delegations whose ask gave up waiting.
   *
   * A reply that arrives after the timeout has nobody to hand it to, and left
   * to fall through it becomes an ordinary inbound message: the parent answers
   * its subagent, the subagent answers back, and two models bill an unbounded
   * exchange nobody asked for. Claiming it consumes it instead — the harness
   * declines to make a turn of it, exactly as for an answered ask.
   *
   * Bounded and oldest-first, because nothing else prunes it.
   * @type {Set<string>}
   */
  const abandonedOutboundIds = new Set();

  /**
   * Set once the mailbox stream that feeds `claim` has ended.
   *
   * Nothing can settle an ask after that, so an ask made — or still pending —
   * afterwards must fail at once rather than hold its turn, and the queue
   * draining behind it, open for its whole timeout.
   * @type {Error | undefined}
   */
  let closedReason;

  /** @param {string} outboundId */
  const abandon = outboundId => {
    abandonedOutboundIds.add(outboundId);
    while (abandonedOutboundIds.size > MAX_ABANDONED_ASKS) {
      const [oldest] = abandonedOutboundIds;
      abandonedOutboundIds.delete(oldest);
    }
  };

  /** @param {PendingDelegation} delegation */
  const forget = delegation => {
    pendingByName.delete(delegation.name);
    if (delegation.outboundId !== undefined) {
      pendingByOutboundId.delete(delegation.outboundId);
    }
  };

  /**
   * Offer one mailbox message to the delegation registry.
   *
   * @param {any} message
   * @returns {{ claimed: boolean }} `claimed` means the harness must not turn
   *   this message into a conversation turn — either because it answered a
   *   pending ask, or because it answered one that had already given up.
   */
  const claim = message => {
    const unclaimed = harden({ claimed: false });
    if (!message || message.type !== 'package') return unclaimed;
    // A sender may reveal a message progressively, settling it later with
    // `editMessage`. Claiming a partial would answer the ask with a
    // "Thinking..." placeholder, so wait for the settled revision — which the
    // daemon re-emits under the same number.
    if (message.done === false) return unclaimed;
    const { from, to, replyTo, messageId, number, names } = message;

    // The echo of our own delegation, which teaches us its messageId.
    if (typeof messageId === 'string') {
      for (const delegation of pendingByName.values()) {
        if (
          delegation.outboundId === undefined &&
          isSameFormula(to, delegation.recipient) &&
          Array.isArray(message.strings) &&
          message.strings.length === 1 &&
          message.strings[0] === delegation.text
        ) {
          delegation.outboundId = messageId;
          pendingByOutboundId.set(messageId, delegation);
          return unclaimed;
        }
      }
    }

    if (typeof replyTo !== 'string') return unclaimed;
    if (abandonedOutboundIds.has(replyTo)) {
      abandonedOutboundIds.delete(replyTo);
      console.error(
        `[subagent] discarding a reply to an ask that had already given up`,
      );
      return harden({ claimed: true });
    }
    const delegation = pendingByOutboundId.get(replyTo);
    // `replyTo` can only name a message its sender took part in, but matching
    // the sender as well keeps the guarantee local to this module.
    if (!delegation || !isSameFormula(from, delegation.recipient)) {
      return unclaimed;
    }
    const edgeNames = /** @type {string[]} */ (
      (Array.isArray(names) ? names : []).filter(
        edgeName => typeof edgeName === 'string',
      )
    );
    forget(delegation);
    delegation.settled = true;
    delegation.settle({
      text: messageText(message),
      number,
      edgeNames: harden(edgeNames),
    });
    return harden({ claimed: true });
  };

  /**
   * Send one task to a subagent and resolve with its reply.
   *
   * @param {object} request
   * @param {string} request.name
   * @param {string} request.task
   * @param {number} request.timeoutSeconds
   * @returns {Promise<{ text: string, number: bigint, edgeNames: string[] }>}
   */
  const ask = async ({ name, task, timeoutSeconds }) => {
    assertSubagentName(name);
    (typeof task === 'string' &&
      task !== '' &&
      task.length <= MAX_TASK_LENGTH) ||
      Fail`Subagent task must be a non-empty string of at most ${q(MAX_TASK_LENGTH)} characters`;
    (Number.isInteger(timeoutSeconds) &&
      timeoutSeconds >= MIN_ASK_TIMEOUT_SECONDS &&
      timeoutSeconds <= MAX_ASK_TIMEOUT_SECONDS) ||
      Fail`Subagent timeout must be a whole number of seconds between ${q(MIN_ASK_TIMEOUT_SECONDS)} and ${q(MAX_ASK_TIMEOUT_SECONDS)}`;
    !pendingByName.has(name) ||
      Fail`Subagent ${q(name)} already has a question in flight`;
    if (closedReason !== undefined) throw closedReason;

    /** @type {import('@endo/promise-kit').PromiseKit<{ text: string, number: bigint, edgeNames: string[] }>} */
    const answerKit = makePromiseKit();
    // No handler is attached until the race below, two round trips away, and
    // `close` can reject in that window. Mark the rejection observed now: the
    // `ask` caller still sees it, but the host does not report a bogus
    // unhandled rejection every time a shutdown races a delegation.
    answerKit.promise.catch(() => undefined);
    /** @type {PendingDelegation} */
    const delegation = {
      name,
      // Filled in below, once `locate` has resolved. Until then the entry
      // exists only to hold the slot; `claim` cannot match an empty recipient
      // because `isSameFormula` rejects a non-locator.
      recipient: '',
      text: task,
      outboundId: undefined,
      settle: answerKit.resolve,
      fail: answerKit.reject,
      settled: false,
    };
    // Claim the slot before the first `await`. Checked-then-awaited, two
    // concurrent asks for one subagent both passed the guard and the second
    // overwrote the first, whose caller then waited out its whole timeout for
    // an answer nothing would ever deliver to it.
    pendingByName.set(name, delegation);

    const path = harden([SUBAGENT_DIRECTORY, name]);
    /** @type {unknown} */
    let recipient;
    try {
      // `locate` takes the path as separate name arguments — unlike `lookup`
      // and `send`, whose guards accept an array.
      recipient = await E(powers).locate(...path);
      typeof recipient === 'string' ||
        Fail`No subagent named ${q(name)} — spawn it first`;
    } catch (error) {
      forget(delegation);
      throw error;
    }
    delegation.recipient = /** @type {string} */ (recipient);
    // Re-checked after the await: closing during `locate` must not go on to
    // send, or the subagent bills a model turn for a reply the closed registry
    // can never observe.
    if (closedReason !== undefined) {
      forget(delegation);
      throw closedReason;
    }

    /** @type {any} */
    let timer;
    const deadline = new Promise(resolve => {
      timer = timers.setTimeout(
        () => resolve('timeout'),
        timeoutSeconds * 1000,
      );
    });
    try {
      // The registry is armed before the send so that the echo of this very
      // message cannot be observed by the inbox loop before it can be matched.
      await E(powers).send(path, harden([task]), harden([]), harden([]));
      const outcome = await Promise.race([
        answerKit.promise.then(answer => harden({ answer })),
        deadline.then(() => harden({ answer: undefined })),
      ]);
      outcome.answer !== undefined ||
        Fail`Subagent ${q(name)} did not reply within ${q(timeoutSeconds)} seconds`;
      return /** @type {{ text: string, number: bigint, edgeNames: string[] }} */ (
        outcome.answer
      );
    } finally {
      timers.clearTimeout(timer);
      // A reply that arrives after this point has nobody waiting for it. It is
      // still consumed rather than delivered — see `abandonedOutboundIds` —
      // because answering it would start an exchange between two models.
      if (!delegation.settled && delegation.outboundId !== undefined) {
        abandon(delegation.outboundId);
      }
      forget(delegation);
    }
  };

  /**
   * Give up on every pending ask, and refuse any that follows.
   *
   * Called when the mailbox stream that feeds `claim` ends: from then on no
   * reply can ever be observed, so an ask that kept waiting would hold its
   * turn — and the loop draining behind it — open for its whole timeout.
   *
   * @param {Error} reason
   */
  const close = reason => {
    closedReason = reason;
    for (const delegation of [...pendingByName.values()]) {
      forget(delegation);
      // Mark it settled before failing it: otherwise the `ask` unwinding a
      // microtask later takes its "gave up" path and re-adds the very id the
      // clear below removed.
      delegation.settled = true;
      delegation.fail(reason);
    }
    abandonedOutboundIds.clear();
  };

  return harden({ claim, ask, close });
};
harden(makeSubagentDelegations);

/**
 * Build the three tools that let a model acquire a subagent, put a question to
 * it over the mailbox, and release it again.
 *
 * The tools exist only when the harness endowed this agent with a
 * `SubagentSpawner`; an agent at the maximum delegation depth is given none,
 * which is what bounds the tree.
 *
 * @param {object} options
 * @param {any} options.powers - The parent agent's guest powers.
 * @param {any} options.spawner - A `SubagentSpawner` capability.
 * @param {ReturnType<typeof makeSubagentDelegations>} options.delegations
 * @param {boolean} [options.retainsAttachments] - Whether a claimed reply stays
 *   in the inbox long enough to adopt what it carries. False for a harness that
 *   dismisses every message it handles, where telling the model to adopt would
 *   be a lie.
 * @returns {Map<string, FaeTool>}
 */
export const makeSubagentTools = ({
  powers,
  spawner,
  delegations,
  retainsAttachments = true,
}) => {
  /** @type {Map<string, FaeTool>} */
  const tools = new Map();

  const spawnTool = harden({
    /** @returns {ToolSchema} */
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'spawnSubagent',
          description:
            'Create a subagent: a separate agent with its own conversation, ' +
            'inbox, and pet name directory. Use it to run a self-contained ' +
            'piece of work without spending your own context on it. The ' +
            'subagent is reachable by mail at the name you choose; put ' +
            'questions to it with askSubagent and release it with stopSubagent.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description:
                  'Lowercase name for the subagent, e.g. "researcher". ' +
                  'Becomes its pet name under subagents/.',
              },
              systemPrompt: {
                type: 'string',
                description:
                  "The subagent's standing instructions. Give it the role and " +
                  'the shape of the answer you want back.',
              },
            },
            required: ['name'],
          },
        },
      }),
    async execute(args) {
      const { name, systemPrompt } = /** @type {any} */ (args);
      assertSubagentName(name);
      const { locator } = /** @type {any} */ (
        await E(spawner).spawn(
          name,
          harden(systemPrompt ? { systemPrompt } : {}),
        )
      );
      // The parent binds the subagent under its own authority, so the spawner
      // never needs write access to this agent's pet store.
      if (!(await E(powers).has(SUBAGENT_DIRECTORY))) {
        await E(powers).makeDirectory(SUBAGENT_DIRECTORY);
      }
      await E(powers).storeLocator([SUBAGENT_DIRECTORY, name], locator);
      return `Spawned subagent "${name}". Ask it something with askSubagent.`;
    },
    help: () => 'Create a subagent reachable by mail under subagents/<name>.',
  });

  const askTool = harden({
    /** @returns {ToolSchema} */
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'askSubagent',
          description:
            'Send a task to a subagent by mail and wait for its reply. ' +
            'Returns the reply text. The subagent keeps its own conversation ' +
            'between questions, so follow-ups can be terse.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'The subagent to ask.',
              },
              task: {
                type: 'string',
                description:
                  'What you want it to do. Be specific about the answer you ' +
                  'expect, since only its reply comes back to you.',
              },
              timeoutSeconds: {
                type: 'integer',
                description: `How long to wait for a reply (default ${DEFAULT_ASK_TIMEOUT_SECONDS}).`,
              },
            },
            required: ['name', 'task'],
          },
        },
      }),
    async execute(args) {
      const { name, task, timeoutSeconds } = /** @type {any} */ (args);
      const answer = await delegations.ask({
        name,
        task,
        timeoutSeconds:
          timeoutSeconds === undefined
            ? DEFAULT_ASK_TIMEOUT_SECONDS
            : Number(timeoutSeconds),
      });
      const text =
        answer.text.length > MAX_ANSWER_LENGTH
          ? `${answer.text.slice(0, MAX_ANSWER_LENGTH)}\n\n(truncated)`
          : answer.text;
      if (answer.edgeNames.length === 0) return text;
      const edges = answer.edgeNames
        .map(edgeName => `"${edgeName}"`)
        .join(', ');
      return retainsAttachments
        ? `${text}\n\n(System: the reply is message #${answer.number} and ` +
            `attaches object(s) with edge name(s) ${edges}. Call adopt with ` +
            `that message number and edge name to keep any of them.)`
        : `${text}\n\n(System: the reply attached object(s) with edge name(s) ` +
            `${edges}, which this session does not retain. To keep one, ask ` +
            `the subagent to store it under a pet name and tell you the name.)`;
    },
    help: () =>
      'Send a task to a subagent by mail and return its reply as text.',
  });

  const stopTool = harden({
    /** @returns {ToolSchema} */
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'stopSubagent',
          description:
            'Release a subagent: stop its inbox loop and drop its name. Do ' +
            'this once its work is done; a subagent left running keeps its ' +
            'conversation and costs resources.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The subagent to release.' },
            },
            required: ['name'],
          },
        },
      }),
    async execute(args) {
      const { name } = /** @type {any} */ (args);
      assertSubagentName(name);
      await E(spawner).stop(name);
      // Drop the parent's own edge last, so a failed stop leaves a name that
      // still points at something rather than a dangling one.
      if (await E(powers).has(SUBAGENT_DIRECTORY, name)) {
        await E(powers).remove(SUBAGENT_DIRECTORY, name);
      }
      return `Stopped subagent "${name}".`;
    },
    help: () => 'Stop a subagent and remove its name.',
  });

  tools.set('spawnSubagent', spawnTool);
  tools.set('askSubagent', askTool);
  tools.set('stopSubagent', stopTool);
  return tools;
};
harden(makeSubagentTools);
