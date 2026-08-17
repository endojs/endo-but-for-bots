// @ts-check

/**
 * @file `GatewayAdmin` exo for the gateway's local administrator
 *   surface (design Feature 7).
 *
 * The administrator's handle is a separate local sock (`admin.sock`,
 * see `sock-paths.js`) gated by ACL such that only the administrator
 * OS account may connect. A process that can connect to the admin
 * sock holds the administrator's authority: it can inspect the
 * registration table, inspect the virtual-host bindings,
 * force-deregister a relay by public key, and read per-account
 * resource balances via an injected `ResourceLedger` (Feature 1,
 * deferred).
 *
 * `GatewayAdmin` is reachable in exactly two ways:
 *
 *   1. In-process, via `gateway.getAdmin()`. Embedders that already
 *      speak CapTP hold the exo directly.
 *   2. Over the local admin sock. The admin sock is mode `0600` and
 *      its parent directory is mode `0700` (deployment-enforced),
 *      so only the administrator OS account can `connect(2)` to it.
 *      The admin sock is **distinct** from the bootstrap sock
 *      (which any local user daemon may use to register itself);
 *      the two channels exist precisely so that registration
 *      authority does not double as admin authority.
 *
 * The exo is **never** served on the gateway's public HTTP / WS
 * surface, and is **never** reached through the bootstrap sock. The
 * "admin authority off the network" rule lives in the surface: the
 * only entry capabilities are the in-process API and the admin sock.
 * The HTTP / WS surface (which lands in later phases) does not
 * expose `GatewayAdmin`; the gateway's `getBootstrap` throws when
 * `sockBootstrap` is disabled, and `getAdmin` throws when
 * `adminDaemon` is disabled. The admin daemon does **not** depend on
 * the bootstrap sock; the two are independent features with their
 * own toggles and their own access channels.
 *
 * Byte fields use `Uint8Array` as the sole unit of transmission per
 * the kriskowal directive on PR #393. Byte arguments use `M.raw()`
 * in the interface guard so the exo accepts `Uint8Array` inputs
 * without invoking `@endo/marshal`'s passable-style check.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, q, X } from '@endo/errors';

import { ED25519_PUBLIC_KEY_LENGTH } from './bootstrap.js';
import { checkRelayPolicy } from './relay-policy.js';

/** @import {
 *   AppsNameHub,
 *   GatewayAdmin,
 *   AdminBackplane,
 *   ResourceLedger,
 *   RelayPolicy,
 * } from './types.js' */

const GatewayAdminInterface = M.interface('GatewayAdmin', {
  listRegistrations: M.call().returns(M.promise()),
  deregisterRelay: M.call(M.raw()).returns(M.promise()),
  listVirtualHosts: M.call().returns(M.promise()),
  getResourceBalances: M.call().returns(M.promise()),
  getCounters: M.call().returns(M.promise()),
  setRelayPolicy: M.call(M.raw(), M.string()).returns(M.promise()),
  addRelayCaller: M.call(M.raw(), M.raw()).returns(M.promise()),
  removeRelayCaller: M.call(M.raw(), M.raw()).returns(M.promise()),
});
harden(GatewayAdminInterface);

/**
 * @typedef {object} AdminDeps Args to `makeGatewayAdmin`.
 * @property {AdminBackplane} backplane The bootstrap's admin
 *   backplane (returned from `makeGatewayBootstrap`).
 * @property {AppsNameHub} apps The gateway's shared `@apps`
 *   NameHub. The admin reads it for `listVirtualHosts`.
 * @property {ResourceLedger} [resourceLedger] Optional Feature 1
 *   ledger. When absent, `getResourceBalances` returns an empty
 *   list rather than throwing, because admin reads should be
 *   benign in a partially-built gateway. A future fixer can flip
 *   the default to throw once the ledger is required.
 */

/**
 * Validate a byte-shaped public-key input. Mirrors the validator
 * in `bootstrap.js`; the admin facet keeps its own copy so the
 * dependency graph between the two modules stays one-directional
 * (`admin.js` imports the constant from `bootstrap.js`, not the
 * private checker).
 *
 * @param {unknown} candidate
 * @returns {Uint8Array}
 */
const checkPublicKey = candidate => {
  if (!(candidate instanceof Uint8Array)) {
    throw makeError(X`publicKey must be a Uint8Array`);
  }
  if (candidate.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw makeError(
      X`publicKey must be ${q(ED25519_PUBLIC_KEY_LENGTH)} bytes, got ${q(candidate.length)}`,
    );
  }
  return candidate;
};

/**
 * Create the `GatewayAdmin` exo. The factory is total: it returns
 * the exo unconditionally and the caller (the gateway proper,
 * `index.js`) decides whether to expose it based on the
 * `adminDaemon` feature toggle.
 *
 * @param {AdminDeps} deps
 * @returns {GatewayAdmin}
 */
export const makeGatewayAdmin = ({ backplane, apps, resourceLedger }) => {
  if (backplane === undefined) {
    throw makeError(X`makeGatewayAdmin requires an admin backplane`);
  }
  if (apps === undefined) {
    throw makeError(X`makeGatewayAdmin requires an AppsNameHub`);
  }

  const exo = makeExo(
    'GatewayAdmin',
    GatewayAdminInterface,
    /** @type {any} */ ({
      async listRegistrations() {
        return backplane.listRegisteredPeers();
      },
      /** @param {Uint8Array} publicKey */
      async deregisterRelay(publicKey) {
        const key = checkPublicKey(publicKey);
        return backplane.deregisterByPublicKey(key);
      },
      async listVirtualHosts() {
        // Forward the apps hub's own `list` shape; rename
        // `webletFormulaId` to keep the admin's vocabulary
        // consistent with the design's "weblet" name. The
        // underlying field is already a string.
        const bindings = await apps.list();
        return harden(
          bindings.map(({ name, webletFormulaId }) =>
            harden({ name, webletFormulaId }),
          ),
        );
      },
      async getResourceBalances() {
        if (resourceLedger === undefined) {
          // Feature 1's ledger has not landed yet. An admin read
          // against a missing ledger returns empty rather than
          // throwing: the admin facet is read-only and the empty
          // shape is a faithful snapshot ("no accounts, no
          // balances") of a gateway that has not yet stood up the
          // ledger. A future fixer flips this to throw once the
          // ledger becomes a hard requirement.
          return harden([]);
        }
        const balances = await resourceLedger.listBalances();
        return harden(balances.map(b => harden({ ...b })));
      },
      async getCounters() {
        const registrations = backplane.listRegisteredPeers();
        let totalWeblets = 0;
        for (const entry of registrations) {
          totalWeblets += entry.weblets.length;
        }
        return harden({
          totalRegistrations: registrations.length,
          totalWeblets,
          pendingNonces: backplane.pendingNonces(),
        });
      },
      /**
       * @param {Uint8Array} publicKey
       * @param {RelayPolicy} policy
       */
      async setRelayPolicy(publicKey, policy) {
        const key = checkPublicKey(publicKey);
        const next = checkRelayPolicy(policy);
        const prev = backplane.setRelayPolicyByPublicKey(key, next);
        if (prev === undefined) {
          throw makeError(
            X`setRelayPolicy: no registration claims the supplied public key`,
          );
        }
        return prev;
      },
      /**
       * @param {Uint8Array} publicKey
       * @param {Uint8Array} callerPublicKey
       */
      async addRelayCaller(publicKey, callerPublicKey) {
        const key = checkPublicKey(publicKey);
        const callerKey = checkPublicKey(callerPublicKey);
        const result = backplane.addRelayCallerByPublicKey(key, callerKey);
        if (result === undefined) {
          throw makeError(
            X`addRelayCaller: no registration claims the supplied public key`,
          );
        }
        return result;
      },
      /**
       * @param {Uint8Array} publicKey
       * @param {Uint8Array} callerPublicKey
       */
      async removeRelayCaller(publicKey, callerPublicKey) {
        const key = checkPublicKey(publicKey);
        const callerKey = checkPublicKey(callerPublicKey);
        const result = backplane.removeRelayCallerByPublicKey(key, callerKey);
        if (result === undefined) {
          throw makeError(
            X`removeRelayCaller: no registration claims the supplied public key`,
          );
        }
        return result;
      },
    }),
  );

  return /** @type {GatewayAdmin} */ (/** @type {unknown} */ (exo));
};
harden(makeGatewayAdmin);
