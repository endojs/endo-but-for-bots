// @ts-check
/* global globalThis */
/**
 * Optimizer bootstrap shim for lal.
 *
 * The optimizer runs out of process from any SES-lockdown'd agent, so it
 * must not install full SES before loading Ax. The other optimizer
 * modules import `harden` as a global; provide a shallow shim so they
 * work when Ax (or another non-SES dependency) is the first thing
 * touched.
 *
 * Provider API key wiring is incidental: the trial runner is the seam
 * that actually reads `process.env`, but documenting the supported keys
 * here keeps the matrix of providers visible in one place. lal honors
 * `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, and
 * `OPENROUTER_API_KEY` directly, and falls back to lal's legacy
 * `LAL_AUTH_TOKEN` + `LAL_HOST` + `LAL_MODEL` when the per-provider
 * variables are absent (lal's existing model-resolution.js takes care
 * of the translation).
 */
const globals =
  /** @type {typeof globalThis & { harden?: <T>(value: T) => T }} */ (
    globalThis
  );
if (!globals.harden) {
  globals.harden = value => Object.freeze(value);
}
