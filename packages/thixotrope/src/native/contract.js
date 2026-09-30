// @ts-check
/**
 * The contract between a native resource directory and the daemon: what its
 * two entry modules export, what each receives, and the protocol the two
 * halves speak. Types only; nothing here runs.
 *
 * `durable.js` runs once in a dedicated manager vat whose heap persists. Its
 * `make` is synchronous and receives the powers below; it returns a
 * registration facet, the only thing installed into the inventory, and a
 * lifecycle facet the daemon calls `started()` on at every start.
 *
 * `ephemeral.js` runs in a fresh Node process each time the manager needs an
 * adapter, with ordinary module resolution and no replay; its `make` receives
 * an empty record of powers and returns the adapter root the manager talks
 * to.
 *
 * @typedef {object} NativeDurablePowers
 * @property {any} E eventual send, as in the guest globals
 * @property {any} Far remotable maker, as in the guest globals
 * @property {any} adapters the launcher: `create()` starts a fresh adapter
 *   process from this installation and returns its incarnation, whose
 *   `getRoot()` is the adapter and whose `retire()` ends the process
 * @property {any} makeKeeper `makeAdapterKeeper`, for a manager that wants
 *   to hold an incarnation itself
 * @property {(options: ManagerOptions<any>) => Manager<any>} makeManager
 *   the manager kit, bound to this installation's launcher and keeper
 *
 * @typedef {object} NativeDurableKit
 * @property {any} registration the public facet, installed into the
 *   inventory under the installation's name
 * @property {{ started: () => unknown }} lifecycle notified at every daemon
 *   start, after every vat is seated
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
 * restores a set of them one at a time, and lists what it holds.
 *
 * @template Spec
 * @typedef {object} AdapterProtocol
 * @property {(key: unknown, spec: Spec) => Promise<unknown>} bind
 * @property {(key: unknown) => Promise<boolean>} unbind
 * @property {(entries: Array<[unknown, Spec]>) => Promise<Array<{ key: unknown, error?: string }>>} restore
 * @property {() => Promise<Array<unknown>>} keys
 */

/**
 * @template Spec
 * @typedef {object} ManagerOptions
 * @property {string} label what a key names, for messages
 * @property {(existing: Spec, wanted: Spec) => boolean} same
 * @property {(existing: Spec, wanted: Spec) => boolean} [replaces]
 * @property {(key: unknown, spec: Spec, state: 'bound' | 'inactive' | 'closed', error?: string) => unknown} describe
 */

/**
 * @template Spec
 * @typedef {object} Manager
 * @property {(key: unknown, spec: Spec) => Promise<RegistrationHandle>} register
 * @property {() => Array<unknown>} keys
 * @property {{ started: () => Promise<void> }} lifecycle
 */

/**
 * @typedef {object} RegistrationHandle
 * @property {() => Promise<unknown>} status the record `describe` returns
 * @property {() => Promise<boolean>} close whether this registration was
 *   still in place; a later registration under the same key is untouched
 */

export {};
