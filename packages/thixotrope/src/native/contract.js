// @ts-check
/**
 * The contract between a native resource directory and the daemon: what its
 * two entry modules export, what each receives, and the protocol the two
 * halves speak. Types only; nothing here runs.
 *
 * `durable.js` runs once in a dedicated manager vat whose heap persists,
 * with the guest prelude (`E`, `Far`, `makeExo`, `M`, and the rest) as
 * globals, typed as `GuestGlobals` from `@endo/thixotrope/guest.js`. Its
 * `make` is synchronous and receives the powers below; it returns a public
 * facet, the only thing installed into the inventory, and a lifecycle facet
 * the daemon calls `started()` on at every start and `exited()` on when an
 * adapter process of this installation exits on its own, after a backoff
 * that grows with consecutive quick exits.
 *
 * `ephemeral.js` runs in a fresh Node process each time the manager needs an
 * adapter, with ordinary module resolution and no replay; its `make` receives
 * an empty record of powers and returns the adapter root the manager talks
 * to.
 *
 * Beside these, a durable module receives what its installation was
 * granted from the inventory and provided by the host, by name.
 *
 * @typedef {object} NativeDurablePowers
 * @property {any} adapters the launcher: `create()` starts a fresh adapter
 *   process from this installation and returns its incarnation, whose
 *   `getRoot()` is the adapter and whose `retire()` ends the process
 * @property {any} makeKeeper `makeAdapterKeeper`, for a manager that wants
 *   to hold an incarnation itself
 * @property {(options: ManagerOptions<any>) => Manager<any>} makeManager
 *   the manager kit, bound to this installation's launcher and keeper
 *
 * @typedef {object} NativeDurableKit
 * @property {any} facet the public facet, installed into the inventory
 *   under the installation's name
 * @property {{ started: () => unknown, exited: () => unknown }} lifecycle
 *   notified at every daemon start, after every vat is seated, and at an
 *   adapter's own exit; a module built on `makeManager` gets both from it
 *
 * @typedef {object} NativeDurableModule
 * @property {(powers: NativeDurablePowers) => NativeDurableKit} make
 *
 * @typedef {object} NativeEphemeralModule
 * @property {(powers: {}) => any} make returns the adapter root;
 *   `makeAdapter` builds one that speaks the manager's protocol
 */

/**
 * The protocol between a manager and its adapter. A registration is a
 * passable `spec` desired under a `key`; the adapter binds it, unbinds it,
 * restores a set of them one at a time, and lists what it holds. A bind
 * answers the resolved spec when binding settled something the spec left
 * open, or `undefined` when the registration is as sent; a restore reports
 * each resolved registration with its resolved spec. The manager adopts a
 * resolved spec as the desired one, so a later restore sends that form;
 * resolving an already-resolved spec must leave it as it is, `same` on both
 * sides must accept an unresolved spec against the resolved one it became,
 * and a resolved spec is data and the manager's own remotables only, since
 * it outlives the process that resolved it.
 *
 * @template Spec
 * @typedef {object} AdapterProtocol
 * @property {(key: unknown, spec: Spec) => Promise<Spec | undefined>} bind
 * @property {(key: unknown) => Promise<boolean>} unbind
 * @property {(entries: Array<[unknown, Spec]>) => Promise<Array<{ key: unknown, spec?: Spec, error?: string }>>} restore
 * @property {() => Promise<Array<unknown>>} keys
 */

/**
 * @template Spec
 * @typedef {object} ManagerOptions
 * @property {string} label what a key names, for messages
 * @property {(existing: Spec, wanted: Spec) => boolean} same
 * @property {(existing: Spec, wanted: Spec) => boolean} [replaces]
 * @property {(key: unknown, spec: Spec, status: 'bound' | 'inactive') => Record<string, unknown>} [decorate]
 *   fields a status record carries beside `key`, `status` and `error`;
 *   never asked of a closed registration
 */

/**
 * The status record of a registration, the same shape for every resource:
 * `bound` while the adapter holds it, `inactive` with the error while it
 * could not, `closed` once withdrawn; and what the author's `decorate` adds.
 * @typedef {{ key: unknown, status: 'bound' | 'inactive' | 'closed', error?: string } & Record<string, unknown>} RegistrationStatus
 */

/**
 * @template Spec
 * @typedef {object} Manager
 * @property {(key: unknown, spec: Spec) => Promise<{ handle: RegistrationHandle, status: RegistrationStatus }>} register
 *   the handle, and the status reconciling it reported
 * @property {() => Array<unknown>} keys
 * @property {{ started: () => Promise<void>, exited: () => Promise<void> }} lifecycle
 */

/**
 * @typedef {object} RegistrationHandle
 * @property {() => Promise<RegistrationStatus>} status reconciles the
 *   registration again and reports it
 * @property {() => Promise<boolean>} close whether this registration was
 *   still in place; a later registration under the same key is untouched
 */

export {};
