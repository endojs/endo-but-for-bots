// @ts-check
/* eslint-disable no-continue */
import { parseLocator } from '@endo/daemon/locator.js';

/**
 * A locator's agent identity may be hosted by a different transport identity.
 * Hints are part of the supplied capability, not proof of identity ownership.
 * Never let a hint change the application's explicitly configured relay.
 * @param {string} locator
 * @param {string} relay
 * @returns {ReturnType<typeof parseLocator> & {peerNode: string}}
 */
export const routeLocator = (locator, relay) => {
  const parsed = parseLocator(locator);
  const nodes = new Set();
  for (const address of parsed.hints) {
    if (!address.startsWith('ws-relay+captp0:')) continue;
    const hint = new URL(address);
    if (hint.searchParams.get('relay') !== relay) continue;
    if (
      !/^[0-9a-f]{64}$/.test(hint.hostname) ||
      hint.username ||
      hint.password ||
      hint.port ||
      hint.hash ||
      (hint.pathname && hint.pathname !== '/') ||
      hint.searchParams.getAll('relay').length !== 1
    )
      throw new Error('Invalid peer route');
    nodes.add(hint.hostname);
  }
  if (nodes.size > 1) throw new Error('Ambiguous peer route');
  return { ...parsed, peerNode: nodes.values().next().value || parsed.node };
};
harden(routeLocator);
