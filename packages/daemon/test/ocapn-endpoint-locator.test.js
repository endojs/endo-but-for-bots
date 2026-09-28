// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/pass-style';
import { makeFormulaNonceLocator } from '../src/networks/formula-nonce-locator.js';
import { makeWellKnownLocatorForSession } from '../src/networks/ocapn.js';

const localNode = 'a'.repeat(64);
const agentNode = 'b'.repeat(64);
const guestId = `${'1'.repeat(64)}:${agentNode}`;
const missId = `${'2'.repeat(64)}:${agentNode}`;

const makeHarness = ({ missBound = 3 } = {}) => {
  const guest = Far('Guest', {});
  const peerEntry = Far('PeerEntry', {});
  const formulaLocator = makeFormulaNonceLocator({
    provideLocalFormula: async id => {
      if (id === guestId) return guest;
      throw Error('absent');
    },
    localNodeNumber: /** @type {any} */ (localNode),
    isLocalNode: node => node === localNode || node === agentNode,
    missBound,
    logger: { error: () => {} },
  });
  let aborts = 0;
  const sessionLocator = makeWellKnownLocatorForSession(
    new Map([['endo-peer-entry', peerEntry]]),
    formulaLocator,
  )({
    remoteDesignator: 'peer',
    peerPublicKey: /** @type {any} */ (undefined),
    abortSession: () => {
      aborts += 1;
    },
  });
  return { guest, peerEntry, sessionLocator, aborts: () => aborts };
};

test('well-known swissnums are answered first and never count as misses', async t => {
  const { peerEntry, sessionLocator, aborts } = makeHarness({ missBound: 1 });
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    t.is(await sessionLocator.get('endo-peer-entry'), peerEntry);
  }
  t.is(aborts(), 0);
});

test('formula identifiers under a local agent key are redeemed', async t => {
  const { guest, sessionLocator } = makeHarness();
  t.is(await sessionLocator.get(guestId), guest);
});

test('formula misses keep the per-session bound behind the well-known table', async t => {
  const { sessionLocator, aborts } = makeHarness({ missBound: 3 });
  t.is(await sessionLocator.get(missId), undefined);
  t.is(await sessionLocator.get('endo-peer-entry-typo'), undefined);
  t.is(aborts(), 0);
  t.is(
    await sessionLocator.get(`${'3'.repeat(64)}:${'c'.repeat(64)}`),
    undefined,
  );
  t.is(aborts(), 1, 'the third miss severs the session');
  t.is(
    await sessionLocator.get(guestId),
    undefined,
    'no redemption after abort',
  );
});
