/* Provides ESM support for `bundle.js`. */

/** @import {PrecompiledModuleSource} from 'ses' */
/** @import {BundlerSupport} from './bundle-lite.js' */

import { join } from './node-module-specifier.js';

/** quotes strings */
const q = JSON.stringify;

const exportsCellRecord = exportMap =>
  ''.concat(
    ...Object.keys(exportMap).map(
      exportName => `\
      ${exportName}: cell(${q(exportName)}),
`,
    ),
  );

const importsCellSetter = (exportMap, index) => {
  // The exportMap is keyed by the exported (external) name and the value is a
  // single-element array containing the local (import-side) binding name.
  // A single local binding may be exported under multiple names (e.g.,
  // `export { details, details as X, details as redacted }`); collect all
  // exported names per local binding so the generated calling-convention
  // entry fans out to every corresponding cell setter rather than relying on
  // an object literal whose duplicate keys would silently collapse to the
  // last one.
  /** @type {Map<string, string[]>} */
  const byLocal = new Map();
  for (const [exportName, [importName]] of Object.entries(exportMap)) {
    let exportNames = byLocal.get(importName);
    if (exportNames === undefined) {
      exportNames = [];
      byLocal.set(importName, exportNames);
    }
    exportNames.push(exportName);
  }
  return ''.concat(
    ...[...byLocal.entries()].map(([importName, exportNames]) => {
      if (exportNames.length === 1) {
        return `\
      ${importName}: cells[${index}].${exportNames[0]}.set,
`;
      }
      const fanout = exportNames
        .map(exportName => `cells[${index}].${exportName}.set(value)`)
        .join('; ');
      return `\
      ${importName}: value => { ${fanout}; },
`;
    }),
  );
};

const adaptReexport = reexportMap => {
  if (!reexportMap) {
    return {};
  }
  const ret = Object.fromEntries(
    Object.values(reexportMap)
      .flat()
      .map(([local, exported]) => [exported, [local]]),
  );
  return ret;
};

export const runtime = `\
function observeImports(map, importName, importIndex) {
  for (const [name, observers] of map.get(importName)) {
    const cell = cells[importIndex][name];
    if (cell === undefined) {
      throw new ReferenceError(\`Cannot import name \${name} (has \${Object.getOwnPropertyNames(cells[importIndex]).join(', ')})\`);
    }
    for (const observer of observers) {
      cell.observe(observer);
    }
  }
}
`;

/** @type {BundlerSupport<PrecompiledModuleSource>} */
export default {
  runtime,
  getBundlerKit(
    {
      index,
      indexedImports,
      moduleSpecifier,
      sourceDirname,
      record: {
        __syncModuleProgram__,
        __fixedExportMap__ = {},
        __liveExportMap__ = {},
        __reexportMap__ = {},
        reexports,
      },
    },
    { useEvaluate = false },
  ) {
    let functor = __syncModuleProgram__;
    if (useEvaluate) {
      const sourceUrl = join(sourceDirname, moduleSpecifier);
      functor = JSON.stringify([functor, sourceUrl]);
    }
    return {
      getFunctor: () => `\
${functor},
`,
      getCells: () => `\
    {
${exportsCellRecord(__fixedExportMap__)}${exportsCellRecord(
        __liveExportMap__,
      )}${exportsCellRecord(adaptReexport(__reexportMap__))}\
    },
`,
      getReexportsWiring: () => {
        const mappings = reexports.map(
          importSpecifier => `\
  defineProperties(cells[${index}], getOwnPropertyDescriptors(cells[${indexedImports[importSpecifier]}]));
`,
        );
        // Create references for export name as newname
        const namedReexportsToProcess = Object.entries(__reexportMap__);
        if (namedReexportsToProcess.length > 0) {
          mappings.push(`
  defineProperties(cells[${index}], {${namedReexportsToProcess.map(
    ([specifier, renames]) => {
      return renames.map(
        ([localName, exportedName]) =>
          `${q(exportedName)}: { value: cells[${indexedImports[specifier]}][${q(
            localName,
          )}] }`,
      );
    },
  )} });
`);
        }
        return mappings.join('');
      },
      getFunctorCall: () => {
        let functorExpression = `functors[${index}]`;
        if (useEvaluate) {
          functorExpression = `evaluateSource(...${functorExpression})`;
        }
        return `\
  ${functorExpression}({
    imports(entries) {
      const map = new Map(entries);
  ${''.concat(
    ...Object.entries(indexedImports).map(
      ([importName, importIndex]) => `\
    observeImports(map, ${q(importName)}, ${importIndex});
  `,
    ),
  )}\
  },
    liveVar: {
  ${importsCellSetter(__liveExportMap__, index)}\
  },
    onceVar: {
${importsCellSetter(__fixedExportMap__, index)}\
    },
    importMeta: {},
  });
`;
      },
    };
  },
};
