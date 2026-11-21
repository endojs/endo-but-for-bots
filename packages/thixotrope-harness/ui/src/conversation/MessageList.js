// @ts-check
/**
 * The transcript (R6-45, R6-46, R6-51; m3-interfaces.md 9.3; W3.6): the
 * controller's turns oldest first, each as its user message, the
 * `message.renderer` features under it (`{ context, turn, record }`, once
 * per turn), its replies and tool groups, the streaming bubble and thinking
 * row of the live turn, and a status row for a turn that did not complete.
 * "Load earlier messages" sits above. Adapted from Floot's `MessageList`
 * at `1315bef86`: Floot drew a flat message list with string ids and
 * Endo-specific `meta`; here a row is a turn the controller holds (its
 * `TurnEntry`), keyed by `turnId`, with replies taken from the turn's live
 * fold or its transcript records (`transcript.js`).
 */
import { h } from 'preact';

import { uiTexts } from '../../../resources/agent-host/impl/gateway/protocol.js';
import { labels } from './labels.js';
import { ConversationSlot } from './slots.js';
import { StatusRow } from './StatusRow.js';
import { LongText, linkify } from './text.js';
import { ToolGroup } from './ToolGroup.js';
import {
  endingOf,
  groupMessages,
  isLive,
  showsStatusRow,
  turnContent,
} from './transcript.js';

/** @import { UiFeature, FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/** @param {{ phase: string }} props */
export const ThinkingRow = ({ phase }) => {
  const thinking = phase === '' || phase === 'thinking';
  return h(
    'div',
    { class: 'floot-msg-row assistant thix-thinking-row' },
    h(
      'div',
      {
        class: 'floot-thinking',
        ...(thinking
          ? { role: 'img', 'aria-label': uiTexts.thinking }
          : { 'aria-hidden': true }),
      },
      h('span', null),
      h('span', null),
      h('span', null),
    ),
    thinking ? null : h('span', { class: 'thix-phase' }, phase),
  );
};

/**
 * The `turn` prop of a `message.renderer` (`MessageRendererProps.turn`):
 * the turn id, its `Turn` presence when the page holds one, and the last
 * `TurnStatus` seen (the view's `current` for that turn, else the entry's).
 *
 * @param {Record<string, any>} entry
 * @param {Record<string, any> | undefined} current
 */
export const rendererTurn = (entry, current) => {
  const ending = endingOf(entry);
  const status =
    current && current.turnId === entry.turnId
      ? current
      : {
          turnId: entry.turnId,
          state: entry.state,
          at: entry.at,
          ...ending,
        };
  return {
    turnId: entry.turnId,
    ...(entry.turn ? { turn: entry.turn } : {}),
    status,
  };
};

/**
 * One turn.
 *
 * @param {{
 *   entry: Record<string, any>,
 *   view: Record<string, any>,
 *   controller: any,
 *   features: readonly UiFeature[],
 *   context: FeatureContext,
 * }} props
 */
export const TurnView = ({ entry, view, controller, features, context }) => {
  const { messages, streamingText, phase } = turnContent(entry);
  const live = isLive(entry.state);
  const record = entry.record ?? {};
  return h(
    'div',
    {
      class: `thix-turn${entry.sealed ? ' sealed' : ''}`,
      'data-turn': entry.turnId,
      'data-state': entry.state,
    },
    h(
      'div',
      { class: 'floot-msg-row user' },
      h(
        'div',
        { class: 'floot-msg' },
        h(LongText, { value: record.input, controller }),
      ),
    ),
    h(ConversationSlot, {
      slot: 'message.renderer',
      features,
      context,
      class: 'thix-renderers',
      props: { turn: rendererTurn(entry, view.current), record },
    }),
    groupMessages(messages).map(row =>
      row.kind === 'actions'
        ? h(ToolGroup, { key: `actions-${row.index}`, actions: row.actions })
        : h(
            'div',
            { key: `msg-${row.index}`, class: `floot-msg-row ${row.msg.role}` },
            h(
              'div',
              { class: 'floot-msg' },
              h(LongText, { value: row.msg.text, controller }),
            ),
          ),
    ),
    live && streamingText
      ? h(
          'div',
          { class: 'floot-msg-row assistant streaming' },
          h('div', { class: 'floot-msg' }, ...linkify(streamingText)),
        )
      : null,
    live && !streamingText
      ? h(ThinkingRow, { phase: phase || view.phase || '' })
      : null,
    !live && showsStatusRow(entry.state)
      ? h(StatusRow, { entry, controller })
      : null,
  );
};

/**
 * "Load earlier messages" (vat pages, then archived pages; the controller
 * chooses).
 *
 * @param {{ view: Record<string, any>, controller: any }} props
 */
export const LoadEarlier = ({ view, controller }) =>
  view.earlier === 'none'
    ? null
    : h(
        'button',
        {
          type: 'button',
          class: 'floot-history-earlier',
          disabled: view.earlier === 'loading',
          onClick: () => controller.loadEarlier(),
        },
        view.earlier === 'loading'
          ? labels.loadingEarlier
          : uiTexts.loadEarlier,
      );

/**
 * @param {{
 *   view: Record<string, any>,
 *   controller: any,
 *   features: readonly UiFeature[],
 *   context: FeatureContext,
 * }} props
 */
export const MessageList = ({ view, controller, features, context }) => {
  const turns = view.messages.map((/** @type {Record<string, any>} */ entry) =>
    h(TurnView, {
      key: entry.turnId,
      entry,
      view,
      controller,
      features,
      context,
    }),
  );
  // A turn that started before any entry shows (busy with no live entry
  // yet): the thinking row still says something is under way.
  const liveShown = view.messages.some(
    (/** @type {Record<string, any>} */ entry) => isLive(entry.state),
  );
  return h(
    'div',
    { class: 'thix-transcript' },
    turns,
    view.busy && !liveShown
      ? h(ThinkingRow, { phase: view.phase || '' })
      : null,
  );
};
