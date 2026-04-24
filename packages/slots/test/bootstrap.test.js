// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { Direction, Kind } from '../src/descriptor.js';
import { makeCList } from '../src/clist.js';
import { makeSlotCodec } from '../src/codec.js';
import { makeSlotClient } from '../src/client.js';
import { LOCAL_ROOT, REMOTE_ROOT, bootstrap } from '../src/bootstrap.js';

test('LOCAL_ROOT and REMOTE_ROOT sit at Object position 1', t => {
  t.deepEqual(
    { ...LOCAL_ROOT },
    { dir: Direction.Local, kind: Kind.Object, position: 1 },
  );
  t.deepEqual(
    { ...REMOTE_ROOT },
    { dir: Direction.Remote, kind: Kind.Object, position: 1 },
  );
});

test('bootstrap exports local root and creates a remote presence', t => {
  const clist = makeCList({ label: 'w' });
  const codec = makeSlotCodec({
    clist,
    makePresence: () => ({}),
    marshalName: 'w',
  });
  const client = makeSlotClient({
    clist,
    codec,
    sendEnvelope: () => {},
  });

  const rootObject = Far('root', { ping: () => 1 });
  const { localDesc, remoteRoot } = bootstrap({
    clist,
    client,
    root: rootObject,
  });

  t.deepEqual({ ...localDesc }, { ...LOCAL_ROOT });
  t.truthy(remoteRoot);
  // The c-list now has both entries: local root and remote root
  // presence.  Looking up either direction returns the expected
  // counterpart.
  t.deepEqual(clist.lookupByValue(rootObject), LOCAL_ROOT);
});
