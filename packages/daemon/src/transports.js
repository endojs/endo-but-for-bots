// @ts-check
//
// Skeleton implementation of the per-agent `Transports` capability
// described in `designs/ocapn-daemon-integration.md`.
//
// **This module is a deliberate gap-revealing skeleton, not a complete
// implementation.** The shape is intentionally minimal so that the
// design's ambiguities surface as bare TODOs at the points where the
// implementer would need to choose. Every TODO below has a matching
// numbered entry in the PR body's "Gaps surfaced" section.

import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { makeError, q } from '@endo/errors';

import { TransportsInterface } from './interfaces.js';

/**
 * @import {
 *   EndoNetwork,
 *   FormulaIdentifier,
 *   TransportsOptions,
 * } from './types.js'
 */

/**
 * Build a per-agent Transports exo (the agent-facing facade).
 *
 * The exo is the in-guest-backend; the daemon side that supplies the
 * gateway calls is the host-side-proxy of the in-guest-backend +
 * host-side-proxy pattern called out by the design.
 *
 * @param {object} args
 * @param {FormulaIdentifier} args.agentId
 *   The owning agent's formula id (used for diagnostics and for the
 *   cross-agent loopback distinguisher; see gap #1).
 * @param {() => Promise<EndoNetwork[]>} args.getReadyNetworks
 *   Snapshot of the daemon's per-scheme netlayer instances. The
 *   factory wires this to `getAllNetworkAddresses`/the networks
 *   directory at materialization time.
 * @param {TransportsOptions} args.options
 *   The four-field options record from `provideTransports`.
 */
export const makeTransports = ({ agentId, getReadyNetworks, options }) => {
  const {
    allowedSchemes,
    // signingKeys intentionally unused in this skeleton; see gap #6.
    // eslint-disable-next-line no-unused-vars
    signingKeys: _signingKeys,
    listenPolicy = 'none',
    outboundPolicy,
  } = options;

  /**
   * Resolve a locator or scheme to one of the daemon's existing
   * netlayer instances.
   *
   * GAP #3 (allowed-scheme mismatch): the design says "throw" but
   * the failure path leaks daemon configuration if the message
   * names the missing scheme verbatim. We throw with the scheme
   * quoted; revisit when gap #3 is resolved.
   *
   * @param {string} scheme
   */
  const findNetworkForScheme = async scheme => {
    if (allowedSchemes !== undefined && !allowedSchemes.includes(scheme)) {
      throw makeError(`Scheme ${q(scheme)} not in allowedSchemes`);
    }
    const nets = await getReadyNetworks();
    for (const net of nets) {
      // eslint-disable-next-line no-await-in-loop
      if (await E(net).supports(scheme)) {
        return net;
      }
    }
    throw makeError(`No netlayer registered for scheme ${q(scheme)}`);
  };

  /**
   * GAP #4 (Locator vs string discrimination):
   * The design's Open Question 4 says "probably accept either, with
   * a runtime branch". The runtime branch needs a way to recognize a
   * Locator exo; we don't have that type in this codebase. For now
   * we accept strings only and TODO the exo case.
   *
   * GAP #5 (transport-hint policy DSL):
   * Once we have a parsed locator, hints (`tcp:host=...`) must be
   * checked against `outboundPolicy`. The design says "simple
   * suffix-match allowlist is the minimum; CIDR support would be
   * useful." We do not implement *any* policy check here; the
   * `outboundPolicy` parameter is accepted and ignored. See PR body.
   *
   * @param {unknown} locator
   */
  const connect = async locator => {
    if (typeof locator !== 'string') {
      throw makeError(
        'connect(): non-string locators are not yet supported (gap #4)',
      );
    }
    // Best-effort scheme extraction.
    const schemeMatch = locator.match(/^([a-z][a-z0-9+.-]*):/i);
    if (!schemeMatch) {
      throw makeError(`Locator ${q(locator)} has no scheme`);
    }
    const scheme = schemeMatch[1];
    // GAP #5: outboundPolicy goes here. We pretend it allows
    // everything.
    if (outboundPolicy !== undefined) {
      // eslint-disable-next-line no-console
      console.error(
        `Transports: outboundPolicy supplied but no DSL defined (gap #5)`,
      );
    }
    const network = await findNetworkForScheme(scheme);
    // GAP #1 (cross-agent loopback distinguisher):
    // When `locator` designates a sibling agent on the same daemon
    // (assessor's note on #138), the design says the proxy returns
    // an in-process direct-cap-forwarding session, not a Noise
    // handshake. The discriminator (is the locator's node component
    // a `localKey`?) is the right test; we leave the loopback fast
    // path to a follow-up and just dispatch through the netlayer.
    // See PR body.
    return E(network).connect(locator, /** farContext */ undefined);
  };

  /**
   * @param {string} scheme
   */
  const has = async scheme => {
    if (allowedSchemes !== undefined && !allowedSchemes.includes(scheme)) {
      return false;
    }
    const nets = await getReadyNetworks();
    for (const net of nets) {
      // eslint-disable-next-line no-await-in-loop
      if (await E(net).supports(scheme)) {
        return true;
      }
    }
    return false;
  };

  /**
   * GAP #1.5 (Locator discovery):
   * Design says `list()` returns `Locator[]`. The Locator type does
   * not exist in this codebase; what we currently have is string
   * addresses from each netlayer. We return strings; revisit once
   * gap #4 lands.
   */
  const list = async () => {
    const nets = await getReadyNetworks();
    const addresses = (
      await Promise.all(
        nets.map(async net => E(net).addresses()),
      )
    ).flat();
    return addresses;
  };

  /**
   * @param {string} _scheme
   * @param {{ port?: number; host?: string }} [_hints]
   */
  const listen = async (_scheme, _hints) => {
    // GAP #2 (listener policy enumeration):
    // The design enumerates 'none' | 'request' | 'allow' for
    // `listenPolicy` but does not say *where* the validation
    // happens. We do the minimal thing — refuse on 'none' — and
    // throw on anything else with a TODO.
    if (listenPolicy === 'none') {
      throw makeError('listen(): listenPolicy denies listening');
    }
    throw makeError(
      `listen(): listenPolicy ${q(listenPolicy)} not yet implemented (gap #2)`,
    );
  };

  /**
   * @param {unknown} _handle
   */
  const disconnect = async _handle => {
    // GAP #7 (asynchronous disconnect race; breaker note):
    // The design does not say what happens if `disconnect(handle)`
    // races with `connect()` against the same handle. Without that
    // semantic we cannot decide whether to await all dependent
    // promises or fire-and-forget.
    throw makeError(
      'disconnect(): handle semantics under-specified (gap #7)',
    );
  };

  const shutdown = async () => {
    // GAP #9 (shutdown vs daemon-side revocation):
    // The design's Revocation section says the daemon may force a
    // shutdown "from outside" (host disinherits the agent). The
    // method on this exo only covers the agent-cooperative path.
    // The daemon-side path is not implemented in this skeleton.
    throw makeError('shutdown(): not yet implemented (gap #9)');
  };

  const help = (_methodName = '') =>
    [
      'EndoTransports — per-agent network capability surface',
      `(skeleton for designs/ocapn-daemon-integration.md, agent ${agentId})`,
    ].join('\n');

  return makeExo('EndoTransports', TransportsInterface, {
    list,
    has,
    connect,
    listen,
    disconnect,
    shutdown,
    help,
  });
};
harden(makeTransports);
