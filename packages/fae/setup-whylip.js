// @ts-check
// Compatibility for hosts configured with the old bootstrap URL.
/** @param {any} root @param {{ model?: string, reasoningEffort?: string }} [options] */
export const setupWhylip = async (root, options) => {
  const setup = await import(
    new URL('../space-whylip/setup.js', import.meta.url).href
  );
  return setup.setupWhylip(root, options);
};
harden(setupWhylip);

/** @param {any} root */
export const main = root => setupWhylip(root);
harden(main);
