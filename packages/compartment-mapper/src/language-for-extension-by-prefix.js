// @ts-check
/**
 * Helpers for layering auxiliary `package.json` language-for-extension
 * overrides onto a compartment's base parser map, scoped by subtree prefix.
 *
 * An auxiliary `package.json` is one without a `name` (see
 * `package-descriptor-cache.js`); it exists solely to scope
 * language-for-extension rules — typically `{"type": "module"}` or
 * `{"type": "commonjs"}` — to a subdirectory of an otherwise typed package.
 * These helpers turn such a descriptor into the language-for-extension delta
 * it implies, and select the effective map for a module by its deepest
 * matching subtree prefix.
 *
 * See `designs/compartment-mapper-auxiliary-package-json.md` (Phase 7,
 * Design Decision §7: the `languageForExtensionByPrefix` field).
 *
 * @module
 */

/**
 * @import {
 *   LanguageForExtension,
 *   LanguageForExtensionByPrefix,
 *   PackageDescriptor,
 * } from './types.js'
 */

const { assign, create, freeze } = Object;

/**
 * The language-for-extension contribution of a single descriptor.
 *
 * `.js` is the only extension whose language depends on a package's `type`:
 * it resolves to `mjs` under `type: "module"` (or when a `module` field is
 * present) and to `cjs` under `type: "commonjs"`. Every other extension
 * (`.mjs`, `.cjs`, `.json`, ...) is type-independent, so an auxiliary
 * descriptor only ever flips `js`. A descriptor may additionally carry an
 * explicit `parsers` map, which layers on top of the `type`-implied flip.
 *
 * @param {PackageDescriptor} descriptor
 * @returns {LanguageForExtension}
 */
export const languageForExtensionOverride = descriptor => {
  const { type, module, parsers } = descriptor;
  /** @type {Record<string, any>} */
  const override = create(null);
  if (type === 'module' || module !== undefined) {
    override.js = 'mjs';
  } else if (type === 'commonjs') {
    override.js = 'cjs';
  }
  if (parsers !== undefined && typeof parsers === 'object') {
    assign(override, parsers);
  }
  return freeze(override);
};

/**
 * Layers a descriptor's override onto a base language-for-extension map,
 * returning a new frozen null-prototype map. Deeper (later) descriptors win
 * on conflicting extensions.
 *
 * @param {LanguageForExtension} base
 * @param {PackageDescriptor} descriptor
 * @returns {LanguageForExtension}
 */
export const layerLanguageForExtension = (base, descriptor) =>
  freeze(
    /** @type {LanguageForExtension} */ (
      assign(create(null), base, languageForExtensionOverride(descriptor))
    ),
  );

/**
 * Selects the effective language-for-extension map for a module at
 * `relativeModulePath` (relative to the compartment root), choosing the
 * deepest prefix in `languageForExtensionByPrefix` that prefixes the path.
 * Falls back to `base` when no prefix matches.
 *
 * @param {LanguageForExtension} base
 * @param {LanguageForExtensionByPrefix} languageForExtensionByPrefix
 * @param {string} relativeModulePath - e.g. `sub/dir/file.js`, with no
 *   leading `./`
 * @returns {LanguageForExtension}
 */
export const selectLanguageForExtension = (
  base,
  languageForExtensionByPrefix,
  relativeModulePath,
) => {
  let selected = base;
  let selectedLength = -1;
  for (const { prefix, languageForExtension } of languageForExtensionByPrefix) {
    if (
      prefix.length > selectedLength &&
      relativeModulePath.startsWith(prefix)
    ) {
      selected = languageForExtension;
      selectedLength = prefix.length;
    }
  }
  return selected;
};
