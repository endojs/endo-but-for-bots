// @ts-check
/**
 * The environment image pin (contract `designs/m6-interfaces.md` P-55, 5.2,
 * 5.3; spec R8-41, R8-42): an image is named by digest, never pulled, and
 * the runner refuses to run anything when the pin is not a digest or the
 * image is absent locally.
 *
 * `isDigestPin` is the form check, applied before any runtime sees the
 * string (a pin is an argv entry of the container CLI). `checkImagePin` is
 * the start gate: the environments adapter's `bind` asks it, and M12's
 * service start calls it with the configured runtime. Reasons are fixed
 * texts: no runtime output (which may name host paths) reaches a caller.
 *
 * Node only (adapter); no state.
 */

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  environmentLimits,
  environmentTexts,
} from '../../../guest/lib/guards/environments.js';
/* eslint-enable import/no-relative-packages */

/** @import { Runtime } from './runtime-fake.js' */

// The image reference grammar of the OCI distribution spec, restricted to
// `<name>@sha256:<64 lowercase hex>` (no tag: the digest is the whole pin).
// A first component with a dot or a port, or `localhost`, is a registry.
const domainComponent = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const domain = `(?:localhost(?::[0-9]+)?|${domainComponent}(?:\\.${domainComponent})+(?::[0-9]+)?|${domainComponent}:[0-9]+)`;
const pathComponent = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const digestPinPattern = new RegExp(
  `^(?:${domain}/)?${pathComponent}(?:/${pathComponent})*@sha256:[0-9a-f]{64}$`,
);

/**
 * True when `pin` is `<repository>@sha256:<64 hex>` within
 * `environmentLimits.imagePinUnits`. A tag, a short or uppercase digest, an
 * empty repository, a leading `-` or any whitespace is refused.
 * @param {unknown} pin
 * @returns {boolean}
 */
export const isDigestPin = pin =>
  typeof pin === 'string' &&
  pin.length <= environmentLimits.imagePinUnits &&
  digestPinPattern.test(pin);
harden(isDigestPin);

/**
 * The start gate (R8-42): the pin's form first (no runtime call for a
 * refused form), then the runtime's own presence check. The `fake` runtime
 * runs no image, so its own `check` decides.
 * @param {object} options
 * @param {Pick<Runtime, 'kind' | 'check'>} options.runtime
 * @param {string | undefined} options.image the configured pin
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export const checkImagePin = async ({ runtime, image }) => {
  if (runtime.kind !== 'fake' && !isDigestPin(image)) {
    return harden({ ok: false, reason: environmentTexts.imageRefused });
  }
  return runtime.check(harden({ image }));
};
harden(checkImagePin);
