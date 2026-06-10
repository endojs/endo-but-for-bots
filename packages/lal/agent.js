// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop */

import { makeExo } from '@endo/exo';
import { M, mustMatch } from '@endo/patterns';
import { E } from '@endo/eventual-send';
import { passableAsJustin } from '@endo/marshal';
import { makeRefIterator } from '@endo/daemon/ref-reader.js';
import { NamePathShape, NameOrPathShape } from '@endo/daemon/type-guards.js';
import { makeLocalTree } from '@endo/platform/fs/node';

import { Agent as PiAgent } from '@earendil-works/pi-agent-core';
import { registerBuiltInApiProviders, getModel } from '@earendil-works/pi-ai';

import { runAgentRound } from './agent-round.js';
import {
  persistTurnDelta,
  loadPersistedTranscript,
} from './transcript-persistence.js';

/** @import { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core' */
/** @import { Model } from '@earendil-works/pi-ai' */

/** @import { FarRef } from '@endo/eventual-send' */
/** @import { GuestPowers, ToolCallArgs, InboxMessage, LalContext } from './agent.types.js' */

// Register pi-ai's built-in API providers (anthropic, openai, google,
// openrouter, mistral, deepseek, groq, xai, github-copilot, and ~20 others)
// so getModel(provider, modelId) lookups succeed for any caller-supplied
// "provider/modelId" string. Ollama is *not* in this registry; lal handles
// "ollama/<id>" specially in `resolveWorkerModel` below by constructing a
// custom Model that points at a local OpenAI-compatible Ollama endpoint.
registerBuiltInApiProviders();

// ============================================================================
// Interface Definition
// ============================================================================

const LalInterface = M.interface('Lal', {
  help: M.call().optional(M.string()).returns(M.string()),
});

// ============================================================================
// Endo Capability Tool Specs
// ============================================================================
//
// Each tool is named, has a one-line summary (used by pi-agent-core as the
// tool description sent to the LLM), and an `execute(powers, args)` callback
// that calls into the daemon. The `parameters` field captures the JSON-schema
// shape the LLM should target; `toAgentTool` (defined below) wraps each spec
// in the permissive open-object schema pi-agent-core ships today. When
// `pi-agent-core` learns to forward custom parameter schemas this field will
// be wired through directly.
//
// Tool dispatch lives entirely in this module: `executeTool` is the single
// `switch` that maps tool names to `E(powers)` calls. The set of tools is the
// same surface lal exposed before the genie migration; only the agent loop
// driving them has been replaced.

/**
 * @typedef {object} LalToolDef
 * @property {string} name
 * @property {string} summary - one-line description sent to the LLM.
 * @property {object} [parameters] - JSON-schema-like shape (for documentation).
 * @property {import('@endo/patterns').Pattern} [params] - `@endo/patterns`
 *   matcher run against the decoded args object before dispatch. Inspired by
 *   `packages/genie/src/tools/common.js`, which uses the same matcher
 *   discipline to validate tool inputs at the `@endo/patterns` layer that
 *   the rest of the Endo capability surface already speaks.
 * @property {readonly string[]} [bigintArgs] - field names whose values
 *   should be coerced from a SmallCaps-shaped BigInt literal (`"+N"` or
 *   `"-N"`) into an actual BigInt before pattern validation. These are
 *   the *only* fields where SmallCaps interpretation is applied: every
 *   other field passes through verbatim so an LLM-emitted string like
 *   `"+15551234567"`, `"#main"`, or `"%percentage"` lands at the tool
 *   boundary as the literal string the model wrote (per maintainer
 *   feedback on #290: a SmallCaps walk over the whole args record is a
 *   footgun because every special-prefixed string in user-text fields
 *   like `strings`, `content`, or `source` would be inadvertently
 *   reinterpreted as a BigInt, sentinel, symbol, or remotable).
 */

// Pet-name and path matchers are imported from `@endo/daemon/type-guards.js`
// so lal validates inbound pet-name arguments against the same shapes the
// daemon's own interfaces use (per #290 review).
// Message numbers arrive as SmallCaps BigInts coerced from `"+N"` literals
// per-tool by `coerceBigintArgs`; permit a plain number too for ergonomic
// LLM emission of small integers.
const MessageNumberShape = M.or(M.bigint(), M.number());

/** @type {LalToolDef[]} */
export const toolDefs = [
  // --- Self-documentation ---
  {
    name: 'help',
    summary:
      'Get documentation for guest capabilities or a specific method. ' +
      'Call with no arguments for an overview, or with a method name for specific documentation.',
    params: M.splitRecord({}, { methodName: M.string() }),
  },

  // --- Directory operations ---
  {
    name: 'has',
    summary:
      'Check if a pet name exists in the directory. Returns true or false. ' +
      'Argument: petNamePath (string[]).',
    params: M.splitRecord({ petNamePath: NamePathShape }),
  },
  {
    name: 'list',
    summary:
      'List contents of your directory or any capability you have a pet name for. ' +
      'With no arguments, lists pet names in your root directory. ' +
      'With a name, looks up that capability and calls list() on it. ' +
      'Optional argument: name (string or string[]).',
    params: M.splitRecord({}, { name: NameOrPathShape }),
  },
  {
    name: 'lookup',
    summary:
      'Resolve a pet name or path to its value. Returns the value stored under that name. ' +
      'Argument: petNameOrPath (string or string[]).',
    params: M.splitRecord({ petNameOrPath: NameOrPathShape }),
  },
  {
    name: 'remove',
    summary:
      'Remove a pet name from the directory. The underlying value is not deleted, just the name mapping. ' +
      'Argument: petNamePath (string[]).',
    params: M.splitRecord({ petNamePath: NamePathShape }),
  },
  {
    name: 'move',
    summary:
      'Move/rename a reference from one name to another. The original name is removed. ' +
      'Arguments: fromPath (string[]), toPath (string[]).',
    params: M.splitRecord({ fromPath: NamePathShape, toPath: NamePathShape }),
  },
  {
    name: 'copy',
    summary:
      'Copy a reference to a new name. Both names will refer to the same value. ' +
      'Arguments: fromPath (string[]), toPath (string[]).',
    params: M.splitRecord({ fromPath: NamePathShape, toPath: NamePathShape }),
  },
  {
    name: 'makeDirectory',
    summary:
      'Create a new subdirectory at the given path. ' +
      'Argument: petNamePath (string[]).',
    params: M.splitRecord({ petNamePath: NamePathShape }),
  },

  // --- Mail operations ---
  {
    name: 'listMessages',
    summary:
      'List all messages in your inbox. Returns an array of message objects ' +
      'with number, date, from, type, and content. No arguments.',
    params: M.splitRecord({}),
  },
  {
    name: 'resolve',
    summary:
      'Respond to a request message by providing a named value. ' +
      'Arguments: messageNumber (SmallCaps BigInt like "+5"), petNameOrPath.',
    params: M.splitRecord({
      messageNumber: MessageNumberShape,
      petNameOrPath: NameOrPathShape,
    }),
    bigintArgs: ['messageNumber'],
  },
  {
    name: 'reject',
    summary:
      'Decline a request message. The requester receives an error. ' +
      'Arguments: messageNumber (SmallCaps BigInt like "+5"), optional reason (string).',
    params: M.splitRecord(
      { messageNumber: MessageNumberShape },
      { reason: M.string() },
    ),
    bigintArgs: ['messageNumber'],
  },
  {
    name: 'adopt',
    summary:
      'Adopt a value from an incoming package message, giving it a pet name. ' +
      'Arguments: messageNumber, edgeName, petName.',
    params: M.splitRecord({
      messageNumber: MessageNumberShape,
      edgeName: NameOrPathShape,
      petName: NameOrPathShape,
    }),
    bigintArgs: ['messageNumber'],
  },
  {
    name: 'dismiss',
    summary:
      'Remove a message from your inbox. Use after you have processed a message. ' +
      'Argument: messageNumber (SmallCaps BigInt like "+5").',
    params: M.splitRecord({ messageNumber: MessageNumberShape }),
    bigintArgs: ['messageNumber'],
  },
  {
    name: 'request',
    summary:
      'Send a request to another agent asking for a capability. ' +
      'Arguments: recipientName, description (string), optional responseName.',
    params: M.splitRecord(
      { recipientName: NameOrPathShape, description: M.string() },
      { responseName: NameOrPathShape },
    ),
  },
  {
    name: 'send',
    summary:
      'Send a package message with values to another agent. ' +
      'Arguments: recipientName, strings (string[]), edgeNames (string[]), petNames. ' +
      'For text-only messages: send("@host", ["text"], [], []).',
    params: M.splitRecord({
      recipientName: NameOrPathShape,
      strings: M.arrayOf(M.string()),
      edgeNames: M.arrayOf(M.string()),
      petNames: M.arrayOf(NameOrPathShape),
    }),
  },
  {
    name: 'reply',
    summary:
      'Reply to a message in your inbox, threading the response to the original message. ' +
      'Use this instead of send() when responding to a received message. ' +
      'Arguments: messageNumber, strings (string[]), edgeNames (string[]), petNames.',
    params: M.splitRecord({
      messageNumber: MessageNumberShape,
      strings: M.arrayOf(M.string()),
      edgeNames: M.arrayOf(M.string()),
      petNames: M.arrayOf(NameOrPathShape),
    }),
    bigintArgs: ['messageNumber'],
  },

  // --- Identity ---
  {
    name: 'locate',
    summary:
      'Get the locator URL for a pet name. Returns an "endo://..." URL string. ' +
      'Use locate(["@self"]) to get your own locator. ' +
      'Argument: petNamePath (string[]).',
    params: M.splitRecord({ petNamePath: NamePathShape }),
  },

  // --- Capability operations ---
  {
    name: 'inspect',
    summary:
      'Look up a capability by pet name and call its help() method to learn how to use it. ' +
      'Argument: petNameOrPath.',
    params: M.splitRecord({ petNameOrPath: NameOrPathShape }),
  },
  {
    name: 'readText',
    summary:
      'Read text content from a capability (ReadableTree, WritableTree, etc.). ' +
      'Arguments: petNameOrPath, fileName (string).',
    params: M.splitRecord({
      petNameOrPath: NameOrPathShape,
      fileName: M.string(),
    }),
  },
  {
    name: 'writeText',
    summary:
      'Write text content to a capability (WritableTree, etc.). ' +
      'Arguments: petNameOrPath, fileName (string), content (string).',
    params: M.splitRecord({
      petNameOrPath: NameOrPathShape,
      fileName: M.string(),
      content: M.string(),
    }),
  },

  // --- Code evaluation ---
  {
    name: 'evaluate',
    summary:
      'Evaluate JavaScript code directly. Arguments: workerName (string|undefined), ' +
      'source (string), codeNames (string[]), edgeNames (string[]), resultName.',
    // workerName + codeNames + edgeNames are optional in the dispatcher
    // (codeNames/edgeNames default to [] and workerName accepts the
    // "#undefined" SmallCaps sentinel). Allow either undefined or the
    // expected primitive shape.
    params: M.splitRecord(
      { source: M.string(), resultName: NameOrPathShape },
      {
        workerName: M.or(M.string(), M.undefined()),
        codeNames: M.arrayOf(M.string()),
        edgeNames: M.arrayOf(M.string()),
      },
    ),
  },

  // --- Define (code with slots for host to fill) ---
  {
    name: 'define',
    summary:
      'Propose a reusable program with named capability slots for the host to fill. ' +
      'Unlike evaluate(), you do NOT provide the capabilities yourself. ' +
      'Arguments: source (string), slots (object mapping slot name to { label }).',
    params: M.splitRecord({
      source: M.string(),
      slots: M.recordOf(M.string(), M.splitRecord({ label: M.string() })),
    }),
  },
];

// ============================================================================
// System Prompt
// ============================================================================

/** @type {string} */
const systemPrompt = `\
You are an Endo agent with Guest capabilities. You communicate entirely
through tool calls — do not write prose responses.

## Quick Reference

1. \`listMessages()\` — Check your inbox
2. \`locate(["@self"])\` — Get your identity (compare with message "from" to identify your own messages)
3. For received messages: \`adopt()\` values -> process -> \`reply()\` -> \`dismiss()\`

## Names

There are two kinds of name in your inventory:

- *Special names* start with \`@\` and are read-only and indelible
  (you cannot remove, rename, or overwrite them):
  - \`@self\` — Your own handle
  - \`@host\` — Your host agent
- *Pet names* are user-chosen labels like \`my-counter\` or
  \`project-data\`. You can create, rename, copy, and remove them
  freely. They are lowercase alphanumeric with hyphens
  (\`a-z0-9-\`, 1-128 chars).

## Message numbers

Message numbers are BigInts. Express them as \`"+N"\`: \`dismiss("+5")\`, \`reply("+3", ...)\`.
The harness decodes other tool arguments from JSON for you; see
\`readText("primer", "smallcaps.md")\` only if you need the background.

## Key Rules

1. Reply to every received message using \`reply()\`, then \`dismiss()\` it
2. Adopt values first — if a message has values in its \`names\` array, adopt them before use
3. Prefer direct tools — use \`list()\`, \`readText()\`, \`writeText()\`, \`lookup()\`, etc. instead of \`evaluate()\`
4. No prose responses — communicate only through tool calls
5. Check before acting — use \`list()\` and \`has()\` to verify pet names exist

## Helping the User

Your user may be interacting with Endo through either the *Endo CLI*
(terminal commands like \`endo ls\`, \`endo send\`, \`endo adopt\`) or the
*Endo Chat* web UI (slash commands like \`/ls\`, \`/send\`, \`/adopt\`),
or both. When giving the user instructions or guidance:

- Frame instructions for *both* interfaces when practical.
  For example: "You can list your inventory with \`endo ls\` in the
  terminal or \`/ls\` in Chat."
- Read \`readText("primer", "cli-reference.md")\` and
  \`readText("primer", "chat-reference.md")\` for the full command
  lists in each interface.
- Read the scenario guides under \`readText("primer", "howto-*.md")\`
  for step-by-step walkthroughs of common tasks.
- Prefer the user's apparent interface when you can infer it; if
  uncertain, show both.

## Writing Programs

When the user asks you to write, create, propose, or build a program,
**always use the \`define()\` tool**. Do not use \`evaluate()\` — the user
expects to review the code and choose which capabilities to bind.

- Each endowment the code needs becomes a named slot in the \`slots\`
  parameter with a descriptive label.
- The code receives endowments as lexical bindings (variable names
  matching the slot keys).
- The *completion value* (last expression) is the result. Make sure
  the final expression evaluates to whatever the program should produce.
- Top-level \`await\` is not supported. For a single async call, the
  promise itself is the completion value. For multiple async steps,
  wrap in an async IIFE: \`(async () => { ... })()\`.

Example — propose a program that reads a file from a directory:
\`\`\`
define("E(dir).readText('config.json')", {
  "dir": {"label": "Directory containing config.json"}
})
\`\`\`

## Primer

You have a \`primer\` directory in your inventory with detailed documentation.
Use the \`readText\` and \`list\` tools to read it:

\`\`\`
list("primer")          // See available docs
readText("primer", "README.md")   // Overview and table of contents
\`\`\`

The primer contains:
- Agent tool reference, messaging, capabilities, encoding, formatting, errors
- CLI and Chat command references
- How-to guides for common scenarios

When you encounter an unfamiliar situation, read the relevant primer document
before resorting to \`evaluate()\`. For unfamiliar capabilities, use
\`inspect("name")\` to call their \`help()\` method.
`;

// ============================================================================
// Tool Dispatch
// ============================================================================

// Per-tool SmallCaps BigInt-coercion. The previous harness ran the entire
// args record through a SmallCaps marshal, which silently re-interpreted any
// LLM-emitted string starting with a SmallCaps special prefix (`!"#$%&'()*+,-`)
// as a BigInt, sentinel, symbol, or remotable. That was a footgun: a phone
// number `"+15551234567"`, a literal `"+5"` typed by the user, a hashtag
// `"#main"`, or the word `"%percentage"` in `strings` / `content` / `source`
// would all be silently mutated before the tool ever saw them (#290 review,
// kriskowal, 2026-05-20). To stay rigorous on SmallCaps as long as we are
// using JSON as the wire format, we coerce *only* the per-tool fields
// declared as `bigintArgs` (the documented `messageNumber` surface) and
// leave every other string verbatim. The `@endo/patterns` matchers then
// catch any drift (a string in a `petNamePath: string[]` slot, a number in
// a `petName: string` slot, etc.) at the args boundary.

const BIGINT_LITERAL_RE = /^[+-]\d+$/;

/**
 * Coerce a single value to a BigInt when it is shaped like a SmallCaps
 * BigInt literal (`"+N"` or `"-N"`). Plain numbers and existing BigInts
 * are passed through; the pattern matcher tolerates both. Anything that
 * does not look like a BigInt literal is returned unchanged so the
 * matcher can reject it with a clear "must be a bigint" diagnostic.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
const coerceBigintArg = value => {
  if (typeof value !== 'string') return value;
  if (!BIGINT_LITERAL_RE.test(value)) return value;
  try {
    return BigInt(value);
  } catch {
    return value;
  }
};

/**
 * Coerce the named bigint-typed fields of an args record in place
 * (returning a fresh object). Non-bigint fields are copied through
 * verbatim with no SmallCaps interpretation. This is the entirety of
 * SmallCaps decoding the harness performs on inbound tool args; every
 * other primitive shape is left to the LLM's JSON.
 *
 * @param {Record<string, unknown>} args
 * @param {readonly string[]} bigintArgs
 * @returns {Record<string, unknown>}
 */
const coerceBigintArgs = (args, bigintArgs) => {
  if (bigintArgs.length === 0) return args;
  /** @type {Record<string, unknown>} */
  const next = { ...args };
  for (const key of bigintArgs) {
    if (Object.hasOwn(next, key)) {
      next[key] = coerceBigintArg(next[key]);
    }
  }
  return next;
};

// Pre-index each tool's @endo/patterns matcher and its bigint-arg list by
// tool name. The matcher validates the decoded args record before dispatch,
// matching the discipline `packages/genie/src/tools/common.js` applies
// (per-tool schema + nested-JSON fixup) but expressed at the args-record
// level since lal's tools share one switch-dispatcher rather than per-tool
// closures.
const paramsByTool = new Map(
  toolDefs.filter(t => t.params !== undefined).map(t => [t.name, t.params]),
);
/** @type {Map<string, readonly string[]>} */
const bigintArgsByTool = new Map(
  toolDefs
    .filter(t => t.bigintArgs && t.bigintArgs.length > 0)
    .map(t => [t.name, /** @type {readonly string[]} */ (t.bigintArgs)]),
);

/**
 * Validate decoded args against the tool's `@endo/patterns` matcher.
 * If the first attempt fails and any field is a string that parses as JSON,
 * we retry once with those fields un-JSON-fied. Some LLMs (notably smaller
 * Ollama models) emit nested arrays/objects as JSON-encoded strings; the
 * same retry idea is used in genie's `common.js`.
 *
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown>} Possibly fixed-up args.
 */
const validateAndFixupArgs = (name, args) => {
  const pattern = paramsByTool.get(name);
  if (pattern === undefined) return args;
  try {
    mustMatch(harden(args), pattern, `${name} args`);
    return args;
  } catch (err) {
    if (typeof args !== 'object' || args === null) throw err;
    let fixedAny = false;
    /** @type {Record<string, unknown>} */
    const next = { ...args };
    for (const [key, val] of Object.entries(args)) {
      if (typeof val === 'string') {
        try {
          next[key] = JSON.parse(val);
          fixedAny = true;
        } catch {
          // not JSON; leave as-is
        }
      }
    }
    if (!fixedAny) throw err;
    mustMatch(harden(next), pattern, `${name} args`);
    return next;
  }
};

/**
 * Build the executeTool callback bound to a specific guest's powers. The
 * returned function is the `execTool` parameter to `new PiAgent({tools:[...]})`;
 * it must always resolve (errors propagate as the tool's `details`/`content`).
 *
 * @param {any} powers - Guest powers
 * @returns {(name: string, args: ToolCallArgs) => Promise<unknown>}
 */
export const makeExecuteTool = powers => {
  const executeTool = async (name, rawArgs) => {
    // pi-agent-core delivers args as a plain object after JSON-parsing.
    // Coerce only the declared bigint-typed fields (the `messageNumber`
    // surface) from `"+N"` literals to actual BigInts. Every other field
    // passes through verbatim so user-text fields like `strings`,
    // `content`, and `source` cannot be inadvertently reinterpreted as
    // SmallCaps tokens (#290 review, kriskowal: a JSON-over-the-wire
    // protocol needs rigorous SmallCaps treatment, not a recursive walk).
    const argsRecord = /** @type {Record<string, unknown>} */ (rawArgs ?? {});
    const bigintArgs = bigintArgsByTool.get(name) ?? [];
    const decoded = coerceBigintArgs(argsRecord, bigintArgs);
    // Validate against the tool's @endo/patterns matcher so a malformed
    // args record fails fast with a structured error instead of cascading
    // into a confusing E(powers).<method>() failure mid-dispatch.
    const args = /** @type {ToolCallArgs} */ (
      validateAndFixupArgs(name, decoded)
    );
    switch (name) {
      // Self-documentation
      case 'help': {
        const { methodName } = args;
        return E(powers).help(methodName);
      }

      // Directory operations
      case 'has': {
        const { petNamePath } = args;
        if (!petNamePath) {
          throw new Error('petNamePath is required');
        }
        return E(powers).has(...petNamePath);
      }
      case 'list': {
        // eslint-disable-next-line no-shadow
        const { name: lookupName } = args;
        if (lookupName !== undefined) {
          const capability = await E(powers).lookup(lookupName);
          return E(capability).list();
        }
        return E(powers).list();
      }
      case 'lookup': {
        const { petNameOrPath } = args;
        if (petNameOrPath === undefined) {
          throw new Error('petNameOrPath is required');
        }
        return E(powers).lookup(petNameOrPath);
      }
      case 'remove': {
        const { petNamePath } = args;
        if (!petNamePath) {
          throw new Error('petNamePath is required');
        }
        return E(powers).remove(...petNamePath);
      }
      case 'move': {
        const { fromPath, toPath } = args;
        if (!fromPath || !toPath) {
          throw new Error('fromPath and toPath are required');
        }
        return E(powers).move(fromPath, toPath);
      }
      case 'copy': {
        const { fromPath, toPath } = args;
        if (!fromPath || !toPath) {
          throw new Error('fromPath and toPath are required');
        }
        return E(powers).copy(fromPath, toPath);
      }
      case 'makeDirectory': {
        const { petNamePath } = args;
        if (!petNamePath) {
          throw new Error('petNamePath is required');
        }
        return E(powers).makeDirectory(petNamePath);
      }

      // Mail operations
      case 'listMessages': {
        const rawMessages = await E(powers).listMessages();
        return harden(
          rawMessages.map(
            (
              /** @type {InboxMessage & {messageId?: string, replyTo?: string}} */ msg,
            ) => ({
              number: msg.number,
              date: msg.date,
              from: msg.from,
              to: msg.to,
              type: msg.type,
              strings: msg.strings,
              names: msg.names,
              messageId: msg.messageId,
              replyTo: msg.replyTo,
            }),
          ),
        );
      }
      case 'resolve': {
        const { messageNumber, petNameOrPath } = args;
        if (messageNumber === undefined || petNameOrPath === undefined) {
          throw new Error('messageNumber and petNameOrPath are required');
        }
        return E(powers).resolve(messageNumber, petNameOrPath);
      }
      case 'reject': {
        const { messageNumber, reason } = args;
        if (messageNumber === undefined) {
          throw new Error('messageNumber is required');
        }
        return E(powers).reject(messageNumber, reason);
      }
      case 'adopt': {
        const { messageNumber, edgeName, petName } = args;
        if (
          messageNumber === undefined ||
          edgeName === undefined ||
          petName === undefined
        ) {
          throw new Error('messageNumber, edgeName, and petName are required');
        }
        return E(powers).adopt(messageNumber, edgeName, petName);
      }
      case 'dismiss': {
        const { messageNumber } = args;
        if (messageNumber === undefined) {
          throw new Error('messageNumber is required');
        }
        return E(powers).dismiss(messageNumber);
      }
      case 'request': {
        const { recipientName, description, responseName } = args;
        if (recipientName === undefined || description === undefined) {
          throw new Error('recipientName and description are required');
        }
        return E(powers).request(recipientName, description, responseName);
      }
      case 'send': {
        const { recipientName, strings, edgeNames, petNames } = args;
        if (
          recipientName === undefined ||
          !strings ||
          !edgeNames ||
          !petNames
        ) {
          throw new Error(
            'recipientName, strings, edgeNames, and petNames are required',
          );
        }
        return E(powers).send(recipientName, strings, edgeNames, petNames);
      }
      case 'reply': {
        const { messageNumber, strings, edgeNames, petNames } = args;
        if (
          messageNumber === undefined ||
          !strings ||
          !edgeNames ||
          !petNames
        ) {
          throw new Error(
            'messageNumber, strings, edgeNames, and petNames are required',
          );
        }
        return E(powers).reply(messageNumber, strings, edgeNames, petNames);
      }

      // Identity
      case 'locate': {
        const { petNamePath } = args;
        if (!petNamePath) {
          throw new Error('petNamePath is required');
        }
        return E(powers).locate(...petNamePath);
      }

      // Capability operations
      case 'inspect': {
        const { petNameOrPath } = args;
        if (petNameOrPath === undefined) {
          throw new Error('petNameOrPath is required');
        }
        const capability = await E(powers).lookup(petNameOrPath);
        const parts = [];
        try {
          const helpText = await E(capability).help();
          parts.push(helpText);
        } catch {
          parts.push(
            `Capability at "${petNameOrPath}" does not implement help().`,
          );
        }
        try {
          // eslint-disable-next-line no-underscore-dangle
          const methods = await E(capability).__getMethodNames__();
          parts.push(`\nMethods: ${methods.join(', ')}`);
        } catch {
          // No __getMethodNames__ available.
        }
        return parts.join('\n');
      }
      case 'readText': {
        const { petNameOrPath, fileName } = args;
        if (petNameOrPath === undefined || fileName === undefined) {
          throw new Error('petNameOrPath and fileName are required');
        }
        const capability = await E(powers).lookup(petNameOrPath);
        return E(capability).readText(fileName);
      }
      case 'writeText': {
        const { petNameOrPath, fileName, content } = args;
        if (
          petNameOrPath === undefined ||
          fileName === undefined ||
          content === undefined
        ) {
          throw new Error('petNameOrPath, fileName, and content are required');
        }
        const capability = await E(powers).lookup(petNameOrPath);
        return E(capability).writeText(fileName, content);
      }

      // Code evaluation
      case 'evaluate': {
        const {
          workerName: rawWorkerName,
          source,
          codeNames = [],
          edgeNames = [],
          resultName,
        } = args;
        if (source === undefined) {
          throw new Error('source is required');
        }
        if (resultName === undefined) {
          throw new Error('resultName is required');
        }
        const workerName =
          rawWorkerName === 'undefined' || rawWorkerName === '#undefined'
            ? undefined
            : rawWorkerName;
        return E(powers).evaluate(
          workerName,
          source,
          harden(codeNames),
          harden(edgeNames),
          resultName,
        );
      }

      // Define code with slots for host to fill
      case 'define': {
        const { source, slots } = args;
        if (source === undefined) {
          throw new Error('source is required');
        }
        if (slots === undefined) {
          throw new Error('slots is required');
        }
        return E(powers).define(source, harden(slots));
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };

  return executeTool;
};

// ============================================================================
// Worker Loop
// ============================================================================

/**
 * Spawn a worker loop that follows a guest's inbox and processes messages
 * using a pi-agent-core–backed PiAgent. Conversation continuity survives a
 * daemon restart: each completed inbound-message turn persists its
 * transcript delta to the guest's petstore (see {@link persistTurnDelta}),
 * and on spawn the worker rehydrates `initialState.messages` from those
 * deltas (see {@link loadPersistedTranscript}) so a fresh PiAgent resumes
 * with the full prior context.
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

  // Bind the tool dispatcher to this guest's powers, then build the
  // AgentTool array pi-agent-core consumes directly. We construct the
  // PiAgent in-line (rather than via a higher-level harness helper) so that
  //   (a) we are free to seed `initialState.messages` from prior
  //       transcripts when cross-restart continuity lands (see PR body),
  //   (b) we control the system prompt verbatim (no policy suffix or
  //       security-notes wrapping is applied), and
  //   (c) the per-tool parameter schema lives at the tool boundary,
  //       which lets `@endo/patterns` validation guard inbound args.
  const executeTool = makeExecuteTool(powers);
  const agentTools = toolDefs.map(({ name, summary }) =>
    toAgentTool(name, summary, executeTool),
  );

  const { model: resolvedModel, getApiKey } =
    await resolveWorkerModel(workerEnv);

  // Rehydrate prior conversation context (if any) from the petstore so a
  // worker spawned after a daemon restart resumes the same transcript. A
  // fresh worker, or a worker whose persisted state is corrupt/unreadable,
  // gets `[]` here and starts a new conversation (never fails to spawn).
  const restoredMessages = await loadPersistedTranscript(powers);

  const piAgent = new PiAgent({
    initialState: {
      systemPrompt,
      model: resolvedModel,
      tools: agentTools,
      messages: restoredMessages,
      thinkingLevel: resolvedModel.reasoning ? 'medium' : 'off',
    },
    convertToLlm: msgs =>
      msgs.filter(
        m =>
          m.role === 'user' ||
          m.role === 'assistant' ||
          m.role === 'toolResult',
      ),
    toolExecution: 'sequential',
    getApiKey,
  });

  /**
   * Run one chat round on the PiAgent, forwarding tool-call activity to
   * the console and dispatching tool errors via the LLM transcript.
   *
   * @param {string} prompt - User-role content for this round.
   */
  const runOneRound = async prompt => {
    for await (const event of runAgentRound(piAgent, prompt)) {
      switch (event.type) {
        case 'ToolCallStart': {
          const argsPreview = (() => {
            try {
              const s =
                typeof event.args === 'string'
                  ? event.args
                  : passableAsJustin(harden(event.args ?? {}), false);
              return s.length > 200 ? `${s.slice(0, 200)}...` : s;
            } catch {
              return '(args)';
            }
          })();
          console.log(`[tool] ${event.toolName}(${argsPreview})`);
          break;
        }
        case 'ToolCallEnd': {
          if ('error' in event && event.error) {
            console.error(
              `[tool] ${event.toolName} error: ${event.error.message}`,
            );
          } else {
            const out = (() => {
              try {
                return passableAsJustin(event.result, false);
              } catch {
                return String(event.result);
              }
            })();
            console.log(`[tool] ${event.toolName} -> ${out}`);
          }
          break;
        }
        case 'Message': {
          if (event.role === 'assistant' && event.content) {
            // The LLM's text response is logged for visibility; lal's
            // protocol is tool-call-only, so any prose surfaces here as a
            // debugging breadcrumb rather than being sent to a peer.
            console.log(`[assistant] ${event.content}`);
          }
          break;
        }
        case 'Error': {
          console.error(`[agent] LLM error: ${event.message}`);
          throw event.cause || new Error(event.message);
        }
        default:
          break;
      }
    }
  };

  /**
   * Build the user-role content for an inbound message. lal's prompt is
   * intentionally minimal: the LLM is expected to call listMessages() to
   * inspect the inbox itself.
   *
   * @returns {string}
   */
  const formatInboundMessage = () =>
    'You have new mail. Check your messages and respond appropriately.';

  /**
   * Run the agent loop, processing incoming messages.
   *
   * @returns {Promise<void>}
   */
  const runAgent = async () => {
    // Announce ourselves with a call to action.
    await E(powers).send(
      '@host',
      [
        "Hello! I'm ready to help.\n\n" +
          'Send me a message to get started — in Chat, type ' +
          '`@` followed by my name and your request.\n\n' +
          'A few things to try:\n' +
          '- Ask me what I can do\n' +
          '- Ask me to list your inventory\n' +
          '- Ask me to help write a program\n\n' +
          'Type `/help` to see all available Chat commands.',
      ],
      [],
      [],
    );

    /** @type {string | undefined} */
    const selfLocator = await E(powers).locate('@self');
    const cancelled = await getCancelled();
    const cancelledSignal = cancelled
      ? cancelled.then(
          () => ({ cancelled: true }),
          () => ({ cancelled: true }),
        )
      : null;

    const messageIterator = makeRefIterator(E(powers).followMessages());
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
      const inboxMessage =
        /** @type {InboxMessage & {type?: string, messageId?: string, replyTo?: string}} */ (
          message
        );
      const { from: fromLocator, number, type } = inboxMessage;

      // Skip our own outbound messages; only act on inbound mail.
      // eslint-disable-next-line @endo/restrict-comparison-operands
      if (fromLocator !== selfLocator) {
        console.log(
          `[mail] New message #${number} (type: ${type || 'package'})`,
        );
        // High-water mark before the round: everything appended past this
        // index is this turn's transcript delta.
        const priorLength = piAgent.state.messages.length;
        try {
          await runOneRound(formatInboundMessage());
          // `runOneRound` returns only once the PiAgent is idle — no
          // in-flight tool calls — so this is a safe complete-message
          // boundary to persist. Write only the delta for this turn.
          const delta = piAgent.state.messages.slice(priorLength);
          await persistTurnDelta(powers, BigInt(number), delta);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error('[agent] LLM error, notifying sender:', errorMessage);
          try {
            await E(powers).reply(
              number,
              [`LLM provider error: ${errorMessage}`],
              [],
              [],
            );
          } catch (replyError) {
            console.error('[agent] Failed to notify sender:', replyError);
          }
        }
      }
    }
  };

  await runAgent();
};
harden(spawnWorkerLoop);

// ============================================================================
// Model + Provider Resolution
// ============================================================================
//
// pi-ai's built-in registry models carry their own `baseUrl`, while custom
// OpenAI-compatible endpoints (local `/v1` servers, remote Ollama, vLLM,
// llama.cpp, etc.) must be represented by explicit Model objects. lal's
// historical configuration passes LAL_HOST + LAL_MODEL + LAL_AUTH_TOKEN, so
// the helpers below preserve both the selected endpoint and the worker-local
// auth token while adapting that legacy shape to pi-agent-core.

/** @typedef {(provider: string) => Promise<string | undefined>} ApiKeyResolver */

/**
 * @typedef {object} WorkerModelConfig
 * @property {Model<'openai-completions'>} model
 * @property {ApiKeyResolver} getApiKey
 */

const DEFAULT_HOST = 'http://localhost:11434';
const DEFAULT_LOCAL_MODEL = 'qwen3';

/**
 * @param {string} value
 * @returns {string}
 */
const trimTrailingSlashes = value => value.replace(/\/+$/, '');

/**
 * Convert a caller-supplied OpenAI-compatible base URL into the form the
 * OpenAI SDK expects. Ollama's native host is conventionally configured
 * without `/v1`; other OpenAI-compatible hosts are often configured with it
 * already, so this helper appends it only when absent.
 *
 * @param {string} baseURL
 * @returns {string}
 */
const normalizeOpenAIBaseUrl = baseURL => {
  const trimmed = trimTrailingSlashes(baseURL);
  return trimmed.match(/\/v1(?:\/.*)?$/) ? trimmed : `${trimmed}/v1`;
};

/**
 * Preserve the historical behavior where a blank model, or the old generic
 * qwen3 form default, upgrades to the provider-specific default for hosted
 * registry providers. For local/custom endpoints, qwen3 remains the default.
 *
 * @param {string | undefined} explicitModel
 * @param {string} defaultModel
 * @returns {string}
 */
const resolveLegacyModelDefault = (explicitModel, defaultModel) =>
  !explicitModel || explicitModel === DEFAULT_LOCAL_MODEL
    ? defaultModel
    : explicitModel;

/**
 * Build an API-key resolver scoped to this worker. Returning undefined lets
 * pi-ai fall back to its normal environment-variable lookup for registry
 * providers; local OpenAI-compatible endpoints keep the old harmless `ollama`
 * sentinel when no token was supplied.
 *
 * @param {string | undefined} authToken
 * @param {string | undefined} fallbackToken
 * @returns {ApiKeyResolver}
 */
const makeApiKeyResolver = (authToken, fallbackToken) => async _provider =>
  authToken || fallbackToken;

/**
 * Resolve the legacy LAL_HOST + LAL_MODEL + LAL_AUTH_TOKEN triple into the
 * concrete pi-ai Model and worker-local API-key resolver. Recognized LAL_HOST
 * patterns:
 *
 *   contains "anthropic.com"  -> pi-ai registry provider "anthropic"
 *   contains "generativelanguage.googleapis.com" or "gemini" -> "google"
 *   contains "openrouter"    -> pi-ai registry provider "openrouter"
 *   contains "openai.com"    -> pi-ai registry provider "openai"
 *   contains "/v1"           -> custom OpenAI-compatible endpoint
 *   otherwise                -> custom Ollama-compatible endpoint
 *
 * @param {{ LAL_HOST?: string, LAL_MODEL?: string, LAL_AUTH_TOKEN?: string }} env
 * @returns {Promise<WorkerModelConfig>}
 */
export async function resolveWorkerModel(env) {
  await Promise.resolve();
  const rawHost = env.LAL_HOST || DEFAULT_HOST;
  const host = rawHost.toLowerCase();
  const { LAL_AUTH_TOKEN: authToken } = env;

  if (host.includes('anthropic.com')) {
    return harden({
      model: resolveRegistryModel(
        'anthropic',
        resolveLegacyModelDefault(env.LAL_MODEL, 'claude-opus-4-5-20251101'),
      ),
      getApiKey: makeApiKeyResolver(authToken, undefined),
    });
  }

  if (
    host.includes('generativelanguage.googleapis.com') ||
    host.includes('gemini')
  ) {
    return harden({
      // pi-ai exposes Google's Gemini models under the provider name 'google'.
      model: resolveRegistryModel(
        'google',
        resolveLegacyModelDefault(env.LAL_MODEL, 'gemini-2.0-flash'),
      ),
      getApiKey: makeApiKeyResolver(authToken, undefined),
    });
  }

  if (host.includes('openrouter')) {
    return harden({
      model: resolveRegistryModel(
        'openrouter',
        env.LAL_MODEL || 'openrouter/auto',
      ),
      getApiKey: makeApiKeyResolver(authToken, undefined),
    });
  }

  if (host.includes('openai.com')) {
    return harden({
      model: resolveRegistryModel(
        'openai',
        resolveLegacyModelDefault(env.LAL_MODEL, 'gpt-4o-mini'),
      ),
      getApiKey: makeApiKeyResolver(authToken, undefined),
    });
  }

  if (host.includes('/v1')) {
    return harden({
      model: buildOpenAICompatibleModel(
        env.LAL_MODEL || DEFAULT_LOCAL_MODEL,
        trimTrailingSlashes(rawHost),
        'openai',
        'openai-compatible',
      ),
      getApiKey: makeApiKeyResolver(authToken, 'ollama'),
    });
  }

  return harden({
    model: buildOllamaModel(env.LAL_MODEL || DEFAULT_LOCAL_MODEL, rawHost),
    getApiKey: makeApiKeyResolver(authToken, getOllamaApiKey()),
  });
}
harden(resolveWorkerModel);

/**
 * @param {string} provider
 * @param {string} modelId
 * @returns {Model<'openai-completions'>}
 */
function resolveRegistryModel(provider, modelId) {
  // pi-ai's KnownProvider overloads of getModel typically resolve the modelId
  // to `never` for the generic call site; we want the runtime registry lookup
  // here, which works for any string the caller passed.
  // @ts-expect-error - permissive runtime lookup against KnownProvider overloads
  const model = getModel(provider, modelId);
  if (model === undefined) {
    throw new Error(`Unknown pi-ai model: ${provider}/${modelId}`);
  }
  return model;
}

/**
 * Build a pi-ai Model object for an OpenAI-compatible endpoint.
 *
 * @param {string} id
 * @param {string} baseUrl
 * @param {string} provider
 * @param {string} namePrefix
 * @returns {Model<'openai-completions'>}
 */
function buildOpenAICompatibleModel(id, baseUrl, provider, namePrefix) {
  return harden({
    id,
    name: `${namePrefix}/${id}`,
    api: 'openai-completions',
    provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8192,
  });
}

/**
 * Build a pi-ai Model object for an Ollama-compatible instance. Ollama exposes
 * an OpenAI-compatible /v1/chat/completions endpoint, so we masquerade as the
 * "openai" provider with a custom baseUrl. The endpoint is taken from the
 * worker's submitted LAL_HOST form value rather than environment defaults.
 *
 * @param {string} id - The ollama model name (e.g. "qwen3")
 * @param {string} host
 * @returns {Model<'openai-completions'>}
 */
function buildOllamaModel(id, host) {
  return buildOpenAICompatibleModel(
    id,
    normalizeOpenAIBaseUrl(host),
    'openai',
    'ollama',
  );
}

/**
 * API-key resolver for Ollama models. Ollama itself does not require a key,
 * but pi-ai's openai-completions adaptor refuses requests without one.
 * Prefer `OLLAMA_API_KEY` (in case the operator has set one for a remote
 * Ollama), else fall back to a harmless sentinel that the operator's setup
 * commonly uses already.
 *
 * @returns {string}
 */
function getOllamaApiKey() {
  // eslint-disable-next-line no-undef
  const env = globalThis?.process?.env ?? {};
  return env.OLLAMA_API_KEY || 'ollama';
}

/**
 * Convert a lal tool definition into a pi-agent-core AgentTool. The
 * `parameters` field is a permissive open-object schema; per-tool argument
 * validation lives in `executeTool` (per-field BigInt coercion plus the
 * `@endo/patterns` matcher + JSON-string fixup retry). When pi-agent-core's
 * tool-schema forwarding stabilizes we can promote the per-tool schemas
 * into this field.
 *
 * @param {string} name
 * @param {string} summary
 * @param {(name: string, args: any) => Promise<any>} executeTool
 * @returns {AgentTool<any>}
 */
export function toAgentTool(name, summary, executeTool) {
  return {
    name,
    label: name,
    description: summary,
    parameters: { type: 'object', additionalProperties: true },
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const result = await executeTool(name, params);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      /** @type {AgentToolResult<any>} */
      const toolResult = {
        content: [{ type: 'text', text }],
        details: result,
      };
      return toolResult;
    },
  };
}

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
      // eslint-disable-next-line @endo/restrict-comparison-operands
      if (msg.from === selfLocator && msg.type === 'form') {
        formMessageId = msg.messageId;
      }
    }

    const messageIterator = makeRefIterator(E(powers).followMessages());
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
