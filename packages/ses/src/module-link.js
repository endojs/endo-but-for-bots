/* eslint-disable no-underscore-dangle */

import { assert } from './error/assert.js';
import {
  makeModuleInstance,
  makeVirtualModuleInstance,
} from './module-instance.js';
import {
  Map,
  ReferenceError,
  TypeError,
  entries,
  isArray,
  isPrimitive,
  mapGet,
  mapHas,
  mapSet,
  weakmapGet,
} from './commons.js';
import {
  EMPTY_ATTRIBUTES,
  attributesMemoKey,
} from './module-attributes.js';

const { Fail, quote: q } = assert;

// `link` creates `ModuleInstances` and `ModuleNamespaces` for a module and its
// transitive dependencies and connects their imports and exports.
// After linking, the resulting working set is ready to be executed.
// The linker only concerns itself with module namespaces that are objects with
// property descriptors for their exports, which the Compartment proxies with
// the actual `ModuleNamespace`.
export const link = (
  compartmentPrivateFields,
  moduleAliases,
  compartment,
  moduleSpecifier,
  attributes = EMPTY_ATTRIBUTES,
) => {
  const { name: compartmentName, moduleRecords } = weakmapGet(
    compartmentPrivateFields,
    compartment,
  );

  const memoKey = attributesMemoKey(moduleSpecifier, attributes);
  const moduleRecord = mapGet(moduleRecords, memoKey);
  if (moduleRecord === undefined) {
    throw ReferenceError(
      `Missing link to module ${q(moduleSpecifier)} from compartment ${q(
        compartmentName,
      )}`,
    );
  }

  // Mutual recursion so there's no confusion about which
  // compartment is in context: the module record may be in another
  // compartment, denoted by moduleRecord.compartment.
  // eslint-disable-next-line no-use-before-define
  return instantiate(compartmentPrivateFields, moduleAliases, moduleRecord);
};

function mayBePrecompiledModuleSource(moduleSource) {
  return typeof moduleSource.__syncModuleProgram__ === 'string';
}

function validatePrecompiledModuleSource(moduleSource, moduleSpecifier) {
  const { __fixedExportMap__, __liveExportMap__ } = moduleSource;
  !isPrimitive(__fixedExportMap__) ||
    Fail`Property '__fixedExportMap__' of a precompiled module source must be an object, got ${q(
      __fixedExportMap__,
    )}, for module ${q(moduleSpecifier)}`;
  !isPrimitive(__liveExportMap__) ||
    Fail`Property '__liveExportMap__' of a precompiled module source must be an object, got ${q(
      __liveExportMap__,
    )}, for module ${q(moduleSpecifier)}`;
}

function mayBeVirtualModuleSource(moduleSource) {
  return typeof moduleSource.execute === 'function';
}

function validateVirtualModuleSource(moduleSource, moduleSpecifier) {
  const { exports } = moduleSource;
  isArray(exports) ||
    Fail`Invalid module source: 'exports' of a virtual module source must be an array, got ${q(
      exports,
    )}, for module ${q(moduleSpecifier)}`;
}

function validateModuleSource(moduleSource, moduleSpecifier) {
  !isPrimitive(moduleSource) ||
    Fail`Invalid module source: must be of type object, got ${q(
      moduleSource,
    )}, for module ${q(moduleSpecifier)}`;
  const { imports, exports, reexports = [] } = moduleSource;
  isArray(imports) ||
    Fail`Invalid module source: 'imports' must be an array, got ${q(
      imports,
    )}, for module ${q(moduleSpecifier)}`;
  isArray(exports) ||
    Fail`Invalid module source: 'exports' must be an array, got ${q(
      exports,
    )}, for module ${q(moduleSpecifier)}`;
  isArray(reexports) ||
    Fail`Invalid module source: 'reexports' must be an array if present, got ${q(
      reexports,
    )}, for module ${q(moduleSpecifier)}`;
}

export const instantiate = (
  compartmentPrivateFields,
  moduleAliases,
  moduleRecord,
) => {
  const {
    compartment,
    moduleSpecifier,
    resolvedImports,
    moduleSource,
    attributes = EMPTY_ATTRIBUTES,
  } = moduleRecord;
  const { instances } = weakmapGet(compartmentPrivateFields, compartment);

  // Instances share the module records' extended memo key so two attribute
  // variants of one specifier instantiate separately.
  const memoKey = attributesMemoKey(moduleSpecifier, attributes);

  // Memoize.
  if (mapHas(instances, memoKey)) {
    return mapGet(instances, memoKey);
  }

  validateModuleSource(moduleSource, moduleSpecifier);

  const importedInstances = new Map();
  let moduleInstance;
  if (mayBePrecompiledModuleSource(moduleSource)) {
    validatePrecompiledModuleSource(moduleSource, moduleSpecifier);
    moduleInstance = makeModuleInstance(
      compartmentPrivateFields,
      moduleAliases,
      moduleRecord,
      importedInstances,
    );
  } else if (mayBeVirtualModuleSource(moduleSource)) {
    validateVirtualModuleSource(moduleSource, moduleSpecifier);
    moduleInstance = makeVirtualModuleInstance(
      compartmentPrivateFields,
      moduleSource,
      compartment,
      moduleAliases,
      moduleSpecifier,
      resolvedImports,
      attributes,
    );
  } else {
    throw TypeError(`Invalid module source, got ${q(moduleSource)}`);
  }

  // Memoize.
  mapSet(instances, memoKey, moduleInstance);

  // Link dependency modules.
  for (const [importSpecifier, resolvedSpecifier] of entries(resolvedImports)) {
    const importedInstance = link(
      compartmentPrivateFields,
      moduleAliases,
      compartment,
      resolvedSpecifier,
    );
    mapSet(importedInstances, importSpecifier, importedInstance);
  }

  return moduleInstance;
};
