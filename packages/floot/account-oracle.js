// @ts-check

/**
 * Floot's account-oracle caplet: the retained `make-unconfined` entrypoint
 * `floot-factory-setup.js` provisions under `<dir>/account-oracle`.
 *
 * It is the shared entrypoint of `@endo/hosted-agent`, which the hosted
 * adapters also provision, one per subscription. This file stays because the
 * formulas already minted name it as their specifier.
 *
 * Its namespace may hold `account-profile` (the operator's declared plan,
 * quota and price list) and `account-source` (a capability with `observe()`,
 * and optionally `watch()` and `refresh()`), and the journal of what was
 * observed. See
 * `@endo/hosted-agent/account-oracle-module.js`.
 */
export { make } from '@endo/hosted-agent/account-oracle-module.js';
