// Shared helper for the two-process OCapN-over-Noise toy demo.
//
// Builds one @endo/ocapn instance backed by a Noise (IK) network wired to a
// real transport (WebSocket/HTTP or TCP+CBOR). This mirrors the in-process
// `makeNoisePeer` helper in test/integration.test.js, but takes a live
// transport so two OS processes can connect over a real socket.

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';

import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';

import { makeOcapnNoiseNetwork } from '../index.js';

export { E, Far };

/**
 * @param {{
 *   name: string,
 *   transport: any,
 *   locator?: Map<string, any>,
 * }} options
 */
export const makeNoisePeer = async ({ name, transport, locator = new Map() }) => {
  const network = makeOcapnNoiseNetwork({ codec: cborCodec });
  const signingKeys = network.generateSigningKeys();
  const keyId = network.addSigningKeys(signingKeys);
  await network.addTransport(transport);
  const location = network.locationFor(keyId);
  const client = await makeOcapn({
    codec: cborCodec,
    network: /** @type {any} */ (network),
    debugLabel: name,
    locator,
    debugMode: true,
  });
  return { client, network, keyId, location, locator };
};
