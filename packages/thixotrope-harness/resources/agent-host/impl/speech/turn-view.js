// @ts-check
/**
 * The speech view of one turn (`designs/m11-interfaces.md` section 7,
 * R5-34, D-M11-4, D-M11-7): the turn's assistant text, read from the
 * session's live channel in this process (a `Live` subscription, the same
 * object pages use), fed to a `TurnTextSink` in order. Zero vat deliveries:
 * the snapshot and every delta come from the adapter's own channel; a
 * staged `final` is read through `Content`, also in process.
 *
 * 1. `subscribe(session)`; the first delivery is the snapshot. A snapshot of
 *    another turn (older, or not yet started) closes the subscription and
 *    rejects `speechTexts.turnNotLive`. A session already spoken by
 *    `speakViewsPerSession` open views rejects `speechTexts.tooManyViews`
 *    before subscribing.
 * 2. From the snapshot: the text of every `assistant` message, each ended by
 *    a newline (no sentence straddles two), then the streaming text; a
 *    settled turn then ends (a finished last turn replays to the end).
 * 3. Then, for deliveries of this `turnId`: `delta` -> its text;
 *    `tool_call` -> a line break; `final` -> the part of the final text the
 *    round has not spoken (whitespace-insensitive; nothing when the final
 *    does not start with the round's text: a revised final is left to the
 *    transcript); `end` and `abort` -> end (R5-34: a closing abort counts as
 *    the end). Phases, usage, tool results and thinking are not spoken;
 *    deliveries of another turn are ignored, and the next turn's
 *    `turn-start` before this turn's end (a channel gap) ends the view.
 * 4. A subscription closed by the channel before the end, or a failed read,
 *    aborts with `speechTexts.turnNotFound`.
 * 5. `close()` releases the subscription and calls the sink no more; the
 *    turn is never touched (R5-47).
 *
 * Ported from Endo `packages/floot/src/turn-speech.js` (`saidSoFar`,
 * `unspokenOf`, `feedView`) at `1315bef86` onto the harness channel. Changes:
 * the round's text (not the whole turn's) is what a final is compared with,
 * as the contract states, and it is kept only up to `sentenceBacklogUnits`
 * units (over that, a final adds nothing); a staged final is read up to the
 * same bound; an abort is always an end.
 *
 * Retained state per view: the round's text (bounded above) and the
 * subscription. Views are counted per `Live` (one per incarnation) and per
 * session presence, in `WeakMap`s that forget both.
 *
 * Node module of the agent-host adapter.
 */
/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { limits } from '../../../../guest/lib/limits.js';
import { isStaged } from '../../../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */
import { audioLimits, speechTexts } from './audio-protocol.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { OpenTurnViewOptions, TurnSpeechView } from './engine-types.js' */

const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * `OpenTurnViewOptions` of `engine-types.js` and the host's limits (the
 * only test lever, contract 3.3).
 * @typedef {OpenTurnViewOptions & {
 *   limits?: { speakViewsPerSession?: number, sentenceBacklogUnits?: number },
 * }} TurnViewOptions
 */

/** @type {WeakMap<object, WeakMap<object, number>>} open views by Live, then session */
const openViews = new WeakMap();

/** @param {object} live */
const viewsOf = live => {
  let views = openViews.get(live);
  if (views === undefined) {
    views = new WeakMap();
    openViews.set(live, views);
  }
  return views;
};

/** @param {string} text */
const collapse = text => text.replace(/\s+/g, ' ').trim();

/**
 * What a final adds to the round's spoken text: its rest after that text,
 * compared with whitespace collapsed (message separators and trimmed line
 * ends differ between the two); nothing when it does not start with it.
 * @param {string} final
 * @param {string} spoken
 */
const unspokenOf = (final, spoken) => {
  const finalText = collapse(final);
  const spokenText = collapse(spoken);
  if (!finalText.startsWith(spokenText)) return '';
  return finalText.slice(spokenText.length);
};

/**
 * The text of a final: inline, or a staged one read through `Content` a
 * page at a time, up to `units` units.
 * @param {any} content
 * @param {any} text a string or a StagedText
 * @param {number} units
 */
const finalTextOf = async (content, text, units) => {
  await null;
  if (!isStaged(text)) return /** @type {string} */ (text);
  let read = '';
  let offset = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await E(content).read(
      text.blob,
      harden({ offset, maxBytes: limits.blobPageBytes }),
    );
    read += page.text;
    if (page.done || read.length >= units) return read.slice(0, units);
    offset = page.next;
  }
};

/**
 * The text a snapshot holds: the completed assistant messages, each ended by
 * a newline, then the streaming text.
 * @param {any} status a FoldableStatus
 */
const saidSoFar = status => {
  const completed = status.messages
    .filter(
      (/** @type {any} */ message) =>
        message.role === 'assistant' && message.text,
    )
    .map((/** @type {any} */ message) => `${message.text}\n`)
    .join('');
  return `${completed}${status.streamingText}`;
};

/**
 * Open the speech view of `turnId` in `session`'s channel. Rejects
 * `turnNotLive` or `tooManyViews` (and opens nothing); otherwise the sink
 * receives the turn's text from here on.
 * @param {TurnViewOptions} options
 * @returns {Promise<TurnSpeechView>}
 */
export const openTurnView = async ({
  live,
  content,
  session,
  turnId,
  sink,
  limits: { speakViewsPerSession, sentenceBacklogUnits } = {},
}) => {
  const maxViews = speakViewsPerSession ?? audioLimits.speakViewsPerSession;
  const roundUnits = sentenceBacklogUnits ?? audioLimits.sentenceBacklogUnits;
  const views = viewsOf(live);
  if ((views.get(session) ?? 0) >= maxViews) {
    throw Error(speechTexts.tooManyViews);
  }
  // Counted before the first await, so concurrent opens see each other.
  views.set(session, (views.get(session) ?? 0) + 1);
  let counted = true;
  const release = () => {
    if (!counted) return;
    counted = false;
    const left = (views.get(session) ?? 1) - 1;
    if (left > 0) views.set(session, left);
    else views.delete(session);
  };

  /** @type {any} */
  let subscription;
  /** @type {any} */
  let first;
  await null;
  try {
    subscription = await E(live).subscribe(session);
    first = await E(subscription).next();
  } catch {
    release();
    if (subscription !== undefined)
      void E(subscription)
        .close()
        .catch(() => {});
    throw Error(speechTexts.turnNotFound);
  }
  const [head, ...rest] = first.deliveries;
  const snapshot = head?.event;
  if (snapshot?.type !== 'snapshot' || snapshot.turn?.turnId !== turnId) {
    release();
    void E(subscription)
      .close()
      .catch(() => {});
    throw Error(
      first.closed ? speechTexts.turnNotFound : speechTexts.turnNotLive,
    );
  }

  let over = false;
  /** The round's text as spoken so far (what a final is compared with). */
  let round = '';
  let roundOverflow = false;
  /** @param {string} text */
  const addToRound = text => {
    if (roundOverflow) return;
    if (round.length + text.length > roundUnits) {
      roundOverflow = true;
      round = '';
    } else {
      round += text;
    }
  };
  const newRound = () => {
    round = '';
    roundOverflow = false;
  };

  /** Stop: release the subscription; the sink hears nothing more. */
  const stop = () => {
    if (over) return;
    over = true;
    release();
    void E(subscription)
      .close()
      .catch(() => {});
  };
  const end = () => {
    if (over) return;
    stop();
    sink.end();
  };
  /** @param {string} reason */
  const abort = reason => {
    if (over) return;
    stop();
    sink.abort(reason);
  };
  /** @param {string} text */
  const say = text => {
    if (text && !over) sink.text(text);
  };

  const { status, settled } = snapshot.turn;
  say(saidSoFar(status));
  addToRound(status.streamingText);
  if (settled) end();

  /** @param {any} event a final of this turn */
  const applyFinal = async event => {
    /** @type {string | undefined} */
    let final;
    await null;
    try {
      final = await finalTextOf(content, event.text, roundUnits);
    } catch {
      // A final that cannot be read adds nothing; what was said stands.
      final = undefined;
    }
    if (final === undefined || over) return;
    if (!roundOverflow) say(unspokenOf(final, round));
    newRound();
    addToRound(final);
  };

  /**
   * One delivery's event; answers a promise only for a final (the rest is
   * synchronous, so a delta reaches the sink in the batch's own turn).
   * @param {any} event
   * @returns {Promise<void> | undefined}
   */
  const apply = event => {
    if (event.type === 'turn-start') {
      if (event.turnId !== turnId) end();
      return undefined;
    }
    if (event.turnId !== turnId) return undefined;
    switch (event.type) {
      case 'delta':
        addToRound(event.text);
        say(event.text);
        break;
      case 'tool_call':
        newRound();
        if (!over) sink.lineBreak();
        break;
      case 'final':
        return applyFinal(event);
      case 'end':
      case 'abort':
        end();
        break;
      default:
      // Phases, usage, tool results and thinking are not spoken.
    }
    return undefined;
  };

  const feed = async () => {
    let deliveries = rest;
    let closed = Boolean(first.closed);
    await null;
    for (;;) {
      for (const { event } of deliveries) {
        if (over) return;
        const reading = apply(event);
        // eslint-disable-next-line no-await-in-loop
        if (reading !== undefined) await reading;
      }
      if (over) return;
      if (closed) {
        abort(speechTexts.turnNotFound);
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      const batch = await E(subscription).next();
      if (over) return;
      deliveries = batch.deliveries;
      closed = Boolean(batch.closed);
    }
  };
  if (!over) {
    void feed().catch(() => abort(speechTexts.turnNotFound));
  }

  return harden({ close: stop });
};
harden(openTurnView);
