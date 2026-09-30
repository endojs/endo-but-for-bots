// @ts-check
import '@endo/init';
import { decodeBase64, encodeBase64 } from '@endo/base64';
import { makeOcapn } from '@endo/ocapn';
import { syrupCodec } from '@endo/ocapn/syrup';
import process from 'node:process';

import { describeNativePackage } from '../../native/describe-package.js';
import { makePipeNetwork } from '../../net/pipe-network.js';
import { silentLogger } from '../logging.js';
import { makeNodePowers } from './powers.js';

const [workerId, moduleUrl, packageJson] = process.argv.slice(2);
const { files, paths, hashes, random } = makeNodePowers();
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
  const identity = JSON.parse(packageJson ?? 'null');
  if (identity !== null) {
    // The digest is checked here, in the process that will import the
    // module, so an edit between installation and start cannot slip in.
    const actual = await describeNativePackage(
      { files, paths, hashes },
      identity.directory,
    );
    if (actual.digest !== identity.digest || actual.moduleUrl !== moduleUrl)
      throw Error(
        'Installed native package has changed; install its new version explicitly',
      );
  }
  const namespace = await import(moduleUrl);
  if (typeof namespace.make !== 'function')
    throw Error('Native ephemeral module must export make(powers)');
  const root = await namespace.make(harden({}));
  if (root?.[Symbol.for('passStyle')] !== 'remotable')
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
