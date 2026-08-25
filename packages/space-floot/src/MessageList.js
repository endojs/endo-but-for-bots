// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { useState } from 'preact/hooks';

import { tokenizeJs } from './highlight.js';

/** @import { VNode } from 'preact' */
/** @import { FlootMessage, FlootState, FlootController } from './types.js' */

// Transcript renderer: history + the live turn, as discrete bubbles and action
// groups. Pure view — `messages` and `streamingText` come from the host
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

// ── Agent actions ────────────────────────────────────────────────────────────

/**
 * Tools whose arguments are a JavaScript body worth colouring: the daemon's own
 * `exec`, and its MCP aliases (`mcp__endo__exec`, and any future
 * `mcp__<server>__exec`).
 *
 * @param {string | undefined} name
 * @returns {boolean}
 */
export const isJsTool = name => /(^|_)exec$/i.test(`${name || ''}`);
harden(isJsTool);

/**
 * Pretty-print a tool payload. Tool args and results arrive as strings that are
 * usually JSON; re-serializing an object payload with indentation is the single
 * biggest readability win, and anything that isn't JSON is shown verbatim.
 *
 * @param {string | null | undefined} payload
 * @returns {string}
 */
export const formatPayload = payload => {
  const source = `${payload == null ? '' : payload}`;
  const trimmed = source.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return source;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return source;
  }
};
harden(formatPayload);

/**
 * The JavaScript an `exec`-family call actually runs. Its args are a JSON
 * record whose `code` field holds the source; showing that source directly
 * (rather than the JSON envelope with its escaped newlines) is what makes the
 * entry readable.
 *
 * @param {string | undefined} args
 * @returns {string}
 */
export const extractExecCode = args => {
  const source = `${args || ''}`;
  const trimmed = source.trim();
  if (!trimmed.startsWith('{')) return source;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.code === 'string') return parsed.code;
  } catch {
    // Not JSON (or not the shape we expect) — show the args as they came.
  }
  return source;
};
harden(extractExecCode);

/**
 * Collapse a run of actions into the summary its closed header shows: how many
 * ran in total, and how many of each tool.
 *
 * @param {FlootMessage[]} actions
 * @returns {{ total: number, counts: Array<{ name: string, count: number }>,
 *   label: string, detail: string }}
 */
export const summarizeActions = actions => {
  /** @type {Map<string, number>} */
  const tally = new Map();
  for (const action of actions) {
    const name = action.name || 'tool';
    tally.set(name, (tally.get(name) || 0) + 1);
  }
  const counts = [...tally.entries()].map(([name, count]) => ({ name, count }));
  const total = actions.length;
  return {
    total,
    counts,
    label: `${total} action${total === 1 ? '' : 's'}`,
    detail: counts
      .map(({ name, count }) => (count > 1 ? `${name} ×${count}` : name))
      .join(', '),
  };
};
harden(summarizeActions);

// One line of context for a collapsed action, so a closed entry still says what
// it did.
const previewOf = (/** @type {string} */ text) => {
  const line = `${text || ''}`.split('\n').find(l => l.trim()) || '';
  const trimmed = line.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
};

/**
 * A `<pre>` of source, colourised when it is JavaScript. Token spans are built
 * from the tokenizer's output, so the rendered text always concatenates back to
 * the original.
 *
 * @param {{ code: string, language: 'js' | 'text' }} props
 * @returns {VNode}
 */
const CodeBlock = ({ code, language }) => {
  if (language !== 'js') return h('pre', { class: 'floot-tool-pre' }, code);
  const spans = tokenizeJs(code).map((token, index) =>
    token.type === 'plain'
      ? token.text
      : h(
          'span',
          { key: `tok-${index}`, class: `floot-tok floot-tok-${token.type}` },
          token.text,
        ),
  );
  return h('pre', { class: 'floot-tool-pre floot-code' }, ...spans);
};

/**
 * One agent action — the call and its result as a single entry, collapsed by
 * default.
 *
 * @param {{ msg: FlootMessage }} props
 * @returns {VNode}
 */
const ActionEntry = ({ msg }) => {
  const [open, setOpen] = useState(false);
  const name = msg.name || 'tool';
  const js = isJsTool(name);
  const argsText = js ? extractExecCode(msg.args) : formatPayload(msg.args);
  const hasResult = msg.result != null;
  return h(
    'div',
    { class: `floot-action${open ? ' open' : ''}` },
    h(
      'button',
      {
        type: 'button',
        class: 'floot-action-head',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen(!open),
      },
      h('span', { class: 'floot-caret' }, open ? '▾' : '▸'),
      h('span', { class: 'floot-action-name' }, name),
      h('span', { class: 'floot-action-preview' }, previewOf(argsText)),
      hasResult
        ? null
        : h('span', { class: 'floot-action-running' }, 'running…'),
    ),
    open
      ? h(
          'div',
          { class: 'floot-action-body' },
          h(
            'div',
            { class: 'floot-action-section' },
            h(
              'div',
              { class: 'floot-tool-label' },
              js ? 'javascript' : 'arguments',
            ),
            h(CodeBlock, { code: argsText, language: js ? 'js' : 'text' }),
          ),
          hasResult
            ? h(
                'div',
                { class: 'floot-action-section result' },
                h('div', { class: 'floot-tool-label' }, 'result'),
                h(
                  'pre',
                  { class: 'floot-tool-pre' },
                  formatPayload(msg.result),
                ),
              )
            : null,
        )
      : null,
  );
};

/**
 * Every action between two assistant replies, as one collapsible group that is
 * closed by default and summarised in its header.
 *
 * @param {{ actions: FlootMessage[] }} props
 * @returns {VNode}
 */
const ActionGroup = ({ actions }) => {
  const [open, setOpen] = useState(false);
  const summary = summarizeActions(actions);
  return h(
    'div',
    { class: 'floot-msg-row assistant' },
    h(
      'div',
      { class: `floot-actions${open ? ' open' : ''}` },
      h(
        'button',
        {
          type: 'button',
          class: 'floot-actions-head',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen(!open),
        },
        h('span', { class: 'floot-caret' }, open ? '▾' : '▸'),
        h('span', { class: 'floot-actions-count' }, summary.label),
        summary.detail
          ? h('span', { class: 'floot-actions-detail' }, summary.detail)
          : null,
      ),
      open
        ? h(
            'div',
            { class: 'floot-actions-body' },
            actions.map((action, index) =>
              h(ActionEntry, { key: `action-${index}`, msg: action }),
            ),
          )
        : null,
    ),
  );
};

/**
 * @param {{ msg: FlootMessage, canReplay: boolean,
 *   onReplay: (text: string) => void, replaying: boolean }} props
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

/**
 * A submission that has been accepted but not yet run, shown after the live
 * turn it is queued behind. It reads as greyed-out rather than labelled: the
 * position (below the thinking indicator) and the muted styling already say
 * "not sent yet", and a badge on every queued line is noise.
 *
 * @param {{ msg: FlootMessage, onSendNow?: (id: number) => void,
 *   onEdit?: (id: number, text: string) => void,
 *   onDelete?: (id: number) => void }} props
 * @returns {VNode}
 */
const PendingBubble = ({ msg, onSendNow, onEdit, onDelete }) => {
  const text = msg.text || '';
  const id = /** @type {number} */ (msg.pendingId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  const save = () => {
    const next = draft.trim();
    setEditing(false);
    // An empty edit is a no-op, not a delete: deleting has its own button, and
    // silently discarding a message because the box was cleared would be a
    // surprising way to lose one.
    if (next && next !== text && onEdit) onEdit(id, next);
    else setDraft(text);
  };

  if (editing) {
    return h(
      'div',
      { class: 'floot-msg-row user pending editing' },
      h('textarea', {
        class: 'floot-pending-input',
        value: draft,
        onInput: e => setDraft(e.target.value),
        onKeyDown: e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        },
      }),
      h(
        'div',
        { class: 'floot-pending-actions' },
        h(
          'button',
          { type: 'button', class: 'floot-pending-action', onClick: save },
          'Save',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'floot-pending-action',
            onClick: () => {
              setDraft(text);
              setEditing(false);
            },
          },
          'Cancel',
        ),
      ),
    );
  }

  return h(
    'div',
    { class: 'floot-msg-row user pending' },
    h('div', { class: 'floot-msg' }, ...linkify(text)),
    h(
      'div',
      { class: 'floot-pending-actions' },
      onSendNow
        ? h(
            'button',
            {
              type: 'button',
              class: 'floot-pending-action',
              onClick: () => onSendNow(id),
            },
            'Send now',
          )
        : null,
      onEdit
        ? h(
            'button',
            {
              type: 'button',
              class: 'floot-pending-action',
              onClick: () => {
                setDraft(text);
                setEditing(true);
              },
            },
            'Edit',
          )
        : null,
      onDelete
        ? h(
            'button',
            {
              type: 'button',
              class: 'floot-pending-action floot-pending-delete',
              onClick: () => onDelete(id),
            },
            'Delete',
          )
        : null,
    ),
  );
};

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
  // Older hosts may not offer these; each control simply does not render.
  const onSendNow =
    typeof controller.sendPendingNow === 'function'
      ? (/** @type {number} */ id) => controller.sendPendingNow(id)
      : undefined;
  const onEditPending =
    typeof controller.editPending === 'function'
      ? (/** @type {number} */ id, /** @type {string} */ text) =>
          controller.editPending(id, text)
      : undefined;
  const onDeletePending =
    typeof controller.cancelPending === 'function'
      ? (/** @type {number} */ id) => controller.cancelPending(id)
      : undefined;

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
  // Queued submissions are collected out of the transcript and rendered after
  // the live turn's output, below the thinking indicator: they run after it,
  // and showing them above reads as though they had already been sent.
  /** @type {FlootMessage[]} */
  const pendingMessages = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.pending) {
      pendingMessages.push(msg);
      i += 1;
      continue;
    }
    // Keys are positional: the transcript is append-mostly, so an index key is
    // stable and lets Preact reuse rows across streaming re-renders.
    if (msg.role === 'tool') {
      // Consecutive tool messages are one turn's worth of actions — the run
      // between two replies — so they collapse together.
      const actions = [];
      let j = i;
      while (j < messages.length && messages[j].role === 'tool') {
        actions.push(messages[j]);
        j += 1;
      }
      rows.push(h(ActionGroup, { key: `actions-${i}`, actions }));
      i = j;
      continue;
    }
    rows.push(
      h(Bubble, {
        key: `msg-${i}`,
        msg,
        canReplay,
        replaying: canReplay && replayingText === (msg.text || ''),
        onReplay: text => controller.replayMessage(text),
      }),
    );
    i += 1;
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
  // After the live turn, in the order they will run.
  for (const msg of pendingMessages) {
    rows.push(
      h(PendingBubble, {
        // Keyed by the placeholder's own id so an edit re-renders in place and
        // deleting one does not reset the edit state of the next.
        key: `pending-${msg.pendingId}`,
        msg,
        onSendNow,
        onEdit: onEditPending,
        onDelete: onDeletePending,
      }),
    );
  }

  return h('div', { class: 'floot-messages' }, rows);
};
harden(MessageList);
