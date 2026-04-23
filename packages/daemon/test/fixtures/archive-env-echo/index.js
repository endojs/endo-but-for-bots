export const make = (_powers, _context, options = {}) => {
  const env = options.env || {};
  return Far('EnvEchoFromArchive', {
    getEnv() {
      return Object.assign({}, env);
    },
    getEnvVar(key) {
      return env[key];
    },
    hasEnvVar(key) {
      return Object.prototype.hasOwnProperty.call(env, key);
    },
  });
};
