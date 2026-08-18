// @ts-check

/**
 * Composable modifiers for the functions you hand to `confineComponent`.
 *
 * A confined component receives ATTACKER-PROVIDED props (see PATTERNS.md
 * § "The trusted component owns its inputs"). Rather than bake input rules
 * into the container — which would close off legitimate shapes and hide the
 * decision — the disciplines are small higher-order functions you layer over
 * your component, only where each applies:
 *
 *   const Badge = confineComponent(
 *     withLimitedCss(withPrimitiveParams(({ h }, { text }) => …)),
 *   );
 *
 * They wrap the `(endowments, props)` function the container calls, transform
 * `props`, and delegate. `children` (the opaque sentinels the container
 * injects) is always preserved.
 */

/** @import { CompartmentEndowments } from '@endo/preact-container/compartment' */

import { freeze } from './freeze.js';

const isPrimitive = value => {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint';
};

/**
 * Keep only primitive-valued props; drop objects, arrays, functions, symbols,
 * and nullish values. `children` is preserved untouched.
 *
 * Use this where the component's parameters are DESIGNATORS that are values —
 * a label, a timestamp, a count. Do NOT use it where a parameter is a party
 * OBJECT designated by reference (e.g. `petname`): an object is exactly what
 * this drops, and that is correct — the two cases want different modifiers.
 *
 * It DROPS rather than throws, so a trusted component that must always render
 * (a security badge) is never blanked by a hostile prop; the offending param
 * is simply absent. Compose your own asserting wrapper if you want a hard
 * failure instead.
 *
 * @template {(endowments: CompartmentEndowments, props: any) => unknown} F
 * @param {F} fn
 * @returns {F}
 */
export const withPrimitiveParams = fn =>
  /** @type {any} */ (
    (endowments, props) => {
      const next = { children: props && props.children };
      if (props) {
        for (const key of Object.keys(props)) {
          if (key === 'children') continue;
          if (isPrimitive(props[key])) next[key] = props[key];
        }
      }
      return fn(endowments, next);
    }
  );
freeze(withPrimitiveParams);

const CSS_PROPS = freeze(['style', 'class', 'className']);

/**
 * Drop guest-supplied `style`, `class`, and `className` before the component
 * sees them, so a trusted component cannot be restyled, recoloured, or hidden
 * by whoever places it — the presentation is the component's own.
 *
 * This is presentation INTEGRITY for one component — it stops a component
 * being restyled by whoever places it. It does NOT constrain the CSS geometry
 * a confined GUEST emits in its own output: this container has no CSS-property
 * filter, so a guest can still draw a positioned overlay in its own box. The
 * anti-spoofing control for that is the recognizable pattern badge, not CSS
 * containment (see the package README's "What this does not do").
 *
 * @template {(endowments: CompartmentEndowments, props: any) => unknown} F
 * @param {F} fn
 * @returns {F}
 */
export const withLimitedCss = fn =>
  /** @type {any} */ (
    (endowments, props) => {
      const next = {};
      if (props) {
        for (const key of Object.keys(props)) {
          if (!CSS_PROPS.includes(key)) next[key] = props[key];
        }
      }
      return fn(endowments, next);
    }
  );
freeze(withLimitedCss);
