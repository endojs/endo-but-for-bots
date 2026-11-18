// @ts-check
/**
 * What one turn of the conversation shows (W3.6), from the controller's
 * `TurnEntry` (m3-interfaces.md 9.1): its user message (the `TurnStarted`
 * record's `input`, or the live `turn-start` event's), its replies, tool
 * calls and thoughts, and how it ended. Pure functions; records are read,
 * never copied onto other keys.
 *
 * Sources: a turn this page watched live has a `fold` (the reply fold of
 * its events, thoughts included); a turn read from a history page has its
 * `records` (transcript records in call order, text fields as previews or
 * staged fields). A live turn, or one with no records, shows its fold; a
 * settled turn with records shows its records, whose staged fields can be
 * read in full (thoughts are not transcript records: a settled turn this
 * page watched keeps its fold, with the records' texts where they pair,
 * `withRecordTexts`; one read after a reload shows no thoughts).
 */

/** @import { ShownMessage } from './ToolGroup.js' */

/** @param {string | undefined} state */
export const isLive = state => state === 'running' || state === 'cancelling';

/** The settled states that show a status row (R6-51). */
const STATUS_STATES = new Set([
  'failed',
  'cancelled',
  'interrupted',
  'outcome-unknown',
]);

/** @param {string | undefined} state */
export const showsStatusRow = state =>
  state !== undefined && STATUS_STATES.has(state);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const hasText = value => {
  if (typeof value === 'string') return value.trim() !== '';
  if (value && typeof value === 'object') {
    const v = /** @type {any} */ (value);
    return typeof v.bytes === 'number' && v.bytes !== 0;
  }
  return false;
};

/**
 * Messages from transcript records (`TurnRecord`s, call order): each
 * round's text (a `round-settled` or, for a round cut short, `partial`) is
 * an assistant message; `tool-intents` give tool messages whose results
 * `tool-result` fills by `opId`; the `turn-settled` `final` is shown only
 * when no round text was.
 *
 * @param {readonly any[]} records
 * @returns {ShownMessage[]}
 */
export const messagesOfRecords = records => {
  /** @type {ShownMessage[]} */
  const messages = [];
  /** @type {Map<string, ShownMessage>} */
  const tools = new Map();
  let roundText = false;
  /** @type {unknown} */
  let final;
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      // an archived record the view does not know: skipped
    } else if (record.kind === 'partial' || record.kind === 'round-settled') {
      if (hasText(record.text)) {
        messages.push({ role: 'assistant', text: record.text });
        roundText = true;
      }
    } else if (record.kind === 'tool-intents') {
      for (const intent of record.intents ?? []) {
        /** @type {ShownMessage} */
        const message = {
          role: 'tool',
          id: intent.opId,
          name: intent.name,
          args: intent.args,
          result: null,
        };
        tools.set(intent.opId, message);
        messages.push(message);
      }
    } else if (record.kind === 'tool-result') {
      const message = tools.get(record.opId);
      if (message) {
        message.result = record.result;
        message.failed = record.failed;
      } else {
        messages.push({
          role: 'tool',
          id: record.opId,
          name: record.name,
          args: '',
          result: record.result,
          failed: record.failed,
        });
      }
    } else if (record.kind === 'turn-settled') {
      final = record.final;
    }
  }
  if (!roundText && hasText(final)) {
    messages.push({ role: 'assistant', text: final });
  }
  return messages;
};

/**
 * How a turn ended, from its entry and records: the reason a failed turn
 * gave and the acknowledgement note of an outcome-unknown one.
 *
 * @param {Record<string, any>} entry a `TurnEntry` or a history preview
 * @returns {{ error?: string, resolution?: string }}
 */
export const endingOf = entry => {
  /** @type {string | undefined} */
  let error = entry.error;
  /** @type {string | undefined} */
  let resolution = entry.resolution;
  for (const record of entry.records ?? []) {
    if (record && record.kind === 'turn-settled' && error === undefined) {
      error = record.error;
    } else if (
      record &&
      record.kind === 'turn-resolved' &&
      resolution === undefined
    ) {
      resolution = record.note;
    }
  }
  return {
    ...(error === undefined ? {} : { error }),
    ...(resolution === undefined ? {} : { resolution }),
  };
};

/**
 * A settled turn this page watched live has both its fold and its records
 * (the controller re-reads the newest history page at `end`/`abort`, M3-FIX
 * acceptance 8). Its records are the fuller source of text (staged fields
 * can be read in full); its fold alone has the thoughts and the live
 * order. When the fold's assistant messages pair one to one with the
 * records', the fold is shown with each assistant text, and each tool
 * message whose `id` the records also have, taken from the records;
 * otherwise the records alone, as after a reload.
 *
 * @param {readonly ShownMessage[]} foldMessages
 * @param {ShownMessage[]} recordMessages
 * @returns {ShownMessage[]}
 */
const withRecordTexts = (foldMessages, recordMessages) => {
  const texts = recordMessages.filter(message => message.role === 'assistant');
  const foldTexts = foldMessages.filter(
    message => message.role === 'assistant',
  );
  if (texts.length !== foldTexts.length) return recordMessages;
  /** @type {Map<unknown, ShownMessage>} */
  const tools = new Map();
  for (const message of recordMessages) {
    if (message.role === 'tool' && message.id !== undefined) {
      tools.set(message.id, message);
    }
  }
  let next = 0;
  return foldMessages.map(message => {
    if (message.role === 'assistant') {
      const paired = texts[next];
      next += 1;
      return { ...message, text: paired.text };
    }
    const tool =
      message.role === 'tool' && message.id !== undefined
        ? tools.get(message.id)
        : undefined;
    return tool ? { ...message, ...tool } : message;
  });
};

/**
 * The messages a turn shows, and its live streaming text and phase.
 *
 * @param {Record<string, any>} entry a `TurnEntry`
 * @returns {{ messages: ShownMessage[], streamingText: string, phase: string, fromFold: boolean }}
 */
export const turnContent = entry => {
  const live = isLive(entry.state);
  const fold = entry.fold;
  // Records read while the turn ran (a page re-attached mid-turn read the
  // newest history page then) stop before its end: until a `turn-settled`
  // record is in them, the fold is the fuller source (W3.8, J-9605).
  const settled = (entry.records ?? []).some(
    (/** @type {any} */ record) => record?.kind === 'turn-settled',
  );
  if (fold && (live || !entry.records || !settled)) {
    return {
      messages: fold.messages,
      streamingText: live ? fold.streamingText || '' : '',
      phase: live ? fold.phase || '' : '',
      fromFold: true,
    };
  }
  const fromRecords = messagesOfRecords(entry.records ?? []);
  return {
    messages: fold ? withRecordTexts(fold.messages, fromRecords) : fromRecords,
    streamingText: '',
    phase: '',
    fromFold: false,
  };
};

/**
 * @typedef {{ kind: 'bubble', index: number, msg: ShownMessage }
 *   | { kind: 'actions', index: number, actions: ShownMessage[] }} TranscriptRow
 */

/**
 * Group a turn's messages: consecutive tool and thinking messages are one
 * row (one collapsible group); every other message is a bubble.
 *
 * @param {readonly ShownMessage[]} messages
 * @returns {TranscriptRow[]}
 */
export const groupMessages = messages => {
  /** @type {TranscriptRow[]} */
  const rows = [];
  let i = 0;
  const isAction = (/** @type {ShownMessage} */ msg) =>
    msg.role === 'tool' || msg.role === 'thinking';
  while (i < messages.length) {
    if (isAction(messages[i])) {
      const actions = [];
      let j = i;
      while (j < messages.length && isAction(messages[j])) {
        actions.push(messages[j]);
        j += 1;
      }
      rows.push({ kind: 'actions', index: i, actions });
      i = j;
    } else {
      rows.push({ kind: 'bubble', index: i, msg: messages[i] });
      i += 1;
    }
  }
  return rows;
};
