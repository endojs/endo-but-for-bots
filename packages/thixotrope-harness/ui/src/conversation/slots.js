// @ts-check
/**
 * Slot rendering for the conversation views (`composer.addon`,
 * `message.renderer`; m3-interfaces.md 6.2; W3.6).
 *
 * The same rules as `ui/src/shell/Slot.js` (slot order by `order`, default
 * 100, then collection order; `when(context)`; a feature that throws while
 * rendering shows an error line in its place). It is a local copy because
 * `shell/Slot.js` imports `ui/src/features.js`, whose Node list
 * (`feature-list.js`) imports this directory's `index.js` with a top-level
 * await: a view that imports `shell/` deadlocks the module graph in Node
 * (tests). The bundle has no such cycle. When `selectSlot` moves out of
 * `features.js` (reported to the PM), this file can re-export the shell's.
 */
import { Component, h } from 'preact';

import { uiTextOf } from '../../../resources/agent-host/impl/gateway/contract-m3.js';

/** @import { UiFeature, FeatureContext } from '../../../resources/agent-host/impl/gateway/contract-m3.js' */

const DEFAULT_ORDER = 100;

/**
 * @param {unknown} error
 * @returns {string}
 */
export const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * @param {string} id
 * @param {unknown} error
 */
const featureError = (id, error) =>
  h(
    'div',
    { class: 'thix-feature-error', role: 'alert', 'data-feature': id },
    `${id}: ${uiTextOf.statusError(messageOf(error))}`,
  );

/**
 * One feature's component, isolated.
 *
 * @augments {Component<{ feature: UiFeature, props: Record<string, any> }, { error?: unknown }>}
 */
class SlotFeature extends Component {
  /** @param {unknown} error */
  componentDidCatch(error) {
    this.setState({ error });
  }

  render() {
    const { feature, props } = this.props;
    if (this.state && this.state.error !== undefined) {
      return featureError(feature.id, this.state.error);
    }
    const component = /** @type {any} */ (feature.component);
    if (
      component.prototype &&
      typeof component.prototype.render === 'function'
    ) {
      return h(component, props);
    }
    try {
      return component(props);
    } catch (error) {
      return featureError(feature.id, error);
    }
  }
}

/**
 * The features of `slot` that `when(context)` shows, in slot order.
 *
 * @param {readonly UiFeature[]} features
 * @param {string} slot
 * @param {FeatureContext} context
 * @returns {UiFeature[]}
 */
export const slotFeatures = (features, slot, context) =>
  features
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.slot === slot)
    .filter(({ item }) => {
      if (typeof item.when !== 'function') return true;
      try {
        return Boolean(item.when(context));
      } catch {
        return false;
      }
    })
    .sort(
      (a, b) =>
        (a.item.order ?? DEFAULT_ORDER) - (b.item.order ?? DEFAULT_ORDER) ||
        a.index - b.index,
    )
    .map(({ item }) => item);

/**
 * Render a slot's features with `{ context, ...props }`.
 *
 * @param {object} options
 * @param {string} options.slot
 * @param {readonly UiFeature[]} options.features
 * @param {FeatureContext} options.context
 * @param {Record<string, any>} [options.props]
 * @param {string} [options.class]
 */
export const ConversationSlot = ({
  slot,
  features,
  context,
  props = {},
  class: className,
}) => {
  const shown = slotFeatures(features, slot, context);
  if (shown.length === 0) return null;
  return h(
    'div',
    { class: className ?? 'thix-slot', 'data-slot': slot },
    shown.map(feature =>
      h(SlotFeature, {
        key: feature.id,
        feature,
        props: { context, ...props },
      }),
    ),
  );
};
