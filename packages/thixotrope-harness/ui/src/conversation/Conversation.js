// @ts-check
/**
 * The conversation region (P-22; m3-interfaces.md 9.3; W3.6): the `</>`
 * toggle, the transcript (or its raw JSON) and the
 * queue. The shell renders it in its main region and the `Composer` below
 * it; `Recovery` replaces it while the recovery panel is open. The view
 * renders the controller's state and calls only controller actions.
 *
 * Scrolling: the transcript follows new content while the reader is at its
 * bottom, and stays put once they scroll up.
 */
import { h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { uiTexts } from '../../../resources/agent-host/impl/gateway/protocol.js';
import { labels } from './labels.js';
import { MessageList } from './MessageList.js';
import { Queue } from './Queue.js';
import { RawView } from './RawView.js';

/** @import { UiFeature, FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */

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
  const scroller = useRef(/** @type {HTMLDivElement | null} */ (null));
  const stick = useRef(true);
  const view = state.view;
  const generation = useRef(-1);
  const previousTop = useRef(0);
  const lastAutoPage = useRef(/** @type {string | undefined} */ (undefined));
  const anchor = useRef(
    /** @type {{node: Element, offset: number} | undefined} */ (undefined),
  );

  const requestEarlier = () => {
    const element = scroller.current;
    if (!element || state.connection !== 'open' || view?.earlier !== 'more')
      return;
    const node = element.querySelector(
      raw ? '.thix-raw-view > :first-child' : '.thix-turn',
    );
    if (node)
      anchor.current = {
        node,
        offset:
          node.getBoundingClientRect().top +
          element.scrollTop -
          element.getBoundingClientRect().top,
      };
    void controller.loadEarlier();
  };

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !view) return;
    if (generation.current !== view.generation) {
      generation.current = view.generation;
      stick.current = true;
      anchor.current = undefined;
      lastAutoPage.current = undefined;
    }
    const saved = anchor.current;
    if (saved && view.earlier !== 'loading') {
      if (!stick.current && element.contains(saved.node)) {
        const current =
          saved.node.getBoundingClientRect().top +
          element.scrollTop -
          element.getBoundingClientRect().top;
        element.scrollTop += current - saved.offset;
      }
      anchor.current = undefined;
    }
    if (stick.current) element.scrollTop = element.scrollHeight;
    previousTop.current = element.scrollTop;
    // Fill a tall viewport until it has content the reader can scroll.
    const firstId = view.messages[0]?.turnId;
    if (
      element.clientHeight > 0 &&
      element.scrollHeight <= element.clientHeight &&
      view.earlier === 'more' &&
      firstId &&
      firstId !== lastAutoPage.current
    ) {
      lastAutoPage.current = firstId;
      requestEarlier();
    }
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
      role: 'region',
      'aria-label': labels.history,
      'aria-busy': view.earlier === 'loading',
      tabIndex: 0,
      ref: scroller,
      onScroll: () => {
        const element = scroller.current;
        if (!element) return;
        const towardTop = element.scrollTop < previousTop.current;
        previousTop.current = element.scrollTop;
        stick.current =
          element.scrollHeight - element.scrollTop - element.clientHeight <
          STICK_PX;
        if (towardTop && element.scrollTop < 120) requestEarlier();
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

    empty
      ? h('div', { class: 'floot-empty-state' }, labels.emptyConversation)
      : null,
    raw
      ? h(RawView, { view })
      : h(MessageList, { view, controller, features, context }),
    raw ? null : h(Queue, { state, controller }),
  );
};
