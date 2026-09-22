// @ts-check

/**
 * One fold of a turn's reply events into the state a view renders, shared by
 * the daemon's turn, which is the source of snapshots, and the browser's
 * component, which adopts a snapshot and applies the events after it. Both
 * run this code, so a view repainted from a snapshot and one that applied
 * every event converge on the same messages.
 *
 * The fold mutates the status it is given: assistant text accretes in
 * `streamingText` until a tool round or a thinking block closes it into a
 * message; a tool call is a message whose result lands later, paired by id
 * because concurrent calls in one round settle out of order; a thinking block
 * grows under its id. Emission is the caller's: the daemon forwards each
 * event to its views before folding it, so a view that opened on the
 * preceding snapshot applies exactly the events the snapshot does not
 * account for, and the browser notifies its subscribers after.
 *
 * The status is mutable by design; the fold itself is hardened, through the
 * shim that resolves to the realm's `harden` under lockdown on either side.
 *
 * @module
 */

import harden from '@endo/harden';

/** @import { ReplyEvent } from './stream.js' */

/**
 * @typedef {{ role: 'assistant' | 'tool' | 'thinking', text?: string, id?: string,
 *   thinking?: { startedAt: number, endedAt?: number, truncated: boolean },
 *   name?: string, args?: string, result?: string | null }} FoldedMessage
 */

/**
 * The state a fold reads and writes; a daemon turn's status and a browser
 * turn record both have this shape.
 *
 * @typedef {{
 *   phase: string,
 *   streamingText: string,
 *   messages: FoldedMessage[],
 *   error: string | null,
 *   usage: any,
 * }} FoldableStatus
 */

/**
 * @param {object} [options]
 * @param {(reported: Record<string, any>) => any} [options.projectUsage] How a
 *   usage report, from an event or a snapshot, is held: the daemon keeps it
 *   as reported; the browser projects its counts.
 */
export const makeReplyFold = ({ projectUsage = reported => reported } = {}) => {
  /** @type {Map<string, FoldedMessage>} */
  const pendingTools = new Map();

  /** @param {FoldableStatus} status */
  const flushStreamingText = status => {
    if (status.streamingText.trim()) {
      status.messages.push({
        role: 'assistant',
        text: status.streamingText.trim(),
      });
    }
    status.streamingText = '';
  };

  /**
   * Take a snapshot's state as this fold's own: the messages are copied,
   * since a pending tool message is still waiting for its result to be
   * written into it, and the calls without a result are pending again.
   *
   * @param {FoldableStatus} status
   * @param {FoldableStatus} snapshot
   */
  const adopt = (status, snapshot) => {
    status.messages.length = 0;
    status.messages.push(...snapshot.messages.map(message => ({ ...message })));
    pendingTools.clear();
    for (const message of status.messages) {
      if (message.role === 'tool' && message.id && message.result == null) {
        pendingTools.set(message.id, message);
      }
    }
    status.streamingText = snapshot.streamingText;
    status.phase = snapshot.phase;
    status.usage = snapshot.usage == null ? null : projectUsage(snapshot.usage);
    status.error = snapshot.error;
  };

  /**
   * Fold one event. Returns the event when it is the turn's terminal one
   * (`end` or `abort`), so the caller can stop reading.
   *
   * @param {FoldableStatus} status
   * @param {ReplyEvent} event
   * @returns {ReplyEvent | undefined}
   */
  const apply = (status, event) => {
    switch (event.type) {
      case 'delta':
        status.streamingText += event.text;
        return undefined;
      case 'final':
        status.streamingText = event.text;
        return undefined;
      case 'thinking': {
        flushStreamingText(status);
        let message = status.messages.find(
          item => item.role === 'thinking' && item.id === event.id,
        );
        if (!message) {
          message = { role: 'thinking', id: event.id, text: '' };
          status.messages.push(message);
        }
        message.text = `${message.text || ''}${event.text}`;
        message.thinking = {
          startedAt: event.startedAt,
          ...(event.endedAt === undefined ? {} : { endedAt: event.endedAt }),
          truncated: event.truncated,
        };
        return undefined;
      }
      case 'tool_call': {
        // The assistant text that preceded the call is a finished message: a
        // tool round follows it, and more text after that is a separate
        // message.
        flushStreamingText(status);
        /** @type {FoldedMessage} */
        const toolMessage = {
          role: 'tool',
          id: event.id,
          name: event.name,
          args: event.args,
          result: null,
        };
        pendingTools.set(event.id, toolMessage);
        status.messages.push(toolMessage);
        return undefined;
      }
      case 'tool_result': {
        const toolMessage = pendingTools.get(event.id);
        if (toolMessage) {
          toolMessage.result = event.result;
          pendingTools.delete(event.id);
        }
        return undefined;
      }
      case 'phase':
        status.phase = event.phase;
        return undefined;
      case 'usage': {
        const { type: _type, ...reported } = event;
        status.usage = projectUsage({
          ...reported,
          incompleteTurns: event.incompleteTurns || 0,
        });
        return undefined;
      }
      case 'end':
        return event;
      case 'abort':
        status.error = event.reason;
        return event;
      default:
        return undefined;
    }
  };

  /**
   * The turn's last words: whatever assistant text was still arriving is a
   * message now.
   *
   * @param {FoldableStatus} status
   */
  const finish = status => flushStreamingText(status);

  return harden({ adopt, apply, finish });
};
harden(makeReplyFold);
