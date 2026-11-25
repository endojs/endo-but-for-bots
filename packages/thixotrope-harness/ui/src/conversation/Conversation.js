// @ts-check
/**
 * The conversation region (P-22; m3-interfaces.md 9.3; W3.6): the transcript
 * and the queue. The shell renders it in its main region and the `Composer`
 * below it; `Recovery` replaces it while the recovery panel is open. The view
 * renders the controller's state and calls only controller actions.
 *
 * Scrolling: the transcript follows new content while the reader is at its
 * bottom, and stays put once they scroll up.
 */
import { h } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

import { labels } from './labels.js';
import { MessageList } from './MessageList.js';
import { Queue } from './Queue.js';

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
  const scroller = useRef(/** @type {HTMLDivElement | null} */ (null));
  const stick = useRef(true);
  const view = state.view;
  const generation = useRef(-1);
  const previousTop = useRef(0);
  const lastAutoPage = useRef(/** @type {string | undefined} */ (undefined));
  const anchor = useRef(
    /** @type {{node: Element, offset: number} | undefined} */ (undefined),
  );

  const restored = useRef(-1);
  const lastRestorePage = useRef(/** @type {string | undefined} */ (undefined));

  useLayoutEffect(
    () =>
      controller.onReadPosition?.(() => {
        const el = scroller.current;
        if (!el || el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX)
          return undefined;
        const edge = el.getBoundingClientRect().top;
        for (const row of el.querySelectorAll('[data-turn]')) {
          const bounds = row.getBoundingClientRect();
          if (bounds.bottom > edge)
            return {
              turnId: row.getAttribute('data-turn'),
              offset: bounds.top - edge,
            };
        }
        return undefined;
      }),
    [controller],
  );

  const requestEarlier = () => {
    const element = scroller.current;
    if (!element || state.connection !== 'open' || view?.earlier !== 'more')
      return;
    const node = element.querySelector('.thix-turn');
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
      lastRestorePage.current = undefined;
    }
    const position = view.readingPosition;
    if (
      position &&
      restored.current !== view.generation &&
      view.messages.length
    ) {
      const target = [...element.querySelectorAll('[data-turn]')].find(
        row => row.getAttribute('data-turn') === position.turnId,
      );
      if (target) {
        restored.current = view.generation;
        stick.current = false;
        const delta =
          target.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          position.offset;
        element.scrollTo({
          top: element.scrollTop + delta,
          behavior: 'instant',
        });
      } else if (view.earlier !== 'none') {
        const first = view.messages[0].turnId;
        if (view.earlier === 'more' && first !== lastRestorePage.current) {
          lastRestorePage.current = first;
          void controller.loadEarlier();
        }
        return;
      }
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
    empty
      ? h('div', { class: 'floot-empty-state' }, labels.emptyConversation)
      : null,
    h(MessageList, { view, controller, features, context }),
    h(Queue, { state, controller }),
  );
};
