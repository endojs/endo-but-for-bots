// @ts-check
/**
 * Tool groups and "Thought for" (R6-45; m3-interfaces.md 9.3; W3.6).
 * Adapted from Endo `packages/space-floot/src/MessageList.js` at
 * `1315bef86` (`ThoughtEntry`, `ActionEntry`, `ActionGroup` and their
 * helpers): the look and behaviour are Floot's; the group header's duration
 * text is the contract's `uiTextOf.thoughtFor`, and a tool payload may be a
 * staged field (shown by its preview).
 *
 * Everything between two assistant replies that is not a reply (thoughts
 * and tool calls) is one group, closed by default, its header summarising
 * how long the backend thought and how many tools ran. An `exec`-family
 * call shows its `code` highlighted as JavaScript.
 */
import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { uiTextOf } from '../../../resources/agent-host/impl/gateway/protocol.js';
import { tokenizeJs } from './highlight.js';
import { labels } from './labels.js';
import { shownText } from './text.js';

/**
 * A folded message (`reply-fold.js` `FoldedMessage`) or one built from
 * transcript records.
 *
 * @typedef {{ role: string, text?: any, id?: string, name?: string,
 *   args?: any, result?: any, failed?: boolean,
 *   thinking?: { startedAt: number, endedAt?: number, truncated: boolean } }} ShownMessage
 */

/** @param {ShownMessage} msg */
export const isThought = msg => msg.role === 'thinking';

/** @param {ShownMessage} msg */
const thoughtRunning = msg =>
  isThought(msg) &&
  typeof msg.thinking?.startedAt === 'number' &&
  msg.thinking.endedAt === undefined;

/**
 * @param {ShownMessage} msg
 * @param {number} now
 */
const thoughtMs = (msg, now) => {
  const startedAt = msg.thinking?.startedAt;
  if (typeof startedAt !== 'number') return 0;
  return Math.max(0, (msg.thinking?.endedAt ?? now) - startedAt);
};

/**
 * A clock that ticks once a second while a thought streams.
 *
 * @param {boolean} running
 */
const useNow = running => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [running]);
  return now;
};

/** @param {string} text */
export const thoughtPreview = text =>
  text.slice(0, 240).replace(/\s+/g, ' ').trim();

/**
 * Tools whose arguments are JavaScript worth colouring: `exec` and its
 * aliases (`mcp__endo__exec`).
 *
 * @param {string | undefined} name
 */
export const isJsTool = name => /(^|_)exec$/i.test(`${name || ''}`);

/**
 * Pretty-print a JSON payload; anything else verbatim.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export const formatPayload = payload => {
  const source = shownText(payload);
  const trimmed = source.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return source;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return source;
  }
};

/**
 * The JavaScript an `exec` call runs: its args' `code` field.
 *
 * @param {unknown} args
 * @returns {string}
 */
export const extractExecCode = args => {
  const source = shownText(args);
  const trimmed = source.trim();
  if (!trimmed.startsWith('{')) return source;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.code === 'string') return parsed.code;
  } catch {
    // not JSON (or a cut preview): the args as they came
  }
  return source;
};

/**
 * The closed header of a run of actions: "Thought for 1m2s · 3 actions"
 * and the tool tally.
 *
 * @param {ShownMessage[]} entries
 * @param {number} [now]
 */
export const summarizeActions = (entries, now = Date.now()) => {
  /** @type {Map<string, number>} */
  const tally = new Map();
  let total = 0;
  let ms = 0;
  let thoughts = 0;
  let thinking = false;
  for (const entry of entries) {
    if (isThought(entry)) {
      thoughts += 1;
      ms += thoughtMs(entry, now);
      if (thoughtRunning(entry)) thinking = true;
    } else {
      total += 1;
      const name = entry.name || 'tool';
      tally.set(name, (tally.get(name) || 0) + 1);
    }
  }
  const counts = [...tally.entries()].map(([name, count]) => ({ name, count }));
  const thought = thoughts
    ? uiTextOf.thoughtFor(Math.floor(ms / 1000), thinking)
    : '';
  const actions = total ? `${total} action${total === 1 ? '' : 's'}` : '';
  return {
    total,
    counts,
    thought,
    thinking,
    label: [thought, actions].filter(Boolean).join(' · '),
    detail: counts
      .map(({ name, count }) => (count > 1 ? `${name} ×${count}` : name))
      .join(', '),
  };
};

/**
 * Display only: a one-line preview (a `command` field when the args are a
 * JSON record with one).
 *
 * @param {string} text
 */
export const actionPreview = text => {
  let preview = text;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const command = value.command ?? value.cmd;
      if (typeof command === 'string') preview = command;
    }
  } catch {
    // raw code and cut JSON still get a preview
  }
  return preview.replace(/\s+/g, ' ').trim();
};

/**
 * A `<pre>` of source, coloured when it is JavaScript; the spans
 * concatenate back to the source.
 *
 * @param {{ code: string, language: 'js' | 'text' }} props
 */
const CodeBlock = ({ code, language }) => {
  const js = language === 'js';
  const spans = useMemo(
    () =>
      js
        ? tokenizeJs(code).map((token, index) =>
            token.type === 'plain'
              ? token.text
              : h(
                  'span',
                  {
                    key: `tok-${index}`,
                    class: `floot-tok floot-tok-${token.type}`,
                  },
                  token.text,
                ),
          )
        : [code],
    [code, js],
  );
  if (!js) return h('pre', { class: 'floot-tool-pre' }, code);
  return h('pre', { class: 'floot-tool-pre floot-code' }, ...spans);
};

/** @param {{ msg: ShownMessage, now: number }} props */
const ThoughtEntry = ({ msg, now }) => {
  const [open, setOpen] = useState(false);
  const running = thoughtRunning(msg);
  const text = shownText(msg.text);
  const preview = useMemo(() => thoughtPreview(text), [text]);
  return h(
    'div',
    { class: `floot-action thought${open ? ' open' : ''}` },
    h(
      'button',
      {
        type: 'button',
        class: 'floot-action-head',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen(!open),
      },
      h(
        'span',
        { class: 'floot-caret', 'aria-hidden': 'true' },
        open ? '▾' : '▸',
      ),
      h(
        'span',
        { class: 'floot-action-name' },
        uiTextOf.thoughtFor(Math.floor(thoughtMs(msg, now) / 1000), running),
      ),
      h('span', { class: 'floot-action-preview' }, preview),
    ),
    open
      ? h(
          'div',
          { class: 'floot-action-body' },
          h('div', { class: 'floot-thought-note' }, labels.thoughtNote),
          h('pre', { class: 'floot-thought-text' }, text),
          msg.thinking?.truncated
            ? h('div', { class: 'floot-thought-note' }, labels.thoughtTruncated)
            : null,
        )
      : null,
  );
};

/** @param {{ msg: ShownMessage }} props */
const ActionEntry = ({ msg }) => {
  const [open, setOpen] = useState(false);
  const name = msg.name || 'tool';
  const js = isJsTool(name);
  const argsText = useMemo(
    () => (js ? extractExecCode(msg.args) : formatPayload(msg.args)),
    [js, msg.args],
  );
  const preview = useMemo(() => actionPreview(argsText), [argsText]);
  const hasResult = msg.result !== null && msg.result !== undefined;
  return h(
    'div',
    { class: `floot-action${open ? ' open' : ''}`, 'data-tool': name },
    h(
      'button',
      {
        type: 'button',
        class: 'floot-action-head',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen(!open),
      },
      h(
        'span',
        { class: 'floot-caret', 'aria-hidden': 'true' },
        open ? '▾' : '▸',
      ),
      h('span', { class: 'floot-action-name' }, name),
      h('span', { class: 'floot-action-preview' }, preview),
      msg.failed === true
        ? h('span', { class: 'floot-action-running' }, 'failed')
        : null,
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
 * One collapsible group of thoughts and tool calls.
 *
 * @param {{ actions: ShownMessage[] }} props
 */
export const ToolGroup = ({ actions }) => {
  const [open, setOpen] = useState(false);
  const now = useNow(actions.some(thoughtRunning));
  const summary = summarizeActions(actions, now);
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
        h(
          'span',
          { class: 'floot-caret', 'aria-hidden': 'true' },
          open ? '▾' : '▸',
        ),
        h('span', { class: 'floot-actions-count' }, summary.label),
        summary.detail
          ? h('span', { class: 'floot-actions-detail' }, summary.detail)
          : null,
      ),
      open
        ? h(
            'div',
            { class: 'floot-actions-body' },
            actions.map((entry, index) =>
              isThought(entry)
                ? h(ThoughtEntry, { key: `thought-${index}`, msg: entry, now })
                : h(ActionEntry, { key: `action-${index}`, msg: entry }),
            ),
          )
        : null,
    ),
  );
};
