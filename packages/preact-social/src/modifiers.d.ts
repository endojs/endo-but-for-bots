import type { CompartmentEndowments } from '@endo/preact-container/compartment';

/**
 * A function of the shape `confineComponent` calls: `(endowments, props)`.
 */
export type ConfinedRender = (
  endowments: CompartmentEndowments,
  props: Record<string, unknown>,
) => unknown;

/**
 * Keep only primitive-valued props (string/number/boolean/bigint); drop
 * objects, arrays, functions, symbols, and nullish. `children` is preserved.
 * Use for value designators (label, timestamp, count); NOT for a party object
 * designated by reference. Drops rather than throws, so an always-render
 * component is never blanked by a hostile prop.
 */
export function withPrimitiveParams<F extends ConfinedRender>(fn: F): F;

/**
 * Drop guest-supplied `style`, `class`, and `className` before the component
 * sees them, so it cannot be restyled, recoloured, or hidden by whoever places
 * it. Orthogonal to `renderConfined({ strictStyle })`, which constrains the
 * guest subtree's own CSS.
 */
export function withLimitedCss<F extends ConfinedRender>(fn: F): F;
