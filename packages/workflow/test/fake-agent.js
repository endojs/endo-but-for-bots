// @ts-check

/**
 * An in-memory fake of the agent-shaped powers the workflow service
 * consumes, faithful to the daemon's durability split:
 *
 * - Durable across `restart()`: the name tree, delivered messages,
 *   request resolutions (including `responseName` writes and
 *   `@mail/<n>/@result` follow-through), and form-reply values.
 * - Ephemeral: `followMessages` subscriptions and the JS promises
 *   returned by `request()` — a restarted consumer must re-follow and
 *   re-attach, exactly as against the real daemon.
 *
 * The test drives the human/agent side with `resolveRequest`,
 * `rejectRequest`, and `submitForm`.
 */

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

const toPath = nameOrPath =>
  typeof nameOrPath === 'string' ? [nameOrPath] : [...nameOrPath];

export const makeFakeClock = (start = 1_000_000) => {
  let now = start;
  let nextId = 1;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const pendingTimers = new Map();
  return harden({
    now: () => now,
    /**
     * @param {() => void} fn
     * @param {number} ms
     */
    setTimeout: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      pendingTimers.set(id, { at: now + ms, fn });
      return id;
    },
    /** @param {number} id */
    clearTimeout: id => {
      pendingTimers.delete(id);
    },
    /** @param {number} ms */
    advance: async ms => {
      await null;
      const target = now + ms;
      for (;;) {
        const due = [...pendingTimers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort(([, a], [, b]) => a.at - b.at);
        if (due.length === 0) {
          break;
        }
        const [id, timer] = due[0];
        pendingTimers.delete(id);
        now = Math.max(now, timer.at);
        timer.fn();
        // Let settlement cascades run between timer firings.
        // eslint-disable-next-line no-await-in-loop
        await null;
        // eslint-disable-next-line no-await-in-loop
        await null;
      }
      now = target;
    },
  });
};
harden(makeFakeClock);

export const makeFakeAgent = () => {
  // #region durable state
  // Tree node: Map name -> { dir } | { value }.
  /** @returns {Map<string, any>} */
  const makeNode = () => new Map();
  const root = makeNode();
  /** @type {any[]} */
  const messages = [];
  let nextMessageNumber = 0n;
  let nextMessageId = 0;
  /**
   * Request state by decimal message number:
   * { status?: 'fulfilled'|'rejected', value?, reason?, responseName? }
   * @type {Map<string, any>}
   */
  const requests = new Map();
  /** @type {Map<string, any>} value-message payloads by decimal number */
  const messageValues = new Map();
  // #endregion

  const walk = (path, { create = false } = {}) => {
    let node = root;
    for (const name of path) {
      let entry = node.get(name);
      if (entry === undefined) {
        if (!create) {
          return undefined;
        }
        entry = { dir: makeNode() };
        node.set(name, entry);
      }
      if (entry.dir === undefined) {
        return undefined;
      }
      node = entry.dir;
    }
    return node;
  };

  const storeAtPath = (path, value) => {
    const parent = walk(path.slice(0, -1));
    if (parent === undefined) {
      throw Error(`fake-agent: no directory at ${path.slice(0, -1).join('/')}`);
    }
    parent.set(path[path.length - 1], { value });
  };

  const deliver = message => {
    messages.push(harden(message));
    return message;
  };

  const settleRequest = (numberName, status, valueOrReason, incarnation) => {
    const record = requests.get(numberName);
    if (record === undefined || record.status !== undefined) {
      return;
    }
    record.status = status;
    if (status === 'fulfilled') {
      record.value = valueOrReason;
      if (record.responseName !== undefined) {
        storeAtPath(record.responseName, valueOrReason);
      }
    } else {
      record.reason = valueOrReason;
    }
    for (const waiter of incarnation.requestWaiters.get(numberName) ?? []) {
      if (status === 'fulfilled') {
        waiter.resolve(valueOrReason);
      } else {
        waiter.reject(Error(valueOrReason));
      }
    }
  };

  /** @type {any} */
  let currentIncarnation;

  const makeIncarnation = () => {
    const incarnation = {
      /** @type {Map<string, { resolve: any, reject: any }[]>} */
      requestWaiters: new Map(),
      /** @type {{ next: (message: any) => void }[]} */
      followers: [],
      alive: true,
    };

    const waitForRequest = numberName => {
      const record = requests.get(numberName);
      if (record?.status === 'fulfilled') {
        return Promise.resolve(record.value);
      }
      if (record?.status === 'rejected') {
        return Promise.reject(Error(record.reason));
      }
      return new Promise((resolve, reject) => {
        const waiters = incarnation.requestWaiters.get(numberName) ?? [];
        waiters.push({ resolve, reject });
        incarnation.requestWaiters.set(numberName, waiters);
      });
    };

    const lookupPath = path => {
      if (path[0] === '@mail') {
        const numberName = path[1];
        if (path[2] === '@result') {
          return waitForRequest(numberName);
        }
        if (path[2] === '@value') {
          if (!messageValues.has(numberName)) {
            throw Error(`fake-agent: no value on message ${numberName}`);
          }
          return messageValues.get(numberName);
        }
        throw Error(`fake-agent: unknown mail edge ${path[2]}`);
      }
      const parent = walk(path.slice(0, -1));
      const entry = parent?.get(path[path.length - 1]);
      if (entry === undefined) {
        throw Error(`fake-agent: nothing at ${path.join('/')}`);
      }
      if (entry.dir !== undefined) {
        return harden({ directory: path.join('/') });
      }
      return entry.value;
    };

    const powers = Far('FakeAgentPowers', {
      has: async (...path) => {
        const parent = walk(path.slice(0, -1));
        return parent !== undefined && parent.has(path[path.length - 1]);
      },
      list: async (...path) => {
        const node = walk(path);
        if (node === undefined) {
          throw Error(`fake-agent: no directory at ${path.join('/')}`);
        }
        return harden([...node.keys()].sort());
      },
      lookup: async nameOrPath => lookupPath(toPath(nameOrPath)),
      maybeLookup: async nameOrPath => {
        await null;
        try {
          return await lookupPath(toPath(nameOrPath));
        } catch {
          return undefined;
        }
      },
      makeDirectory: async nameOrPath => {
        const path = toPath(nameOrPath);
        const parent = walk(path.slice(0, -1));
        if (parent === undefined) {
          throw Error(
            `fake-agent: no directory at ${path.slice(0, -1).join('/')}`,
          );
        }
        if (!parent.has(path[path.length - 1])) {
          parent.set(path[path.length - 1], { dir: makeNode() });
        }
      },
      storeValue: async (value, nameOrPath) => {
        storeAtPath(toPath(nameOrPath), value);
      },
      remove: async (...path) => {
        const parent = walk(path.slice(0, -1));
        parent?.delete(path[path.length - 1]);
      },
      request: async (recipient, description, responseName) => {
        // Idempotent resume hook, as in mail.js: an already-stored
        // response short-circuits without sending.
        if (responseName !== undefined) {
          const path = toPath(responseName);
          const parent = walk(path.slice(0, -1));
          const entry = parent?.get(path[path.length - 1]);
          if (entry !== undefined && entry.value !== undefined) {
            return entry.value;
          }
        }
        const number = nextMessageNumber;
        nextMessageNumber += 1n;
        nextMessageId += 1;
        const message = deliver({
          type: 'request',
          number,
          messageId: `m${nextMessageId}`,
          description,
          to: toPath(recipient).join('/'),
        });
        requests.set(String(number), {
          responseName:
            responseName === undefined ? undefined : toPath(responseName),
        });
        for (const follower of incarnation.followers) {
          follower.next(message);
        }
        return waitForRequest(String(number));
      },
      form: async (recipient, description, fields) => {
        const number = nextMessageNumber;
        nextMessageNumber += 1n;
        nextMessageId += 1;
        const message = deliver({
          type: 'form',
          number,
          messageId: `m${nextMessageId}`,
          description,
          fields,
          to: toPath(recipient).join('/'),
        });
        for (const follower of incarnation.followers) {
          follower.next(message);
        }
      },
      listMessages: async () => harden([...messages]),
      followMessages: async () => {
        /** @type {any[]} */
        const queue = [...messages];
        /** @type {{ resolve: any } | undefined} */
        let waiting;
        const follower = {
          next: message => {
            queue.push(message);
            if (waiting !== undefined) {
              const { resolve } = waiting;
              waiting = undefined;
              resolve(undefined);
            }
          },
        };
        incarnation.followers.push(follower);
        return harden({
          [Symbol.asyncIterator]() {
            return this;
          },
          next: async () => {
            await null;
            for (;;) {
              if (!incarnation.alive) {
                return harden({ value: undefined, done: true });
              }
              if (queue.length > 0) {
                return harden({ value: queue.shift(), done: false });
              }
              // eslint-disable-next-line no-await-in-loop
              await new Promise(resolve => {
                waiting = { resolve };
              });
            }
          },
          return: async () => harden({ value: undefined, done: true }),
        });
      },
    });

    return { powers, incarnation };
  };

  const first = makeIncarnation();
  currentIncarnation = first.incarnation;

  const controls = {
    // Find the newest message whose description contains `needle`.
    findMessage: (type, needle) => {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (
          message.type === type &&
          (needle === undefined || message.description.includes(needle))
        ) {
          return message;
        }
      }
      return undefined;
    },
    messageCount: (type, needle) =>
      messages.filter(
        message =>
          message.type === type &&
          (needle === undefined || message.description.includes(needle)),
      ).length,
    resolveRequest: async (message, value) => {
      settleRequest(
        String(message.number),
        'fulfilled',
        value,
        currentIncarnation,
      );
      await null;
    },
    rejectRequest: async (message, reason) => {
      settleRequest(
        String(message.number),
        'rejected',
        reason,
        currentIncarnation,
      );
      await null;
    },
    submitForm: async (formMessage, values) => {
      const number = nextMessageNumber;
      nextMessageNumber += 1n;
      nextMessageId += 1;
      messageValues.set(String(number), harden(values));
      const message = deliver({
        type: 'value',
        number,
        messageId: `m${nextMessageId}`,
        replyTo: formMessage.messageId,
      });
      for (const follower of currentIncarnation.followers) {
        follower.next(message);
      }
      await null;
    },
    /**
     * Simulate a daemon restart: the durable state persists; live
     * subscriptions and unresolved request promises of the previous
     * incarnation are severed.
     */
    restart: () => {
      currentIncarnation.alive = false;
      currentIncarnation.requestWaiters.clear();
      currentIncarnation.followers.length = 0;
      const next = makeIncarnation();
      currentIncarnation = next.incarnation;
      return next.powers;
    },
    // Read a stored value directly, bypassing the powers surface.
    peek: path => {
      const parent = walk(path.slice(0, -1));
      const entry = parent?.get(path[path.length - 1]);
      return entry?.value;
    },
  };

  return harden({ powers: first.powers, controls });
};
harden(makeFakeAgent);

/**
 * Drain the microtask queue a few times so eventual-send cascades settle.
 *
 * @param {number} [turns]
 */
export const settle = async (turns = 24) => {
  await null;
  for (let i = 0; i < turns; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
};
harden(settle);

/**
 * Make an invoke target that records calls and answers from a queue (or
 * throws when the queued entry is an Error).
 *
 * @param {any[]} [answers]
 */
export const makeRecordingTarget = (answers = []) => {
  /** @type {{ method: string, args: any[], effectId: string }[]} */
  const calls = [];
  const queue = [...answers];
  const target = Far('RecordingTarget', {
    perform: async (...allArgs) => {
      const effectId = allArgs[allArgs.length - 1];
      const args = allArgs.slice(0, -1);
      calls.push({ method: 'perform', args, effectId });
      const answer = queue.length > 0 ? queue.shift() : undefined;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  });
  // The calls array stays mutable on purpose; harden only the target.
  return { target, calls };
};
harden(makeRecordingTarget);

/**
 * Convenience: await an E-reachable run facet's status.
 *
 * @param {any} run
 */
export const statusOf = run => E(run).status();
harden(statusOf);
