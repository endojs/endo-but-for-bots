// @ts-check
import '@endo/init';
import { decodeBase64, encodeBase64 } from '@endo/base64';
import { makeOcapn } from '@endo/ocapn';
import { syrupCodec } from '@endo/ocapn/syrup';
import { createRequire } from 'node:module';
import process from 'node:process';

import { isRemotable } from '../../is-remotable.js';
import { makePipeNetwork } from '../../net/pipe-network.js';
import { silentLogger } from '../logging.js';
import { makeNodePowers } from './powers.js';

const [workerId, bundlePath, bundleDigest] = process.argv.slice(2);
const { files, hashes, random } = makeNodePowers();
const pipe = makePipeNetwork({
  codec: syrupCodec,
  workerId,
  role: 'worker',
  send: bytes => process.send?.({ frame: encodeBase64(bytes) }),
});
process.on('disconnect', () => process.exit(0));
process.on('message', message => {
  const { frame } = /** @type {{frame: string}} */ (message);
  pipe.deliver(decodeBase64(frame));
});

try {
  // The digest is checked here, in the process that will load the bundle,
  // over the bytes that are there: a file that is not the one installed
  // does not run.
  const bytes = await files.readBytes(bundlePath);
  const actual = hashes.sha256Hex(bytes);
  if (actual !== bundleDigest)
    throw Error(
      `Native resource bundle ${bundlePath} does not match its installed digest ${bundleDigest}; remove the installation and install the resource again`,
    );
  const namespace = createRequire(import.meta.url)(bundlePath);
  if (typeof namespace.make !== 'function')
    throw Error('Native ephemeral module must export make(powers)');
  const root = await namespace.make(harden({}));
  if (!isRemotable(root))
    throw Error('Native ephemeral module must return a remotable root');
  const client = await makeOcapn({
    randomBytes: random.randomBytes,
    logger: silentLogger,
    codec: syrupCodec,
    network: pipe.network,
    locator: new Map([['root', root]]),
    debugLabel: workerId,
  });
  await client.provideSession(pipe.peerLocation);
  process.send?.({ ready: true });
} catch (error) {
  console.error(error);
  process.exit(1);
}
