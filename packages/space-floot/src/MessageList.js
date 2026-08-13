// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';

/** @import { VNode } from 'preact' */
/** @import { FlootMessage, FlootState, FlootController } from './types.js' */

// Transcript renderer: history + the live turn, as discrete bubbles and tool
// rows. Pure view — `messages` and `streamingText` come from the host
// controller's snapshot; nothing here touches the DOM or audio.

// Match http(s) URLs. Deliberately narrow (only http/https) so nothing else in
// a reply can become a live link, and so a published capability URL renders as
// a safe, clickable anchor.
const URL_RE = /(https?:\/\/[^\s]+)/g;

/**
 * Split a plain-text reply into an array of Preact children where each http(s)
 * URL becomes an `<a target="_blank" rel="noopener noreferrer">` and everything
 * else stays a text node (Preact escapes text children, so non-URL content is
 * never interpreted as markup).
 *
 * @param {string} text
 * @returns {Array<string | VNode>}
 */
export const linkify = text => {
  const source = `${text || ''}`;
  if (!source) return [source];
  /** @type {Array<string | VNode>} */
  const parts = [];
  let last = 0;
  for (const match of source.matchAll(URL_RE)) {
    const start = /** @type {number} */ (match.index);
    let url = match[0];
    // Trailing sentence punctuation is almost never part of the URL; keep it as
    // adjacent text so "see https://x/y." doesn't linkify the period.
    let trailing = '';
    const trail = /[.,;:!?)\]}'"]+$/.exec(url);
    if (trail) {
      trailing = trail[0];
      url = url.slice(0, url.length - trailing.length);
    }
    if (start > last) parts.push(source.slice(last, start));
    if (url) {
      parts.push(
        h(
          'a',
          {
            href: url,
            target: '_blank',
            rel: 'noopener noreferrer',
            class: 'floot-link',
          },
          url,
        ),
      );
    }
    if (trailing) parts.push(trailing);
    last = start + match[0].length;
  }
  if (last < source.length) parts.push(source.slice(last));
  return parts.length ? parts : [source];
};
harden(linkify);

const ToolBlock = (
  /** @type {string} */ key,
  /** @type {string} */ name,
  /** @type {string} */ content,
  /** @type {boolean} */ isResult,
) =>
  h(
    'div',
    { key, class: 'floot-msg-row assistant' },
    h(
      'div',
      { class: `floot-tool${isResult ? ' result' : ''}` },
      h(
        'div',
        { class: 'floot-tool-label' },
        `${name || 'tool'}${isResult ? ' result' : ''}`,
      ),
      h('pre', { class: 'floot-tool-pre' }, content),
    ),
  );

/**
 * @param {{ msg: FlootMessage, canReplay: boolean, onReplay: (text: string) => void, replaying: boolean }} props
 * @returns {VNode}
 */
const Bubble = ({ msg, canReplay, onReplay, replaying }) => {
  const text = msg.text || '';
  const mailFrom = msg.meta && msg.meta.mail && msg.meta.mail.from;
  const rowClass = `floot-msg-row ${msg.role}${mailFrom ? ' mail' : ''}`;
  const caption = mailFrom
    ? h(
        'div',
        { class: 'floot-mail-caption' },
        'Mail from ',
        h('span', { class: 'token message-token' }, `@${mailFrom}`),
      )
    : null;
  const bubble = h('div', { class: 'floot-msg' }, ...linkify(text));
  // A finished assistant message offers a replay button when TTS is wired.
  if (msg.role === 'assistant' && canReplay && text.trim()) {
    return h(
      'div',
      { class: rowClass },
      caption,
      h(
        'div',
        { class: 'floot-bubble-wrap' },
        bubble,
        h(
          'button',
          {
            type: 'button',
            class: `floot-replay${replaying ? ' playing' : ''}`,
            'aria-label': 'Replay',
            onClick: () => onReplay(text),
          },
          '▶',
        ),
      ),
    );
  }
  return h('div', { class: rowClass }, caption, bubble);
};
harden(Bubble);

const ThinkingRow = () =>
  h(
    'div',
    { class: 'floot-msg-row assistant' },
    h(
      'div',
      { class: 'floot-thinking' },
      h('span', null),
      h('span', null),
      h('span', null),
    ),
  );

// Raw debug block: the exact structured output for one message (assistant
// content, or a tool call's name/args/result), as pretty JSON. Reuses the
// tool-row styling so no new CSS is needed.
const RawBlock = (/** @type {string} */ key, /** @type {unknown} */ msg) =>
  h(
    'div',
    { key, class: 'floot-msg-row assistant' },
    h(
      'div',
      { class: 'floot-tool' },
      h(
        'div',
        { class: 'floot-tool-label' },
        `${/** @type {any} */ (msg).role || 'raw'} (raw)`,
      ),
      h('pre', { class: 'floot-tool-pre' }, JSON.stringify(msg, null, 2)),
    ),
  );

/**
 * @param {{ state: FlootState, controller: FlootController, debug?: boolean }} props
 * @returns {VNode}
 */
export const MessageList = ({ state, controller, debug = false }) => {
  const { messages, streamingText, busy, loaded, voice } = state;
  const canReplay = Boolean(voice && voice.hasTts);
  const replayingText = voice && voice.replayingText;

  if (!loaded) {
    return h(
      'div',
      { class: 'floot-messages' },
      h(
        'div',
        { class: 'floot-empty-state floot-loading' },
        h('span', { class: 'floot-spinner' }),
        'Loading session…',
      ),
    );
  }

  const hasContent = messages.length > 0 || streamingText || busy;
  if (!hasContent) {
    return h(
      'div',
      { class: 'floot-messages' },
      h('div', { class: 'floot-empty-state' }, 'Say hello to Floot.'),
    );
  }

  // Debug view: show each message's raw structured output verbatim instead of
  // the rendered transcript, plus the live raw stream. A pure re-projection of
  // the same snapshot, so it updates as the turn streams.
  if (debug) {
    /** @type {VNode<any>[]} */
    const rawRows = messages.map((msg, i) => RawBlock(`raw-${i}`, msg));
    if (streamingText) {
      rawRows.push(
        RawBlock('raw-streaming', { role: 'assistant', text: streamingText }),
      );
    } else if (busy) {
      rawRows.push(h(ThinkingRow, { key: 'thinking' }));
    }
    return h('div', { class: 'floot-messages' }, rawRows);
  }

  const rows = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    // Keys are positional: the transcript is append-mostly, so an index key is
    // stable and lets Preact reuse rows across streaming re-renders.
    if (msg.role === 'tool') {
      rows.push(ToolBlock(`tool-${i}`, msg.name || '', msg.args || '', false));
      if (msg.result != null) {
        rows.push(
          ToolBlock(`tool-${i}-result`, msg.name || '', msg.result, true),
        );
      }
    } else {
      rows.push(
        h(Bubble, {
          key: `msg-${i}`,
          msg,
          canReplay,
          replaying: canReplay && replayingText === (msg.text || ''),
          onReplay: text => controller.replayMessage(text),
        }),
      );
    }
  }
  // The in-progress assistant bubble, or a thinking indicator before any text.
  if (streamingText) {
    rows.push(
      h(
        'div',
        { key: 'streaming', class: 'floot-msg-row assistant' },
        h('div', { class: 'floot-msg streaming' }, ...linkify(streamingText)),
      ),
    );
  } else if (busy) {
    rows.push(h(ThinkingRow, { key: 'thinking' }));
  }

  return h('div', { class: 'floot-messages' }, rows);
};
harden(MessageList);
