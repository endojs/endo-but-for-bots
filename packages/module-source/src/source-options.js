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
export const createSourceOptions = overrides =>
  // The freshly created bucket has no `source` yet (the transform pass fills it
  // in later), but `TransformSourceParams` requires it. tsgo does not apply the
  // `@overload` return annotations to the implementation's inferred return the
  // way tsc does, so cast the literal through `unknown` to the declared type.
  /** @type {TransformSourceParams} */ (
    /** @type {unknown} */ ({
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
      importMeta: { present: false },
      ...(overrides ?? {}),
    })
  );
