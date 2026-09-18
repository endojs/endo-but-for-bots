// @ts-check
import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { passStyleOf } from '@endo/pass-style';

const PREFIX = 'floot-turn-event-';
const CONTENT_PREFIX = 'floot-turn-content-';
const SNAPSHOT_PREFIX = 'floot-turn-snapshot-';
const ARCHIVE_PREFIX = 'floot-turn-archive-';
const SNAPSHOT_VERSION = 1;

/**
 * Bounds, and what each one protects.
 *
 * There is no journal-lifetime ceiling. The journal used to refuse its
 * 10,001st event, which made a long healthy session end in "capacity
 * exhausted" and needed operator archival. What that ceiling bounded was the
 * replay — every event read back into memory at every start — and the
 * resident record map that held every turn's full text. Both are bounded
 * below by construction, so the ceiling had nothing left to protect.
 *
 * `MAX_EVENT_SIZE` bounds one stored event. Every text field is cut to
 * `PREVIEW_CHARS` before the event is written, with the full text stored as
 * its own value and referenced, so an event never approaches this by the
 * writer's own construction; the bound is what a replay refuses if storage
 * hands back something the writer could not have produced.
 *
 * `MAX_CONTENT_CHARS` bounds one content value. A value is one JSON document
 * the daemon holds whole while it is marshalled to storage and back, so this
 * is the same 16 Mi figure the bounded readers use for a resident frame — a
 * storage-value bound, not an output ceiling: a tool result larger than this
 * is refused at the call, which fails one tool call rather than the session.
 *
 * `RETAINED_TURNS` bounds the record map. Settled turns beyond it are moved
 * to archive chunks in storage and read back only on request; a turn with an
 * unresolved outcome is never archived, because it is the evidence recovery
 * needs in front of it.
 *
 * `SNAPSHOT_EVERY` bounds replay. A snapshot is the record map at an event
 * sequence; replay reads the newest snapshot and only the events after it.
 *
 * Nothing the conversation wrote is ever removed here. Events, content
 * values and archive chunks are the transcript, and the transcript is kept
 * until the session itself is removed in Endo and collected; a snapshot is a
 * derived accelerator, so the only value this journal ever discards is a
 * snapshot a newer one has superseded. Storage grows with the conversation
 * — that is what keeping it means — while memory and replay do not.
 */
const MAX_EVENT_SIZE = 131_072;
const PREVIEW_CHARS = 8192;
const MAX_CONTENT_CHARS = 16 * 1024 * 1024;
const RETAINED_TURNS = 256;
const SNAPSHOT_EVERY = 64;
const ARCHIVE_CHUNK_TURNS = 256;

/** Text fields an event may carry that are externalized when large. */
const CONTENT_FIELDS = harden({
  dispatch: harden(['input']),
  'tool-intent': harden(['args']),
  'observed-tool-call': harden(['args']),
  'tool-result': harden(['result']),
  'observed-tool-result': harden(['result']),
  finish: harden(['output', 'error']),
  resolve: harden([]),
});

/**
 * Copy only inert JSON data, never Error objects, promises, or capabilities.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {any}
 */
const copyData = (value, depth = 0) => {
  depth <= 20 || Fail`Turn journal data nesting exceeds its storage profile`;
  if (value === undefined) return undefined;
  const style = passStyleOf(harden(value));
  if (style === 'null' || style === 'boolean' || style === 'string')
    return value;
  if (style === 'number' && Number.isFinite(value)) return value;
  if (style === 'copyArray') {
    return /** @type {unknown[]} */ (value).map(item =>
      copyData(item, depth + 1),
    );
  }
  if (style === 'copyRecord') {
    return Object.fromEntries(
      Object.entries(/** @type {Record<string, unknown>} */ (value))
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, copyData(item, depth + 1)]),
    );
  }
  throw Fail`Turn journal accepts only inert JSON data`;
};

/**
 * @param {unknown} value
 * @param {number} [limit]
 * @param {boolean} [allowEmpty]
 */
const assertText = (value, limit = 1024, allowEmpty = false) => {
  (typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= limit) ||
    Fail`Invalid turn journal text field`;
};

/** @param {bigint | number} sequence */
const pad = sequence => `${sequence}`.padStart(20, '0');

/** @param {string} name */
const sequenceOf = name => BigInt(name.slice(name.lastIndexOf('-') + 1));

/**
 * A content reference as a record carries it: where the full text is, and
 * how long it is, beside the preview that replaced it.
 *
 * @param {unknown} ref
 */
const assertContentRef = ref => {
  const { name, chars } = /** @type {{ name?: unknown, chars?: unknown }} */ (
    typeof ref === 'object' && ref !== null ? ref : {}
  );
  (typeof name === 'string' &&
    new RegExp(`^${CONTENT_PREFIX}\\d{20}-[a-z]+$`).test(name) &&
    typeof chars === 'number' &&
    Number.isSafeInteger(chars) &&
    chars > PREVIEW_CHARS) ||
    Fail`Invalid turn journal content reference`;
  return /** @type {{ name: string, chars: number }} */ ({ name, chars });
};

/**
 * Append-only, single-writer journal scoped to one Floot agent's powers.
 * Storage failure is ambiguous: this incarnation is permanently poisoned.
 * A new incarnation replays from the newest snapshot and preserves unresolved
 * outcomes. All operations are serialized, including reads and
 * acknowledgements.
 *
 * Storage holds four kinds of value, each immutable once written:
 * `floot-turn-event-<seq>` for events not yet covered by a snapshot,
 * `floot-turn-content-<seq>-<field>` for text a record refers to rather than
 * carries, `floot-turn-snapshot-<seq>` for the record map as of that event,
 * and `floot-turn-archive-<n>` for settled turns beyond the retained window.
 *
 * @param {any} powers
 * @param {{ migration?: any }} [options]
 */
export const makeTurnJournal = (powers, { migration } = {}) => {
  /** @type {Map<string, any>} */
  const records = new Map();
  let next = 1n;
  // The event sequence the current snapshot covers, and its storage name.
  let through = 0n;
  /** @type {string | undefined} */
  let snapshotName;
  let sinceSnapshot = 0;
  let archivedTurns = 0;
  let archiveChunks = 0;
  /** @type {Set<string>} */
  let names = new Set();
  let initialized = false;
  let poisoned = false;
  let queue = Promise.resolve();
  let migrationStatus = {
    required: false,
    resolution: /** @type {string | undefined} */ (undefined),
  };

  /**
   * @param {any} event
   * @param {bigint} sequence
   * @param {boolean} recovered
   */
  const prepare = (event, sequence, recovered) => {
    const { type, turnId } = event;
    // A replayed event may predate content references, when a field could
    // fill the whole event; a new one is cut to a preview before it is written.
    const textLimit = recovered ? MAX_EVENT_SIZE : PREVIEW_CHARS;
    if (type === 'dispatch') {
      turnId === `${sequence}` || Fail`Invalid turn journal dispatch ID`;
      !records.has(turnId) || Fail`Duplicate turn journal dispatch`;
      assertText(event.input, textLimit, true);
      assertText(event.backendId);
      assertText(event.modelId, 1024, true);
      if (event.reasoningEffort !== undefined)
        assertText(event.reasoningEffort);
      if (event.inputRef !== undefined) assertContentRef(event.inputRef);
      const record = {
        turnId,
        input: event.input,
        ...(event.inputRef === undefined ? {} : { inputRef: event.inputRef }),
        backendId: event.backendId,
        modelId: event.modelId,
        ...(event.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: event.reasoningEffort }),
        state: recovered ? 'outcome-unknown' : 'pending',
        tools: [],
        // Provider-native activity is observed after the fact, not a claim
        // that Floot durably authorized the effect before execution.
        activity: [],
      };
      return () => {
        records.set(turnId, record);
      };
    }
    const record = records.get(turnId);
    record || Fail`Unknown turn journal turn`;
    if (type === 'tool-intent' || type === 'observed-tool-call') {
      !record.terminal || Fail`Tool intent after terminal turn`;
      recovered ||
        record.state === 'pending' ||
        Fail`Cannot dispatch tools for a recovered turn`;
      assertText(event.callId);
      assertText(event.name);
      // Arguments are recorded as the text the caller serialized; a record
      // that carries them structured is inert data already and stays so.
      if (typeof event.args === 'string')
        assertText(event.args, textLimit, true);
      if (event.argsRef !== undefined) assertContentRef(event.argsRef);
      const calls = type === 'tool-intent' ? record.tools : record.activity;
      !calls.some(tool => tool.callId === event.callId) ||
        Fail`Duplicate tool journal call ID`;
      const tool = {
        callId: event.callId,
        name: event.name,
        args: event.args,
        ...(event.argsRef === undefined ? {} : { argsRef: event.argsRef }),
      };
      return () => {
        calls.push(tool);
      };
    } else if (type === 'tool-result' || type === 'observed-tool-result') {
      const calls = type === 'tool-result' ? record.tools : record.activity;
      const tool = calls.find(item => item.callId === event.callId);
      tool || Fail`Tool result without intent`;
      !tool.settled || Fail`Duplicate tool journal result`;
      if (typeof event.result === 'string')
        assertText(event.result, textLimit, true);
      if (event.resultRef !== undefined) assertContentRef(event.resultRef);
      return () => {
        tool.result = event.result;
        if (event.resultRef !== undefined) tool.resultRef = event.resultRef;
        tool.settled = true;
      };
    } else if (type === 'finish') {
      !record.terminal || Fail`Duplicate terminal turn journal event`;
      for (const key of ['output', 'error', 'conversationNodeId']) {
        if (event[key] !== undefined) assertText(event[key], textLimit, true);
      }
      for (const key of ['outputRef', 'errorRef']) {
        if (event[key] !== undefined) assertContentRef(event[key]);
      }
      ['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(
        event.state,
      ) || Fail`Invalid terminal turn journal state`;
      const state =
        record.tools.some(tool => !tool.settled) ||
        record.activity.some(tool => !tool.settled)
          ? 'outcome-unknown'
          : event.state;
      return () => {
        record.terminal = true;
        record.state = state;
        record.reportedState = event.state;
        for (const key of [
          'output',
          'outputRef',
          'error',
          'errorRef',
          'usage',
          'conversationNodeId',
        ]) {
          if (event[key] !== undefined) record[key] = event[key];
        }
      };
    } else if (type === 'resolve') {
      record.state === 'outcome-unknown' ||
        Fail`Only unknown outcomes need resolution`;
      !record.resolution || Fail`Turn outcome already resolved`;
      assertText(event.note, 8192);
      return () => {
        record.resolution = event.note;
      };
    } else {
      throw Fail`Unknown turn journal event type`;
    }
  };

  /** A settled turn needs nothing in front of recovery; it may be archived. */
  const archivable = record =>
    record.terminal === true &&
    (record.state !== 'outcome-unknown' || record.resolution !== undefined);

  /** @param {unknown} snapshot */
  const loadSnapshot = snapshot => {
    const data = copyData(snapshot);
    const counts = [data?.archivedTurns, data?.archiveChunks];
    (data &&
      typeof data === 'object' &&
      data.version === SNAPSHOT_VERSION &&
      typeof data.through === 'string' &&
      /^\d+$/.test(data.through) &&
      Array.isArray(data.records) &&
      counts.every(
        count =>
          typeof count === 'number' &&
          Number.isSafeInteger(count) &&
          count >= 0,
      )) ||
      Fail`Invalid turn journal snapshot`;
    for (const record of data.records) {
      (record &&
        typeof record.turnId === 'string' &&
        /^\d+$/.test(record.turnId) &&
        !records.has(record.turnId)) ||
        Fail`Invalid turn journal snapshot record`;
      // A turn the snapshotting incarnation still had in flight is one this
      // incarnation cannot finish; a later event may still settle it.
      if (record.state === 'pending') record.state = 'outcome-unknown';
      records.set(record.turnId, record);
    }
    through = BigInt(data.through);
    next = through + 1n;
    archivedTurns = data.archivedTurns;
    archiveChunks = data.archiveChunks;
  };

  const initialize = async () => {
    if (initialized) return;
    if (migration) migrationStatus = await E(migration).status();
    names = new Set(
      (await E(powers).list()).filter(name => typeof name === 'string'),
    );
    // The newest snapshot is the one to trust: an older one left behind by a
    // crash between writing the new one and removing the old is a stale copy
    // of the same immutable history.
    const snapshots = [...names]
      .filter(name => name.startsWith(SNAPSHOT_PREFIX))
      .sort();
    if (snapshots.length > 0) {
      snapshotName = snapshots[snapshots.length - 1];
      loadSnapshot(await E(powers).lookup(snapshotName));
    }
    const journalNames = [...names]
      .filter(name => name.startsWith(PREFIX) && sequenceOf(name) > through)
      .sort();
    for (const name of journalNames) {
      name === `${PREFIX}${pad(next)}` ||
        Fail`Turn journal sequence is missing or malformed`;
      // Sequential reads cap transient memory while preserving event order.
      // eslint-disable-next-line no-await-in-loop
      const event = copyData(await E(powers).lookup(name));
      JSON.stringify(event).length <= MAX_EVENT_SIZE ||
        Fail`Turn journal event too large`;
      prepare(event, next, true)();
      next += 1n;
    }
    sinceSnapshot = journalNames.length;
    initialized = true;
  };

  /** @param {() => Promise<any>} operation */
  const serialized = operation => {
    const result = queue.then(async () => {
      !poisoned ||
        Fail`Turn journal unavailable after an uncertain storage operation`;
      try {
        await initialize();
      } catch (error) {
        poisoned = true;
        throw error;
      }
      return operation();
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const assertUnfenced = () => {
    !migrationStatus.required ||
      migrationStatus.resolution ||
      Fail`Verify the imported legacy journal before dispatching another turn`;
    // Unknown historical effects are evidence, not a session-wide admission
    // lock. New work gets a new dispatch; nothing here retries the old one.
    // Storage poison and live runtime containment are independent barriers.
  };

  /**
   * Store one value. Any failure is ambiguous — the value may or may not have
   * landed — so it poisons this incarnation, exactly as an event write does.
   *
   * @param {unknown} value
   * @param {string} name
   */
  const store = async (value, name) => {
    try {
      await E(powers).storeValue(value, name);
    } catch (error) {
      poisoned = true;
      throw error;
    }
    names.add(name);
  };

  /**
   * Remove a derived value a newer one supersedes: a superseded snapshot, or
   * an archive chunk a crash left uncounted. Never an event or content value.
   * A failure here leaves a harmless extra value and is not ambiguous about
   * the history, so it does not poison.
   *
   * @param {string} name
   */
  const discard = async name => {
    await null;
    try {
      await E(powers).remove(name);
      names.delete(name);
    } catch {
      // Left for the next snapshot to try again.
    }
  };

  /**
   * Move the oldest settled turns beyond the retained window into an archive
   * chunk. Returns true if the record map changed.
   */
  const archive = async () => {
    const settled = [...records.values()]
      .filter(archivable)
      .sort((a, b) => (BigInt(a.turnId) < BigInt(b.turnId) ? -1 : 1));
    if (settled.length <= RETAINED_TURNS) return false;
    const excess = settled.slice(
      0,
      Math.min(settled.length - RETAINED_TURNS, ARCHIVE_CHUNK_TURNS),
    );
    const name = `${ARCHIVE_PREFIX}${pad(archiveChunks)}`;
    // A chunk of this index can already exist only if a previous incarnation
    // wrote it and then failed before the snapshot that would have counted
    // it; the snapshot in force says it is not part of the history.
    if (names.has(name)) await discard(name);
    // Stored as a detached copy: hardening the live records would freeze
    // the map's own objects against the events still to come.
    await store(
      harden({
        version: SNAPSHOT_VERSION,
        records: JSON.parse(JSON.stringify(excess)),
      }),
      name,
    );
    for (const record of excess) records.delete(record.turnId);
    archiveChunks += 1;
    archivedTurns += excess.length;
    return true;
  };

  /**
   * Write the record map as of the last event. Ordered so that a crash at any
   * point leaves a replayable history: the chunk before the snapshot that
   * counts it, the new snapshot before the old one goes. The events it covers
   * stay where they are; they are simply not read again.
   */
  const snapshot = async () => {
    await archive();
    const covered = next - 1n;
    const name = `${SNAPSHOT_PREFIX}${pad(covered)}`;
    await store(
      harden({
        version: SNAPSHOT_VERSION,
        through: `${covered}`,
        records: JSON.parse(JSON.stringify([...records.values()])),
        archivedTurns,
        archiveChunks,
      }),
      name,
    );
    snapshotName = name;
    through = covered;
    sinceSnapshot = 0;
    for (const stale of [...names]) {
      if (stale.startsWith(SNAPSHOT_PREFIX) && stale !== name) {
        // eslint-disable-next-line no-await-in-loop
        await discard(stale);
      }
    }
  };

  /**
   * Cut each large text field to a preview and store the full text as its own
   * value, referenced from the event. Content is written before the event
   * that refers to it, so a crash between the two leaves an unreferenced
   * value rather than a reference to nothing.
   *
   * @param {any} event
   * @param {bigint} sequence
   */
  const externalize = async (event, sequence) => {
    const fields = CONTENT_FIELDS[event.type] || [];
    let result = event;
    for (const field of fields) {
      const text = event[field];
      if (typeof text === 'string') {
        text.length <= MAX_CONTENT_CHARS ||
          Fail`Turn journal ${q(field)} exceeds the ${q(MAX_CONTENT_CHARS)}-character storage value bound`;
        if (text.length > PREVIEW_CHARS) {
          const name = `${CONTENT_PREFIX}${pad(sequence)}-${field}`;
          // eslint-disable-next-line no-await-in-loop
          await store(text, name);
          result = {
            ...result,
            [field]: text.slice(0, PREVIEW_CHARS),
            [`${field}Ref`]: { name, chars: text.length },
          };
        }
      }
    }
    return result;
  };

  /** @param {any} value */
  const write = async value => {
    const event = harden(await externalize(copyData(value), next));
    JSON.stringify(event).length <= MAX_EVENT_SIZE ||
      Fail`Turn journal event too large`;
    // Validate without mutating or copying the session's accumulated history.
    // The serialized operation retains this commit until storage acknowledges
    // the immutable event. No other operation can change its target meanwhile.
    const commit = prepare(event, next, false);
    await store(event, `${PREFIX}${pad(next)}`);
    commit();
    next += 1n;
    sinceSnapshot += 1;
    if (sinceSnapshot >= SNAPSHOT_EVERY) await snapshot();
  };

  return harden({
    /** @param {{ input: string, backendId: string, modelId: string, reasoningEffort?: string }} options */
    begin: options =>
      serialized(async () => {
        assertUnfenced();
        ![...records.values()].some(record => record.state === 'pending') ||
          Fail`A turn is already active`;
        const turnId = `${next}`;
        await write({ ...options, type: 'dispatch', turnId });
        return turnId;
      }),
    /**
     * @param {string} turnId
     * @param {any} event
     */
    append: (turnId, event) =>
      serialized(async () => {
        [
          'tool-intent',
          'tool-result',
          'observed-tool-call',
          'observed-tool-result',
          'finish',
        ].includes(event.type) || Fail`Invalid appended turn journal event`;
        await write({ ...event, turnId });
      }),
    /** @param {string} turnId */
    get: turnId =>
      serialized(async () => {
        const record = records.get(turnId);
        record || Fail`Unknown turn journal turn`;
        return harden(JSON.parse(JSON.stringify(record)));
      }),
    /**
     * The retained records: every turn with an unresolved outcome, and the
     * most recent settled ones. Older settled turns are in `listArchived`.
     */
    list: () =>
      serialized(async () =>
        harden(
          JSON.parse(
            JSON.stringify([
              ...(migrationStatus.required
                ? [
                    {
                      turnId: 'legacy-import',
                      input: 'Verify imported legacy journal evidence',
                      backendId: 'migration',
                      modelId: '',
                      state: 'outcome-unknown',
                      terminal: true,
                      tools: [],
                      activity: [],
                      error:
                        'This journal was imported from model-writable storage. Independently verify external effects before acknowledging; imported records are not authenticated evidence.',
                      ...(migrationStatus.resolution
                        ? { resolution: migrationStatus.resolution }
                        : {}),
                    },
                  ]
                : []),
              ...records.values(),
            ]),
          ),
        ),
      ),
    /**
     * Settled turns beyond the retained window, oldest first, read from
     * storage on request rather than held in memory.
     */
    listArchived: () =>
      serialized(async () => {
        const archived = [];
        for (let index = 0; index < archiveChunks; index += 1) {
          const name = `${ARCHIVE_PREFIX}${pad(index)}`;
          // eslint-disable-next-line no-await-in-loop
          const chunk = copyData(await E(powers).lookup(name));
          (chunk?.version === SNAPSHOT_VERSION &&
            Array.isArray(chunk.records)) ||
            Fail`Invalid turn journal archive chunk`;
          archived.push(...chunk.records);
        }
        return harden(archived);
      }),
    /**
     * The full text a record refers to. A reference is data a record carries,
     * not a capability: only names this journal wrote resolve.
     *
     * @param {{ name: string, chars: number }} ref
     */
    readContent: ref =>
      serialized(async () => {
        const { name, chars } = assertContentRef(ref);
        names.has(name) || Fail`Unknown turn journal content`;
        const text = await E(powers).lookup(name);
        (typeof text === 'string' && text.length === chars) ||
          Fail`Turn journal content does not match its reference`;
        return /** @type {string} */ (text);
      }),
    status: () =>
      serialized(async () =>
        harden({
          usedEvents: `${next - 1n}`,
          retainedTurns: records.size,
          archivedTurns,
        }),
      ),
    assertReady: () =>
      serialized(async () => {
        assertUnfenced();
      }),
    /**
     * @param {string} turnId
     * @param {string} note
     */
    resolve: (turnId, note) =>
      serialized(async () => {
        if (turnId === 'legacy-import') {
          (migrationStatus.required && !migrationStatus.resolution) ||
            Fail`No unresolved legacy journal import`;
          assertText(note, 8192);
          note.trim().length > 0 || Fail`Resolution note must not be blank`;
          try {
            await E(migration).resolve(note);
          } catch (error) {
            poisoned = true;
            throw error;
          }
          migrationStatus = { required: true, resolution: note };
          return;
        }
        assertText(note, 8192);
        note.trim().length > 0 || Fail`Resolution note must not be blank`;
        await write({ type: 'resolve', turnId, note });
      }),
  });
};
harden(makeTurnJournal);
