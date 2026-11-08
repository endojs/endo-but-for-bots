// @ts-check
// eslint-disable-next-line import/no-relative-packages -- Inert subscription with a real daemon formula identity.
import { makeTestInference } from '../../fae/test/session/_inference.js';

/** A durable issuer used by the Fae inference recipe across daemon restarts. */
export const make = () =>
  makeTestInference(() => 'journal evidence').subscription;
harden(make);
