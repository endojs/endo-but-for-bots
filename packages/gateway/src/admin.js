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
 * Wire shape: byte fields (public keys) follow the `@endo/bytes`
 * convention: immutable `ArrayBuffer` on the wire, `Uint8Array`
 * accepted on in-realm calls.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, q, X } from '@endo/errors';
import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';

import { ED25519_PUBLIC_KEY_LENGTH } from './bootstrap.js';

/** @import { AppsNameHub } from './vhost.js' */
/** @import { WebletDescriptor } from './bootstrap.js' */

const GatewayAdminInterface = M.interface('GatewayAdmin', {
  listRegistrations: M.call().returns(M.promise()),
  deregisterRelay: M.call(M.any()).returns(M.promise()),
  listVirtualHosts: M.call().returns(M.promise()),
  getResourceBalances: M.call().returns(M.promise()),
  getCounters: M.call().returns(M.promise()),
});
harden(GatewayAdminInterface);

/**
 * @typedef {object} RegistrationSummary The shape `listRegistrations`
 *   returns per entry. Byte fields are returned as the same shape
 *   they were registered with; the caller can hex-render them with
 *   the same helper the bootstrap uses internally.
 * @property {ReadonlyArray<ArrayBuffer | Uint8Array>} publicKeys
 *   Every public key bound to this registration. The first key is
 *   the one passed to `register` / `registerRelay`; subsequent keys
 *   come from `addPublicKey`.
 * @property {ReadonlyArray<WebletDescriptor>} weblets All weblets
 *   the registration has published and not unpublished.
 * @property {unknown} [relayTarget] Present when the registration
 *   came in through `registerRelay`; the relay target exo for
 *   Feature 6.
 * @property {unknown} [daemon] Present when the registration came
 *   in through `register`; the user-daemon callback exo for the
 *   HTTP / WS surface (Feature 4 follow-on).
 */

/**
 * @typedef {object} VirtualHostSummary The shape `listVirtualHosts`
 *   returns per entry.
 * @property {string} name The lowercased virtual-host name.
 * @property {string} webletFormulaId The bound weblet formula
 *   identifier.
 */

/**
 * @typedef {object} ResourceBalance The shape
 *   `getResourceBalances` returns per account.
 * @property {string} account Account identifier (per-user-daemon
 *   handle, opaque to the gateway today).
 * @property {number} compute Compute-time tokens (suggested unit:
 *   seconds).
 * @property {number} storage Storage tokens (suggested unit: bytes).
 * @property {number} network Network tokens (suggested unit: bytes).
 */

/**
 * @typedef {object} ResourceLedger The Feature 1 surface the
 *   administrator queries. Phase 3 ships the admin facet that
 *   *calls* into the ledger; the ledger implementation itself
 *   lands with the Chat-hosting feature. Until then, embedders
 *   that want admin reads of resource balances supply a stub.
 * @property {() => Promise<ReadonlyArray<ResourceBalance>>} listBalances
 */

/**
 * @typedef {object} CountersSnapshot Per-registration counters the
 *   administrator dumps for diagnostics. The shape is intentionally
 *   open: future phases extend it with HTTP / WS / OCapN counters
 *   without changing the call site. The current slice surfaces
 *   what Phase 2 actually counts: the size of the registration
 *   table and the number of outstanding nonces.
 * @property {number} totalRegistrations
 * @property {number} totalWeblets Aggregate count across every
 *   registration.
 * @property {number} pendingNonces Outstanding (issued, not yet
 *   consumed or expired) challenges.
 */

/**
 * @typedef {object} GatewayAdmin CapTP-facing exo. All methods are
 *   async so they cross the wire as eventual sends.
 * @property {() => Promise<ReadonlyArray<RegistrationSummary>>} listRegistrations
 *   Returns every non-deregistered entry in the registration table.
 * @property {(publicKey: ArrayBuffer | Uint8Array) => Promise<boolean>} deregisterRelay
 *   Force-deregister the registration that owns the supplied public
 *   key. Returns `true` if a matching registration was found and
 *   torn down, `false` if no registration claimed the key. A
 *   registration is identified by *any* of its public keys; the
 *   whole registration tombstones.
 * @property {() => Promise<ReadonlyArray<VirtualHostSummary>>} listVirtualHosts
 *   Snapshot the `@apps` NameHub. Reads only; admin does not
 *   override the routing policy from this method.
 * @property {() => Promise<ReadonlyArray<ResourceBalance>>} getResourceBalances
 *   Snapshot the resource ledger. Returns an empty list when no
 *   `ResourceLedger` is wired (Phase 3 ships this stubbed; Feature
 *   1 wires the ledger in).
 * @property {() => Promise<CountersSnapshot>} getCounters Diagnostic
 *   counter dump.
 */

/**
 * @typedef {object} AdminBackplane The in-process interface the
 *   bootstrap exposes to the admin facet. Keeps the admin exo
 *   loosely coupled to the bootstrap's internal representation;
 *   the bootstrap returns this shape from `makeGatewayBootstrap`'s
 *   second return value, and `makeGatewayAdmin` consumes it.
 * @property {() => ReadonlyArray<RegistrationSummary>} listRegisteredPeers
 *   In-process snapshot of every live registration. The bootstrap
 *   handle exports this under the same name; the admin facet's
 *   CapTP method is `listRegistrations` (per the design's named
 *   admin operation), but the backplane plumbing uses the
 *   bootstrap's vocabulary.
 * @property {(publicKey: ArrayBuffer | Uint8Array) => boolean} deregisterByPublicKey
 *   Synchronous force-deregister hook. Returns `true` if a matching
 *   registration was torn down.
 * @property {() => number} pendingNonces Count of outstanding
 *   challenges.
 */

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
 * @returns {ArrayBuffer | Uint8Array}
 */
const checkPublicKey = candidate => {
  if (
    !(candidate instanceof ArrayBuffer) &&
    !(candidate instanceof Uint8Array)
  ) {
    throw makeError(
      X`publicKey must be an immutable ArrayBuffer or Uint8Array`,
    );
  }
  const length =
    candidate instanceof Uint8Array ? candidate.length : candidate.byteLength;
  if (length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw makeError(
      X`publicKey must be ${q(ED25519_PUBLIC_KEY_LENGTH)} bytes, got ${q(length)}`,
    );
  }
  return candidate;
};

/**
 * Hex-render a byte view. Used only for diagnostic counters; the
 * admin facet does not key anything by hex itself.
 *
 * @param {ArrayBuffer | Uint8Array} bytes
 * @returns {string}
 */
const publicKeyToHex = bytes => {
  const view = bytes instanceof Uint8Array ? bytes : bytesFromImmutable(bytes);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
};
// Silences "unused" warnings while keeping the helper available
// for the inevitable per-entry hex dump in a future counter.
void publicKeyToHex;

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
      /** @param {ArrayBuffer | Uint8Array} publicKey */
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
    }),
  );

  return /** @type {GatewayAdmin} */ (/** @type {unknown} */ (exo));
};
harden(makeGatewayAdmin);
