/* global Far */
export const make = (_powers, _context, options = {}) => {
  // Snapshot env into a frozen copy at construction time so the XS
  // marshaller (which is stricter than Node's about extensible
  // objects) accepts the result of getEnv().  Object.freeze suffices
  // here because env values are primitive strings.
  const frozenEnv = Object.freeze({ ...(options.env || {}) });
  return Far('EnvEchoFromArchive', {
    getEnv() {
      return frozenEnv;
    },
    getEnvVar(key) {
      return frozenEnv[key];
    },
    hasEnvVar(key) {
      return Object.prototype.hasOwnProperty.call(frozenEnv, key);
    },
  });
};
