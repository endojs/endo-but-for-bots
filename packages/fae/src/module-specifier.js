// @ts-check

/**
 * Keep hosted formulas on the retained current-release entrypoint. Other
 * installations keep their ordinary module URL.
 * @param {string} relative
 * @param {string} base
 */
export const stableModuleSpecifier = (relative, base) =>
  new URL(relative, base).href.replace(
    /^file:\/\/\/var\/lib\/endo\/releases\/[^/]+\//,
    'file:///var/lib/endo/current/',
  );
harden(stableModuleSpecifier);
