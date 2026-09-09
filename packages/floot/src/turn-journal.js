// @ts-check
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { passStyleOf } from '@endo/pass-style';

const PREFIX = 'floot-turn-event-';
// This storage profile bounds reconstruction to 10,000 immutable events and
// each event to 128 Ki UTF-16 code units. Exhaustion needs operator archival,
// never deletion or a fallback to a newer, incomplete snapshot.
const MAX_EVENTS = 10_000n;
const MAX_EVENT_SIZE = 131_072;

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

/**
 * Append-only, single-writer journal scoped to one Floot agent's powers.
 * Storage failure is ambiguous: this incarnation is permanently poisoned.
 * A new incarnation replays every event and fences unresolved outcomes.
 * All operations are serialized, including reads and acknowledgements.
 * @param {any} powers
 */
export const makeTurnJournal = powers => {
  /** @type {Map<string, any>} */
  const records = new Map();
  let next = 1n;
  let initialized = false;
  let poisoned = false;
  let queue = Promise.resolve();

  /**
   * @param {any} event
   * @param {bigint} sequence
   * @param {boolean} recovered
   */
  const apply = (event, sequence, recovered) => {
    const { type, turnId } = event;
    if (type === 'dispatch') {
      turnId === `${sequence}` || Fail`Invalid turn journal dispatch ID`;
      !records.has(turnId) || Fail`Duplicate turn journal dispatch`;
      assertText(event.input, MAX_EVENT_SIZE, true);
      assertText(event.backendId);
      assertText(event.modelId, 1024, true);
      if (event.reasoningEffort !== undefined)
        assertText(event.reasoningEffort);
      records.set(turnId, {
        turnId,
        input: event.input,
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
      });
      return;
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
      const calls = type === 'tool-intent' ? record.tools : record.activity;
      !calls.some(tool => tool.callId === event.callId) ||
        Fail`Duplicate tool journal call ID`;
      calls.push({
        callId: event.callId,
        name: event.name,
        args: event.args,
      });
    } else if (type === 'tool-result' || type === 'observed-tool-result') {
      const calls = type === 'tool-result' ? record.tools : record.activity;
      const tool = calls.find(item => item.callId === event.callId);
      tool || Fail`Tool result without intent`;
      !tool.settled || Fail`Duplicate tool journal result`;
      tool.result = event.result;
      tool.settled = true;
    } else if (type === 'finish') {
      !record.terminal || Fail`Duplicate terminal turn journal event`;
      for (const key of ['output', 'error', 'conversationNodeId']) {
        if (event[key] !== undefined)
          assertText(event[key], MAX_EVENT_SIZE, true);
      }
      ['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(
        event.state,
      ) || Fail`Invalid terminal turn journal state`;
      record.terminal = true;
      record.state = [...record.tools, ...record.activity].some(
        tool => !tool.settled,
      )
        ? 'outcome-unknown'
        : event.state;
      record.reportedState = event.state;
      for (const key of ['output', 'error', 'usage', 'conversationNodeId']) {
        if (event[key] !== undefined) record[key] = event[key];
      }
    } else if (type === 'resolve') {
      record.state === 'outcome-unknown' ||
        Fail`Only unknown outcomes need resolution`;
      !record.resolution || Fail`Turn outcome already resolved`;
      assertText(event.note, 8192);
      record.resolution = event.note;
    } else {
      throw Fail`Unknown turn journal event type`;
    }
  };

  const initialize = async () => {
    if (initialized) return;
    const names = await E(powers).list();
    const journalNames = names
      .filter(name => typeof name === 'string' && name.startsWith(PREFIX))
      .sort();
    BigInt(journalNames.length) <= MAX_EVENTS ||
      Fail`Turn journal capacity exceeded`;
    for (const name of journalNames) {
      name === `${PREFIX}${`${next}`.padStart(20, '0')}` ||
        Fail`Turn journal sequence is missing or malformed`;
      // Sequential reads cap transient memory while preserving event order.
      // eslint-disable-next-line no-await-in-loop
      const event = copyData(await E(powers).lookup(name));
      JSON.stringify(event).length <= MAX_EVENT_SIZE ||
        Fail`Turn journal event too large`;
      apply(event, next, true);
      next += 1n;
    }
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
    ![...records.values()].some(
      record => record.state === 'outcome-unknown' && !record.resolution,
    ) || Fail`Resolve the unknown turn outcome before dispatching another turn`;
  };

  /** @param {any} value */
  const write = async value => {
    next <= MAX_EVENTS || Fail`Turn journal capacity exhausted`;
    const event = harden(copyData(value));
    JSON.stringify(event).length <= MAX_EVENT_SIZE ||
      Fail`Turn journal event too large`;
    // Validate against a disposable copy before storage. No local record can
    // advance until the immutable write has succeeded.
    const before = [...records.entries()].map(([id, record]) => [
      id,
      JSON.parse(JSON.stringify(record)),
    ]);
    try {
      apply(event, next, false);
    } finally {
      records.clear();
      for (const [id, record] of before) records.set(id, record);
    }
    const name = `${PREFIX}${`${next}`.padStart(20, '0')}`;
    try {
      await E(powers).storeValue(event, name);
    } catch (error) {
      poisoned = true;
      throw error;
    }
    apply(event, next, false);
    next += 1n;
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
    list: () =>
      serialized(async () =>
        harden(JSON.parse(JSON.stringify([...records.values()]))),
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
        await write({ type: 'resolve', turnId, note });
      }),
  });
};
harden(makeTurnJournal);
