// @ts-check
/** @import { SyncFilePowers } from '../platform/sync-files.js' */
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';

/**
 * The OCapN hub's state as a write-ahead log of deltas over a full image.
 *
 * The hub hands the store its whole state as one plain record at every
 * commit (`serializeHubState`), and must not send a frame until the state
 * that lets a restart re-send or deduplicate it is durable. The whole-file
 * store meets that by replacing `hub.json` atomically: write a scratch file,
 * fsync it, rename it, fsync the directory, two full syncs and the whole
 * state's bytes per commit, however little changed. This store meets it with
 * one durable append per commit of what changed since the last one, so a
 * commit costs one sync and a size that follows the change, not the state.
 *
 * Files (beside the whole-file store's `hub.json`):
 * - `hub-image.json`: one line,
 *   `{"format":"thixotrope-hub-image","version":1,"through":S,"state":{...}}`,
 *   the full state as of commit S; replaced atomically.
 * - `hub-log.jsonl`: a header line
 *   `{"format":"thixotrope-hub-log","version":1}` (written atomically, with
 *   the image), then one line per commit,
 *   `{"seq":S,"put":{T:{K:V}},"drop":{T:[K]},"replace":{T:{...}}}`: in table
 *   T (a top-level record of the state, such as `refs` or `sessions`), set
 *   entry K to V, delete entry K, or replace the whole table (when the order
 *   of its entries changed, which a put cannot say). Other top-level fields
 *   (`version`) are in `top`; a top-level field that went away is in
 *   `untop`. A table that is new and empty is a `put` with no entries.
 *
 * Recovery reads the image and applies, in order, every log record whose
 * `seq` is greater than the image's `through`; those must be numbered
 * `through + 1`, `through + 2`, ... without a gap. Records at or below
 * `through` are what an interrupted compaction left behind: the image
 * already holds them, and they are skipped. The torn-tail rule: a record is
 * committed exactly when its line, newline included, is in the file. Text
 * after the last newline is an append that a crash interrupted before it
 * returned; the hub sent nothing that depended on it, and it is dropped. Any
 * other line that does not parse, a gap in the numbering, or a log without
 * an image is damage, and opening refuses the directory rather than guess.
 *
 * Compaction writes the image of the commit at hand (in place of its
 * append) and then resets the log to its header, each atomically. A crash
 * between the two leaves an image whose `through` covers every record in
 * the old log, so they are skipped. It runs when the log outgrows
 * `max(compactChars, compactRatio x image)`, after an append that failed
 * (its bytes may be torn on disk, and another append must not join them),
 * after opening found a torn tail or skipped records, and at the first
 * commit of a fresh directory.
 *
 * Migration: a directory with only the whole-file `hub.json` opens with that
 * state as its image, written at once; `hub.json` is then replaced by a
 * marker whose `version` no hub state reader accepts, so an older build
 * refuses the directory ("Incompatible hub state") instead of reading a
 * state that stopped advancing. A crash in between leaves both: the image
 * wins (`hub.json` can only hold the state it was made from) and the marker
 * is written again.
 *
 * Entry order is kept: `getState()` returns the record with the same
 * top-level, table and entry order as the last one committed, as the
 * whole-file store's `JSON.parse` would (the hub restores its maps in that
 * order, and iterates them when it releases and retires).
 *
 * The store must be the directory's only writer (the daemon's lease).
 *
 * @param {SyncFilePowers} syncFiles
 * @param {object} paths
 * @param {string} paths.imagePath
 * @param {string} paths.logPath
 * @param {string} paths.legacyPath the whole-file store's `hub.json`
 * @param {object} [options]
 * @param {number} [options.compactChars] the log never compacts below this
 *   size (default 1 MiB)
 * @param {number} [options.compactRatio] nor below this many times the
 *   image (default 2)
 */
export const makeHubLogStore = (
  syncFiles,
  { imagePath, logPath, legacyPath },
  { compactChars = 1_048_576, compactRatio = 2 } = {},
) => {
  const IMAGE_FORMAT = 'thixotrope-hub-image';
  const LOG_FORMAT = 'thixotrope-hub-log';
  const FORMAT_VERSION = 1;
  const LOG_HEADER = `${JSON.stringify({ format: LOG_FORMAT, version: FORMAT_VERSION })}\n`;
  const MARKER_VERSION = 'hub-log';
  const MARKER = `${JSON.stringify({
    version: MARKER_VERSION,
    note: 'The hub state moved to hub-image.json and hub-log.jsonl. A build without the hub log cannot open this directory.',
  })}\n`;

  /**
   * What is durable, as JSON text per entry: top-level field order, each
   * table's entries in order, and the other top-level fields.
   *
   * @typedef {{ order: Array<string>, tables: Map<string, Map<string, string>>, scalars: Map<string, string> }} Image
   */

  /** @type {Image | undefined} */
  let image;
  /** The last commit number durable (or attempted, after a failure). */
  let seq = 0;
  let imageChars = 0;
  let logChars = 0;
  let logRecords = 0;
  /** The next commit must rewrite the image: see compaction above. */
  let compactNext = false;
  let loaded = false;

  const counters = {
    appends: 0,
    appendChars: 0,
    compactions: 0,
    compactionChars: 0,
    unchanged: 0,
    replacedTables: 0,
    recoveredRecords: 0,
    droppedTail: 0,
    skippedRecords: 0,
    migrated: 0,
  };

  /** @param {unknown} value */
  const isTable = value =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  /**
   * @param {any} state
   * @returns {Image}
   */
  const imageOf = state => {
    isTable(state) || Fail`Hub state must be a record`;
    /** @type {Image} */
    const next = { order: [], tables: new Map(), scalars: new Map() };
    for (const [name, value] of Object.entries(state)) {
      next.order.push(name);
      if (isTable(value)) {
        next.tables.set(
          name,
          new Map(
            Object.entries(value).map(([key, entry]) => [
              key,
              JSON.stringify(entry),
            ]),
          ),
        );
      } else {
        next.scalars.set(name, JSON.stringify(value));
      }
    }
    return next;
  };

  /**
   * The state's JSON text, from the image's entry texts.
   * @param {Image} from
   */
  const stateText = from =>
    `{${from.order
      .map(name => {
        const table = from.tables.get(name);
        const body =
          table === undefined
            ? /** @type {string} */ (from.scalars.get(name))
            : `{${[...table].map(([key, text]) => `${JSON.stringify(key)}:${text}`).join(',')}}`;
        return `${JSON.stringify(name)}:${body}`;
      })
      .join(',')}}`;

  /**
   * Write `next` as the image of commit `through` and reset the log.
   * @param {Image} next
   * @param {number} through
   */
  const compact = (next, through) => {
    const text = `{"format":${JSON.stringify(IMAGE_FORMAT)},"version":${FORMAT_VERSION},"through":${through},"state":${stateText(next)}}\n`;
    // Until both writes return, a failure leaves the next commit to compact.
    compactNext = true;
    syncFiles.writeTextAtomic(imagePath, text);
    syncFiles.writeTextAtomic(logPath, LOG_HEADER);
    compactNext = false;
    image = next;
    imageChars = text.length;
    logChars = LOG_HEADER.length;
    logRecords = 0;
    counters.compactions += 1;
    counters.compactionChars += text.length + LOG_HEADER.length;
    return text.length + LOG_HEADER.length;
  };

  /**
   * Apply one log record to `target` in place.
   * @param {Image} target
   * @param {any} record
   */
  const applyRecord = (target, record) => {
    for (const name of record.untop ?? []) {
      target.order = target.order.filter(n => n !== name);
      target.tables.delete(name);
      target.scalars.delete(name);
    }
    /** @param {string} name */
    const place = name => {
      if (!target.order.includes(name)) target.order.push(name);
    };
    for (const [name, value] of Object.entries(record.top ?? {})) {
      place(name);
      target.tables.delete(name);
      target.scalars.set(name, JSON.stringify(value));
    }
    for (const [name, value] of Object.entries(record.replace ?? {})) {
      place(name);
      target.scalars.delete(name);
      target.tables.set(
        name,
        new Map(
          Object.entries(/** @type {any} */ (value)).map(([key, entry]) => [
            key,
            JSON.stringify(entry),
          ]),
        ),
      );
    }
    for (const [name, keys] of Object.entries(record.drop ?? {})) {
      const table = target.tables.get(name);
      if (table !== undefined)
        for (const key of /** @type {Array<string>} */ (keys))
          table.delete(key);
    }
    for (const [name, entries] of Object.entries(record.put ?? {})) {
      place(name);
      target.scalars.delete(name);
      let table = target.tables.get(name);
      if (table === undefined) {
        table = new Map();
        target.tables.set(name, table);
      }
      for (const [key, entry] of Object.entries(/** @type {any} */ (entries))) {
        table.set(key, JSON.stringify(entry));
      }
    }
    // Restore top-level order as the record states it, when it states it.
    if (record.order) target.order = [...record.order];
  };

  /**
   * @param {string} path
   * @returns {{ value: any, length: number }}
   */
  const parseWhole = path => {
    const text = syncFiles.readText(path);
    try {
      return { value: JSON.parse(text), length: text.length };
    } catch (error) {
      throw Error(
        `Hub state ${q(path)} is damaged (${/** @type {Error} */ (error).message}); restore it from a backup or use a fresh state directory`,
        { cause: error },
      );
    }
  };

  const load = () => {
    if (loaded) return;
    const hasImage = syncFiles.exists(imagePath);
    const hasLog = syncFiles.exists(logPath);
    const legacy = syncFiles.exists(legacyPath)
      ? parseWhole(legacyPath).value
      : undefined;
    const legacyIsMarker = legacy?.version === MARKER_VERSION;
    if (!hasImage) {
      if (hasLog)
        throw Error(
          `Hub log ${q(logPath)} has no image ${q(imagePath)}; this store never writes one without the other, so the directory is damaged`,
        );
      if (legacyIsMarker)
        throw Error(
          `Hub state ${q(legacyPath)} says it moved to the hub log, but ${q(imagePath)} is missing; the directory is damaged`,
        );
      loaded = true;
      if (legacy !== undefined) {
        // Migration from the whole-file store: the image first, then the
        // marker, so no crash leaves the state only in a file a later
        // open ignores.
        compact(imageOf(legacy), 0);
        syncFiles.writeTextAtomic(legacyPath, MARKER);
        counters.migrated += 1;
      }
      return;
    }
    const { value: head, length: headLength } = parseWhole(imagePath);
    (head.format === IMAGE_FORMAT && head.version === FORMAT_VERSION) ||
      Fail`Hub image ${q(imagePath)} has format ${q(head.format)} version ${q(head.version)}; this build reads ${q(IMAGE_FORMAT)} version ${q(FORMAT_VERSION)}`;
    Number.isSafeInteger(head.through) ||
      Fail`Hub image ${q(imagePath)} has no commit number`;
    const recovered = imageOf(head.state);
    let needsCompaction = false;
    let durableLogChars = 0;
    let records = 0;
    let last = head.through;
    if (hasLog) {
      const text = syncFiles.readText(logPath);
      const end = text.lastIndexOf('\n') + 1;
      if (end < text.length) {
        // The torn tail: an append a crash cut short.
        counters.droppedTail += 1;
        needsCompaction = true;
      }
      const lines = text.slice(0, end).split('\n');
      lines.pop();
      const header = lines.length > 0 ? lines[0] : '';
      `${header}\n` === LOG_HEADER ||
        Fail`Hub log ${q(logPath)} does not start with this build's header ${q(LOG_HEADER.trim())}`;
      for (let i = 1; i < lines.length; i += 1) {
        /** @type {any} */
        let record;
        try {
          record = JSON.parse(lines[i]);
        } catch (error) {
          throw Error(
            `Hub log ${q(logPath)} record ${i} is damaged (${/** @type {Error} */ (error).message}); a complete line is never torn, so the directory is damaged`,
            { cause: error },
          );
        }
        Number.isSafeInteger(record.seq) ||
          Fail`Hub log ${q(logPath)} record ${i} has no commit number`;
        if (Number(record.seq) <= Number(head.through)) {
          // Left by a compaction a crash interrupted: in the image already.
          counters.skippedRecords += 1;
          needsCompaction = true;
        } else {
          record.seq === last + 1 ||
            Fail`Hub log ${q(logPath)} skips from commit ${last} to ${record.seq}`;
          applyRecord(recovered, record);
          last = record.seq;
          records += 1;
          counters.recoveredRecords += 1;
        }
      }
      durableLogChars = end;
    } else {
      // A compaction a crash interrupted after its image.
      needsCompaction = true;
    }
    // Entry order as a record has it (integer-like keys first), as the
    // state the hub committed had it: the next delta compares against it.
    image = imageOf(JSON.parse(stateText(recovered)));
    seq = last;
    imageChars = headLength;
    logChars = durableLogChars;
    logRecords = records;
    loaded = true;
    if (needsCompaction) compactNext = true;
    if (legacy !== undefined && !legacyIsMarker) {
      // A migration a crash interrupted after its image.
      syncFiles.writeTextAtomic(legacyPath, MARKER);
    }
  };

  /**
   * The record taking `image` to `state`, as JSON text, or undefined when
   * nothing changed; and the image it makes.
   * @param {Image} from
   * @param {any} state
   */
  const deltaOf = (from, state) => {
    isTable(state) || Fail`Hub state must be a record`;
    const next = imageOf(state);
    /** @type {Array<string>} */
    const parts = [];
    /** @type {Array<string>} */
    const put = [];
    /** @type {Array<string>} */
    const drop = [];
    /** @type {Array<string>} */
    const replace = [];
    /** @type {Array<string>} */
    const top = [];
    const untop = from.order.filter(name => !next.order.includes(name));
    /** @param {Map<string, string>} table */
    const tableText = table =>
      `{${[...table].map(([key, entryText]) => `${JSON.stringify(key)}:${entryText}`).join(',')}}`;
    /**
     * @param {string} name
     * @param {Map<string, string>} table
     */
    const diffTable = (name, table) => {
      const before = from.tables.get(name);
      if (before === undefined) {
        put.push(`${JSON.stringify(name)}:${tableText(table)}`);
        return;
      }
      // A put keeps a surviving entry where it was and appends a new one:
      // when the surviving entries moved, or a new one is not after all of
      // them, only the whole table says so.
      const kept = [...before.keys()].filter(key => table.has(key));
      let moved = false;
      let k = 0;
      let added = false;
      for (const key of table.keys()) {
        if (before.has(key)) {
          if (added || kept[k] !== key) {
            moved = true;
            break;
          }
          k += 1;
        } else {
          added = true;
        }
      }
      if (moved) {
        counters.replacedTables += 1;
        replace.push(`${JSON.stringify(name)}:${tableText(table)}`);
        return;
      }
      const changed = new Map(
        [...table].filter(([key, entryText]) => before.get(key) !== entryText),
      );
      if (changed.size > 0)
        put.push(`${JSON.stringify(name)}:${tableText(changed)}`);
      const gone = [...before.keys()].filter(key => !table.has(key));
      if (gone.length > 0)
        drop.push(`${JSON.stringify(name)}:${JSON.stringify(gone)}`);
    };
    for (const name of next.order) {
      const table = next.tables.get(name);
      if (table !== undefined) {
        diffTable(name, table);
      } else {
        const scalarText = /** @type {string} */ (next.scalars.get(name));
        if (from.scalars.get(name) !== scalarText)
          top.push(`${JSON.stringify(name)}:${scalarText}`);
      }
    }
    // A put appends a new top-level field: say so when it was elsewhere.
    const expected = [
      ...from.order.filter(name => next.order.includes(name)),
      ...next.order.filter(name => !from.order.includes(name)),
    ];
    const orderChanged = expected.some((name, i) => next.order[i] !== name);
    if (
      put.length + drop.length + replace.length + top.length + untop.length ===
        0 &&
      !orderChanged
    )
      return { text: undefined, next };
    if (untop.length > 0) parts.push(`"untop":${JSON.stringify(untop)}`);
    if (top.length > 0) parts.push(`"top":{${top.join(',')}}`);
    if (replace.length > 0) parts.push(`"replace":{${replace.join(',')}}`);
    if (drop.length > 0) parts.push(`"drop":{${drop.join(',')}}`);
    if (put.length > 0) parts.push(`"put":{${put.join(',')}}`);
    if (orderChanged) parts.push(`"order":${JSON.stringify(next.order)}`);
    return { text: parts.join(','), next };
  };

  return harden({
    getState: () => {
      load();
      return image === undefined ? undefined : JSON.parse(stateText(image));
    },
    /**
     * Durable when it returns: one append, or a compaction.
     * @param {any} state
     * @returns {number} the characters written
     */
    setState: state => {
      load();
      if (image === undefined || compactNext) {
        seq += 1;
        return compact(imageOf(state), seq);
      }
      const { text, next } = deltaOf(image, state);
      if (text === undefined) {
        counters.unchanged += 1;
        return 0;
      }
      seq += 1;
      const line = `{"seq":${seq},${text}}\n`;
      if (
        logChars + line.length >
        Math.max(compactChars, compactRatio * imageChars)
      )
        return compact(next, seq);
      try {
        syncFiles.appendTextDurable(logPath, line);
      } catch (error) {
        // Some of the line may be on disk: never append after it.
        compactNext = true;
        throw error;
      }
      image = next;
      logChars += line.length;
      logRecords += 1;
      counters.appends += 1;
      counters.appendChars += line.length;
      return line.length;
    },
    stats: () =>
      harden({
        kind: 'log',
        ...counters,
        seq,
        imageChars,
        logChars,
        logRecords,
      }),
  });
};
harden(makeHubLogStore);
