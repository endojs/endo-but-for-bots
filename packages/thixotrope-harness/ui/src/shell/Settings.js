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
 * The selected section is `state.settings.section`. With none chosen, the
 * view waits up to `settingsSettleMs` for "This session" (no global panel
 * is mounted just to be replaced: Subscriptions reads provider usage on
 * mount), then shows the first listed section and keeps it until the user
 * picks one. The list is a tablist (arrow keys, Home and End move between
 * tabs; Enter or Space selects); opening focuses the selected tab and
 * closing returns focus to the header's Settings control. Escape closes
 * the view, except in a text field or when another layer (the New session
 * dialog) has it. Page-wide errors (`state.status`), which the hidden
 * status bar would show, are shown above the section.
 */
import { h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { FeatureHost, Slot, visibleFeatures } from './Slot.js';

/** @import { UiFeature, FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/** The section id of the `session.settings` slot. */
export const sessionSection = 'session';

/** The header's Settings control. */
export const settingsToggleId = 'thix-settings-toggle';

/**
 * How long the view waits, when no section was chosen, for the session's
 * sections to show something before it opens a global section instead.
 */
export const settingsSettleMs = 1000;

export const settingsTexts = harden({
  title: 'Settings',
  open: 'Open settings',
  close: 'Close settings (Esc)',
  sections: 'Settings sections',
  thisSession: 'This session',
  nothing: 'Nothing to configure here.',
  loading: 'Loading settings…',
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
 * Whether an Escape belongs to another layer: a dialog (New session) that
 * handled it or is open.
 *
 * @param {any} event
 * @param {any} state
 */
const otherLayer = (event, state) =>
  Boolean(
    state.newSessionOpen ||
    event.target?.closest?.(
      '[role="dialog"], [aria-modal="true"], .floot-modal-backdrop',
    ),
  );

/** @param {string} id */
const tabId = id => `thix-settings-tab-${id}`;
/** @param {string} id */
const panelId = id => `thix-settings-panel-${id}`;

/**
 * @param {{
 *   state: any,
 *   controller: any,
 *   features: readonly UiFeature[],
 *   context: FeatureContext,
 *   sessionFeatures: boolean,
 *   narrow?: boolean,
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
  narrow = false,
}) => {
  const rootRef = useRef(/** @type {any} */ (null));
  const navRef = useRef(/** @type {any} */ (null));
  const sessionRef = useRef(/** @type {any} */ (null));
  const [sessionShown, setSessionShown] = useState(false);
  const [settled, setSettled] = useState(false);
  /** The default section once chosen: kept until the user picks one. */
  const fallback = useRef(/** @type {string | undefined} */ (undefined));
  const focused = useRef(false);

  // Follow what the session's features render, also when one of them
  // changes on its own (an answer arriving), which does not draw the view.
  useLayoutEffect(() => {
    const element = sessionRef.current;
    if (!element) {
      setSessionShown(false);
      return undefined;
    }
    const check = () => {
      const shown = hasContent(element);
      setSessionShown(shown);
      // Settled once it has shown: emptied later, the view falls back.
      if (shown) setSettled(true);
    };
    check();
    const Observer = element.ownerDocument?.defaultView?.MutationObserver;
    if (typeof Observer !== 'function') return undefined;
    const observer = new Observer(check);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [sessionFeatures, state.activeKey]);

  const wanted = state.settings?.section;
  const waiting =
    sessionFeatures &&
    !sessionShown &&
    !settled &&
    (wanted === undefined || wanted === sessionSection);

  // The session's sections get `settingsSettleMs` to show something before
  // a global section is chosen in their place.
  useLayoutEffect(() => {
    if (!waiting) return undefined;
    const view = rootRef.current?.ownerDocument?.defaultView;
    if (!view) {
      setSettled(true);
      return undefined;
    }
    const timer = view.setTimeout(() => setSettled(true), settingsSettleMs);
    return () => view.clearTimeout(timer);
  }, [waiting]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const document = root?.ownerDocument ?? globalThis.document;
    if (!document) return undefined;
    /** @param {any} event */
    const onKey = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (editable(event.target)) return;
      if (otherLayer(event, controller.getState())) return;
      controller.closeSettings();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Closing: focus inside the view (or already lost) goes back to the
      // Settings control; focus the user moved elsewhere stays there.
      const active = document.activeElement;
      if (!active || active === document.body || root?.contains(active)) {
        document.getElementById(settingsToggleId)?.focus();
      }
    };
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
  /** @param {string | undefined} id */
  const listed = id => sections.some(section => section.id === id);
  /** @type {string | undefined} */
  let selected;
  if (listed(wanted)) {
    selected = wanted;
  } else if (!waiting) {
    if (!listed(fallback.current)) fallback.current = sections[0]?.id;
    selected = fallback.current;
  }
  const panel = panels.find(feature => feature.id === selected);

  // Opening: once a section is shown, focus its tab (unless the user has
  // moved focus elsewhere meanwhile).
  useLayoutEffect(() => {
    if (focused.current || selected === undefined) return;
    focused.current = true;
    const document = rootRef.current?.ownerDocument;
    const active = document?.activeElement;
    if (
      active &&
      active !== document.body &&
      active.id !== settingsToggleId &&
      !rootRef.current.contains(active)
    )
      return;
    navRef.current?.querySelector(`[data-section="${selected}"]`)?.focus();
  }, [selected]);

  /**
   * Arrow keys, Home and End move focus between the tabs; Enter or Space
   * selects (manual activation: a panel may call a provider when shown).
   *
   * @param {any} event
   */
  const onNavKey = event => {
    const tabs = [...navRef.current.querySelectorAll('[role="tab"]')];
    const at = tabs.indexOf(event.target);
    if (at < 0) return;
    const next = {
      ArrowDown: at + 1,
      ArrowRight: at + 1,
      ArrowUp: at - 1,
      ArrowLeft: at - 1,
      Home: 0,
      End: tabs.length - 1,
    }[/** @type {string} */ (event.key)];
    if (next === undefined) return;
    event.preventDefault();
    tabs[(next + tabs.length) % tabs.length].focus();
  };

  /**
   * @param {string} id
   * @param {Record<string, any>} attributes
   * @param {...any} children
   */
  const section = (id, attributes, ...children) =>
    h(
      'section',
      {
        ...attributes,
        class: 'thix-settings-section',
        'data-section': id,
        ...(listed(id)
          ? {
              id: panelId(id),
              role: 'tabpanel',
              'aria-labelledby': tabId(id),
            }
          : {}),
      },
      ...children,
    );

  return h(
    'div',
    {
      ref: rootRef,
      id: 'thix-settings',
      class: 'thix-settings',
      'data-selected': selected,
    },
    h(
      'nav',
      { class: 'thix-settings-nav', 'aria-label': settingsTexts.sections },
      h(
        'div',
        {
          ref: navRef,
          class: 'thix-settings-tabs',
          role: 'tablist',
          'aria-orientation': narrow ? 'horizontal' : 'vertical',
          onKeyDown: onNavKey,
        },
        sections.map(({ id, label }) =>
          h(
            'button',
            {
              key: id,
              id: tabId(id),
              type: 'button',
              role: 'tab',
              class: `thix-settings-item${id === selected ? ' on' : ''}`,
              'data-section': id,
              'aria-selected': id === selected ? 'true' : 'false',
              'aria-controls': panelId(id),
              tabIndex:
                id === selected ||
                (selected === undefined && id === sections[0].id)
                  ? 0
                  : -1,
              onClick: () => controller.selectSettingsSection(id),
            },
            label,
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'thix-settings-content' },
      state.status
        ? h(
            'p',
            { class: 'thix-settings-status', role: 'status' },
            state.status,
          )
        : null,
      sessionFeatures
        ? section(
            sessionSection,
            { ref: sessionRef, hidden: selected !== sessionSection },
            h('h2', null, settingsTexts.thisSession),
            h(Slot, { slot: 'session.settings', features, context }),
          )
        : null,
      panel
        ? section(
            panel.id,
            { key: panel.id, 'data-panel': panel.id },
            h(FeatureHost, {
              key: panel.id,
              feature: panel,
              props: { context },
            }),
          )
        : null,
      waiting && selected === undefined
        ? h(
            'p',
            { class: 'thix-settings-empty', role: 'status' },
            settingsTexts.loading,
          )
        : null,
      !waiting && selected === undefined
        ? h('p', { class: 'thix-settings-empty' }, settingsTexts.nothing)
        : null,
    ),
  );
};
