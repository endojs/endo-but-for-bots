/**
 * Helpers for option handling.
 *
 * @module
 */

/**
 * @import {TransformSourceParams} from './types/module-source.js'
 */

/**
 * Creates a fresh `sourceOptions` object with the mutable state properties
 * that `makeModulePlugins` populates during analysis and transform passes.
 *
 * Callers pass overrides for fields like `sourceUrl`, `sourceMap`,
 * `allowHidden`, etc.
 *
 * @template {object} T
 * @overload
 * @param {T} overrides
 * @returns {TransformSourceParams & T}
 */
/**
 * Creates a fresh `sourceOptions` object with the mutable state properties
 * that `makeModulePlugins` populates during analysis and transform passes.
 *
 * @overload
 * @returns {TransformSourceParams}
 */

/**
 * Creates a fresh `sourceOptions` object with the mutable state properties
 * that `makeModulePlugins` populates during analysis and transform passes.
 *
 * Callers pass overrides for fields like `sourceUrl`, `sourceMap`,
 * `allowHidden`, etc.
 *
 * @template {object} T
 * @param {T} [overrides]
 */
export const createSourceOptions = overrides => ({
  sourceType: 'module',
  fixedExportMap: Object.create(null),
  imports: Object.create(null),
  exportAlls: [],
  reexportMap: Object.create(null),
  liveExportMap: Object.create(null),
  /** @type {Array<[string, boolean, string | undefined]>} */
  hoistedDecls: [],
  importSources: Object.create(null),
  importDecls: [],
  dynamicImport: { present: false },
  /**
   * Specifiers seen as static string-literal arguments of dynamic `import(...)`
   * call sites, collected as a null-prototype set. Surfaced on the module
   * source record so the compartment-mapper archive trace can discover and
   * capture modules reachable only via dynamic import.
   */
  dynamicImportSources: Object.create(null),
  importMeta: { present: false },
  ...(overrides ?? {}),
});
