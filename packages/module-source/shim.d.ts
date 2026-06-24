/// <reference types="ses" />

// The shim installs `ModuleSource` as a global. Declare the ambient global so
// consumers that load `@endo/module-source/shim.js` can reference
// `ModuleSource` both as a value and as a type without TS2304/TS2749.
import { ModuleSource as ModuleSourceClass } from '@endo/module-source';

declare global {
  // eslint-disable-next-line no-var
  var ModuleSource: typeof ModuleSourceClass;
  // The instance shape produced by `new ModuleSource(...)`.
  type ModuleSource = {
    imports: string[];
    exports: string[];
    reexports: string[];
    __syncModuleProgram__: string;
    __liveExportMap__: unknown;
    __reexportMap__: unknown;
    __fixedExportMap__: unknown;
    __needsImport__: unknown;
    __needsImportMeta__: unknown;
  };
}

export {};
