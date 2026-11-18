// @ts-check
/**
 * The conversation region (P-22; m3-interfaces.md 9.3; W3.6): the `</>`
 * toggle, "Load earlier messages", the transcript (or its raw JSON) and the
 * queue. The shell renders it in its main region and the `Composer` below
 * it; `Recovery` replaces it while the recovery panel is open. The view
 * renders the controller's state and calls only controller actions.
 *
 * Scrolling: the transcript follows new content while the reader is at its
 * bottom, and stays put once they scroll up.
 */
import { h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { uiTexts } from '../../../resources/agent-host/impl/gateway/contract-m3.js';
import { labels } from './labels.js';
import { LoadEarlier, MessageList } from './MessageList.js';
import { Queue } from './Queue.js';
import { RawView } from './RawView.js';

/** @import { UiFeature, FeatureContext } from '../../../resources/agent-host/impl/gateway/contract-m3.js' */

/** Pixels from the bottom that still count as "at the bottom". */
const STICK_PX = 48;

/**
 * @param {{
 *   state: any,
 *   controller: any,
 *   features: readonly UiFeature[],
 *   context: FeatureContext,
 * }} props
 */
export const Conversation = ({ state, controller, features, context }) => {
  const [raw, setRaw] = useState(false);
  const scroller = useRef(/** @type {any} */ (null));
  const stick = useRef(true);
  const view = state.view;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  });

  if (!view) return null;
  const empty =
    view.messages.length === 0 &&
    view.pending.length === 0 &&
    !view.busy &&
    view.earlier === 'none';

  return h(
    'div',
    {
      class: 'floot-messages thix-conversation',
      ref: scroller,
      onScroll: () => {
        const element = scroller.current;
        if (!element) return;
        stick.current =
          element.scrollHeight - element.scrollTop - element.clientHeight <
          STICK_PX;
      },
    },
    h(
      'div',
      { class: 'thix-conversation-tools' },
      h(
        'button',
        {
          type: 'button',
          class: `thix-raw-toggle${raw ? ' on' : ''}`,
          title: raw ? labels.rawOn : labels.rawOff,
          'aria-pressed': raw ? 'true' : 'false',
          onClick: () => setRaw(!raw),
        },
        uiTexts.rawView,
      ),
    ),
    h(LoadEarlier, { view, controller }),
    empty
      ? h('div', { class: 'floot-empty-state' }, labels.emptyConversation)
      : null,
    raw
      ? h(RawView, { view })
      : h(MessageList, { view, controller, features, context }),
    raw ? null : h(Queue, { state, controller }),
  );
};
