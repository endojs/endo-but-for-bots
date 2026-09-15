// @ts-check

// Rootless engine identity/configuration, not guest environment. The config
// files themselves remain trusted operator inputs. Explicit --remote=false
// and --http-proxy=false are still required at their respective CLI boundaries.
const hostKeys = harden([
  'PATH',
  'HOME',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'CONTAINERS_CONF',
  'CONTAINERS_CONF_OVERRIDE',
  'CONTAINERS_STORAGE_CONF',
  'CONTAINERS_REGISTRIES_CONF',
  'REGISTRY_AUTH_FILE',
  'STORAGE_DRIVER',
  'STORAGE_OPTS',
  'TMPDIR',
]);

/**
 * Capture one environment for every command owned by a local Podman runtime.
 * Overrides are trusted operator settings, never SliceSpec.env or spawn.env.
 * Rootless lookup and cleanup must use the same HOME/XDG/storage configuration;
 * TMPDIR selects Podman's temporary image download storage. REGISTRY_AUTH_FILE
 * preserves the operator's image-pull authentication file, like default files
 * under HOME. Raw provider secrets, proxy variables, remote connections and
 * unrelated daemon environment are excluded.
 * This does not remove authority available through operator config files or
 * default credential files beneath HOME; it bounds inherited environment only.
 *
 * @param {Readonly<Record<string, string | undefined>>} ambient
 * @param {Readonly<Record<string, string | undefined>>} [overrides]
 * @returns {Readonly<Record<string, string>>}
 */
export const makePodmanHostEnvironment = (ambient, overrides = {}) => {
  /** @type {Record<string, string>} */
  const captured = {};
  for (const key of hostKeys) {
    const value = overrides[key] ?? ambient[key];
    if (value !== undefined) captured[key] = value;
  }
  captured.PATH ??= '/usr/bin:/bin';
  return harden(captured);
};
harden(makePodmanHostEnvironment);
