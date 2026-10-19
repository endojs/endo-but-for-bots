// @ts-check

/** @import { OcapnNoiseNetwork, OcapnNoiseTransport } from '../src/types.js' */

/**
 * Register a transport and explicitly open its inbound listener.
 *
 * @param {OcapnNoiseNetwork} network
 * @param {OcapnNoiseTransport} transport
 * @param {unknown} [options]
 */
export const registerListeningTransport = async (
  network,
  transport,
  options = undefined,
) => {
  network.addTransport(transport);
  return network.listen(transport, options);
};
