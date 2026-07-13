// @ts-check
/* global globalThis */

// The optimizer runs out of process from the daemon, so it must not install SES
// lockdown before loading Ax. A shallow `harden` shim is enough for the prompt
// and metric modules it reuses from fae.
const globals =
  /** @type {typeof globalThis & { harden?: <T>(value: T) => T }} */ (
    globalThis
  );
if (!globals.harden) {
  globals.harden = value => Object.freeze(value);
}
