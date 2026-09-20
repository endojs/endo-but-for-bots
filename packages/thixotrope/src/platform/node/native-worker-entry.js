// @ts-check
import '@endo/init';
import { decodeBase64, encodeBase64 } from '@endo/base64';
import { makeOcapn } from '@endo/ocapn';
import { syrupCodec } from '@endo/ocapn/syrup';
import { randomBytes } from 'node:crypto';
import process from 'node:process';

import { makePipeNetwork } from '../../net/pipe-network.js';
import { silentLogger } from '../logging.js';

const [workerId, moduleUrl] = process.argv.slice(2);
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
  const namespace = await import(moduleUrl);
  const root = await namespace.make(harden({}));
  const client = await makeOcapn({
    randomBytes: length => new Uint8Array(randomBytes(length)),
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
