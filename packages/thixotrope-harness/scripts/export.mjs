#!/usr/bin/env node
// @ts-check
/**
 * Data-only export and import of a served harness state (M2 W2.7;
 * `designs/m2-interfaces.md` 7.3, 4.11).
 *
 *   node scripts/export.mjs export STATE FILE [--workspace w]
 *   node scripts/export.mjs import STATE FILE [--workspace w]
 *
 * STATE is a served state directory (its `control.sock`). The file is JSON
 * lines:
 *
 *   { type: 'factory', settings }     backends by label, default model,
 *                                     turn deadline
 *   { type: 'presets', records }      user presets (M5 W5.1): every field
 *                                     but the endowments, backend by label
 *   { type: 'session', head }         per session: info, config, usage,
 *                                     archive state, hold
 *   { type: 'records', from, records } in log order; every staged field is
 *                                     `{ text }` with the full text
 *   { type: 'queue', entries, hold }  waiting entries
 *   { type: 'end' }
 *
 * Export reads `HarnessRoot.exportState` pages, then per session the
 * archived turns through `History` (`page` from the newest sealed ordinal
 * down, `turnContent`, `SealedText.read`) and the kept part through
 * `SessionInternal.exportState` pages and `Content.read`. A `lost` session
 * (its vat is gone) cannot be read and is left out (counted).
 *
 * Import, per session: `HarnessRoot.importSession` (backend matched by
 * label among `SessionFactory.listBackends()` and the caller's `backends`;
 * title, model, creation time and `userInitiated` from the head), texts
 * staged with `AgentHostAdmin.writersFor(session)`, then
 * `SessionInternal.importState` chunks of at most `frameBytes` and
 * `pageRecords` records in log order (the session seals as it goes), the
 * waiting entries, `end`. The importer keeps the session's unsealed tail
 * bounded: while more than `archiveKeepTurns + 3 * archiveSegmentTurns`
 * imported turns are not sealed it waits for the session's seals (it reads
 * the head page's archive state).
 *
 * Presets (M5 W5.1, acceptance 14): export reads the user presets through
 * `Operator.getPresets()` (`describe()` each); import creates each one with
 * `PresetCatalog.create` at the current revision, its backend matched by
 * label as a session's.
 *
 * Not exported (documented losses): exec scope bindings (the exec vat's
 * scope is not in any record); workspace files and shell home (the imported
 * environment starts at its pinned base commit or with an empty repository); secret values (re-create them); preset
 * endowments and built-in presets' edits (objects are not exported; a
 * built-in comes back as shipped). An archived turn's records come back in segment order: tool results
 * in call order, and a `TurnResolved` sealed after its turn right after it.
 */
import './_init.mjs';

import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import readline from 'node:readline';
import url from 'node:url';

import { E, passStyleOf } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import {
  assertWorkspaceSeed,
  workspaceSeedLabel,
} from '../guest/lib/workspace-seed.js';
import { limits } from '../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { names } from './provision-steps.js';

/** Bytes kept free in an import chunk for its keys and envelope. */
const CHUNK_SLACK = 2048;
/** Unsealed imported turns the importer lets a session hold. */
export const importAhead =
  limits.archiveKeepTurns + 3 * limits.archiveSegmentTurns;

/** @param {string} text */
const utf8 = text => Buffer.byteLength(text, 'utf8');

/**
 * UTF-8 bytes of every string in a passable tree (presences count 0), as
 * the vat's `messageBytes` counts them.
 * @param {unknown} value
 * @returns {number}
 */
export const treeBytes = value => {
  if (typeof value === 'string') return utf8(value);
  if (Array.isArray(value)) {
    let total = 0;
    for (const element of value) total += treeBytes(element);
    return total;
  }
  if (value !== null && typeof value === 'object') {
    if (passStyleOf(value) !== 'copyRecord') return 0;
    let total = 0;
    for (const [key, element] of Object.entries(value)) {
      total += utf8(key) + treeBytes(element);
    }
    return total;
  }
  return 0;
};

/**
 * A copy of `value` in which every staged field the predicate recognises
 * is replaced by what `replace` answers (awaited, in order).
 * @param {unknown} value
 * @param {(field: any) => boolean} isField
 * @param {(field: any) => Promise<unknown>} replace
 * @returns {Promise<any>}
 */
const mapFields = async (value, isField, replace) => {
  if (Array.isArray(value)) {
    const out = [];
    for (const element of value) {
      out.push(await mapFields(element, isField, replace));
    }
    return out;
  }
  if (value === null || typeof value !== 'object') return value;
  if (passStyleOf(value) !== 'copyRecord') return value;
  if (isField(value)) return replace(value);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, element] of Object.entries(value)) {
    out[key] = await mapFields(element, isField, replace);
  }
  return out;
};

/** @param {any} field */
const isStaged = field =>
  'blob' in field &&
  'bytes' in field &&
  passStyleOf(field.blob) === 'remotable';
/** @param {any} field */
const isSealed = field =>
  'sealed' in field &&
  'bytes' in field &&
  passStyleOf(field.sealed) === 'remotable';

/**
 * The whole text of a reader (`Content.read(blob, range)` or
 * `SealedText.read(range)`), page by page.
 * @param {(range: { offset: number, maxBytes: number }) => Promise<any>} read
 */
const readAll = async read => {
  const parts = [];
  let offset = 0;
  for (;;) {
    const page = await read(harden({ offset, maxBytes: limits.blobPageBytes }));
    parts.push(page.text);
    if (page.done) break;
    offset = page.next;
  }
  return parts.join('');
};

/**
 * A JSON-lines writer that waits for the stream when it is full.
 * @param {string} file
 */
const openLines = file => {
  const stream = createWriteStream(file, { encoding: 'utf8' });
  return {
    /** @param {unknown} line */
    write: async line => {
      if (!stream.write(`${JSON.stringify(line)}\n`))
        await once(stream, 'drain');
    },
    close: async () => {
      stream.end();
      await once(stream, 'finish');
    },
  };
};

/**
 * The harness objects of a control client on the harness workspace.
 * @param {any} client
 */
const harnessOf = async client => {
  const root = await client.call('lookup', names.harness);
  const admin = await client.call('lookup', names.agentHost);
  const operator = await E(root).getOperator();
  const factory = await E(operator).getFactory();
  return { root, admin, factory, operator };
};

/**
 * M5 W5.1: the user presets of a state as export records (endowments and
 * built-ins left out; the backend by label).
 * @param {any} operator
 */
const exportPresets = async operator => {
  const catalog = await E(operator).getPresets();
  const records = [];
  for (const preset of await E(catalog).list()) {
    const view = await E(preset).describe();
    if (!view.builtIn) {
      /** @type {Record<string, unknown>} */
      const record = {
        label: view.label,
        template: view.template,
        description: view.description,
        instructions: view.instructions,
        networkPolicy: view.networkPolicy,
        objects: view.objects,
      };
      const marker = view.endowments.find(
        (/** @type {any} */ entry) => entry.label === workspaceSeedLabel,
      );
      if (marker !== undefined) {
        const described = await E(marker.value).describe();
        assertWorkspaceSeed(described);
        if (
          view.workspaceSeed &&
          view.workspaceSeed.commit !== described.commit
        )
          throw Error(
            'Project preset and marker identify different source commits',
          );
        record.workspaceSeed = described;
      } else if (view.workspaceSeed !== undefined) {
        record.workspaceSeed = view.workspaceSeed;
      }
      if (view.backend !== undefined)
        record.backend = await labelOf(view.backend);
      if (view.modelId !== undefined) record.modelId = view.modelId;
      if (view.reasoningEffort !== undefined)
        record.reasoningEffort = view.reasoningEffort;
      records.push(record);
    }
  }
  return records;
};

/**
 * M5 W5.1: create each exported preset (backend matched by label).
 * @param {any} operator
 * @param {any[]} records
 * @param {Map<string, any>} byLabel
 */
const importPresets = async (operator, records, byLabel) => {
  const imported = [];
  const catalog = await E(operator).getPresets();
  for (const { backend: label, ...rest } of records) {
    /** @type {Record<string, unknown>} */
    const record = { ...rest };
    if (label !== undefined) {
      const backend = byLabel.get(label);
      if (backend === undefined)
        throw Error(
          `no backend labelled ${JSON.stringify(label)} in this state (preset ${JSON.stringify(rest.label)})`,
        );
      record.backend = backend;
    }
    const { revision } = await E(catalog).configuration();
    const { preset } = await E(catalog).create(harden(record), revision);
    imported.push(preset);
  }
  return imported;
};

/** @param {any} backend */
const labelOf = async backend => (await E(backend).describe()).label;

/**
 * Export every session of a served state to `file`.
 * @param {object} options
 * @param {any} options.client a control client on the harness workspace
 * @param {string} options.file
 * @param {number} [options.recordsPerLine] records per `records` line
 * @returns {Promise<{ sessions: number, skipped: number, presets: number, records: number, archivedTurns: number, texts: number, ms: number }>}
 */
export const exportState = async ({ client, file, recordsPerLine = 512 }) => {
  const t0 = performance.now();
  const { root, admin, operator } = await harnessOf(client);
  const content = await E(admin).content();
  /** @type {any} */
  let history;
  const out = openLines(file);
  const counts = {
    sessions: 0,
    skipped: 0,
    presets: 0,
    records: 0,
    archivedTurns: 0,
    texts: 0,
  };
  /** @param {any} field */
  const keptText = async field => {
    counts.texts += 1;
    return { text: await readAll(range => E(content).read(field.blob, range)) };
  };
  /** @param {any} field */
  const sealedText = async field => {
    counts.texts += 1;
    return { text: await readAll(range => E(field.sealed).read(range)) };
  };
  /** @param {any} value */
  const plain = value => mapFields(value, isStaged, keptText);

  /** @type {string | undefined} */
  let cursor;
  let first = true;
  try {
    for (;;) {
      const page = await E(root).exportState(
        ...(cursor === undefined ? [] : [cursor]),
      );
      if (first) {
        first = false;
        const { settings = {} } = page;

        const backends = await Promise.all(
          (settings.backends ?? []).map(labelOf),
        );
        /** @type {Record<string, unknown>} */
        const exported = { ...settings, backends };
        if (settings.defaultBackend !== undefined) {
          exported.defaultBackend = await labelOf(settings.defaultBackend);
        }

        await out.write({ type: 'factory', settings: exported });
        const presets = await exportPresets(operator);
        counts.presets = presets.length;
        await out.write({ type: 'presets', records: presets });
      }
      for (const entry of page.sessions) {
        if (entry.state === 'lost') {
          counts.skipped += 1;
        } else {
          counts.sessions += 1;

          const head = await E(entry.internal).exportState();

          await out.write({
            type: 'session',
            head: {
              key: entry.key,
              title: entry.title,
              userInitiated: entry.userInitiated,
              info: head.info,

              config: await plain(head.config),
              usage: head.usage,
              ...(head.archive === undefined ? {} : { archive: head.archive }),
              ...(head.execution === undefined
                ? {}
                : { execution: head.execution }),
              ...(head.hold === undefined ? {} : { hold: head.hold }),
            },
          });
          let from = 0;
          /** @param {any[]} records */
          const writeRecords = async records => {
            for (let i = 0; i < records.length; i += recordsPerLine) {
              const slice = records.slice(i, i + recordsPerLine);

              await out.write({ type: 'records', from, records: slice });
              from += slice.length;
              counts.records += slice.length;
            }
          };
          // The archived turns, oldest first, through History (4.11).
          const sealedTurns = head.archive?.sealedTurns ?? 0;
          if (sealedTurns > 0) {
            history ??= await E(admin).history();
            /** @type {string[]} */
            const turnIds = [];
            /** @type {string | undefined} */
            let at = `h${sealedTurns}`;
            while (at !== undefined) {
              const shown = await E(history).page(entry.session, at);
              for (const turn of shown.turns) turnIds.push(turn.turnId);
              at = shown.next;
            }
            turnIds.reverse();
            for (const turnId of turnIds) {
              /** @type {any[]} */
              const records = [];
              /** @type {string | undefined} */
              let c;
              do {
                const part = await E(history).turnContent(
                  entry.session,
                  turnId,
                  ...(c === undefined ? [] : [c]),
                );
                records.push(...part.records);
                c = part.next;
              } while (c !== undefined);

              await writeRecords(
                await mapFields(records, isSealed, sealedText),
              );
              counts.archivedTurns += 1;
            }
          }
          // The kept part, then the queue.
          /** @type {string | undefined} */
          let next = head.next;
          while (next !== undefined) {
            const part = await E(entry.internal).exportState(next);
            if (part.part === 'records') {
              await writeRecords(await plain(part.records));
            } else if (part.part === 'queue') {
              await out.write({
                type: 'queue',

                entries: await plain(part.entries),
                ...(part.hold === undefined ? {} : { hold: part.hold }),
              });
            } else if (part.part === 'inbox') {
              await out.write({
                type: 'inbox',
                messages: await plain(part.messages),
              });
            } else if (part.part === 'end') {
              await out.write({ type: 'end' });
            }
            next = part.next;
          }
        }
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
  } finally {
    await out.close();
  }
  return { ...counts, ms: Math.round(performance.now() - t0) };
};

/**
 * Stage `{ text }` fields through a session's BlobWriters.
 * @param {any} writers
 * @param {string} text
 */
const stage = async (writers, text) => {
  const writer = await E(writers).open();
  // Pieces of whole code points within blobPieceBytes.
  let piece = '';
  let bytes = 0;
  for (const char of text) {
    const size = utf8(char);
    if (bytes + size > limits.blobPieceBytes) {
      await E(writer).append(piece);
      piece = '';
      bytes = 0;
    }
    piece += char;
    bytes += size;
  }
  if (piece.length > 0) await E(writer).append(piece);
  return E(writer).close();
};

/** @param {any} field */
const isText = field =>
  Object.keys(field).length === 1 && typeof field.text === 'string';

/**
 * Import every session of `file` into a served state.
 * @param {object} options
 * @param {any} options.client a control client on the harness workspace
 * @param {string} options.file
 * @param {any[]} [options.backends] backends to match by label besides the
 *   factory's `listBackends()` (a test's scripted backends)
 * @param {(progress: { session: number, records: number, turns: number, ms: number }) => void} [options.onProgress]
 * @returns {Promise<{ sessions: any[], presets: number, records: number, turns: number, chunks: number, waits: number, waitMs: number, ms: number }>}
 */
export const importState = async ({
  client,
  file,
  backends = [],
  onProgress,
}) => {
  const t0 = performance.now();
  const { root, admin, factory, operator } = await harnessOf(client);
  /** @type {Map<string, any>} */
  const byLabel = new Map();
  for (const backend of [...(await E(factory).listBackends()), ...backends]) {
    const label = await labelOf(backend);
    if (!byLabel.has(label)) byLabel.set(label, backend);
  }
  const importedPresets = [];
  const totals = {
    presets: 0,
    records: 0,
    turns: 0,
    chunks: 0,
    waits: 0,
    waitMs: 0,
  };
  /** @type {any[]} */
  const sessions = [];
  /** @type {{ session: any, internal: any, writers: any, inboxBodies: Map<number, any>, chunk: any[], bytes: number, from: number, turns: number, sealed: number } | undefined} */
  let current;

  /** @param {any} value */
  const staged = value =>
    mapFields(value, isText, field =>
      stage(/** @type {any} */ (current).writers, field.text),
    );

  /** Wait until the session's unsealed imported turns are within bound. */
  const throttle = async () => {
    const s = /** @type {NonNullable<typeof current>} */ (current);
    if (s.turns - s.sealed <= importAhead) return;
    const w0 = performance.now();
    totals.waits += 1;
    for (;;) {
      const head = await E(s.internal).exportState();
      s.sealed = head.archive?.sealedTurns ?? 0;
      if (s.turns - s.sealed <= importAhead - limits.archiveSegmentTurns) break;

      await new Promise(resolve => setTimeout(resolve, 50));
      if (performance.now() - w0 > 120_000)
        throw Error(
          `the session sealed nothing for 120 s (${s.turns} turns imported, ${s.sealed} sealed)`,
        );
    }
    totals.waitMs += performance.now() - w0;
  };

  const flush = async () => {
    const s = current;
    if (s === undefined || s.chunk.length === 0) return;
    const records = harden(s.chunk);
    const progress = await E(s.internal).importState(
      harden({ part: 'records', from: s.from, records }),
    );
    s.from += records.length;
    if (progress.records !== s.from)
      throw Error(
        `the session holds ${progress.records} records, not ${s.from}`,
      );
    s.chunk = [];
    s.bytes = CHUNK_SLACK;
    totals.chunks += 1;
    onProgress?.({
      session: sessions.length,
      records: totals.records,
      turns: totals.turns,
      ms: Math.round(performance.now() - t0),
    });
    await throttle();
  };

  /**
   * An export that stops before a session's `end` (truncated at a line
   * boundary): the half-imported session is deleted and the import fails,
   * naming it, rather than report success and leave it unlisted until the
   * next daemon start deletes it (J-9493).
   * @param {string} why
   */
  const abandon = async why => {
    const s = /** @type {NonNullable<typeof current>} */ (current);
    current = undefined;
    await E(factory).deleteSession(s.session);
    sessions.pop();
    throw Error(
      `the export ${why} inside session ${sessions.length + 1}; that session was not imported`,
    );
  };

  const lines = readline.createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const text of lines) {
    const line = harden(JSON.parse(text.length === 0 ? '{}' : text));
    if (line.type === 'factory') {
      const { settings } = line;
      /** @type {Record<string, unknown>} */
      const changes = {};
      const fallback = byLabel.get(settings.defaultBackend);
      if (fallback !== undefined) changes.defaultBackend = fallback;
      if (settings.defaultModelId !== undefined)
        changes.defaultModelId = settings.defaultModelId;
      if (settings.turnDeadlineMs !== undefined)
        changes.turnDeadlineMs = settings.turnDeadlineMs;
      if (Object.keys(changes).length > 0)
        await E(root).configure(harden(changes));
    } else if (line.type === 'presets') {
      const added = await importPresets(operator, line.records, byLabel);
      importedPresets.push(...added);
      totals.presets += added.length;
    } else if (line.type === 'session') {
      if (current !== undefined) await abandon('starts another session');
      const { head } = line;
      const label = head.config.backendTitle;
      const backend = byLabel.get(label);
      if (backend === undefined)
        throw Error(
          `no backend labelled ${JSON.stringify(label)} in this state`,
        );
      /** @type {Record<string, unknown>} */
      const options = {
        title: head.title,
        backend,
        modelId: head.config.modelId,
        at: head.config.createdAt,
        userInitiated: head.userInitiated,
      };
      const saved = head.config.preset;
      if (
        saved?.endowmentLabels?.includes(workspaceSeedLabel) &&
        saved.workspaceSeed === undefined
      )
        throw Error(
          'This legacy project session has no recorded source commit. Reprovision its project preset with the original commit before creating a replacement session.',
        );
      if (saved?.objects?.length || head.execution !== undefined) {
        // Only restore the selected template objects. Importing an old
        // session must never grant a destination preset's live endowments.
        const candidates = [
          ...importedPresets,
          ...(await E(factory).listPresets()),
        ];
        for (const preset of candidates) {
          const view = await E(preset).describe();
          if (
            (view.builtIn || importedPresets.includes(preset)) &&
            view.label === saved?.label &&
            view.template === saved.template &&
            view.networkPolicy === saved.networkPolicy &&
            view.workspaceSeed?.project === saved.workspaceSeed?.project &&
            view.workspaceSeed?.commit === saved.workspaceSeed?.commit &&
            view.endowments.length === 0 &&
            view.objects.length === saved.objects.length &&
            view.objects.every(
              (object, i) =>
                object.kind === saved.objects[i].kind &&
                object.label === saved.objects[i].label,
            )
          ) {
            options.preset = preset;
            break;
          }
        }
        if (!options.preset)
          throw Error(
            'Cannot restore the session environment from its exported preset',
          );
      }
      const made = await E(root).importSession(harden(options));
      const writers = await E(admin).writersFor(made.session);
      current = {
        session: made.session,
        internal: made.internal,
        writers,
        inboxBodies: new Map(),
        chunk: [],
        bytes: CHUNK_SLACK,
        from: 0,
        turns: 0,
        sealed: 0,
      };
      sessions.push(made.session);
      await E(made.internal).importState(
        harden({
          part: 'head',
          usage: head.usage,
          ...(head.execution === undefined
            ? {}
            : { execution: head.execution }),
        }),
      );
    } else if (line.type === 'records') {
      const s = /** @type {NonNullable<typeof current>} */ (current);
      for (const record of line.records) {
        const ready = harden(await staged(record));
        const size = treeBytes(ready);
        if (
          s.chunk.length >= limits.pageRecords ||
          (s.chunk.length > 0 && s.bytes + size > limits.frameBytes)
        ) {
          await flush();
        }
        s.chunk.push(ready);
        s.bytes += size;
        totals.records += 1;
        if (record.kind === 'turn-started') {
          s.turns += 1;
          totals.turns += 1;
        }
      }
    } else if (line.type === 'queue') {
      await flush();
      const s = /** @type {NonNullable<typeof current>} */ (current);
      /** @type {any[]} */
      const entries = [];
      for (const entry of line.entries) {
        const submission =
          utf8(entry.submission.text) > limits.inlineBytes
            ? await stage(s.writers, entry.submission.text)
            : entry.submission;
        entries.push({ ...entry, submission });
      }
      await E(s.internal).importState(
        harden({
          part: 'queue',
          entries,
          ...(line.hold === undefined ? {} : { hold: line.hold }),
        }),
      );
    } else if (line.type === 'inbox') {
      if (current === undefined) throw Error('no import is open for inbox');
      await flush();
      const { writers, internal, inboxBodies } = current;
      /** @type {any[]} handles not yet attached to the importing session */
      const fresh = [];
      try {
        if (
          !Array.isArray(line.messages) ||
          line.messages.length > limits.inboxMessages
        )
          throw Error('invalid inbox page size');
        const messages = [];
        for (const item of line.messages) {
          if (item.body && typeof item.body === 'object' && isText(item.body)) {
            const prior = inboxBodies.get(item.number);
            const body = prior ?? (await stage(writers, item.body.text));
            if (prior === undefined) fresh.push(body.blob);
            messages.push({ ...item, body });
          } else {
            messages.push(item);
          }
        }
        await E(internal).importState(harden({ part: 'inbox', messages }));
        for (const item of messages) inboxBodies.set(item.number, item.body);
      } catch (error) {
        try {
          for (let i = 0; i < fresh.length; i += limits.blobResolveBatch) {
            await E(admin).releaseBlobs(
              harden(fresh.slice(i, i + limits.blobResolveBatch)),
            );
          }
        } finally {
          await abandon(`contains a refused inbox page (${String(error)})`);
        }
      }
    } else if (line.type === 'end') {
      await flush();
      const s = /** @type {NonNullable<typeof current>} */ (current);
      await E(s.internal).importState(harden({ part: 'end' }));
      current = undefined;
    }
  }
  if (current !== undefined) await abandon('ends');
  return {
    sessions,
    ...totals,
    waitMs: Math.round(totals.waitMs),
    ms: Math.round(performance.now() - t0),
  };
};

/** @param {string[]} argv */
const main = async argv => {
  const [command, state, file, ...rest] = argv;
  let workspace = 'w';
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--workspace') {
      i += 1;
      workspace = rest[i];
    } else throw Error(`Unknown option ${rest[i]}`);
  }
  if (!['export', 'import'].includes(command) || !state || !file)
    throw Error('usage: export.mjs export|import STATE FILE [--workspace w]');
  const [{ connectLocalControl }, { makeNodePowers }] = await Promise.all([
    import('@endo/thixotrope/local-control.js'),
    import('@endo/thixotrope/node-powers.js'),
  ]);
  const client = await connectLocalControl(
    makeNodePowers(),
    path.join(path.resolve(state), 'control.sock'),
    { workspace },
  );
  try {
    const result =
      command === 'export'
        ? await exportState({ client, file })
        : await importState({ client, file });
    const { sessions, ...shown } = /** @type {any} */ (result);
    process.stdout.write(
      `${JSON.stringify({ command, ...shown, sessions: Array.isArray(sessions) ? sessions.length : sessions })}\n`,
    );
  } finally {
    client.close();
  }
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
