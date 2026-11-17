// @ts-check
// Test helpers for W2.8: one adapter incarnation (blob store, archive store,
// context cache) over a directory under H/tmp, the oracles a test compares
// with (projection and records of the full record list), and normalisers
// that make a History page or a vat page comparable with the full list.
// Import after the guest prelude.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { previewText } from '../../guest/lib/bounded.js';
import { blobsOf, isStaged } from '../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */
import { makeBlobStore } from '../../resources/agent-host/impl/blobs.js';
import { makeContextCache } from '../../resources/agent-host/impl/context-cache.js';
import { projectRecords } from '../../resources/agent-host/impl/projection.js';
import { makeArchiveStore } from '../../resources/agent-host/impl/archive/store.js';
import { harnessRoot } from '../_helpers.js';
import { makeFakeBlobSink } from './_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

/**
 * A scratch state directory under H/tmp (removed by `cleanup`).
 * @param {string} prefix
 */
export const makeStateDir = async prefix => {
  const base = join(harnessRoot, 'tmp');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, prefix));
  /** Archive stores made over this directory: drained before removal. */
  /** @type {any[]} */
  const archives = [];
  return {
    root,
    blobDir: join(root, 'agent-host', 'blobs'),
    archiveDir: join(root, 'agent-host', 'archive'),
    archives,
    cleanup: async () => {
      await Promise.all(archives.map(archive => archive.drain()));
      await rm(root, { recursive: true, force: true });
    },
  };
};

/**
 * A fake manager sink: blob minting and resolving (`_m1b-blobs.js`) plus
 * `resolveSessions` (a session's archive key, `h<n>`, assigned on first use).
 */
export const makeFakeSink = () => {
  const blob = makeFakeBlobSink();
  /** @type {WeakMap<any, string>} */
  const archiveKeys = new WeakMap();
  let serial = 0;
  const counts = { resolveSessions: 0 };
  /** @param {any} session */
  const keyOf = session => {
    let key = archiveKeys.get(session);
    if (key === undefined) {
      serial += 1;
      key = `h${serial}`;
      archiveKeys.set(session, key);
    }
    return key;
  };
  const sink = Far('AgentHostSink', {
    mintBlobs: () => E(blob.sink).mintBlobs(),
    /** @param {any[]} blobs */
    resolveBlobs: blobs => E(blob.sink).resolveBlobs(blobs),
    /** @param {any[]} sessions */
    resolveSessions: sessions => {
      counts.resolveSessions += 1;
      return harden(sessions.map(keyOf));
    },
  });
  return { sink, keyOf, counts, blobCounts: blob.counts };
};

/**
 * One adapter incarnation over `dirs`: a fresh blob store, archive store and
 * context cache (a restart is another call over the same dirs and sink).
 * @param {{ blobDir: string, archiveDir: string, archives?: any[] }} dirs
 * @param {any} sink
 * @param {{ trace?: any, maxTextUnits?: number }} [options]
 */
export const makeIncarnation = (dirs, sink, { trace, maxTextUnits } = {}) => {
  const blobs = makeBlobStore({ dir: dirs.blobDir, sink });
  const archive = makeArchiveStore({
    dir: dirs.archiveDir,
    blobs,
    sink,
    ...(trace === undefined ? {} : { trace }),
  });
  dirs.archives?.push(archive);
  const cache = makeContextCache({
    store: blobs,
    archive,
    ...(maxTextUnits === undefined ? {} : { maxTextUnits }),
  });
  return { blobs, archive, cache, history: archive.history() };
};

/**
 * The oracle: the projection of the full record list.
 * @param {readonly any[]} all
 * @param {any} blobs a BlobStore that can read every handle
 */
export const oracleTranscript = async (all, blobs) => {
  const list = [...new Set(all.flatMap(blobsOf))];
  const texts = new Map(
    await Promise.all(
      list.map(
        async blob =>
          /** @type {[any, string]} */ ([blob, await blobs.read(blob)]),
      ),
    ),
  );
  return projectRecords(all, { texts }).transcript;
};

/**
 * A record with every staged field replaced by `{ staged: { preview,
 * bytes, digest } }` (a vat's StagedText or History's SealedField alike).
 * @param {any} value
 * @returns {any}
 */
export const normalise = value => {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(normalise);
  if (isStaged(value) || 'sealed' in value) {
    /** @type {Record<string, any>} */
    const staged = { preview: value.preview, bytes: value.bytes };
    if (value.digest !== undefined) staged.digest = value.digest;
    return { staged };
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(value)) out[key] = normalise(value[key]);
  return out;
};

/**
 * The vat's preview of a record (turn.js `previewRecord`), normalised.
 * @param {any} record
 */
export const referencePreview = record => {
  const message = (/** @type {any} */ t) =>
    isStaged(t) ? t : previewText(t, limits.messagePreviewUnits);
  const tool = (/** @type {any} */ t) =>
    isStaged(t) ? t : previewText(t, limits.toolPreviewUnits);
  switch (record.kind) {
    case 'turn-started':
      return normalise({ ...record, input: message(record.input) });
    case 'partial':
    case 'round-settled':
      return normalise({ ...record, text: message(record.text) });
    case 'turn-settled':
      return normalise(
        record.final === undefined
          ? record
          : { ...record, final: message(record.final) },
      );
    case 'tool-result':
      return normalise({ ...record, result: tool(record.result) });
    case 'tool-intents':
      return normalise({
        ...record,
        intents: record.intents.map((/** @type {any} */ intent) => ({
          ...intent,
          args: tool(intent.args),
        })),
      });
    default:
      return normalise(record);
  }
};

/**
 * Full text of a staged field: a vat StagedText (through the blob store) or
 * a SealedField (through its SealedText, page by page).
 * @param {any} field
 * @param {any} blobs
 */
export const fullText = async (field, blobs) => {
  if (isStaged(field)) return blobs.read(field.blob);
  let text = '';
  let offset = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await E(field.sealed).read({
      offset,
      maxBytes: limits.blobPageBytes,
    });
    text += page.text;
    if (page.done) return text;
    offset = page.next;
  }
};

/**
 * A record with every staged field replaced by its full text.
 * @param {any} value
 * @param {any} blobs
 * @returns {Promise<any>}
 */
export const withTexts = async (value, blobs) => {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    return Promise.all(value.map(v => withTexts(v, blobs)));
  }
  if (isStaged(value) || 'sealed' in value) {
    return { text: await fullText(value, blobs) };
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(value)) {
    // eslint-disable-next-line no-await-in-loop
    out[key] = await withTexts(value[key], blobs);
  }
  return out;
};
