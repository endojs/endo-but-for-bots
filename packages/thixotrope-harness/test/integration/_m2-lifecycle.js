// @ts-check
/**
 * Helpers for M2 W2.7's lifecycle tests and the import perf check: a
 * synthetic export file (sessions of N turns in the export format of
 * `scripts/export.mjs`, written without a daemon, so `importState` can build
 * long sessions for fixtures), and disk sizes.
 *
 * A synthetic turn has the shape of a one-tool-call turn of the
 * long-session script (J-9388: about 9 records a turn): `turn-started`,
 * `dispatched` 0, `round-settled` 0 with one call, `tool-intents`,
 * `tool-result`, `dispatched` 1, `round-settled` 1 with the answer,
 * `turn-settled`. Texts are inline (each under `inlineBytes`), so building a
 * fixture stages nothing.
 */
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const usage = harden({
  inputTokens: 120,
  outputTokens: 40,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/**
 * @param {string} seed
 * @param {number} bytes
 */
const filler = (seed, bytes) => {
  const unit = `${seed} lorem ipsum dolor sit amet `;
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
};

/**
 * The records of synthetic turn `n`.
 * @param {number} n
 * @param {number} at
 * @param {{ inputBytes: number, answerBytes: number, shape?: 'tool' | 'plain' }} sizes
 *   `plain`: a turn of one round without a tool call (4 records)
 */
export const syntheticTurn = (n, at, { inputBytes, answerBytes, shape }) => {
  const turnId = `t${n}`;
  const opId = `${turnId}/r0/c0`;
  if (shape === 'plain') {
    return [
      {
        kind: 'turn-started',
        turnId,
        input: filler(`question ${n}`, inputBytes),
        at,
      },
      { kind: 'dispatched', turnId, round: 0 },
      {
        kind: 'round-settled',
        turnId,
        round: 0,
        text: filler(`answer ${n}`, answerBytes),
        callCount: 0,
        usage,
        at: at + 600,
      },
      {
        kind: 'turn-settled',
        turnId,
        status: 'completed',
        at: at + 700,
        usage,
      },
    ];
  }
  return [
    {
      kind: 'turn-started',
      turnId,
      input: filler(`question ${n}`, inputBytes),
      at,
    },
    { kind: 'dispatched', turnId, round: 0 },
    {
      kind: 'round-settled',
      turnId,
      round: 0,
      text: '',
      callCount: 1,
      usage,
      at: at + 200,
    },
    {
      kind: 'tool-intents',
      turnId,
      round: 0,
      intents: [
        {
          opId,
          callId: `call-${n}`,
          name: 'echo',
          args: JSON.stringify({ text: `look up ${n}` }),
        },
      ],
    },
    {
      kind: 'tool-result',
      turnId,
      opId,
      name: 'echo',
      result: `looked up ${n}`,
      failed: false,
    },
    { kind: 'dispatched', turnId, round: 1 },
    {
      kind: 'round-settled',
      turnId,
      round: 1,
      text: filler(`answer ${n}`, answerBytes),
      callCount: 0,
      usage,
      at: at + 600,
    },
    { kind: 'turn-settled', turnId, status: 'completed', at: at + 700, usage },
  ];
};

/**
 * @typedef {object} SyntheticSession
 * @property {string} title
 * @property {number} turns
 * @property {string} backendLabel
 * @property {number} [createdAt]
 * @property {number} [inputBytes] default 200
 * @property {number} [answerBytes] default 1,000
 * @property {'tool' | 'plain'} [shape] default 'tool' (8 records a turn)
 * @property {{ text: string, requestId: string, at: number }[]} [queue]
 */

/**
 * Write an export file of synthetic sessions.
 * @param {string} file
 * @param {SyntheticSession[]} sessions
 * @returns {Promise<{ records: number, bytes: number }>}
 */
export const writeSyntheticExport = async (file, sessions) => {
  const stream = createWriteStream(file, { encoding: 'utf8' });
  let records = 0;
  let bytes = 0;
  /** @param {unknown} line */
  const write = async line => {
    const text = `${JSON.stringify(line)}\n`;
    bytes += Buffer.byteLength(text);
    if (!stream.write(text)) await once(stream, 'drain');
  };
  await write({
    type: 'factory',
    settings: { backends: [], turnDeadlineMs: 0 },
  });
  for (const [index, s] of sessions.entries()) {
    const createdAt = s.createdAt ?? 1_700_000_000_000;
    const sizes = {
      inputBytes: s.inputBytes ?? 200,
      answerBytes: s.answerBytes ?? 1000,
      shape: s.shape ?? 'tool',
    };
    const config = {
      key: `s${index + 1}`,
      title: s.title,
      backendTitle: s.backendLabel,
      modelId: 'scripted',
      preset: { label: 'chat-only' },
      createdAt,
      userInitiated: true,
    };
    // eslint-disable-next-line no-await-in-loop
    await write({
      type: 'session',
      head: {
        key: config.key,
        title: s.title,
        userInitiated: true,
        info: {
          key: config.key,
          title: s.title,
          backendTitle: s.backendLabel,
          modelId: 'scripted',
          presetLabel: 'chat-only',
          createdAt,
        },
        config,
        usage: {
          inputTokens: 240 * s.turns,
          outputTokens: 80 * s.turns,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          reasoningOutputTokens: 0,
          context: { usedTokens: 0, windowTokens: 0 },
          turns: s.turns,
          incompleteTurns: 0,
        },
      },
    });
    /** @type {any[]} */
    let batch = [];
    let from = 0;
    for (let n = 1; n <= s.turns; n += 1) {
      batch.push(...syntheticTurn(n, createdAt + n * 1000, sizes));
      if (batch.length >= 512 || n === s.turns) {
        // eslint-disable-next-line no-await-in-loop
        await write({ type: 'records', from, records: batch });
        from += batch.length;
        records += batch.length;
        batch = [];
      }
    }
    if (s.queue !== undefined && s.queue.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await write({
        type: 'queue',
        entries: s.queue.map(({ text, requestId, at }) => ({
          submission: { text },
          requestId,
          at,
        })),
      });
    }
    // eslint-disable-next-line no-await-in-loop
    await write({ type: 'end' });
  }
  stream.end();
  await once(stream, 'finish');
  return { records, bytes };
};

/**
 * Bytes of every file under `dir` (0 when it does not exist).
 * @param {string} dir
 * @returns {Promise<number>}
 */
export const dirBytes = async dir => {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      total += await dirBytes(full);
    } else if (entry.isFile()) {
      // eslint-disable-next-line no-await-in-loop
      total += (await stat(full).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
};

/**
 * Disk use of a state directory, by part.
 * @param {string} root
 */
export const diskOf = async root => {
  const [total, heaps, workers, archive, blobs] = await Promise.all([
    dirBytes(root),
    dirBytes(path.join(root, 'heaps')),
    dirBytes(path.join(root, 'workers')),
    dirBytes(path.join(root, 'agent-host', 'archive')),
    dirBytes(path.join(root, 'agent-host', 'blobs')),
  ]);
  return { total, heaps, workers, archive, blobs };
};

/**
 * Disk use of one vat, by its debug label: its worker directory (journal,
 * meta), its current heap snapshot and its incarnation files.
 * @param {string} root
 * @param {string} debugLabel e.g. 'session s1'
 */
export const vatDisk = async (root, debugLabel) => {
  const workers = path.join(root, 'workers');
  let workerBytes = 0;
  let snapshotBytes = 0;
  let found = false;
  for (const id of await readdir(workers).catch(() => [])) {
    /** @type {any} */
    let meta;
    try {
      // eslint-disable-next-line no-await-in-loop
      const text = await readFile(path.join(workers, id, 'meta.json'), 'utf8');
      meta = JSON.parse(text);
    } catch {
      meta = undefined;
    }
    if (meta?.debugLabel === debugLabel) {
      found = true;
      // eslint-disable-next-line no-await-in-loop
      workerBytes += await dirBytes(path.join(workers, id));
      if (meta.snapshot?.ref !== undefined) {
        // eslint-disable-next-line no-await-in-loop
        snapshotBytes += await stat(
          path.join(root, 'heaps', 'snapshots', `${meta.snapshot.ref}.sqlite`),
        ).then(
          s => s.size,
          () => 0,
        );
      }
    }
  }
  const slug = debugLabel.replace(/[^A-Za-z0-9._-]+/g, '-');
  const incarnations = path.join(root, 'heaps', 'incarnations');
  let incarnationBytes = 0;
  for (const name of await readdir(incarnations).catch(() => [])) {
    if (name.startsWith(`vat-${slug}-`)) {
      // eslint-disable-next-line no-await-in-loop
      incarnationBytes += await dirBytes(path.join(incarnations, name)).then(
        async bytes =>
          bytes ||
          stat(path.join(incarnations, name)).then(
            s => (s.isFile() ? s.size : 0),
            () => 0,
          ),
      );
    }
  }
  return {
    found,
    workerBytes,
    snapshotBytes,
    incarnationBytes,
    total: workerBytes + snapshotBytes + incarnationBytes,
  };
};
