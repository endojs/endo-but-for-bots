/* Validates a compartment map against its schema. */

import { Fail, q, b } from '@endo/errors';
import {
  assertPackagePolicy,
  ATTENUATORS_COMPARTMENT,
  ENTRY_COMPARTMENT,
} from './policy-format.js';

/**
 * @import {
 *   FileCompartmentDescriptor,
 *   FileCompartmentMapDescriptor,
 *   FileModuleConfiguration,
 *   CompartmentMapDescriptor,
 *   EntryDescriptor,
 *   ModuleConfiguration,
 *   ExitModuleConfiguration,
 *   CompartmentModuleConfiguration,
 *   CompartmentDescriptor,
 *   ScopeDescriptor,
 *   BaseModuleConfiguration,
 *   DigestedCompartmentMapDescriptor,
 *   PackageCompartmentMapDescriptor,
 *   PackageCompartmentDescriptor,
 *   FileUrlString,
 *   LanguageForExtension,
 *   LanguageForModuleSpecifier,
 *   ModuleConfigurationKind,
 *   ModuleConfigurationKindToType,
 *   ErrorModuleConfiguration,
 *   DigestedCompartmentDescriptor} from './types.js'
 */

const { keys, entries } = Object;
const { isArray } = Array;

/** @type {(left: string, right: string) => number} */
export const stringCompare = (left, right) =>
  // eslint-disable-next-line no-nested-ternary
  left === right ? 0 : left < right ? -1 : 1;

/**
 * @template T
 * @param {Iterable<T>} iterable
 */
function* enumerate(iterable) {
  let index = 0;
  for (const value of iterable) {
    yield [index, value];
    index += 1;
  }
}

// The assertion helpers below are written as function declarations rather than
// arrow functions assigned to a const so their `asserts x is X` signatures
// attach to the function's own type; tsgo does not preserve an assertion
// signature through assignment to a const.

/**
 * Type guard for a string value.
 *
 * @overload
 * @param {unknown} value
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts value is string}
 */

/**
 * Type guard for a string value with a custom assertion failure message.
 *
 * @overload
 * @param {unknown} value
 * @param {string} message
 * @returns {asserts value is string}
 */

/**
 * Type guard for a string value.
 *
 * @param {unknown} value
 * @param {string} pathOrMessage
 * @param {string} [url]
 * @returns {asserts value is string}
 */
function assertString(value, pathOrMessage, url) {
  typeof value === 'string' ||
    Fail`${b(pathOrMessage)} in ${q(url)} must be a string; got ${q(value)}`;
}

/**
 * Asserts the `label` field valid
 *
 * @param {unknown} allegedLabel
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedLabel is string}
 */
function assertLabel(allegedLabel, keypath, url) {
  assertString(allegedLabel, keypath, url);
  if (allegedLabel === ATTENUATORS_COMPARTMENT) {
    return;
  }
  if (allegedLabel === ENTRY_COMPARTMENT) {
    return;
  }
  /^(?:@[a-z][a-z0-9-.]*\/)?[a-z][a-z0-9-.]*(?:>(?:@[a-z][a-z0-9-.]*\/)?[a-z][a-z0-9-.]*)*$/.test(
    allegedLabel,
  ) ||
    Fail`${b(keypath)} must be a canonical name in ${q(url)}; got ${q(allegedLabel)}`;
}

/**
 * @param {unknown} allegedObject
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedObject is Record<PropertyKey, unknown>}
 */
function assertPlainObject(allegedObject, keypath, url) {
  const object = Object(allegedObject);
  (object === allegedObject &&
    !isArray(object) &&
    !(typeof object === 'function')) ||
    Fail`${b(keypath)} must be an object; got ${q(allegedObject)} of type ${q(typeof allegedObject)} in ${q(url)}`;
}

/**
 *
 * @param {unknown} value
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts value is boolean}
 */
function assertBoolean(value, keypath, url) {
  typeof value === 'boolean' ||
    Fail`${b(keypath)} in ${q(url)} must be a boolean; got ${q(value)}`;
}

/**
 * @param {unknown} conditions
 * @param {string} url
 * @returns {asserts conditions is CompartmentMapDescriptor['tags']}
 */
function assertConditions(conditions, url) {
  if (conditions === undefined) return;
  isArray(conditions) ||
    Fail`conditions must be an array; got ${q(conditions)} in ${q(url)}`;
  for (const [index, value] of enumerate(
    /** @type {unknown[]} */ (conditions),
  )) {
    assertString(value, `conditions[${index}]`, url);
  }
}

/**
 * @template {Partial<ModuleConfiguration>} T
 * @param {T} allegedModule
 * @returns {Omit<T, keyof BaseModuleConfiguration>}
 */
const getModuleConfigurationSpecificProperties = allegedModule => {
  const {
    retained: _retained,
    deferredError: _deferredError,
    ...other
  } = allegedModule;
  return /** @type {Omit<T, keyof BaseModuleConfiguration>} */ (
    Object.fromEntries(entries(other).filter(([key]) => !key.startsWith('_')))
  );
};

/**
 *
 * @param {Record<PropertyKey, unknown>} allegedModule
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedModule is Record<PropertyKey, unknown> & BaseModuleConfiguration}
 */
function assertBaseModuleConfiguration(allegedModule, keypath, url) {
  const { deferredError, retained, createdBy } = allegedModule;
  if (deferredError !== undefined) {
    assertString(deferredError, `${keypath}.deferredError`, url);
  }
  if (retained !== undefined) {
    assertBoolean(retained, `${keypath}.retained`, url);
  }
  if (createdBy !== undefined) {
    assertString(createdBy, `${keypath}.createdBy`, url);
  }
}

/**
 * @param {ModuleConfiguration} moduleDescriptor
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts moduleDescriptor is CompartmentModuleConfiguration}
 */
function assertCompartmentModuleConfiguration(moduleDescriptor, keypath, url) {
  const { compartment, module, ...extra } =
    getModuleConfigurationSpecificProperties(
      /** @type {CompartmentModuleConfiguration} */ (moduleDescriptor),
    );
  keys(extra).length === 0 ||
    Fail`${b(keypath)} must not have extra properties; got ${q(extra)} in ${q(url)}`;

  assertString(compartment, `${keypath}.compartment`, url);
  assertString(module, `${keypath}.module`, url);
}

/**
 * @param {ModuleConfiguration} moduleDescriptor
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts moduleDescriptor is FileModuleConfiguration}
 */
function assertFileModuleConfiguration(moduleDescriptor, keypath, url) {
  const { location, parser, sha512, ...extra } =
    getModuleConfigurationSpecificProperties(
      /** @type {FileModuleConfiguration} */ (moduleDescriptor),
    );
  keys(extra).length === 0 ||
    Fail`${b(keypath)} must not have extra properties; got ${q(keys(extra))} in ${q(url)}`;
  if (location !== undefined) {
    assertString(location, `${keypath}.location`, url);
  }
  assertString(parser, `${keypath}.parser`, url);

  if (sha512 !== undefined) {
    assertString(sha512, `${keypath}.sha512`, url);
  }
}

/**
 * @param {ModuleConfiguration} moduleDescriptor
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts moduleDescriptor is ExitModuleConfiguration}
 */
function assertExitModuleConfiguration(moduleDescriptor, keypath, url) {
  const { exit, ...extra } = getModuleConfigurationSpecificProperties(
    /** @type {ExitModuleConfiguration} */ (moduleDescriptor),
  );
  keys(extra).length === 0 ||
    Fail`${b(keypath)} must not have extra properties; got ${q(keys(extra))} in ${q(url)}`;
  assertString(exit, `${keypath}.exit`, url);
}

/**
 *
 * @param {ModuleConfiguration} moduleDescriptor
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts moduleDescriptor is ErrorModuleConfiguration}
 */
function assertErrorModuleConfiguration(moduleDescriptor, keypath, url) {
  const { deferredError } = moduleDescriptor;
  if (deferredError) {
    assertString(deferredError, `${keypath}.deferredError`, url);
  }
}

/**
 * @template {ModuleConfigurationKind[]} Kinds
 * @overload
 * @param {unknown} allegedModule
 * @param {string} keypath
 * @param {string} url
 * @param {Kinds} kinds
 * @returns {asserts allegedModule is ModuleConfigurationKindToType<Kinds[number]>}
 */

/**
 * @overload
 * @param {unknown} allegedModule
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedModule is ModuleConfiguration}
 */
/**
 * @param {unknown} allegedModule
 * @param {string} keypath
 * @param {string} url
 * @param {ModuleConfigurationKind[]} [kinds]
 * @returns {asserts allegedModule is ModuleConfiguration}
 */
function assertModuleConfiguration(allegedModule, keypath, url, kinds = []) {
  assertPlainObject(allegedModule, keypath, url);
  assertBaseModuleConfiguration(allegedModule, keypath, url);

  const finalKinds =
    kinds.length > 0
      ? kinds
      : /** @type {ModuleConfigurationKind[]} */ ([
          'compartment',
          'file',
          'exit',
          'error',
        ]);
  /** @type {Error[]} */
  const errors = [];
  for (const kind of finalKinds) {
    switch (kind) {
      case 'compartment': {
        try {
          assertCompartmentModuleConfiguration(
            /** @type {ModuleConfiguration} */ (allegedModule),
            keypath,
            url,
          );
        } catch (error) {
          errors.push(/** @type {Error} */ (error));
        }
        break;
      }
      case 'file': {
        try {
          assertFileModuleConfiguration(
            /** @type {ModuleConfiguration} */ (allegedModule),
            keypath,
            url,
          );
        } catch (error) {
          errors.push(/** @type {Error} */ (error));
        }
        break;
      }
      case 'exit': {
        try {
          assertExitModuleConfiguration(
            /** @type {ModuleConfiguration} */ (allegedModule),
            keypath,
            url,
          );
        } catch (error) {
          errors.push(/** @type {Error} */ (error));
        }
        break;
      }
      case 'error': {
        try {
          assertErrorModuleConfiguration(
            /** @type {ModuleConfiguration} */ (allegedModule),
            keypath,
            url,
          );
        } catch (error) {
          errors.push(/** @type {Error} */ (error));
        }
        break;
      }
      default:
        throw new TypeError(
          `Unknown module descriptor kind ${q(kind)} in ${q(url)}`,
        );
    }
  }

  errors.length < finalKinds.length ||
    Fail`invalid module descriptor in ${q(url)} at ${q(keypath)}; expected to match one of ${q(kinds)}: ${errors.map(err => err.message).join('; ')}`;
}

/**
 * @param {unknown} allegedModules
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedModules is Record<string, ModuleConfiguration>}
 */
function assertModuleConfigurations(allegedModules, keypath, url) {
  assertPlainObject(allegedModules, keypath, url);
  for (const [key, value] of entries(allegedModules)) {
    assertString(
      key,
      `all keys of ${keypath}.modules must be strings; got ${key} in ${q(url)}`,
    );
    assertModuleConfiguration(value, `${keypath}.modules[${q(key)}]`, url);
  }
}

/**
 * @param {unknown} allegedModules
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedModules is Record<string, FileModuleConfiguration|CompartmentModuleConfiguration>}
 */
function assertFileModuleConfigurations(allegedModules, keypath, url) {
  assertPlainObject(allegedModules, keypath, url);
  for (const [key, value] of entries(allegedModules)) {
    assertString(
      key,
      `all keys of ${keypath}.modules must be strings; got ${key} in ${q(url)}`,
    );
    assertModuleConfiguration(value, `${keypath}.modules[${q(key)}]`, url, [
      'file',
      'compartment',
      'error',
    ]);
  }
}

/**
 * @param {unknown} allegedModules
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedModules is Record<string, ModuleConfiguration>}
 */
function assertDigestedModuleConfigurations(allegedModules, keypath, url) {
  assertPlainObject(allegedModules, keypath, url);
  for (const [key, value] of entries(allegedModules)) {
    assertString(
      key,
      `all keys of ${keypath}.modules must be strings; got ${key} in ${q(url)}`,
    );
    assertModuleConfiguration(value, `${keypath}.modules[${q(key)}]`, url, [
      'file',
      'exit',
      'error',
    ]);
  }
}

/**
 * @param {unknown} allegedParsers
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedParsers is LanguageForExtension}
 */
function assertParsers(allegedParsers, keypath, url) {
  assertPlainObject(allegedParsers, `${keypath}.parsers`, url);

  for (const [key, value] of entries(allegedParsers)) {
    assertString(
      key,
      `all keys of ${keypath}.parsers must be strings; got ${key} in ${q(url)}`,
    );
    assertString(value, `${keypath}.parsers[${q(key)}]`, url);
  }
}

/**
 * @overload
 * @param {unknown} allegedTruthyValue
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedTruthyValue is NonNullable<unknown>}
 */

/**
 *
 * @overload
 * @param {unknown} allegedTruthyValue
 * @param {string} message
 * @returns {asserts allegedTruthyValue is NonNullable<unknown>}
 */

/**
 *
 * @param {unknown} allegedTruthyValue
 * @param {string} keypath
 * @param {string} [url]
 * @returns {asserts allegedTruthyValue is NonNullable<unknown>}
 */
function assertTruthy(allegedTruthyValue, keypath, url) {
  allegedTruthyValue ||
    (url
      ? Fail`${b(keypath)} in ${q(url)} must be truthy; got ${q(allegedTruthyValue)}`
      : Fail`${q(url)}`);
}

/**
 * @template [T=string]
 * @typedef {(value: unknown, keypath: string, url: string) => void} AssertFn
 */

/**
 * @template {string} [T=string]
 * @param {unknown} allegedScope
 * @param {string} keypath
 * @param {string} url
 * @param {AssertFn<T>} [assertCompartmentValue]
 * @returns {asserts allegedScope is ScopeDescriptor<T>}
 */
function assertScope(allegedScope, keypath, url, assertCompartmentValue) {
  assertPlainObject(allegedScope, keypath, url);

  const { compartment, ...extra } = allegedScope;
  keys(extra).length === 0 ||
    Fail`${b(keypath)} must not have extra properties; got ${q(keys(extra))} in ${q(url)}`;

  if (assertCompartmentValue) {
    assertCompartmentValue(compartment, `${keypath}.compartment`, url);
  } else {
    assertString(compartment, `${keypath}.compartment`, url);
  }
}

/**
 * @template {string} [T=string]
 * @param {unknown} allegedScopes
 * @param {string} keypath
 * @param {string} url
 * @param {AssertFn<T>} [assertCompartmentValue]
 * @returns {asserts allegedScopes is Record<string, ScopeDescriptor<T>>}
 */
function assertScopes(
  allegedScopes,
  keypath,
  url,
  assertCompartmentValue = assertString,
) {
  assertPlainObject(allegedScopes, keypath, url);

  for (const [key, value] of entries(allegedScopes)) {
    assertString(
      key,
      `all keys of ${keypath}.scopes must be strings; got ${key} in ${q(url)}`,
    );
    assertScope(
      value,
      `${keypath}.scopes[${q(key)}]`,
      url,
      assertCompartmentValue,
    );
  }
}

/**
 * @param {unknown} allegedTypes
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedTypes is LanguageForModuleSpecifier}
 */
function assertTypes(allegedTypes, keypath, url) {
  assertPlainObject(allegedTypes, `${keypath}.types`, url);

  for (const [key, value] of entries(allegedTypes)) {
    assertString(
      key,
      `all keys of ${keypath}.types must be strings; got ${key} in ${q(url)}`,
    );
    assertString(value, `${keypath}.types[${q(key)}]`, url);
  }
}

/**
 * @template {Record<string, ModuleConfiguration>} [M=Record<string, ModuleConfiguration>]
 * @param {unknown} allegedCompartment
 * @param {string} keypath
 * @param {string} url
 * @param {AssertFn<M>} [moduleConfigurationAssertionFn]
 * @returns {asserts allegedCompartment is CompartmentDescriptor}
 */
function assertCompartmentDescriptor(
  allegedCompartment,
  keypath,
  url,
  moduleConfigurationAssertionFn = assertModuleConfigurations,
) {
  assertPlainObject(allegedCompartment, keypath, url);

  const {
    location,
    name,
    parsers,
    types,
    scopes,
    modules,
    policy,
    sourceDirname,
    retained,
  } = allegedCompartment;

  assertString(location, `${keypath}.location`, url);
  assertString(name, `${keypath}.name`, url);

  // TODO: It may be prudent to assert that there exists some module referring
  // to its own compartment

  moduleConfigurationAssertionFn(modules, keypath, url);

  if (parsers !== undefined) {
    assertParsers(parsers, keypath, url);
  }
  if (scopes !== undefined) {
    assertScopes(scopes, keypath, url);
  }
  if (types !== undefined) {
    assertTypes(types, keypath, url);
  }
  if (policy !== undefined) {
    assertPackagePolicy(policy, keypath, url);
  }
  if (sourceDirname !== undefined) {
    assertString(sourceDirname, `${keypath}.sourceDirname`, url);
  }
  if (retained !== undefined) {
    assertBoolean(retained, `${keypath}.retained`, url);
  }
}

/**
 * Ensures a string is a file URL (a {@link FileUrlString})
 *
 * @param {unknown} allegedFileUrlString - a package location to assert
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedFileUrlString is FileUrlString}
 */
function assertFileUrlString(allegedFileUrlString, keypath, url) {
  assertString(allegedFileUrlString, keypath, url);
  allegedFileUrlString.startsWith('file://') ||
    Fail`${b(keypath)} must be a file URL in ${q(url)}; got ${q(allegedFileUrlString)}`;
  allegedFileUrlString.length > 7 ||
    Fail`${b(keypath)} must contain a non-empty path in ${q(url)}; got ${q(allegedFileUrlString)}`;
}

/**
 * @param {unknown} allegedModules
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedModules is Record<string, CompartmentModuleConfiguration>}
 */
function assertPackageModuleConfigurations(allegedModules, keypath, url) {
  assertPlainObject(allegedModules, keypath, url);
  for (const [key, value] of entries(allegedModules)) {
    assertString(
      key,
      `all keys of ${keypath}.modules must be strings; got ${key} in ${q(url)}`,
    );
    assertModuleConfiguration(value, `${keypath}.modules[${q(key)}]`, url, [
      'compartment',
    ]);
  }
}

/**
 *
 * @param {unknown} allegedLocation
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedLocation is PackageCompartmentDescriptor['location']}
 */
function assertPackageLocation(allegedLocation, keypath, url) {
  if (allegedLocation === ATTENUATORS_COMPARTMENT) {
    return;
  }
  assertFileUrlString(allegedLocation, keypath, url);
}

/**
 * @param {unknown} allegedCompartment
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedCompartment is PackageCompartmentDescriptor}
 */
function assertPackageCompartmentDescriptor(allegedCompartment, keypath, url) {
  assertCompartmentDescriptor(
    allegedCompartment,
    keypath,
    url,
    assertPackageModuleConfigurations,
  );

  const {
    location,
    scopes,
    label,
    // these unused vars already validated by assertPackageModuleConfigurations
    name: _name,
    sourceDirname: _sourceDirname,
    modules: _modules,
    parsers: _parsers,
    types: _types,
    policy: _policy,
    version: _version,
    ...extra
  } = /** @type {PackageCompartmentDescriptor} */ (allegedCompartment);

  keys(extra).length === 0 ||
    Fail`${b(keypath)} must not have extra properties; got ${q(keys(extra))} in ${q(url)}`;

  assertPackageLocation(location, `${keypath}.location`, url);
  assertLabel(label, `${keypath}.label`, url);
  assertScopes(scopes, `${keypath}.scopes`, url, assertFileUrlString);
}

/**
 *
 * @param {unknown} allegedCompartment
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedCompartment is DigestedCompartmentDescriptor}
 */
function assertDigestedCompartmentDescriptor(allegedCompartment, keypath, url) {
  assertCompartmentDescriptor(
    allegedCompartment,
    keypath,
    url,
    assertDigestedModuleConfigurations,
  );

  const {
    name: _name,
    label: _label,
    modules: _modules,
    policy: _policy,
    location: _location,
    ...extra
  } = allegedCompartment;

  keys(extra).length === 0 ||
    Fail`${b(keypath)} must not have extra properties; got ${q(keys(extra))} in ${q(url)}`;
}

/**
 * @param {unknown} allegedCompartment
 * @param {string} keypath
 * @param {string} url
 * @returns {asserts allegedCompartment is FileCompartmentDescriptor}
 */
function assertFileCompartmentDescriptor(allegedCompartment, keypath, url) {
  assertCompartmentDescriptor(
    allegedCompartment,
    keypath,
    url,
    assertFileModuleConfigurations,
  );

  const {
    location: _location,
    name: _name,
    label,
    modules: _modules,
    policy: _policy,
    ...extra
  } = /** @type {FileCompartmentDescriptor} */ (allegedCompartment);

  keys(extra).length === 0 ||
    Fail`${b(keypath)} must not have extra properties; got ${q(keys(extra))} in ${q(url)}`;

  assertString(label, `${keypath}.label`, url);
}

/**
 * @param {unknown} allegedCompartments
 * @param {string} url
 * @returns {asserts allegedCompartments is Record<string, unknown>}
 */
function assertCompartmentDescriptors(allegedCompartments, url) {
  assertPlainObject(allegedCompartments, 'compartments', url);
  const compartmentNames = keys(allegedCompartments);
  compartmentNames.length > 0 ||
    Fail`compartments must not be empty in ${q(url)}`;
  for (const key of keys(allegedCompartments)) {
    assertString(
      key,
      `all keys of compartments must be strings; got ${key} in ${q(url)}`,
    );
  }
  compartmentNames.every(name => typeof name === 'string') ||
    Fail`all keys of compartments must be strings; got ${q(compartmentNames)} in ${q(url)}`;
}

/**
 * @param {unknown} allegedCompartments
 * @param {string} url
 * @returns {asserts allegedCompartments is Record<string, FileCompartmentDescriptor>}
 */
function assertFileCompartmentDescriptors(allegedCompartments, url) {
  assertCompartmentDescriptors(allegedCompartments, url);
  for (const [key, value] of entries(allegedCompartments)) {
    assertFileCompartmentDescriptor(value, `compartments[${q(key)}]`, url);
  }
}

/**
 * @param {unknown} allegedCompartments
 * @param {string} url
 * @returns {asserts allegedCompartments is Record<string, PackageCompartmentDescriptor>}
 */
function assertPackageCompartmentDescriptors(allegedCompartments, url) {
  assertCompartmentDescriptors(allegedCompartments, url);
  for (const [key, value] of entries(allegedCompartments)) {
    assertPackageCompartmentDescriptor(value, `compartments[${q(key)}]`, url);
  }
}
/**
 * @param {unknown} allegedEntry
 * @param {string} url
 * @returns {asserts allegedEntry is EntryDescriptor}
 */
function assertEntry(allegedEntry, url) {
  assertPlainObject(allegedEntry, 'entry', url);
  const { compartment, module, ...extra } = allegedEntry;
  keys(extra).length === 0 ||
    Fail`"entry" must not have extra properties in compartment map; got ${q(keys(extra))} in ${q(url)}`;
  assertString(compartment, 'entry.compartment', url);
  assertString(module, 'entry.module', url);
}

/**
 * @param {unknown} allegedCompartmentMap
 * @param {string} url
 * @returns {asserts allegedCompartmentMap is CompartmentMapDescriptor}
 */
function assertCompartmentMap(allegedCompartmentMap, url) {
  assertPlainObject(allegedCompartmentMap, 'compartment map', url);
  const {
    // TODO migrate tags to conditions
    // https://github.com/endojs/endo/issues/2388
    tags: conditions,
    entry,
    compartments: _compartments,
    ...extra
  } = allegedCompartmentMap;
  keys(extra).length === 0 ||
    Fail`Compartment map must not have extra properties; got ${q(keys(extra))} in ${q(url)}`;
  assertConditions(conditions, url);
  assertEntry(entry, url);
  assertTruthy(
    allegedCompartmentMap.compartments?.[entry.compartment],
    `compartments must contain entry compartment "${entry.compartment}" in ${q(url)}`,
  );
}

/**
 * @param {unknown} allegedCompartmentMap
 * @param {string} [url]
 * @returns {asserts allegedCompartmentMap is FileCompartmentMapDescriptor}
 */
export function assertFileCompartmentMap(
  allegedCompartmentMap,
  url = '<unknown-compartment-map.json>',
) {
  assertCompartmentMap(allegedCompartmentMap, url);
  const { compartments } = allegedCompartmentMap;
  assertFileCompartmentDescriptors(compartments, url);
}

/**
 *
 * @param {unknown} allegedCompartments
 * @param {string} url
 * @returns {asserts allegedCompartments is Record<string, DigestedCompartmentDescriptor>}
 */
export function assertDigestedCompartmentDescriptors(
  allegedCompartments,
  url = '<unknown-compartment-map.json>',
) {
  assertCompartmentDescriptors(allegedCompartments, url);
  for (const [key, value] of entries(allegedCompartments)) {
    assertDigestedCompartmentDescriptor(value, `compartments[${q(key)}]`, url);
  }
}

/**
 *
 * @param {unknown} allegedCompartmentMap
 * @param {string} [url]
 * @returns {asserts allegedCompartmentMap is DigestedCompartmentMapDescriptor}
 */
export function assertDigestedCompartmentMap(
  allegedCompartmentMap,
  url = '<unknown-compartment-map.json>',
) {
  assertCompartmentMap(allegedCompartmentMap, url);
  const { compartments } = allegedCompartmentMap;
  assertDigestedCompartmentDescriptors(compartments, url);
}

/**
 * @param {unknown} allegedCompartmentMap
 * @param {string} [url]
 * @returns {asserts allegedCompartmentMap is PackageCompartmentMapDescriptor}
 */
export function assertPackageCompartmentMap(
  allegedCompartmentMap,
  url = '<unknown-compartment-map.json>',
) {
  assertCompartmentMap(allegedCompartmentMap, url);
  const { compartments } = allegedCompartmentMap;
  assertPackageCompartmentDescriptors(compartments, url);
}
