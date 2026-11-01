// @ts-check
/* eslint-disable no-continue */
import { E } from '@endo/eventual-send';
import { parseApplicationConfig } from '@endo/browser-endo/application.js';
import { formatLocatorWithHints } from '@endo/daemon/locator.js';

/** Upgrade an existing hosted link only to a relay on the same trusted host.
 * Local gateways, Android bridges and peers without a relay keep compatibility.
 * @param {string} gateway
 * @param {string} agent
 * @param {{node: string, addresses: string[]}} info
 * @returns {string | undefined}
 */
export const peerFragmentForChat = (gateway, agent, info) => {
  const gatewayUrl = new URL(`https://${gateway}/`);
  if (
    !/^[0-9a-f]{64}:[0-9a-f]{64}$/.test(agent) ||
    !/^[0-9a-f]{64}$/.test(info.node)
  )
    return undefined;
  for (const address of info.addresses) {
    const hint = new URL(address);
    if (
      hint.protocol !== 'ws-relay+captp0:' ||
      hint.hostname !== info.node ||
      hint.username ||
      hint.password ||
      hint.port ||
      hint.hash
    )
      continue;
    const relay = hint.searchParams.get('relay');
    const relayDomain = hint.searchParams.get('domain');
    if (!relay || !relayDomain) continue;
    const relayUrl = new URL(relay);
    if (
      relayUrl.protocol !== 'wss:' ||
      relayUrl.host !== gatewayUrl.host ||
      relayUrl.username ||
      relayUrl.password ||
      relayUrl.hash
    )
      continue;
    const locator = formatLocatorWithHints(
      /** @type {any} */ (agent),
      'host',
      /** @type {any} */ ([address]),
    );
    return new URLSearchParams({
      relay,
      relayDomain,
      'cap.agent': locator,
    }).toString();
  }
  return undefined;
};
harden(peerFragmentForChat);

/** Verify migration before replacing a working gateway connection.
 * @param {object} options
 * @param {any} options.connection
 * @param {any} options.powers
 * @param {string} options.gateway
 * @param {string} options.agent
 * @param {(config: any) => any} options.connect
 * @param {number} [options.timeoutMs]
 */
export const upgradeChatConnection = async ({
  connection,
  powers,
  gateway,
  agent,
  connect,
  timeoutMs = 5000,
}) => {
  const fallback = harden({ connection, powers, fragment: undefined });
  let candidate;
  let expired = false;
  let timer;
  const attempt = async () => {
    try {
      // eslint-disable-next-line no-underscore-dangle
      const methods = await E(powers).__getMethodNames__();
      if (expired || !methods.includes('getPeerInfo')) return fallback;
      const info = await E(powers).getPeerInfo();
      if (expired) return fallback;
      const fragment = peerFragmentForChat(gateway, agent, info);
      if (!fragment) return fallback;
      candidate = connect(parseApplicationConfig(fragment));
      const peerPowers = await candidate.powers;
      if (expired) {
        candidate.close();
        return fallback;
      }
      connection.close();
      return harden({ connection: candidate, powers: peerPowers, fragment });
    } catch {
      candidate?.close();
      return fallback;
    }
  };
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => {
      expired = true;
      candidate?.close();
      resolve(fallback);
    }, timeoutMs);
  });
  try {
    return await Promise.race([attempt(), deadline]);
  } finally {
    clearTimeout(timer);
  }
};
harden(upgradeChatConnection);
