// @ts-check
/* global globalThis */
/**
 * Optimizer bootstrap shim.
 *
 * The optimizer runs out of process from any SES-lockdown'd agent, so it
 * must not install full SES before loading Ax. The other optimizer
 * modules import `harden` as a global; provide a shallow shim so they
 * work when Ax (or another non-SES dependency) is the first thing
 * touched.
 *
 * Provider API key wiring is incidental: the consumer's trial runner is
 * the seam that actually reads `process.env`. The CLI's `makeAxAI`
 * recognizes `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`,
 * and `OPENROUTER_API_KEY` directly; the consumer can supply its own
 * `makeAxAI` override (e.g. to honor a legacy auth-token env var)
 * through the CLI's config object.
 */
const globals =
  /** @type {typeof globalThis & { harden?: <T>(value: T) => T }} */ (
    globalThis
  );
export const hardenShimMarker = Symbol.for(
  '@endo/agentry/optimizer/init/hardenShim',
);
if (!globals.harden) {
  const shim = value => Object.freeze(value);
  Object.defineProperty(shim, hardenShimMarker, {
    configurable: true,
    value: true,
  });
  globals.harden = shim;
}
