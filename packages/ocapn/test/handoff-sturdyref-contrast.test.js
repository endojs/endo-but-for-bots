// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import { testWithErrorUnwrapping, makeTestClient } from './_util.js';
import { encodeSwissnum } from '../src/client/util.js';
import { makeGrantDetails } from '../src/client/grant-tracker.js';

/** @import { SwissNum } from '../src/client/types.js' */

// Live-handoff contrast (design cut 6; see
// designs/sturdy-refs-cross-peer-bridge.md § 3 "Contrast with live-reference
// handoff"). A SturdyRef pass and a live `desc:handoff-give` handoff are the two
// tiers a gifter chooses between: the SturdyRef delegates durable, offline
// re-acquisition authority; the live handoff introduces a session-scoped
// reference. Both compose on the SAME remotable — the grant tracker permits
// exactly the `handoff -> sturdy-ref` upgrade, so a presence a peer first
// imported live can later be recognized as sturdy-granted when the exporter
// mints and passes a SturdyRef for the same object. This test drives that over a
// real session: a live-imported reference works AND its grant is the sanctioned
// upgrade target.

/**
 * @param {string} s
 * @returns {SwissNum}
 */
const swissNum = s => /** @type {SwissNum} */ (/** @type {unknown} */ (s));

testWithErrorUnwrapping(
  'a live-imported reference works and its grant upgrades handoff -> sturdy-ref (never the reverse)',
  async t => {
    // Exporter A serves a live object; Receiver B imports it over a real
    // session — the live introduction that a `desc:handoff-give` handoff
    // realizes across sessions.
    const obj = Far('Obj', { getNumber: () => 42 });
    const aKit = await makeTestClient({
      debugLabel: 'A',
      makeDefaultSwissnumTable: () => new Map([['Obj', obj]]),
    });
    const locationA = aKit.location;

    const bKit = await makeTestClient({ debugLabel: 'B' });

    try {
      // B imports the live reference from A. Importing records a `handoff` grant
      // for the presence in B's grant tracker (the live/session tier).
      const sessionA = await bKit.debug.provideInternalSession(locationA);
      const bootstrapA = sessionA.ocapn.getRemoteBootstrap();
      const presence = await E(bootstrapA).fetch(encodeSwissnum('Obj'));

      // The live introduction still works — the same object is reachable.
      t.is(await E(presence).getNumber(), 42, 'the live-imported reference works');

      const grantTracker = bKit.debug.grantTracker;
      const live = grantTracker.getGrantDetails(presence);
      assert(live, 'B recorded a grant for the live-imported presence');
      t.is(live.type, 'handoff', 'a live import is recorded as a handoff grant');

      // The SturdyRef follows: the exporter mints and passes a SturdyRef for the
      // SAME object. Recording the sturdy-ref grant on the same remotable is the
      // ONE sanctioned transition — the grant tracker records the upgrade.
      const upgraded = makeGrantDetails(
        live.location,
        live.slot,
        'sturdy-ref',
        swissNum('swiss-for-the-same-object'),
      );
      t.notThrows(
        () => grantTracker.recordImport(presence, upgraded),
        'handoff -> sturdy-ref upgrade is permitted for the same remotable',
      );
      t.is(
        grantTracker.getGrantDetails(presence)?.type,
        'sturdy-ref',
        'the presence is now recognized as sturdy-granted',
      );
      t.is(
        grantTracker.getGrantDetails(presence)?.swissNum,
        swissNum('swiss-for-the-same-object'),
        'the upgrade carries the sturdy-ref swiss-num',
      );

      // The reverse (sturdy-ref -> handoff) is NOT a valid transition: a durable
      // grant never silently downgrades to a session-scoped one.
      const freshPresence = Far('Fresh', {});
      grantTracker.recordImport(
        freshPresence,
        makeGrantDetails(live.location, live.slot, 'sturdy-ref', swissNum('s2')),
      );
      t.throws(
        () =>
          grantTracker.recordImport(
            freshPresence,
            makeGrantDetails(live.location, live.slot, 'handoff'),
          ),
        { message: /Invalid grant type transition/ },
        'sturdy-ref -> handoff is rejected',
      );
    } finally {
      bKit.client.shutdown();
      aKit.client.shutdown();
    }
  },
);
