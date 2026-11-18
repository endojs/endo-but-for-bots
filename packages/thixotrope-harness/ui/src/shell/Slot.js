// @ts-check
/**
 * Slot rendering (m3-interfaces.md 6.2; W3.4). A slot shows the collected
 * features of one `uiSlots` name, in slot order, each that `when(context)`
 * allows. A feature that throws while rendering shows an error line in its
 * place; the page and the other features of the slot keep working.
 *
 * Isolation: `FeatureHost` calls the feature's component function itself,
 * inside a try/catch (its hooks then belong to the host, one feature per
 * host, so their order is stable), and is also an error boundary for what
 * the feature's children throw later (browser: `componentDidCatch`).
 */
import { Component, h } from 'preact';

import { selectSlot } from '../slot-order.js';
import { uiTextOf } from '../../../resources/agent-host/impl/gateway/protocol.js';

/** @import { UiFeature, FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * @param {string} id
 * @param {unknown} error
 */
export const featureError = (id, error) =>
  h(
    'div',
    { class: 'thix-feature-error', role: 'alert', 'data-feature': id },
    `${id}: ${uiTextOf.statusError(messageOf(error))}`,
  );

/**
 * Hosts one feature's component.
 *
 * @augments {Component<{ feature: UiFeature, props: Record<string, any> }, { error?: unknown }>}
 */
export class FeatureHost extends Component {
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
 * The features of `slot` that `when(context)` shows.
 *
 * @param {readonly UiFeature[]} features
 * @param {string} slot
 * @param {FeatureContext} context
 */
export const visibleFeatures = (features, slot, context) =>
  selectSlot(features, slot).filter(feature => {
    if (typeof feature.when !== 'function') return true;
    try {
      return Boolean(feature.when(context));
    } catch {
      return false;
    }
  });

/**
 * Render a slot's features. `props` are added to `{ context }` (a
 * `composer.addon` gets `input` and `replaceRange`, a `message.renderer`
 * `turn` and `record`).
 *
 * @param {object} options
 * @param {string} options.slot
 * @param {readonly UiFeature[]} options.features
 * @param {FeatureContext} options.context
 * @param {Record<string, any>} [options.props]
 * @param {string} [options.class] the wrapper's class
 */
export const Slot = ({
  slot,
  features,
  context,
  props = {},
  class: className,
}) => {
  const shown = visibleFeatures(features, slot, context);
  if (shown.length === 0) return null;
  return h(
    'div',
    { class: className ?? 'thix-slot', 'data-slot': slot },
    shown.map(feature =>
      h(FeatureHost, {
        key: feature.id,
        feature,
        props: { context, ...props },
      }),
    ),
  );
};
