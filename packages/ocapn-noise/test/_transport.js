// @ts-check

/**
 * Register a transport and explicitly open its inbound listener.
 *
 * @param {import('../src/types.js').OcapnNoiseNetwork} network
 * @param {import('../src/types.js').OcapnNoiseTransport} transport
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
