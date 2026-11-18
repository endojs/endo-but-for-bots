/* eslint-disable no-await-in-loop */

// Lal's durable session transcript: a Pi-compatible JSONL file per worker
// session, written through `@endo/jsonl-transcript` into a daemon scratch
// mount (`transcripts-for-lal`). See
// `designs/endopi-jsonl-transcript-format.md` § Writer.

import { E } from '@endo/eventual-send';
import { encodeHex } from '@endo/hex';
import { decodeUtf8, encodeUtf8 } from '@endo/utf8';
// The package root's `types.d.ts` declares types only, so the values come
// from the subpath exports, which carry their own JSDoc types.
import { makeCustomEntry } from '@endo/jsonl-transcript/entries.js';
import { sessionFileName } from '@endo/jsonl-transcript/session-path.js';
import { makeSessionWriter } from '@endo/jsonl-transcript/writer.js';
import { loadFromJsonl, assemblePath } from '@endo/jsonl-transcript/reader.js';

/** @import { ChatMessage, WriterFs } from '@endo/jsonl-transcript' */
/**
 * @import {
 *   TranscriptFile,
 *   TranscriptMail,
 *   TranscriptMount,
 *   TranscriptsHost,
 *   WorkerTranscript,
 * } from './agent.types.js'
 */

export const TRANSCRIPTS_MOUNT_NAME = 'transcripts-for-lal';

/** PiAgent message roles that become `message` entries. */
const PROJECTED_ROLES = harden(['user', 'assistant', 'toolResult']);

/**
 * @param {unknown} message
 * @returns {message is ChatMessage}
 */
const isProjected = message =>
  message !== null &&
  typeof message === 'object' &&
  PROJECTED_ROLES.includes(
    /** @type {{ role?: string }} */ (message).role ?? '',
  );

/**
 * @param {string} path
 * @returns {Error}
 */
const makeEnoent = path => {
  const error = /** @type {Error & { code?: string }} */ (
    Error(`ENOENT: no such file in transcripts mount: ${path}`)
  );
  error.code = 'ENOENT';
  return error;
};

/**
 * Adapt a writable daemon mount to the `WriterFs` that `makeSessionWriter`
 * accepts. Session files sit flat at the mount root, so `mkdir` is a no-op.
 * The file mode is the daemon's concern, not the adapter's.
 *
 * @param {TranscriptMount} mount - A writable `EndoMount`.
 * @returns {WriterFs}
 */
export const makeMountWriterFs = mount => {
  /** @param {string} path */
  const readText = path => E(mount).maybeReadText(path);
  return harden({
    async mkdir() {
      // Nothing to create: files sit at the mount root.
    },
    /** @param {string} path */
    async readFile(path) {
      const text = await readText(path);
      if (text === undefined) {
        throw makeEnoent(path);
      }
      return encodeUtf8(text);
    },
    // The writer truncates only to the end of the last complete line, so
    // `length` never falls inside a multibyte sequence. The mount has no
    // truncate, so this is a non-atomic read-and-rewrite of the whole file.
    /**
     * @param {string} path
     * @param {number} length
     */
    async truncate(path, length) {
      const text = (await readText(path)) ?? '';
      const kept = decodeUtf8(encodeUtf8(text).slice(0, length));
      await E(mount).writeText(path, kept);
    },
    /** @param {string} path */
    async open(path) {
      if ((await readText(path)) === undefined) {
        await E(mount).makeFile(path, '');
      }
      const file = /** @type {TranscriptFile} */ (await E(mount).lookup(path));
      return harden({
        /** @param {string} text */
        write: text => E(file).append(text),
        async close() {
          // The mount owns the file; there is no handle to release.
        },
      });
    },
  });
};
harden(makeMountWriterFs);

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
const defaultFillRandom = bytes => {
  const { crypto } = globalThis;
  if (crypto === undefined) {
    throw Error('uuidv7: no globalThis.crypto; pass fillRandom explicitly');
  }
  crypto.getRandomValues(/** @type {Uint8Array<ArrayBuffer>} */ (bytes));
  return bytes;
};

const MAX_UUIDV7_MILLISECONDS = 2n ** 48n - 1n;

/**
 * A UUIDv7 (RFC 9562): 48-bit millisecond timestamp, version and variant
 * bits, random remainder. Pi's own tools expect entry ids of this shape.
 *
 * Lal runs as an unconfined guest, so `Date.now` and `globalThis.crypto`
 * are the start compartment's real ones. A tamed clock (`NaN`) or a
 * timestamp outside 48 bits throws rather than minting a garbage id.
 *
 * @param {() => number} [now]
 * @param {(bytes: Uint8Array) => Uint8Array} [fillRandom] - Fills its
 *   argument with random bytes and returns it; the return value is used.
 * @returns {string}
 */
export const uuidv7 = (now = Date.now, fillRandom = defaultFillRandom) => {
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw RangeError(`uuidv7: clock returned ${timestamp}`);
  }
  let milliseconds = BigInt(timestamp);
  if (milliseconds > MAX_UUIDV7_MILLISECONDS) {
    throw RangeError(`uuidv7: timestamp ${timestamp} exceeds 48 bits`);
  }
  const bytes = fillRandom(new Uint8Array(16));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(milliseconds % 256n);
    milliseconds /= 256n;
  }
  bytes[6] = 0x70 + (bytes[6] % 0x10);
  bytes[8] = 0x80 + (bytes[8] % 0x40);
  const hex = encodeHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
harden(uuidv7);

/**
 * The session-id prefix that scopes a session file to one worker. One mount
 * serves every worker a Lal manager spawns. The worker name is hex-encoded so
 * the key is injective and holds no `-` or `_`: no worker's key can appear
 * inside another's file name, and names that would slug alike stay apart.
 * The raw name is also recorded in the header as `endo:worker`.
 *
 * @param {string} workerName
 */
const workerPrefix = workerName => `w${encodeHex(encodeUtf8(workerName))}--`;

/**
 * The newest session file in the mount whose name carries `workerName`'s key
 * right after the timestamp and whose header names `workerName` exactly, or
 * `undefined`. `sessionFileName` zero-pads the timestamp, so lexical order is
 * chronological.
 *
 * @param {TranscriptMount} mount
 * @param {string} workerName
 * @returns {Promise<string | undefined>}
 */
export const findLatestSessionFile = async (mount, workerName) => {
  const prefix = workerPrefix(workerName);
  const names = await E(mount).list();
  const candidates = names
    .filter(name => {
      const match = /^\d{14}_(.*)\.jsonl$/.exec(name);
      return match !== null && match[1].startsWith(prefix);
    })
    .sort()
    .reverse();
  for (const name of candidates) {
    const text = (await E(mount).maybeReadText(name)) ?? '';
    const { header } = loadFromJsonl(text);
    if (header !== null && header['endo:worker'] === workerName) {
      return name;
    }
  }
  return undefined;
};
harden(findLatestSessionFile);

/**
 * Open (resuming if possible) the transcript for one worker.
 *
 * Resumes the newest session file for the worker, repairing a torn tail, and
 * returns the `user`/`assistant`/`toolResult` messages on its current path as
 * PiAgent seed messages. With no prior file, or with `fresh: true`, starts a
 * new session file (an older file is left in place).
 *
 * On resume the file already has a header, so the header fields passed here
 * are ignored.
 *
 * The returned transcript assumes one round at a time: `recordMail` and
 * `recordMessages` share the parent chain, and the inbox loop awaits each
 * round before the next.
 *
 * @param {object} options
 * @param {TranscriptMount} options.mount - The writable transcripts mount.
 * @param {string} options.workerName
 * @param {boolean} [options.fresh]
 * @param {() => number} [options.now]
 * @param {(bytes: Uint8Array) => Uint8Array} [options.fillRandom]
 * @param {() => string} [options.makeIdentifier]
 * @param {string} [options.cwd] - Recorded in the header.
 * @param {string} [options.guestIdentifier] - The worker guest's id, for the header.
 * @returns {Promise<WorkerTranscript>}
 */
export const openWorkerTranscript = async ({
  mount,
  workerName,
  fresh = false,
  now = Date.now,
  fillRandom = defaultFillRandom,
  makeIdentifier = () => uuidv7(now, fillRandom),
  cwd = '/',
  guestIdentifier,
}) => {
  const fs = makeMountWriterFs(mount);

  const existing = fresh
    ? undefined
    : await findLatestSessionFile(mount, workerName);
  /** @type {ChatMessage[]} */
  let seedMessages = [];
  /** @type {string | null} */
  let lastIdentifier = null;
  const sessionIdentifier =
    existing === undefined
      ? `${workerPrefix(workerName)}${makeIdentifier()}`
      : undefined;
  /** @type {string} */
  const fileName =
    existing ??
    sessionFileName({
      timestamp: now(),
      sessionId: `${sessionIdentifier}`,
    });

  const writer = makeSessionWriter({ path: fileName, fs });
  // Pi readers ignore unknown header keys; `HeaderEntry` does not list the
  // `endo:` extensions, so the header is built apart from the call.
  const header = {
    sessionId: sessionIdentifier ?? fileName,
    createdAt: now(),
    cwd,
    'endo:worker': workerName,
    ...(guestIdentifier === undefined
      ? {}
      : { 'endo:guestId': guestIdentifier }),
  };
  await writer.writeHeader(header);

  const text = (await E(mount).maybeReadText(fileName)) ?? '';
  const graph = loadFromJsonl(text);
  const nodes = graph.entries.filter(entry => entry.type !== 'header');
  const lastNode = nodes.at(-1);
  if (lastNode !== undefined) {
    lastIdentifier = lastNode.id;
    seedMessages = assemblePath(graph, lastIdentifier).flatMap(entry =>
      entry.type === 'message' && isProjected(entry.message)
        ? [entry.message]
        : [],
    );
  }

  /** @type {WeakSet<object>} */
  const recorded = new WeakSet();

  const link = () => {
    const identifier = makeIdentifier();
    const parentIdentifier = lastIdentifier;
    lastIdentifier = identifier;
    return { id: identifier, parentId: parentIdentifier };
  };

  /** @type {WorkerTranscript} */
  const transcript = {
    fileName,
    get seedMessages() {
      return [...seedMessages];
    },
    /**
     * Mark seeded messages as already on file once the PiAgent holds them.
     *
     * @param {readonly unknown[]} messages
     */
    markRecorded(messages) {
      for (const message of messages) {
        if (message !== null && typeof message === 'object') {
          recorded.add(message);
        }
      }
    },
    /**
     * Record the Endo mail message that started a turn. Ids only, never
     * live references.
     *
     * @param {TranscriptMail} mail
     */
    async recordMail(mail) {
      /** @type {Record<string, unknown>} */
      const payload = {};
      if (mail.messageIdentifier !== undefined) {
        payload.messageId = mail.messageIdentifier;
      }
      if (mail.replyTo !== undefined) payload.replyTo = mail.replyTo;
      if (mail.number !== undefined) payload.number = String(mail.number);
      const parentIdentifier = lastIdentifier;
      try {
        await writer.append(
          makeCustomEntry('endo:mail', { ...link(), payload }),
        );
      } catch (error) {
        lastIdentifier = parentIdentifier;
        throw error;
      }
    },
    /**
     * Append every projected PiAgent message not yet on file, in order. A
     * message counts as on file only once its append succeeds, so a failed
     * write is retried by the next call and the file stays an in-order
     * prefix of the PiAgent's history.
     *
     * @param {readonly unknown[]} messages - The PiAgent's `state.messages`.
     */
    async recordMessages(messages) {
      for (const message of messages) {
        if (isProjected(message) && !recorded.has(message)) {
          const parentIdentifier = lastIdentifier;
          try {
            await writer.appendMessage(message, link());
          } catch (error) {
            lastIdentifier = parentIdentifier;
            throw error;
          }
          recorded.add(message);
        }
      }
    },
    close: () => writer.close(),
  };
  return harden(transcript);
};
harden(openWorkerTranscript);

/**
 * Bind a worker's transcript to its PiAgent. Marks the PiAgent's current
 * (seeded) messages as already on file, and returns a round runner that
 * records the starting mail, runs the round, and then (even if the round
 * throws) appends the round's new messages. A transcript write failure is
 * reported to `onError` and never fails the round: a lost transcript line
 * must not take down the worker.
 *
 * @template {{ state: { messages: readonly unknown[] } }} P
 * @param {object} options
 * @param {WorkerTranscript} options.transcript
 * @param {P} options.piAgent
 * @param {(piAgent: P, prompt: string) => Promise<unknown>} options.runRound
 * @param {(error: unknown) => void} [options.onError]
 * @returns {(prompt: string, mail?: TranscriptMail) => Promise<void>}
 */
export const makeTranscriptRoundRunner = ({
  transcript,
  piAgent,
  runRound,
  onError = error => console.error('[lal] Transcript write failed:', error),
}) => {
  transcript.markRecorded(piAgent.state.messages);

  /** @param {() => Promise<void>} record */
  const recordSafely = async record => {
    try {
      await record();
    } catch (error) {
      onError(error);
    }
  };

  return async (prompt, mail) => {
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
};
harden(makeTranscriptRoundRunner);

/**
 * Look up the host's transcripts scratch mount, creating it on first use.
 * `provideScratchMount` mints a fresh mount on every call, so an existing
 * name is reused rather than overwritten.
 *
 * @param {TranscriptsHost} hostAgent - An `EndoHost`, or anything with
 *   `has`, `lookup`, `provideScratchMount`.
 * @param {string} [petName]
 * @returns {Promise<TranscriptMount>}
 */
export const provideTranscriptsMount = async (
  hostAgent,
  petName = TRANSCRIPTS_MOUNT_NAME,
) => {
  if (await E(hostAgent).has(petName)) {
    return /** @type {Promise<TranscriptMount>} */ (
      E(hostAgent).lookup(petName)
    );
  }
  return /** @type {Promise<TranscriptMount>} */ (
    E(hostAgent).provideScratchMount(petName)
  );
};
harden(provideTranscriptsMount);
