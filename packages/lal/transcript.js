// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop */

// Lal's durable session transcript: a Pi-compatible JSONL file per worker
// session, written through `@endo/jsonl-transcript` into a daemon scratch
// mount (`transcripts-for-lal`). See
// `designs/endopi-jsonl-transcript-format.md` § The writer.
//
// Only the trusted harness (the Lal manager and the worker loop it spawns)
// holds the writable mount. Model-driven tools run against the worker's
// sub-guest powers, whose pet store never names the mount.

import { E } from '@endo/eventual-send';
import { encodeHex } from '@endo/hex';
import { decodeUtf8, encodeUtf8 } from '@endo/utf8';
import {
  loadFromJsonl,
  assemblePath,
  makeCustomEntry,
  makeSessionWriter,
  sessionFileName,
  slugSegment,
} from '@endo/jsonl-transcript';

/** The host pet name of Lal's transcripts scratch mount. */
export const TRANSCRIPTS_MOUNT_NAME = 'transcripts-for-lal';

/** PiAgent message roles that become `message` entries. */
const PROJECTED_ROLES = harden(['user', 'assistant', 'toolResult']);

/**
 * @param {any} message
 * @returns {boolean}
 */
const isProjected = message =>
  message !== null &&
  typeof message === 'object' &&
  PROJECTED_ROLES.includes(message.role);

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
 * @param {any} mount - A writable `EndoMount`.
 */
export const makeMountWriterFs = mount => {
  /** @param {string} path */
  const readText = path => E(mount).maybeReadText(path);
  return harden({
    async mkdir() {
      // Session files sit flat at the mount root.
    },
    async readFile(path) {
      const text = await readText(path);
      if (text === undefined) {
        throw makeEnoent(path);
      }
      return encodeUtf8(text);
    },
    async truncate(path, length) {
      const text = (await readText(path)) ?? '';
      const kept = decodeUtf8(encodeUtf8(text).slice(0, length));
      await E(mount).writeText(path, kept);
    },
    async open(path) {
      if ((await readText(path)) === undefined) {
        await E(mount).makeFile(path, '');
      }
      const file = await E(mount).lookup(path);
      return harden({
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
 * A UUIDv7 (RFC 9562): 48-bit millisecond timestamp, version and variant
 * bits, random remainder. Pi's own tools expect entry ids of this shape.
 *
 * @param {() => number} [now]
 * @param {(bytes: Uint8Array) => Uint8Array} [fillRandom]
 * @returns {string}
 */
export const uuidv7 = (
  now = Date.now,
  fillRandom = bytes => globalThis.crypto.getRandomValues(bytes),
) => {
  const bytes = fillRandom(new Uint8Array(16));
  let milliseconds = now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = milliseconds % 256;
    milliseconds = Math.floor(milliseconds / 256);
  }
  bytes[6] = 0x70 + (bytes[6] % 0x10);
  bytes[8] = 0x80 + (bytes[8] % 0x40);
  const hex = encodeHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
harden(uuidv7);

/**
 * The file-name marker that scopes a session file to one worker. One mount
 * serves every worker a Lal manager spawns; the worker's name is recorded in
 * the session id (and so the file name) and in the header.
 *
 * @param {string} workerName
 */
const workerPrefix = workerName => `${slugSegment(workerName)}--`;

/**
 * The newest session file in the mount that belongs to `workerName`, or
 * `undefined`. `sessionFileName` zero-pads the timestamp, so lexical order is
 * chronological.
 *
 * @param {any} mount
 * @param {string} workerName
 * @returns {Promise<string | undefined>}
 */
export const findLatestSessionFile = async (mount, workerName) => {
  const marker = `_${workerPrefix(workerName)}`;
  const names = /** @type {string[]} */ (await E(mount).list());
  const mine = names
    .filter(name => name.endsWith('.jsonl') && name.includes(marker))
    .sort();
  return mine.length > 0 ? mine[mine.length - 1] : undefined;
};
harden(findLatestSessionFile);

/**
 * Open (resuming if possible) the transcript for one worker.
 *
 * Resumes the newest session file for the worker, repairing a torn tail, and
 * returns its `message` entries as PiAgent seed messages. With no prior file,
 * or with `fresh: true`, starts a new session file.
 *
 * @param {object} options
 * @param {any} options.mount - The writable transcripts mount.
 * @param {string} options.workerName
 * @param {boolean} [options.fresh]
 * @param {() => number} [options.now]
 * @param {() => string} [options.makeIdentifier]
 * @param {string} [options.cwd] - Recorded in the header.
 * @param {string} [options.guestIdentifier] - The worker guest's id, for the header.
 */
export const openWorkerTranscript = async ({
  mount,
  workerName,
  fresh = false,
  now = Date.now,
  makeIdentifier = () => uuidv7(now),
  cwd = '/',
  guestIdentifier,
}) => {
  const fs = makeMountWriterFs(mount);

  const existing = fresh
    ? undefined
    : await findLatestSessionFile(mount, workerName);
  /** @type {any[]} */
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
  // Opening repairs any torn tail before we read the file back.
  // `writeHeader` is a no-op when resuming a non-empty file.
  await writer.writeHeader({
    sessionId: sessionIdentifier ?? fileName,
    createdAt: now(),
    cwd,
    ...(guestIdentifier === undefined
      ? {}
      : { 'endo:guestId': guestIdentifier }),
  });

  const text = (await E(mount).maybeReadText(fileName)) ?? '';
  const graph = loadFromJsonl(text);
  const nodes = graph.entries.filter(entry => entry.type !== 'header');
  const lastNode = nodes.at(-1);
  if (lastNode !== undefined) {
    lastIdentifier = lastNode.id;
    seedMessages = assemblePath(graph, lastIdentifier)
      .filter(entry => entry.type === 'message' && isProjected(entry.message))
      .map(entry => entry.message);
  }

  /** Messages already on file, by identity, so a round appends only news. */
  const recorded = new WeakSet();

  const link = () => {
    const identifier = makeIdentifier();
    const parentIdentifier = lastIdentifier;
    lastIdentifier = identifier;
    return { id: identifier, parentId: parentIdentifier };
  };

  const transcript = {
    fileName,
    /** PiAgent `initialState.messages` for a resumed session. */
    seedMessages,
    /**
     * Mark seeded messages as already on file once the PiAgent holds them.
     *
     * @param {readonly any[]} messages
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
     * @param {{ number?: number | bigint, messageIdentifier?: string, replyTo?: string }} mail
     */
    async recordMail(mail) {
      /** @type {Record<string, unknown>} */
      const payload = {};
      if (mail.messageIdentifier !== undefined) {
        payload.messageId = mail.messageIdentifier;
      }
      if (mail.replyTo !== undefined) payload.replyTo = mail.replyTo;
      if (mail.number !== undefined) payload.number = String(mail.number);
      await writer.append(makeCustomEntry('endo:mail', { ...link(), payload }));
    },
    /**
     * Append every projected PiAgent message not yet on file, in order.
     *
     * @param {readonly any[]} messages - The PiAgent's `state.messages`.
     */
    async recordMessages(messages) {
      for (const message of messages) {
        if (isProjected(message) && !recorded.has(message)) {
          recorded.add(message);
          await writer.appendMessage(message, link());
        }
      }
    },
    close: () => writer.close(),
  };
  return transcript;
};
harden(openWorkerTranscript);

/**
 * Look up the host's transcripts scratch mount, creating it on first use.
 * `provideScratchMount` mints a fresh mount on every call, so an existing
 * name is reused rather than overwritten.
 *
 * @param {any} hostAgent - An `EndoHost` (or anything with `has`,
 *   `lookup`, `provideScratchMount`).
 * @param {string} [petName]
 */
export const provideTranscriptsMount = async (
  hostAgent,
  petName = TRANSCRIPTS_MOUNT_NAME,
) => {
  if (await E(hostAgent).has(petName)) {
    return E(hostAgent).lookup(petName);
  }
  return E(hostAgent).provideScratchMount(petName);
};
harden(provideTranscriptsMount);
