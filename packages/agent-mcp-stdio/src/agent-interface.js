// @ts-check
/// <reference types="ses"/>
/* global setTimeout */

// The static agent interface: the fixed tool catalog this server serves and
// the harness renders into `--allowedTools`. Like Lal's tool families
// (packages/lal/tools/), it is a hardened declaration of names, descriptions,
// parameter schemas, and bound operations. It is never inferred from, or
// reshaped by, the guest it is bound to: a grant change affects whether a call
// succeeds, not which names exist.
//
// Code-evaluation operations (`evaluate`, `define`) are deliberately present.
// Endo's sandbox is designed to evaluate arbitrary code in the presence of the
// guest's capabilities, so an evaluator reaches no authority the guest does
// not already hold.
//
// Streams. MCP tool calls are request/response, so a daemon subscription
// (`followMessages`, `followNameChanges`, `followLocatorNameChanges`, or a
// reader stored under a pet name) is opened by a `follow*` tool that returns
// a follower handle, then drained in bounded pulls with `readFollower` and
// released with `closeFollower`. A pull returns at most `maxItems` items and
// returns within `waitMilliseconds` of the call in all, even when it waits
// behind earlier pulls on the same follower, so neither a quiet stream, a slow
// steady one, nor a queue of callers holds a tool call open. An item that arrives after a pull
// times out is kept for the next pull. Pulls on one follower run one at a
// time, so concurrent `readFollower` calls neither duplicate nor lose an item.
// Followers live only as long as this server.
//
// Search. `glob`, `grep`, and `glorp` are the daemon's mount methods, reached
// through the pet name path of a mount the guest holds. They are eager and
// capped by the daemon; the daemon offers no streaming variant.

import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { GuestInterface, HostInterface } from '@endo/daemon/src/interfaces.js';
import {
  M,
  getInterfaceGuardPayload,
  getInterfaceMethodKeys,
} from '@endo/patterns';

/** @import { ToolDeclaration } from '@endo/agent-tools/adapters/mcp.js' */

const PetNamePathShape = M.arrayOf(M.string());
const MessageNumberArgumentShape = M.or(M.number(), M.string());
const PlainRecordShape = M.recordOf(M.string(), M.any());

const petNamePathSchema = harden({
  type: 'array',
  items: { type: 'string' },
  description: 'A pet name path, for example ["docs", "readme.md"].',
});
// Exactly the values `toMessageNumber` accepts: the number form is a safe
// integer, and a message number past 2**53 - 1 takes the string form.
const messageNumberSchema = harden({
  anyOf: [
    { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    { type: 'string', pattern: '^\\+?[0-9]+$' },
  ],
  description:
    'A message number from listMessages, for example 5 or "5" ' +
    '(write a number past 9007199254740991 as a decimal string).',
});
const stringsSchema = harden({ type: 'array', items: { type: 'string' } });
const petNamePathsSchema = harden({ type: 'array', items: petNamePathSchema });
const locatorSchema = harden({
  type: 'string',
  description: 'A locator, for example from locate or invite.',
});
const recordSchema = harden({ type: 'object' });

const DEFAULT_MAX_ITEMS = 16;
const LIMIT_MAX_ITEMS = 256;
const DEFAULT_WAIT_MILLISECONDS = 1000;
const LIMIT_WAIT_MILLISECONDS = 30_000;
const LIMIT_FOLLOWERS = 64;

/**
 * Convert a JSON message number (a non-negative safe integer or a decimal
 * string) to the bigint the daemon expects. Daemon message numbers are
 * unbounded natural numbers, so the string form has no digit cap. Throws on anything else, which the
 * adapter reports as an `argument-scope` rejection.
 *
 * @param {number | string} value
 * @returns {bigint}
 */
export const toMessageNumber = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\+?[0-9]+$/.test(value)) {
    return BigInt(value.replace(/^\+/, ''));
  }
  throw TypeError(`Not a message number: ${value}`);
};
harden(toMessageNumber);

/**
 * @param {Record<string, any>} toolArguments
 */
const normalizeMessageNumber = toolArguments =>
  harden({
    ...toolArguments,
    messageNumber: toMessageNumber(toolArguments.messageNumber),
  });

/**
 * @param {Record<string, any>} properties
 * @param {string[]} [required]
 */
const objectSchema = (properties, required = []) =>
  harden({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  });

/**
 * A tool whose one required argument is a pet name path, forwarded to the
 * same-named guest method as rest arguments.
 *
 * @param {string} name
 * @param {string} description
 * @returns {ToolDeclaration<any>}
 */
const restPathTool = (name, description) => ({
  name,
  description,
  inputSchema: objectSchema({ petNamePath: petNamePathSchema }, [
    'petNamePath',
  ]),
  argumentsShape: M.splitRecord({ petNamePath: PetNamePathShape }),
  invoke: (guest, { petNamePath }) => E(guest)[name](...petNamePath),
});

/**
 * A tool whose optional argument is a pet name path, forwarded as rest
 * arguments; omitted, it addresses the guest's own directory.
 *
 * @param {string} name
 * @param {string} description
 * @returns {ToolDeclaration<any>}
 */
const optionalRestPathTool = (name, description) => ({
  name,
  description,
  inputSchema: objectSchema({ petNamePath: petNamePathSchema }),
  argumentsShape: M.splitRecord({}, { petNamePath: PetNamePathShape }),
  invoke: (guest, { petNamePath = [] }) => E(guest)[name](...petNamePath),
});

/**
 * A tool whose one required argument is a locator.
 *
 * @param {string} name
 * @param {string} description
 * @returns {ToolDeclaration<any>}
 */
const locatorTool = (name, description) => ({
  name,
  description,
  inputSchema: objectSchema({ locator: locatorSchema }, ['locator']),
  argumentsShape: M.splitRecord({ locator: M.string() }),
  invoke: (guest, { locator }) => E(guest)[name](locator),
});

/**
 * A tool whose one required argument is a message number.
 *
 * @param {string} name
 * @param {string} description
 * @param {(messageNumber: bigint, value: unknown) => unknown} [render]
 * @returns {ToolDeclaration<any>}
 */
const messageTool = (name, description, render = (_, value) => value) => ({
  name,
  description,
  inputSchema: objectSchema({ messageNumber: messageNumberSchema }, [
    'messageNumber',
  ]),
  argumentsShape: M.splitRecord({ messageNumber: MessageNumberArgumentShape }),
  normalizeArguments: normalizeMessageNumber,
  invoke: async (guest, { messageNumber }) =>
    render(messageNumber, await E(guest)[name](messageNumber)),
});

/**
 * Copy only the options that were supplied, so an absent option reaches the
 * daemon as absent rather than as `undefined`.
 *
 * @param {Record<string, any>} toolArguments
 * @param {string[]} names
 */
const pickOptions = (toolArguments, names) =>
  harden(
    Object.fromEntries(
      names
        .filter(name => toolArguments[name] !== undefined)
        .map(name => [name, toolArguments[name]]),
    ),
  );

const searchOptionSchemas = harden({
  maxResults: { type: 'integer', minimum: 1 },
  followSymlinks: { type: 'boolean' },
});

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
const defaultDelay = milliseconds =>
  new Promise(resolve => {
    // A pull that an item wins leaves this timer armed; never let it hold the
    // process open after stdin EOF.
    const timer = /** @type {any} */ (setTimeout(resolve, milliseconds));
    timer?.unref?.();
  });

/**
 * Make the agent tool catalog. Each call has its own follower table, so each
 * server gets a fresh one.
 *
 * @param {object} [options]
 * @param {(milliseconds: number) => Promise<void>} [options.delay]
 * @returns {ReadonlyArray<ToolDeclaration<any>>}
 */
export const makeAgentTools = ({ delay = defaultDelay } = {}) => {
  /**
   * @typedef {object} Follower
   * @property {AsyncIterator<unknown, unknown, undefined>} iterator
   * @property {Promise<IteratorResult<unknown, unknown>> | undefined} pending
   * @property {Promise<void>} queue - settles when the previous pull ends.
   */
  /** @type {Map<string, Follower>} */
  const followers = new Map();
  let nextFollowerNumber = 1;
  // Closed followers whose daemon subscription is not yet observed released.
  // They still count against the cap: on a quiet stream the release waits
  // behind a pull still pending, so dropping only the handle would let
  // open-then-close cycles grow the daemon's subscriptions without bound.
  let releasingFollowers = 0;

  /**
   * @param {() => unknown} makeReader - opens the daemon subscription, yielding
   *   a reader or a promise for one. Called only once the follower cap admits
   *   a new follower, so a refused call opens no subscription.
   */
  const openFollower = makeReader => {
    if (followers.size + releasingFollowers >= LIMIT_FOLLOWERS) {
      throw Error(
        `Too many open followers (${LIMIT_FOLLOWERS}, counting ${releasingFollowers} closed but not yet released); close one with closeFollower`,
      );
    }
    const follower = `follower${nextFollowerNumber}`;
    nextFollowerNumber += 1;
    const iterator = iterateReader(/** @type {any} */ (makeReader()));
    followers.set(follower, {
      iterator,
      pending: undefined,
      queue: Promise.resolve(),
    });
    return harden({ follower });
  };

  /**
   * @param {string} follower
   */
  const getFollower = follower => {
    const record = followers.get(follower);
    if (record === undefined) {
      throw Error(`No open follower named ${follower}`);
    }
    return record;
  };

  const timedOut = Symbol('timed out');

  /**
   * One pull: at most `maxItems` items, returning once `deadline` settles.
   *
   * @param {string} follower
   * @param {Follower} record
   * @param {number} maxItems
   * @param {Promise<symbol>} deadline
   */
  const pull = async (follower, record, maxItems, deadline) => {
    const items = [];
    while (items.length < maxItems) {
      if (record.pending === undefined) {
        record.pending = record.iterator.next();
      }
      /** @type {unknown} */
      let outcome;
      try {
        // eslint-disable-next-line no-await-in-loop
        outcome = await Promise.race([record.pending, deadline]);
      } catch (error) {
        // The stream failed: it yields nothing more, so release the follower
        // and keep the items this pull already took from it.
        followers.delete(follower);
        if (items.length === 0) {
          throw error;
        }
        return harden({
          items,
          done: true,
          error: /** @type {Error} */ (error)?.message ?? String(error),
        });
      }
      if (outcome === timedOut) {
        // Keep the pending pull: its item belongs to the next read.
        return harden({ items, done: false });
      }
      record.pending = undefined;
      const { done, value } = /** @type {IteratorResult<unknown, unknown>} */ (
        outcome
      );
      if (done) {
        followers.delete(follower);
        return harden({ items, done: true });
      }
      items.push(value);
    }
    return harden({ items, done: false });
  };

  /**
   * @param {string} follower
   * @param {number} maxItems
   * @param {number} waitMilliseconds
   */
  const readFollower = (follower, maxItems, waitMilliseconds) => {
    if (!Number.isSafeInteger(maxItems)) {
      throw TypeError(`maxItems must be an integer: ${maxItems}`);
    }
    const record = getFollower(follower);
    // The wait starts at the call, not when earlier pulls on this follower
    // finish, so a queued read still returns within its own bound. A read
    // whose wait elapses before its turn answers empty and, when its turn
    // comes, takes nothing, so no item is lost to a caller that has left.
    const deadline = delay(waitMilliseconds).then(() => timedOut);
    let started = false;
    let expired = false;
    const queued = record.queue.then(() => {
      if (expired) {
        return harden({ items: [], done: false });
      }
      started = true;
      return pull(follower, record, maxItems, deadline);
    });
    const expiredInQueue = deadline.then(() => {
      if (started) {
        return queued;
      }
      expired = true;
      return harden({ items: [], done: false });
    });
    record.queue = queued.then(
      () => {},
      () => {},
    );
    return Promise.race([queued, expiredInQueue]);
  };

  /**
   * @param {string} follower
   */
  const closeFollower = follower => {
    const record = getFollower(follower);
    followers.delete(follower);
    // Do not wait: a return queues behind a pull still pending on a quiet
    // stream. The follower counts against the cap until both settle.
    releasingFollowers += 1;
    const released = Promise.resolve(record.iterator.return?.(undefined));
    Promise.allSettled([record.pending, record.queue, released]).then(() => {
      releasingFollowers -= 1;
    });
    return `Closed ${follower}`;
  };

  /** @type {Promise<void>} */
  let makePathQueue = Promise.resolve();

  /**
   * @param {any} guest
   * @param {string[]} segments
   */
  const makePath = async (guest, segments) => {
    const created = [];
    for (let length = 1; length <= segments.length; length += 1) {
      const prefix = segments.slice(0, length);
      const present = /** @type {boolean} */ (
        // eslint-disable-next-line no-await-in-loop
        await E(guest).has(...prefix)
      );
      if (!present) {
        // eslint-disable-next-line no-await-in-loop
        await E(guest).makeDirectory(prefix);
        created.push(prefix.join('/'));
      }
    }
    return created.length === 0
      ? `Directory ${segments.join('/')} already exists`
      : `Created directories ${created.join(', ')}`;
  };

  /** @type {ToolDeclaration<any>[]} */
  const tools = [
    // Help and names.
    {
      name: 'help',
      description:
        'Describe your own capability surface, or one method of it by name.',
      inputSchema: objectSchema({ methodName: { type: 'string' } }),
      argumentsShape: M.splitRecord({}, { methodName: M.string() }),
      invoke: (guest, { methodName }) =>
        methodName === undefined ? E(guest).help() : E(guest).help(methodName),
    },
    restPathTool(
      'has',
      'Report whether a pet name path exists in your directory.',
    ),
    optionalRestPathTool(
      'list',
      'List the pet names in your directory, or in the directory at a path.',
    ),
    restPathTool(
      'remove',
      'Remove a pet name. The named value itself is not deleted.',
    ),
    {
      name: 'move',
      description: 'Rename a pet name; the original name is removed.',
      inputSchema: objectSchema(
        { fromPath: petNamePathSchema, toPath: petNamePathSchema },
        ['fromPath', 'toPath'],
      ),
      argumentsShape: M.splitRecord({
        fromPath: PetNamePathShape,
        toPath: PetNamePathShape,
      }),
      invoke: (guest, { fromPath, toPath }) => E(guest).move(fromPath, toPath),
    },
    {
      name: 'copy',
      description: 'Give an existing value a second pet name.',
      inputSchema: objectSchema(
        { fromPath: petNamePathSchema, toPath: petNamePathSchema },
        ['fromPath', 'toPath'],
      ),
      argumentsShape: M.splitRecord({
        fromPath: PetNamePathShape,
        toPath: PetNamePathShape,
      }),
      invoke: (guest, { fromPath, toPath }) => E(guest).copy(fromPath, toPath),
    },
    restPathTool(
      'identify',
      'Report the formula identifier a pet name path designates.',
    ),
    {
      name: 'reverseIdentify',
      description: 'List the pet names that designate a formula identifier.',
      inputSchema: objectSchema({ identifier: { type: 'string' } }, [
        'identifier',
      ]),
      argumentsShape: M.splitRecord({ identifier: M.string() }),
      invoke: (guest, { identifier }) => E(guest).reverseIdentify(identifier),
    },
    optionalRestPathTool(
      'listIdentifiers',
      'List the formula identifiers in your directory, or in the directory at a path.',
    ),
    {
      name: 'storeIdentifier',
      description: 'Name the value a formula identifier designates.',
      inputSchema: objectSchema(
        { petNamePath: petNamePathSchema, identifier: { type: 'string' } },
        ['petNamePath', 'identifier'],
      ),
      argumentsShape: M.splitRecord({
        petNamePath: PetNamePathShape,
        identifier: M.string(),
      }),
      invoke: async (guest, { petNamePath, identifier }) => {
        await E(guest).storeIdentifier(petNamePath, identifier);
        return `Stored ${identifier} as ${petNamePath.join('/')}`;
      },
    },

    // Locators.
    restPathTool('locate', 'Report the locator for a pet name path.'),
    optionalRestPathTool(
      'listLocators',
      'List the locators in your directory, or in the directory at a path.',
    ),
    locatorTool(
      'reverseLocate',
      'List the pet names that designate a locator.',
    ),
    {
      name: 'storeLocator',
      description:
        'Adopt a locator: give the value it designates a pet name in your directory.',
      inputSchema: objectSchema(
        { petNamePath: petNamePathSchema, locator: locatorSchema },
        ['petNamePath', 'locator'],
      ),
      argumentsShape: M.splitRecord({
        petNamePath: PetNamePathShape,
        locator: M.string(),
      }),
      invoke: async (guest, { petNamePath, locator }) => {
        await E(guest).storeLocator(petNamePath, locator);
        return `Adopted ${locator} as ${petNamePath.join('/')}`;
      },
    },
    restPathTool(
      'locateContent',
      'Report the content locator (a magnet URN) for a pet name path.',
    ),
    optionalRestPathTool(
      'listContent',
      'List the content locators in your directory, or in the directory at a path.',
    ),
    restPathTool(
      'storeContent',
      'Store the content at a pet name path and report its content locator.',
    ),
    locatorTool(
      'reverseLocateContent',
      'List the pet names whose content a content locator designates.',
    ),
    locatorTool(
      'internalizeContentLocator',
      'Internalize a content locator into the local content store.',
    ),
    locatorTool(
      'loadContent',
      'Load the content a content locator designates.',
    ),
    {
      name: 'invite',
      description:
        'Mint an invitation for a new correspondent and report its locator.',
      inputSchema: objectSchema({ petNamePath: petNamePathSchema }, [
        'petNamePath',
      ]),
      argumentsShape: M.splitRecord({ petNamePath: PetNamePathShape }),
      invoke: (guest, { petNamePath }) => E(guest).invite(petNamePath),
    },
    {
      name: 'accept',
      description:
        'Redeem an invitation locator and name the new correspondent.',
      inputSchema: objectSchema(
        { locator: locatorSchema, petNamePath: petNamePathSchema },
        ['locator', 'petNamePath'],
      ),
      argumentsShape: M.splitRecord({
        locator: M.string(),
        petNamePath: PetNamePathShape,
      }),
      invoke: (guest, { locator, petNamePath }) =>
        E(guest).accept(locator, petNamePath),
    },

    // Files and directories.
    {
      name: 'makeDirectory',
      description: 'Create a new directory at a pet name path.',
      inputSchema: objectSchema({ petNamePath: petNamePathSchema }, [
        'petNamePath',
      ]),
      argumentsShape: M.splitRecord({ petNamePath: PetNamePathShape }),
      invoke: async (guest, { petNamePath }) => {
        await E(guest).makeDirectory(petNamePath);
        return `Created directory ${petNamePath.join('/')}`;
      },
    },
    {
      name: 'makePath',
      description:
        'Create the directory at a pet name path and any intermediate ' +
        'directories, only where they do not yet exist. makePath calls run ' +
        'one at a time, so one never replaces directories another created; ' +
        'a concurrent mkdir is not ordered against them.',
      inputSchema: objectSchema({ petNamePath: petNamePathSchema }, [
        'petNamePath',
      ]),
      argumentsShape: M.splitRecord({ petNamePath: PetNamePathShape }),
      invoke: (guest, { petNamePath }) => {
        // Check-then-create is not atomic, and the daemon's makeDirectory
        // replaces an existing name, so concurrent makePath calls sharing a
        // prefix would each create it and the later would erase the earlier's
        // children. Each call waits for the previous one on this server.
        const made = makePathQueue.then(() => makePath(guest, petNamePath));
        makePathQueue = made.then(
          () => {},
          () => {},
        );
        return made;
      },
    },
    {
      name: 'readText',
      description: 'Read the text of a file at a pet name path.',
      inputSchema: objectSchema({ petNamePath: petNamePathSchema }, [
        'petNamePath',
      ]),
      argumentsShape: M.splitRecord({ petNamePath: PetNamePathShape }),
      invoke: (guest, { petNamePath }) => E(guest).readText(petNamePath),
    },
    {
      name: 'maybeReadText',
      description:
        'Read the text of a file at a pet name path, or nothing if it is absent.',
      inputSchema: objectSchema({ petNamePath: petNamePathSchema }, [
        'petNamePath',
      ]),
      argumentsShape: M.splitRecord({ petNamePath: PetNamePathShape }),
      invoke: (guest, { petNamePath }) => E(guest).maybeReadText(petNamePath),
    },
    {
      name: 'writeText',
      description: 'Write text to a file at a pet name path.',
      inputSchema: objectSchema(
        { petNamePath: petNamePathSchema, text: { type: 'string' } },
        ['petNamePath', 'text'],
      ),
      argumentsShape: M.splitRecord({
        petNamePath: PetNamePathShape,
        text: M.string(),
      }),
      invoke: async (guest, { petNamePath, text }) => {
        await E(guest).writeText(petNamePath, text);
        return `Wrote ${text.length} characters to ${petNamePath.join('/')}`;
      },
    },
    {
      name: 'storeValue',
      description: 'Store a JSON value under a pet name path.',
      inputSchema: objectSchema({ petNamePath: petNamePathSchema, value: {} }, [
        'petNamePath',
        'value',
      ]),
      argumentsShape: M.splitRecord({
        petNamePath: PetNamePathShape,
        value: M.any(),
      }),
      invoke: async (guest, { petNamePath, value }) => {
        await E(guest).storeValue(value, petNamePath);
        return `Stored a value as ${petNamePath.join('/')}`;
      },
    },

    // Search, over a mount you hold.
    {
      name: 'glob',
      description:
        'List the file paths matching a glob pattern in the mount at a pet name path.',
      inputSchema: objectSchema(
        {
          mountPath: petNamePathSchema,
          pattern: { type: 'string' },
          followSymlinks: searchOptionSchemas.followSymlinks,
        },
        ['mountPath', 'pattern'],
      ),
      argumentsShape: M.splitRecord(
        { mountPath: PetNamePathShape, pattern: M.string() },
        { followSymlinks: M.boolean() },
      ),
      invoke: (guest, toolArguments) =>
        E(E(guest).lookup(toolArguments.mountPath)).glob(
          toolArguments.pattern,
          pickOptions(toolArguments, ['followSymlinks']),
        ),
    },
    {
      name: 'grep',
      description:
        'Search file contents for a regular expression in the mount at a pet ' +
        'name path, optionally only in the given file paths.',
      inputSchema: objectSchema(
        {
          mountPath: petNamePathSchema,
          pattern: { type: 'string' },
          paths: stringsSchema,
          ...searchOptionSchemas,
        },
        ['mountPath', 'pattern'],
      ),
      argumentsShape: M.splitRecord(
        { mountPath: PetNamePathShape, pattern: M.string() },
        {
          paths: M.arrayOf(M.string()),
          maxResults: M.and(M.safeInteger(), M.gte(1)),
          followSymlinks: M.boolean(),
        },
      ),
      invoke: (guest, toolArguments) => {
        const { mountPath, pattern, paths } = toolArguments;
        const options = pickOptions(toolArguments, [
          'maxResults',
          'followSymlinks',
        ]);
        const mount = E(guest).lookup(mountPath);
        return paths === undefined
          ? E(mount).grep(pattern, undefined, options)
          : E(mount).grep(pattern, paths, options);
      },
    },
    {
      name: 'glorp',
      description:
        'Search the contents of the files matching a glob pattern for a ' +
        'regular expression, in the mount at a pet name path.',
      inputSchema: objectSchema(
        {
          mountPath: petNamePathSchema,
          globPattern: { type: 'string' },
          grepPattern: { type: 'string' },
          ...searchOptionSchemas,
        },
        ['mountPath', 'globPattern', 'grepPattern'],
      ),
      argumentsShape: M.splitRecord(
        {
          mountPath: PetNamePathShape,
          globPattern: M.string(),
          grepPattern: M.string(),
        },
        {
          maxResults: M.and(M.safeInteger(), M.gte(1)),
          followSymlinks: M.boolean(),
        },
      ),
      invoke: (guest, toolArguments) =>
        E(E(guest).lookup(toolArguments.mountPath)).glorp(
          toolArguments.globPattern,
          toolArguments.grepPattern,
          pickOptions(toolArguments, ['maxResults', 'followSymlinks']),
        ),
    },

    // Evaluation.
    {
      name: 'evaluate',
      description:
        'Evaluate JavaScript in a worker, with named values from your ' +
        'directory in scope. codeNames[i] is bound to petNamePaths[i].',
      inputSchema: objectSchema(
        {
          workerName: petNamePathSchema,
          source: { type: 'string' },
          codeNames: stringsSchema,
          petNamePaths: petNamePathsSchema,
          resultName: petNamePathSchema,
        },
        ['source', 'codeNames', 'petNamePaths'],
      ),
      argumentsShape: M.splitRecord(
        {
          source: M.string(),
          codeNames: M.arrayOf(M.string()),
          petNamePaths: M.arrayOf(PetNamePathShape),
        },
        { workerName: PetNamePathShape, resultName: PetNamePathShape },
      ),
      invoke: (
        guest,
        { workerName, source, codeNames, petNamePaths, resultName },
      ) =>
        resultName === undefined
          ? E(guest).evaluate(workerName, source, codeNames, petNamePaths)
          : E(guest).evaluate(
              workerName,
              source,
              codeNames,
              petNamePaths,
              resultName,
            ),
    },
    {
      name: 'define',
      description:
        'Propose code with named slots to your host, who fills each slot ' +
        'with a value and runs it.',
      inputSchema: objectSchema(
        {
          source: { type: 'string' },
          slots: {
            type: 'object',
            additionalProperties: objectSchema({ label: { type: 'string' } }, [
              'label',
            ]),
          },
        },
        ['source', 'slots'],
      ),
      argumentsShape: M.splitRecord({
        source: M.string(),
        slots: M.recordOf(
          M.string(),
          M.splitRecord({ label: M.string() }, {}, {}),
        ),
      }),
      invoke: async (guest, { source, slots }) => {
        await E(guest).define(source, slots);
        return 'Definition sent';
      },
    },

    // Mail.
    {
      name: 'listMessages',
      description: 'List the messages in your inbox.',
      inputSchema: objectSchema({}),
      argumentsShape: M.splitRecord({}),
      invoke: guest => E(guest).listMessages(),
    },
    {
      name: 'send',
      description:
        'Send a package message: text fragments interleaved with named values. ' +
        'strings has one more entry than edgeNames; petNames names the values.',
      inputSchema: objectSchema(
        {
          recipient: petNamePathSchema,
          strings: stringsSchema,
          edgeNames: stringsSchema,
          petNames: petNamePathsSchema,
        },
        ['recipient', 'strings', 'edgeNames', 'petNames'],
      ),
      argumentsShape: M.splitRecord({
        recipient: PetNamePathShape,
        strings: M.arrayOf(M.string()),
        edgeNames: M.arrayOf(M.string()),
        petNames: M.arrayOf(PetNamePathShape),
      }),
      invoke: async (guest, { recipient, strings, edgeNames, petNames }) => {
        await E(guest).send(recipient, strings, edgeNames, petNames);
        return 'Message sent';
      },
    },
    {
      name: 'reply',
      description: 'Reply to a message in your inbox with a package message.',
      inputSchema: objectSchema(
        {
          messageNumber: messageNumberSchema,
          strings: stringsSchema,
          edgeNames: stringsSchema,
          petNames: petNamePathsSchema,
        },
        ['messageNumber', 'strings', 'edgeNames', 'petNames'],
      ),
      argumentsShape: M.splitRecord({
        messageNumber: MessageNumberArgumentShape,
        strings: M.arrayOf(M.string()),
        edgeNames: M.arrayOf(M.string()),
        petNames: M.arrayOf(PetNamePathShape),
      }),
      normalizeArguments: normalizeMessageNumber,
      invoke: async (
        guest,
        { messageNumber, strings, edgeNames, petNames },
      ) => {
        await E(guest).reply(messageNumber, strings, edgeNames, petNames);
        return 'Reply sent';
      },
    },
    {
      name: 'editMessage',
      description:
        'Replace the content of a message you sent; done marks it final.',
      inputSchema: objectSchema(
        {
          messageNumber: messageNumberSchema,
          strings: stringsSchema,
          edgeNames: stringsSchema,
          petNames: petNamePathsSchema,
          done: { type: 'boolean' },
        },
        ['messageNumber', 'strings', 'edgeNames', 'petNames'],
      ),
      argumentsShape: M.splitRecord(
        {
          messageNumber: MessageNumberArgumentShape,
          strings: M.arrayOf(M.string()),
          edgeNames: M.arrayOf(M.string()),
          petNames: M.arrayOf(PetNamePathShape),
        },
        { done: M.boolean() },
      ),
      normalizeArguments: normalizeMessageNumber,
      invoke: async (
        guest,
        { messageNumber, strings, edgeNames, petNames, done },
      ) => {
        await (done === undefined
          ? E(guest).editMessage(messageNumber, strings, edgeNames, petNames)
          : E(guest).editMessage(messageNumber, strings, edgeNames, petNames, {
              done,
            }));
        return `Edited message ${messageNumber}`;
      },
    },
    messageTool('messageHistory', 'List the revisions of a message.'),
    {
      name: 'adopt',
      description:
        'Give a pet name to a value carried by a message in your inbox.',
      inputSchema: objectSchema(
        {
          messageNumber: messageNumberSchema,
          edgeName: { type: 'string' },
          petName: petNamePathSchema,
        },
        ['messageNumber', 'edgeName', 'petName'],
      ),
      argumentsShape: M.splitRecord({
        messageNumber: MessageNumberArgumentShape,
        edgeName: M.string(),
        petName: PetNamePathShape,
      }),
      normalizeArguments: normalizeMessageNumber,
      invoke: async (guest, { messageNumber, edgeName, petName }) => {
        await E(guest).adopt(messageNumber, edgeName, petName);
        return `Adopted ${edgeName} as ${petName.join('/')}`;
      },
    },
    messageTool(
      'dismiss',
      'Remove a message from your inbox.',
      messageNumber => `Dismissed message ${messageNumber}`,
    ),
    {
      name: 'dismissAll',
      description: 'Remove every message from your inbox.',
      inputSchema: objectSchema({}),
      argumentsShape: M.splitRecord({}),
      invoke: async guest => {
        await E(guest).dismissAll();
        return 'Dismissed all messages';
      },
    },
    {
      name: 'request',
      description:
        'Ask a correspondent for a value and wait for the answer, optionally ' +
        'naming it.',
      inputSchema: objectSchema(
        {
          recipient: petNamePathSchema,
          description: { type: 'string' },
          responseName: petNamePathSchema,
        },
        ['recipient', 'description'],
      ),
      argumentsShape: M.splitRecord(
        { recipient: PetNamePathShape, description: M.string() },
        { responseName: PetNamePathShape },
      ),
      invoke: (guest, { recipient, description, responseName }) =>
        responseName === undefined
          ? E(guest).request(recipient, description)
          : E(guest).request(recipient, description, responseName),
    },
    {
      name: 'resolve',
      description: 'Answer a request in your inbox with a named value.',
      inputSchema: objectSchema(
        { messageNumber: messageNumberSchema, petNamePath: petNamePathSchema },
        ['messageNumber', 'petNamePath'],
      ),
      argumentsShape: M.splitRecord({
        messageNumber: MessageNumberArgumentShape,
        petNamePath: PetNamePathShape,
      }),
      normalizeArguments: normalizeMessageNumber,
      invoke: async (guest, { messageNumber, petNamePath }) => {
        await E(guest).resolve(messageNumber, petNamePath);
        return `Resolved request ${messageNumber}`;
      },
    },
    {
      name: 'reject',
      description: 'Decline a request in your inbox, optionally saying why.',
      inputSchema: objectSchema(
        { messageNumber: messageNumberSchema, reason: { type: 'string' } },
        ['messageNumber'],
      ),
      argumentsShape: M.splitRecord(
        { messageNumber: MessageNumberArgumentShape },
        { reason: M.string() },
      ),
      normalizeArguments: normalizeMessageNumber,
      invoke: async (guest, { messageNumber, reason }) => {
        await (reason === undefined
          ? E(guest).reject(messageNumber)
          : E(guest).reject(messageNumber, reason));
        return `Rejected request ${messageNumber}`;
      },
    },
    {
      name: 'sendValue',
      description: 'Reply to a message with a named value.',
      inputSchema: objectSchema(
        { messageNumber: messageNumberSchema, petNamePath: petNamePathSchema },
        ['messageNumber', 'petNamePath'],
      ),
      argumentsShape: M.splitRecord({
        messageNumber: MessageNumberArgumentShape,
        petNamePath: PetNamePathShape,
      }),
      normalizeArguments: normalizeMessageNumber,
      invoke: async (guest, { messageNumber, petNamePath }) => {
        await E(guest).sendValue(messageNumber, petNamePath);
        return `Sent ${petNamePath.join('/')} in reply to ${messageNumber}`;
      },
    },
    {
      name: 'form',
      description: 'Send a form for a correspondent to fill in.',
      inputSchema: objectSchema(
        {
          recipient: petNamePathSchema,
          description: { type: 'string' },
          fields: { type: 'array', items: recordSchema },
        },
        ['recipient', 'description', 'fields'],
      ),
      argumentsShape: M.splitRecord({
        recipient: PetNamePathShape,
        description: M.string(),
        fields: M.arrayOf(PlainRecordShape),
      }),
      invoke: async (guest, { recipient, description, fields }) => {
        await E(guest).form(recipient, description, fields);
        return 'Form sent';
      },
    },
    {
      name: 'submit',
      description: 'Submit values for a form in your inbox.',
      inputSchema: objectSchema(
        { messageNumber: messageNumberSchema, values: recordSchema },
        ['messageNumber', 'values'],
      ),
      argumentsShape: M.splitRecord({
        messageNumber: MessageNumberArgumentShape,
        values: PlainRecordShape,
      }),
      normalizeArguments: normalizeMessageNumber,
      invoke: async (guest, { messageNumber, values }) => {
        await E(guest).submit(messageNumber, values);
        return `Submitted form ${messageNumber}`;
      },
    },

    // Following streams in bounded pulls.
    {
      name: 'followMessages',
      description:
        'Follow your inbox: the current messages, then each new one. ' +
        'Returns a follower to read with readFollower.',
      inputSchema: objectSchema({}),
      argumentsShape: M.splitRecord({}),
      invoke: guest => openFollower(() => E(guest).followMessages()),
    },
    {
      name: 'followNameChanges',
      description:
        'Follow the names in your directory: the current names, then each ' +
        'change. Returns a follower to read with readFollower.',
      inputSchema: objectSchema({}),
      argumentsShape: M.splitRecord({}),
      invoke: guest => openFollower(() => E(guest).followNameChanges()),
    },
    {
      name: 'followLocatorNameChanges',
      description:
        'Follow the pet names that designate a locator. Returns a follower ' +
        'to read with readFollower.',
      inputSchema: objectSchema({ locator: locatorSchema }, ['locator']),
      argumentsShape: M.splitRecord({ locator: M.string() }),
      invoke: (guest, { locator }) =>
        openFollower(() => E(guest).followLocatorNameChanges(locator)),
    },
    {
      name: 'followStream',
      description:
        'Follow the stream (a reader) stored under a pet name path. Returns ' +
        'a follower to read with readFollower.',
      inputSchema: objectSchema({ petNamePath: petNamePathSchema }, [
        'petNamePath',
      ]),
      argumentsShape: M.splitRecord({ petNamePath: PetNamePathShape }),
      invoke: (guest, { petNamePath }) =>
        openFollower(() => E(guest).lookup(petNamePath)),
    },
    {
      name: 'readFollower',
      description:
        'Read up to maxItems items from a follower, returning within ' +
        'waitMilliseconds in all. done is true once the stream has ended.',
      inputSchema: objectSchema(
        {
          follower: { type: 'string' },
          maxItems: { type: 'integer', minimum: 1, maximum: LIMIT_MAX_ITEMS },
          waitMilliseconds: {
            type: 'integer',
            minimum: 0,
            maximum: LIMIT_WAIT_MILLISECONDS,
          },
        },
        ['follower'],
      ),
      argumentsShape: M.splitRecord(
        { follower: M.string() },
        {
          maxItems: M.and(M.safeInteger(), M.gte(1), M.lte(LIMIT_MAX_ITEMS)),
          waitMilliseconds: M.and(
            M.safeInteger(),
            M.gte(0),
            M.lte(LIMIT_WAIT_MILLISECONDS),
          ),
        },
      ),
      invoke: (
        _guest,
        {
          follower,
          maxItems = DEFAULT_MAX_ITEMS,
          waitMilliseconds = DEFAULT_WAIT_MILLISECONDS,
        },
      ) => readFollower(follower, maxItems, waitMilliseconds),
    },
    {
      name: 'closeFollower',
      description: 'Stop following and release a follower.',
      inputSchema: objectSchema({ follower: { type: 'string' } }, ['follower']),
      argumentsShape: M.splitRecord({ follower: M.string() }),
      invoke: (_guest, { follower }) => closeFollower(follower),
    },
  ];
  return harden(tools.map(tool => harden(tool)));
};
harden(makeAgentTools);

/**
 * Methods a resolved value must carry to be accepted as a guest facet.
 */
export const requiredGuestMethods = harden([
  'help',
  'has',
  'list',
  'remove',
  'move',
  'copy',
  'makeDirectory',
  'readText',
  'writeText',
  'listMessages',
  'send',
  'reply',
  'adopt',
  'dismiss',
]);

/**
 * Methods that only a host carries, derived from the daemon's own
 * `HostInterface` and `GuestInterface` so the list tracks the daemon rather
 * than a hand-kept copy. A formula id resolving to a value with any of these
 * is not a guest, and the server refuses to speak for it.
 */
export const hostOnlyMethods = (() => {
  const guestMethods = new Set(getInterfaceMethodKeys(GuestInterface));
  return harden(
    getInterfaceMethodKeys(HostInterface)
      .filter(name => typeof name === 'string' && !guestMethods.has(name))
      .sort(),
  );
})();

/** The interface name the daemon gives every guest facet. */
export const guestInterfaceName =
  getInterfaceGuardPayload(GuestInterface).interfaceName;
