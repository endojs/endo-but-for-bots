// @ts-check
/**
 * The Settings view (m3-interfaces.md 6.2, 9.1): opened by the header's
 * Settings control, it replaces the main region (no composer, no status
 * bar). A vertical list on the left selects a section, which renders on
 * the right; at `drawerMaxWidthPx` or less the list is a horizontal row on
 * top (`settings.css`).
 *
 * Sections: one per `app.panel` feature that `when(context)` shows (its
 * `label`), and "This session" with the `session.settings` features of the
 * active session. A `session.settings` component may answer nothing (the
 * environment's section for a session without a shell, or while it
 * reads), so those features stay mounted, hidden, while the view is open
 * and "This session" is listed only once one of them has rendered
 * something: the view never opens on an empty pane.
 *
 * The selected section is `state.settings.section`; absent or no longer
 * listed, the view shows "This session" when it is listed, else the first
 * global section. Escape (outside a text field) closes the view.
 */
import { h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { FeatureHost, Slot, visibleFeatures } from './Slot.js';

/** @import { UiFeature, FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/** The section id of the `session.settings` slot. */
export const sessionSection = 'session';

export const settingsTexts = harden({
  title: 'Settings',
  open: 'Open settings',
  close: 'Close settings (Esc)',
  sections: 'Settings sections',
  thisSession: 'This session',
  nothing: 'Nothing to configure here.',
});

/**
 * Whether a key press belongs to a field that handles Escape itself.
 *
 * @param {any} target
 */
const editable = target =>
  Boolean(
    target &&
    (target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)),
  );

/**
 * Whether the hidden or shown `session.settings` slot has rendered
 * anything.
 *
 * @param {any} element
 */
const hasContent = element =>
  Boolean(element?.querySelector('[data-slot="session.settings"] > *'));

/**
 * @param {{
 *   state: any,
 *   controller: any,
 *   features: readonly UiFeature[],
 *   context: FeatureContext,
 *   sessionFeatures: boolean,
 * }} props `sessionFeatures`: whether the active session's
 *   `session.settings` apply (a session is open and not an inspected
 *   subagent)
 */
export const Settings = ({
  state,
  controller,
  features,
  context,
  sessionFeatures,
}) => {
  const sessionRef = useRef(/** @type {any} */ (null));
  const [sessionShown, setSessionShown] = useState(false);

  // Follow what the session's features render, also when one of them
  // changes on its own (an answer arriving), which does not draw the view.
  useLayoutEffect(() => {
    const element = sessionRef.current;
    if (!element) {
      setSessionShown(false);
      return undefined;
    }
    const check = () => setSessionShown(hasContent(element));
    check();
    const Observer = element.ownerDocument?.defaultView?.MutationObserver;
    if (typeof Observer !== 'function') return undefined;
    const observer = new Observer(check);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [sessionFeatures, state.activeKey]);

  useLayoutEffect(() => {
    const document = sessionRef.current?.ownerDocument ?? globalThis.document;
    if (!document) return undefined;
    /** @param {any} event */
    const onKey = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (editable(event.target)) return;
      controller.closeSettings();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [controller]);

  const panels = visibleFeatures(features, 'app.panel', context);
  /** @type {Array<{ id: string, label: string }>} */
  const sections = [
    ...(sessionFeatures && sessionShown
      ? [{ id: sessionSection, label: settingsTexts.thisSession }]
      : []),
    ...panels.map(feature => ({
      id: feature.id,
      label: feature.label ?? feature.id,
    })),
  ];
  const wanted = state.settings?.section;
  const selected = sections.some(section => section.id === wanted)
    ? wanted
    : sections[0]?.id;
  const panel = panels.find(feature => feature.id === selected);

  return h(
    'div',
    { id: 'thix-settings', class: 'thix-settings', 'data-selected': selected },
    h(
      'nav',
      { class: 'thix-settings-nav', 'aria-label': settingsTexts.sections },
      sections.map(section =>
        h(
          'button',
          {
            key: section.id,
            type: 'button',
            class: `thix-settings-item${section.id === selected ? ' on' : ''}`,
            'data-section': section.id,
            'aria-current': section.id === selected ? 'page' : undefined,
            onClick: () => controller.selectSettingsSection(section.id),
          },
          section.label,
        ),
      ),
    ),
    h(
      'div',
      { class: 'thix-settings-content' },
      sessionFeatures
        ? h(
            'section',
            {
              ref: sessionRef,
              class: 'thix-settings-section',
              'data-section': sessionSection,
              hidden: selected !== sessionSection,
            },
            h('h2', null, settingsTexts.thisSession),
            h(Slot, { slot: 'session.settings', features, context }),
          )
        : null,
      panel
        ? h(
            'section',
            {
              key: panel.id,
              class: 'thix-settings-section',
              'data-section': panel.id,
              'data-panel': panel.id,
            },
            h(FeatureHost, {
              key: panel.id,
              feature: panel,
              props: { context },
            }),
          )
        : null,
      selected === undefined
        ? h('p', { class: 'thix-settings-empty' }, settingsTexts.nothing)
        : null,
    ),
  );
};
