// @ts-check
// Usage (mints the admin capability at pet name `android-admin`):
//   endo run --UNCONFINED packages/host-android-admin/src/setup-android.js \
//     --powers @agent \
//     -E ENDO_ANDROID_POLICY='{"allowedActions":["getDeviceState","lockNow"]}'
//
// Requires --powers @agent because the script calls makeUnconfined(),
// evaluate(), and move().

/**
 * Boot-time bring-up for the on-device Android administration agent.
 *
 * Runs the whole device-side provisioning sequence the design calls for:
 * install the iroh transport so the device is reachable by NodeId without an
 * open port, mint the admin capability kit, and name its two facets so the
 * vendable one can be attached to a message while the control one stays put.
 *
 * Vending itself is deliberately *not* automated here.  Handing administrative
 * authority over a physical device to a remote peer is an act an operator
 * should perform explicitly, against a peer they have already accepted; a
 * bring-up script that auto-vended on boot would grant that authority every
 * time the device restarted, to whatever peer currently holds the name.
 */

import { E } from '@endo/eventual-send';

/** @import { ERef } from '@endo/eventual-send' */

const adminSpecifier = new URL('index.js', import.meta.url).href;
const irohSetupSpecifier = new URL(
  '../../daemon/src/networks/setup-iroh.js',
  import.meta.url,
).href;

/**
 * @param {ERef<any>} powers - HOST/@agent powers.
 * @param {object} [_context]
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 */
export const main = async (powers, _context, { env = {} } = {}) => {
  await null;
  const policy = env.ENDO_ANDROID_POLICY;
  if (typeof policy !== 'string' || policy.length === 0) {
    throw new Error(
      'setup-android: ENDO_ANDROID_POLICY is required; it is the JSON policy bounding what the vended capability may do',
    );
  }
  // Fail here rather than at first use: a malformed policy that only surfaces
  // when an operator tries to lock the device is a bad time to learn about it.
  JSON.parse(policy);

  const bridge = env.ENDO_ANDROID_BRIDGE || 'nodejs-mobile';
  const notes = [];

  // 1. Reachability. iroh dials keys, not IPs, so the device needs no open
  //    port and no public address — the property that makes a phone behind
  //    CGNAT reachable from HQ at all.
  if (env.ENDO_ANDROID_SKIP_IROH === '1') {
    notes.push('skipped iroh install');
  } else {
    const hasIroh = await E(powers).has(['@nets', 'iroh']);
    if (hasIroh) {
      notes.push('iroh already installed');
    } else {
      const { main: installIroh } = await import(irohSetupSpecifier);
      await installIroh(powers);
      notes.push('iroh installed at @nets/iroh');
    }
  }

  // 2. The capability kit.  The formula returns a kit rather than a bare
  //    client so the control facet stays reachable on the device.
  await E(powers).makeUnconfined(undefined, adminSpecifier, {
    powersName: '@none',
    resultName: 'android-admin-kit',
    env: {
      policy,
      bridge,
      ...(env.ENDO_ANDROID_TIMEOUT_MS
        ? { timeoutMs: env.ENDO_ANDROID_TIMEOUT_MS }
        : {}),
    },
  });

  // 3. Name the facets separately, so attaching the vendable one to a message
  //    cannot drag the control one along with it.
  await E(powers).evaluate(
    undefined,
    'E(kit).client()',
    ['kit'],
    ['android-admin-kit'],
    ['android-admin'],
  );
  await E(powers).evaluate(
    undefined,
    'E(kit).control()',
    ['kit'],
    ['android-admin-kit'],
    ['android-admin-control'],
  );

  return [
    `android admin installed (bridge ${bridge}; ${notes.join('; ')})`,
    'vend with:  @<peer> android admin @android-admin',
    'keep `android-admin-control` on this device: it can re-scope policy and revoke.',
  ].join('\n');
};
harden(main);
