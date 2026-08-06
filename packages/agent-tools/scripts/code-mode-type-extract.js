// @ts-check
/// <reference types="ses"/>

/**
 * Generic, exo-agnostic code-mode type machinery: the shared intermediate
 * representation ({@link GlobalTypeIR}) plus BOTH renderers that fill it from a
 * source and the one renderer that prints it.
 *
 * This module is NOT part of the `@endo/agentry` runtime graph: it depends on
 * the `typescript` compiler API and the `@endo/patterns` guard payload helpers,
 * both dev-only. The per-exo extractors (`code-mode-git-extract.js`,
 * `code-mode-fs-extract.js`, `code-mode-git-remote-extract.js`,
 * `code-mode-http-extract.js`, `code-mode-shell-extract.js`) compose these
 * primitives with their own source configuration; `scripts/gen-code-mode-types.js`
 * composes the per-exo extractors to write the checked-in runtime artifacts,
 * and the divergence gate in `test/code-mode-types.test.js` re-runs them to
 * keep those artifacts fresh.
 *
 * Two renderers fill the IR from two different kinds of source; the module
 * exports both and picks no canonical one:
 *
 * - {@link extractTsModuleIR} reads a TypeScript declaration source and prints
 *   the named root type with the `typescript` compiler API. Full-fidelity
 *   TypeScript is the richest source when one exists (named parameters,
 *   prose-free signatures straight from the author). A type it reaches in
 *   another `@endo/*` package is followed into that package's own type source
 *   and inlined, transitively and without a depth limit; a type outside the
 *   `@endo` namespace, or one no reachable type source declares, collapses to
 *   `unknown` so the prompt surface stays self-contained.
 * - {@link extractGuardIR} walks the runtime `M.interface` guards of a remotable
 *   and the transitive closure of remotables they reach. This is the richest
 *   source when no expressive `.d.ts` exists (a stub, or a generated one).
 *
 * Neither is canonical: `M.interface` guards are lossy as a type source
 * (positional patterns with no parameter names, no JSDoc or prose context), so
 * the TypeScript path stays valuable; a stub `.d.ts` makes the guard path the
 * only useful one. A consumer composes whichever fits each exo.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import {
  getInterfaceGuardPayload,
  getMethodGuardPayload,
} from '@endo/patterns';
import { getTag, passStyleOf } from '@endo/pass-style';

/**
 * @typedef {object} TypeMember
 * @property {string} name Member (method) name.
 * @property {string} signature TS type of the member, e.g. `() => Promise<string>`.
 *
 * @typedef {object} AuxType
 * @property {string} name Type name (may be generic, e.g. `ERef<T>`).
 * @property {string} text Right-hand side of the `type <name> = <text>` alias.
 *
 * @typedef {object} GlobalTypeIR
 * @property {string} rootName Name of the global's root object type, e.g. `WritableEndoGit`.
 * @property {TypeMember[]} members Members of the root object type.
 * @property {AuxType[]} auxTypes Supporting named types the members reference
 *   (excluding the root type itself, which the renderer synthesizes from
 *   `members` so a read-only member filter cannot leak the full surface back in
 *   through a self-referential return).
 * @property {string} [selfName] Name a self-referential member signature (e.g.
 *   `scope(...) => X | Self`) uses for the root type when it differs from
 *   `rootName`. Set this when a caller renames `rootName` after extraction
 *   (e.g. `ReadWriteEndoGit` printed as `WritableEndoGit`) so the renderer can
 *   rewrite the stale self-reference left behind in `members`/`auxTypes`
 *   text. Defaults to `rootName` when omitted.
 */

// #region shared renderer (no typescript / patterns dependency)

/**
 * @param {TypeMember[]} members
 * @returns {string}
 */
const renderObjectType = members =>
  `{\n${members.map(m => `  ${m.name}: ${m.signature};`).join('\n')}\n}`;

/**
 * @param {AuxType[]} auxTypes
 * @returns {string}
 */
const renderAuxTypes = auxTypes =>
  auxTypes.map(a => `type ${a.name} = ${a.text};`).join('\n');

/**
 * The single renderer applied to every IR regardless of source: synthesize the
 * root `type` from `members`, print it alongside the supporting aliases as
 * `aux`, and reference it by name as the `body` spliced after
 * `declare const <name>:`.
 *
 * @param {GlobalTypeIR} ir
 * @param {{ auxPrefix?: string }} [options]
 * @returns {{ aux: string, body: string }}
 */
export const renderDeclaration = (ir, options = {}) => {
  const { auxPrefix = '' } = options;
  /** @type {Map<string, string>} */
  const renamed = new Map();
  if (ir.selfName !== undefined && ir.selfName !== ir.rootName) {
    renamed.set(ir.selfName, ir.rootName);
  }
  const scopedName = name => {
    const match = /^([A-Za-z_$][0-9A-Za-z_$]*)(<.*>)?$/u.exec(name);
    if (!match) {
      throw new Error(`invalid generated type alias name: ${name}`);
    }
    const [, base, parameters = ''] = match;
    const scopedBase = base.startsWith(auxPrefix)
      ? base
      : `${auxPrefix}${base}`;
    const scoped = `${scopedBase}${parameters}`;
    renamed.set(base, scopedBase);
    return scoped;
  };
  const auxNames = ir.auxTypes.map(type => scopedName(type.name));
  const rewrite = text => {
    let rewritten = text;
    for (const [name, replacement] of renamed) {
      rewritten = rewritten.replace(
        new RegExp(`\\b${name}\\b`, 'g'),
        replacement,
      );
    }
    return rewritten;
  };
  const aux = [
    {
      name: ir.rootName,
      text: renderObjectType(
        ir.members.map(member => ({
          ...member,
          signature: rewrite(member.signature),
        })),
      ),
    },
    ...ir.auxTypes.map((type, index) => ({
      name: rewrite(auxNames[index]),
      text: rewrite(type.text),
    })),
  ];
  return harden({ aux: renderAuxTypes(aux), body: ir.rootName });
};
harden(renderDeclaration);

// #endregion

// #region TypeScript renderer (`type` -> declaration, via the typescript printer)

/**
 * @typedef {{ specifier: string, exportedName: string }} ImportBinding
 *   A locally bound type name and the module member it names.
 */

/**
 * Index the `import ... from '<specifier>'` bindings a declaration source
 * introduces, so a bare type reference such as `Passable` can be told apart
 * from a TypeScript global and followed (or collapsed) as the import it is.
 *
 * @param {readonly ts.Statement[]} statements
 * @param {Map<string, ImportBinding>} [importMap] Accumulator, so a
 *   `declare module` block can extend its file's top-level imports.
 * @returns {Map<string, ImportBinding>}
 */
const collectImportBindings = (statements, importMap = new Map()) => {
  for (const stmt of statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.importClause !== undefined
    ) {
      const specifier = stmt.moduleSpecifier.text;
      const { namedBindings } = stmt.importClause;
      if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          importMap.set(element.name.text, {
            specifier,
            exportedName: (element.propertyName ?? element.name).text,
          });
        }
      }
    }
  }
  return importMap;
};

/**
 * @param {string} fileName
 * @param {string} text
 * @returns {ParsedTypeModule}
 */
const parseTypeAliases = (fileName, text) => {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  /** @type {Map<string, ts.TypeAliasDeclaration | ts.InterfaceDeclaration>} */
  const aliasMap = new Map();
  for (const stmt of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
      aliasMap.set(stmt.name.text, stmt);
    }
  }
  return {
    sourceFile,
    aliasMap,
    importMap: collectImportBindings(sourceFile.statements),
  };
};

/**
 * @param {URL} dtsUrl
 * @param {string} moduleName
 * @returns {ParsedTypeModule}
 */
const parseDtsModule = (dtsUrl, moduleName) => {
  const text = readFileSync(fileURLToPath(dtsUrl), 'utf8');
  const sourceFile = ts.createSourceFile(
    fileURLToPath(dtsUrl),
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  /** @type {ts.ModuleBlock | undefined} */
  let moduleBody;
  for (const stmt of sourceFile.statements) {
    if (
      ts.isModuleDeclaration(stmt) &&
      ts.isStringLiteral(stmt.name) &&
      stmt.name.text === moduleName &&
      stmt.body &&
      ts.isModuleBlock(stmt.body)
    ) {
      moduleBody = stmt.body;
      break;
    }
  }
  if (!moduleBody) {
    throw new Error(`could not find declare module '${moduleName}'`);
  }
  /** @type {Map<string, ts.TypeAliasDeclaration | ts.InterfaceDeclaration>} */
  const aliasMap = new Map();
  for (const stmt of moduleBody.statements) {
    if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
      aliasMap.set(stmt.name.text, stmt);
    }
  }
  return {
    sourceFile,
    aliasMap,
    importMap: collectImportBindings(
      moduleBody.statements,
      collectImportBindings(sourceFile.statements),
    ),
  };
};

/** @typedef {{ sourceFile: ts.SourceFile, aliasMap: Map<string, ts.TypeAliasDeclaration | ts.InterfaceDeclaration>, importMap: Map<string, ImportBinding> }} ParsedTypeModule */

/**
 * Type sources the package's own `exports` map cannot name directly.
 * These packages publish thin declaration re-export indexes, which carry no
 * definitions of their own; the definitions live in checked `.ts` hosts.
 */
const TYPE_SOURCE_OVERRIDES = new Map([
  ['@endo/exo-stream', 'types.ts'],
  ['@endo/platform/fs/lite/types', 'src/fs/types.ts'],
  ['@endo/platform/fs/extended', 'src/fs/extended/types.ts'],
]);

/**
 * The `@endo/<name>` package a bare or subpath specifier belongs to, or
 * `undefined` for a specifier outside the `@endo` namespace.
 *
 * @param {string} moduleName
 * @returns {string | undefined}
 */
const endoPackageName = moduleName => {
  const match = /^(@endo\/[^/]+)(?:\/.*)?$/u.exec(moduleName);
  return match === null ? undefined : match[1];
};

/**
 * The first `types` condition reachable in an `exports` entry, whatever
 * condition object nests it.
 *
 * @param {unknown} entry
 * @returns {string | undefined}
 */
const typesCondition = entry => {
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const conditions = /** @type {Record<string, unknown>} */ (entry);
  if (typeof conditions.types === 'string') {
    return conditions.types;
  }
  for (const value of Object.values(conditions)) {
    const found = typesCondition(value);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

/**
 * Locate an installed package's root directory without depending on it
 * exporting `./package.json`.
 *
 * @param {NodeJS.Require} require
 * @param {string} packageName
 * @returns {string | undefined}
 */
const resolvePackageRoot = (require, packageName) => {
  try {
    return dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    // Fall through: the package may not export its manifest.
  }
  let directory;
  try {
    directory = dirname(require.resolve(packageName));
  } catch {
    return undefined;
  }
  for (let parent = directory; ; parent = dirname(parent)) {
    const manifest = join(parent, 'package.json');
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
      if (name === packageName) {
        return parent;
      }
    }
    if (dirname(parent) === parent) {
      return undefined;
    }
  }
};

/**
 * Resolve the declaration source behind an imported type expression.
 * Workspace packages expose runtime paths for their default condition, while
 * the extractor needs the checked source type host instead: the `types`
 * condition of the package's `exports` map, else the `.ts` or `.d.ts` beside
 * the resolved runtime module.
 *
 * A package that publishes no type source (`@endo/patterns` and
 * `@endo/pass-style` export a bare runtime path) resolves to `undefined`, and
 * the types it would have contributed collapse to `unknown`.
 *
 * @param {string} moduleName
 * @param {string} fromFile
 * @returns {string | undefined}
 */
const resolveTypeModule = (moduleName, fromFile) => {
  const packageName = endoPackageName(moduleName);
  if (packageName === undefined) {
    return undefined;
  }
  const require = createRequire(fromFile);
  const packageRoot = resolvePackageRoot(require, packageName);
  if (packageRoot === undefined) {
    return undefined;
  }
  const override = TYPE_SOURCE_OVERRIDES.get(moduleName);
  if (override !== undefined) {
    return join(packageRoot, override);
  }
  const subpath =
    moduleName === packageName
      ? '.'
      : `.${moduleName.slice(packageName.length)}`;
  const { exports: exportsMap } = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  );
  const declared = typesCondition(exportsMap?.[subpath]);
  if (declared !== undefined) {
    const resolved = join(packageRoot, declared);
    return existsSync(resolved) ? resolved : undefined;
  }
  let runtime;
  try {
    runtime = require.resolve(moduleName);
  } catch {
    return undefined;
  }
  if (runtime.endsWith('.ts')) {
    return runtime;
  }
  const base = runtime.replace(/\.js$/u, '');
  return [`${base}.ts`, `${base}.d.ts`].find(candidate =>
    existsSync(candidate),
  );
};
harden(resolveTypeModule);

/** @type {Map<string, ParsedTypeModule>} */
const typeModuleCache = new Map();

/**
 * @param {string} fileName
 * @returns {ParsedTypeModule}
 */
const parseTypeModule = fileName => {
  const cached = typeModuleCache.get(fileName);
  if (cached !== undefined) {
    return cached;
  }
  const text = readFileSync(fileName, 'utf8');
  const parsed = parseTypeAliases(fileName, text);
  typeModuleCache.set(fileName, parsed);
  return parsed;
};
harden(parseTypeModule);

/**
 * Build a {@link GlobalTypeIR} by locating the named root `type` alias in a
 * parsed TypeScript declaration source, then printing the kept members and the
 * supporting aliases they reach with the `typescript` printer.
 *
 * With a `memberFilter`, only the named members (and the types they reach) are
 * kept; this is how a read-only or otherwise narrowed variant is produced from
 * the same source.
 *
 * @param {object} config
 * @param {ParsedTypeModule} config.rootModule The parsed declaration source.
 * @param {string} config.rootType Name of the root `type` alias to print.
 * @param {string[]} [config.memberFilter] When set, keep only these members.
 * @returns {GlobalTypeIR}
 */
const extractTsAliasesIR = ({ rootModule, rootType, memberFilter }) => {
  const { sourceFile, aliasMap } = rootModule;
  const printer = ts.createPrinter({ removeComments: true });
  const sourceKey = fileName => `${fileName}:`;

  /** @type {Map<string, ParsedTypeModule>} */
  const parsedModules = new Map([[sourceFile.fileName, rootModule]]);
  /** @type {Map<string, string>} */
  const outputNames = new Map();
  /** @type {Map<string, string>} */
  const outputOwners = new Map();
  /** @type {Map<string, AuxType>} */
  const auxTypes = new Map();
  const building = new Set();

  const moduleFor = fileName => {
    const current = parsedModules.get(fileName);
    if (current !== undefined) {
      return current;
    }
    const parsed = parseTypeModule(fileName);
    parsedModules.set(fileName, parsed);
    return parsed;
  };

  const modulePrefix = fileName => {
    if (fileName.includes('/fs/extended/')) {
      return 'Extended';
    }
    if (
      fileName.includes('/fs/lite/') ||
      fileName.endsWith('/fs/types.d.ts') ||
      fileName.endsWith('/fs/types.ts')
    ) {
      return 'Lite';
    }
    return 'Imported';
  };

  // A preferred name may carry a type-parameter list (`StreamNode<Y, R>`).
  // Collisions are resolved on the base name alone, so two same-named generic
  // types from different modules still get distinct aliases.
  const allocateName = (key, preferredName, fileName) => {
    const existing = outputNames.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const [, base, parameters = ''] = /** @type {RegExpExecArray} */ (
      /^([^<]+)(<.*>)?$/u.exec(preferredName)
    );
    let name = base;
    if (name === rootType || outputOwners.has(name)) {
      const prefix = modulePrefix(fileName);
      name = `${prefix}${base}`;
      let suffix = 2;
      while (name === rootType || outputOwners.has(name)) {
        name = `${prefix}${base}${suffix}`;
        suffix += 1;
      }
    }
    outputNames.set(key, `${name}${parameters}`);
    outputOwners.set(name, key);
    return `${name}${parameters}`;
  };

  // Keep aliases authored by the capability package stable.
  // Imported aliases are allocated after these so two platform modules can
  // both define, for example, a `Directory` without colliding in the emitted
  // block.
  for (const name of aliasMap.keys()) {
    const key = `${sourceKey(sourceFile.fileName)}${name}`;
    allocateName(key, name, sourceFile.fileName);
  }

  /** @typedef {{ declaration: ts.TypeAliasDeclaration | ts.InterfaceDeclaration, fileName: string, key: string }} FoundDeclaration */

  /**
   * Follow a type reference into another `@endo/*` package's declaration
   * source. The walk is transitive and uncapped: a followed type's own
   * imports resolve the same way, and `ensureAlias` memoizes per
   * module-and-name so a cycle terminates.
   *
   * A specifier outside the `@endo` namespace, a package with no type source,
   * and a name that source does not declare all resolve to `undefined`, which
   * the caller renders as `unknown`.
   *
   * @param {string} moduleName
   * @param {string} name
   * @param {string} fromFile
   * @returns {FoundDeclaration | undefined}
   */
  const followImport = (moduleName, name, fromFile) => {
    const fileName = resolveTypeModule(moduleName, fromFile);
    if (fileName === undefined) {
      return undefined;
    }
    const declaration = moduleFor(fileName).aliasMap.get(name);
    return declaration === undefined
      ? undefined
      : { declaration, fileName, key: `${sourceKey(fileName)}${name}` };
  };

  /**
   * @param {ts.ImportTypeNode} node
   * @param {string} fromFile
   * @returns {FoundDeclaration | undefined}
   */
  const importedDeclaration = (node, fromFile) => {
    if (
      !ts.isLiteralTypeNode(node.argument) ||
      !ts.isStringLiteral(node.argument.literal) ||
      node.qualifier === undefined
    ) {
      return undefined;
    }
    return followImport(
      node.argument.literal.text,
      node.qualifier.getText(),
      fromFile,
    );
  };

  const resolveReference = (name, fromFile) => {
    const declaration = moduleFor(fromFile).aliasMap.get(name);
    if (declaration !== undefined) {
      return {
        declaration,
        fileName: fromFile,
        key: `${sourceKey(fromFile)}${name}`,
      };
    }
    // The extended filesystem source re-exports ERef from @endo/eventual-send
    // without declaring it locally.
    // Keep the prompt self-contained with the
    // same eventual-send shape used by the guard renderer.
    if (name === 'ERef') {
      return {
        declaration: undefined,
        fileName: fromFile,
        key: 'builtin:ERef',
      };
    }
    return undefined;
  };

  /**
   * @param {string} key
   * @param {string} preferredName
   * @param {string} fileName
   * @returns {string}
   */
  const ensureName = (key, preferredName, fileName) =>
    allocateName(key, preferredName, fileName);

  /**
   * The type-parameter list to redeclare on an emitted alias, as bare names
   * (`<Y, R>`).  Constraints are dropped: they name types from packages the
   * prompt does not carry, and a prompt declaration has nothing to check them
   * against.
   *
   * @param {ts.TypeAliasDeclaration | ts.InterfaceDeclaration} declaration
   * @returns {string}
   */
  const typeParameterNames = declaration =>
    declaration.typeParameters === undefined ||
    declaration.typeParameters.length === 0
      ? ''
      : `<${declaration.typeParameters.map(p => p.name.text).join(', ')}>`;

  /**
   * The same list with each parameter's default, so every reference can omit
   * its type arguments the way the source's own references do.  A parameter
   * with no declared default defaults to `unknown`.
   *
   * @param {ts.TypeAliasDeclaration | ts.InterfaceDeclaration} declaration
   * @param {string} fileName
   * @returns {string}
   */
  const typeParameterDefaults = (declaration, fileName) =>
    declaration.typeParameters === undefined ||
    declaration.typeParameters.length === 0
      ? ''
      : `<${declaration.typeParameters
          .map(parameter => {
            const fallback =
              parameter.default === undefined
                ? 'unknown'
                : printer.printNode(
                    ts.EmitHint.Unspecified,
                    transformType(parameter.default, fileName),
                    moduleFor(fileName).sourceFile,
                  );
            return `${parameter.name.text} = ${fallback}`;
          })
          .join(', ')}>`;

  /**
   * @param {string} key
   * @param {string} name
   * @param {string} fileName
   */
  const ensureAlias = (key, name, fileName) => {
    if (key === 'builtin:ERef') {
      const outputName = ensureName(key, 'ERef<T>', fileName);
      if (!auxTypes.has(key)) {
        auxTypes.set(key, { name: outputName, text: 'T | Promise<T>' });
      }
      return outputName;
    }
    const current = moduleFor(fileName).aliasMap.get(name);
    if (current === undefined) {
      throw new Error(`missing declaration for ${name}`);
    }
    const outputName = ensureName(
      key,
      `${name}${typeParameterNames(current)}`,
      fileName,
    );
    // A type reached again while its own body is still printing is a cycle;
    // the name is already allocated, so returning it terminates the walk.
    if (auxTypes.has(key) || building.has(key)) {
      return outputName;
    }
    building.add(key);
    const declaration = ts.isTypeAliasDeclaration(current)
      ? current.type
      : ts.factory.createTypeLiteralNode(current.members);
    const text = printer.printNode(
      ts.EmitHint.Unspecified,
      transformType(declaration, fileName),
      moduleFor(fileName).sourceFile,
    );
    auxTypes.set(key, {
      name: `${outputName.replace(/<.*>$/u, '')}${typeParameterDefaults(
        current,
        fileName,
      )}`,
      text,
    });
    building.delete(key);
    return outputName;
  };

  /**
   * Rewrite local and followed `@endo/*` type references to the names
   * allocated for the emitted declaration block.
   * References that leave the `@endo` namespace, or that no reachable type
   * source declares, intentionally become `unknown`; the rest are collected
   * recursively as aux types.
   *
   * @param {ts.TypeNode} node
   * @param {string} fromFile
   * @returns {ts.TypeNode}
   */
  function transformType(node, fromFile) {
    const unknownType = () =>
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    const transformer = /** @type {ts.TransformerFactory<ts.TypeNode>} */ (
      context => root => {
        /**
         * @param {FoundDeclaration} found
         * @param {ts.NodeArray<ts.TypeNode> | undefined} typeArguments
         * @param {(node: ts.Node) => ts.Node | undefined} visit
         */
        const referenceTo = (found, typeArguments, visit) => {
          const outputName = ensureAlias(
            found.key,
            found.declaration.name.text,
            found.fileName,
          );
          return ts.factory.createTypeReferenceNode(
            outputName.replace(/<.*>$/u, ''),
            typeArguments &&
              ts.factory.createNodeArray(
                typeArguments.map(
                  argument =>
                    /** @type {ts.TypeNode} */ (ts.visitNode(argument, visit)),
                ),
              ),
          );
        };
        /** @param {ts.Node} current */
        const visit = current => {
          if (ts.isImportTypeNode(current)) {
            const found = importedDeclaration(current, fromFile);
            // Code mode is intentionally self-contained: a type no `@endo/*`
            // declaration source can supply retains a valid prompt type
            // rather than a dangling reference.
            return found === undefined
              ? unknownType()
              : referenceTo(found, current.typeArguments, visit);
          }
          if (
            ts.isTypeReferenceNode(current) &&
            ts.isIdentifier(current.typeName)
          ) {
            // The synthesized root declaration is the canonical name for a
            // recursive reference to itself.  Allocating it as an auxiliary
            // alias would rename it (the root name is already occupied) and
            // print an accidental imported-looking duplicate type.
            if (
              current.typeName.text === rootType &&
              fromFile === sourceFile.fileName
            ) {
              return ts.visitEachChild(current, visit, context);
            }
            const found = resolveReference(current.typeName.text, fromFile);
            if (found !== undefined) {
              const outputName = ensureAlias(
                found.key,
                current.typeName.text,
                found.fileName,
              );
              return ts.factory.createTypeReferenceNode(
                outputName.replace(/<.*>$/u, ''),
                current.typeArguments
                  ? ts.factory.createNodeArray(
                      current.typeArguments.map(argument =>
                        ts.visitNode(argument, visit),
                      ),
                    )
                  : undefined,
              );
            }
            // A name the module imports is module-scoped, not a TypeScript
            // global: follow it when it is an `@endo/*` type and collapse it
            // otherwise, so no unresolvable identifier reaches the prompt.
            const binding = moduleFor(fromFile).importMap.get(
              current.typeName.text,
            );
            if (binding !== undefined) {
              const imported = followImport(
                binding.specifier,
                binding.exportedName,
                fromFile,
              );
              return imported === undefined
                ? unknownType()
                : referenceTo(imported, current.typeArguments, visit);
            }
          }
          return ts.visitEachChild(current, visit, context);
        };
        return /** @type {ts.TypeNode} */ (ts.visitNode(root, visit));
      }
    );
    const result = ts.transform(node, [transformer]);
    const [transformed] = result.transformed;
    result.dispose();
    return /** @type {ts.TypeNode} */ (transformed);
  }

  const rootAlias = aliasMap.get(rootType);
  if (!rootAlias || !ts.isTypeAliasDeclaration(rootAlias)) {
    throw new Error(`${rootType} is not a type alias`);
  }
  const keep = name => !memberFilter || memberFilter.includes(name);

  /**
   * @param {ts.TypeNode} node
   * @param {Set<string>} seen
   * @returns {ts.TypeElement[]}
   */
  const typeMembers = (node, seen) => {
    if (ts.isTypeLiteralNode(node)) {
      return [...node.members];
    }
    if (ts.isIntersectionTypeNode(node)) {
      return node.types.flatMap(part => typeMembers(part, seen));
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const name = node.typeName.text;
      const declaration = aliasMap.get(name);
      if (declaration !== undefined && !seen.has(name)) {
        const nextSeen = new Set(seen);
        nextSeen.add(name);
        if (ts.isTypeAliasDeclaration(declaration)) {
          return typeMembers(declaration.type, nextSeen);
        }
      }
    }
    throw new Error(`${rootType} must resolve to object type members`);
  };
  const rootMembers = typeMembers(rootAlias.type, new Set([rootType]));

  /** @type {TypeMember[]} */
  const members = [];
  /** @type {Map<string, ts.TypeElement>} */
  const memberMap = new Map();
  for (const m of rootMembers) {
    if (ts.isPropertySignature(m) && m.type) {
      memberMap.set(m.name.getText(sourceFile), m);
    }
  }
  for (const m of memberMap.values()) {
    if (
      ts.isPropertySignature(m) &&
      m.type &&
      keep(m.name.getText(sourceFile))
    ) {
      members.push({
        name: m.name.getText(sourceFile),
        signature: printer.printNode(
          ts.EmitHint.Unspecified,
          transformType(m.type, sourceFile.fileName),
          sourceFile,
        ),
      });
    }
  }

  return harden({
    rootName: rootType,
    members: members.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    auxTypes: [...auxTypes.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
  });
};
harden(extractTsAliasesIR);

/**
 * The TypeScript renderer for a hand-written `.d.ts` with a `declare module`.
 *
 * @param {object} config
 * @param {URL} config.dtsUrl URL of the `.d.ts` to read.
 * @param {string} config.moduleName The `declare module '<name>'` the root type
 *   lives in.
 * @param {string} config.rootType Name of the root `type` alias to print.
 * @param {string[]} [config.memberFilter] When set, keep only these members.
 * @returns {GlobalTypeIR}
 */
export const extractTsModuleIR = ({
  dtsUrl,
  moduleName,
  rootType,
  memberFilter,
}) => {
  const rootModule = parseDtsModule(dtsUrl, moduleName);
  return extractTsAliasesIR({ rootModule, rootType, memberFilter });
};
harden(extractTsModuleIR);

/**
 * The TypeScript renderer for a declaration source with top-level exported
 * `type` aliases, such as checked `.ts` typedef hosts.
 *
 * @param {object} config
 * @param {string} config.fileName Source filename for TypeScript diagnostics.
 * @param {string} config.text Declaration source text.
 * @param {string} config.rootType Name of the root `type` alias to print.
 * @param {string[]} [config.memberFilter] When set, keep only these members.
 * @returns {GlobalTypeIR}
 */
export const extractTsFileTextIR = ({
  fileName,
  text,
  rootType,
  memberFilter,
}) => {
  const rootModule = parseTypeAliases(fileName, text);
  return extractTsAliasesIR({ rootModule, rootType, memberFilter });
};
harden(extractTsFileTextIR);

// #endregion

// #region guard renderer (`guard` -> declaration, via the patterns guard walker)

/**
 * @param {string[]} parts
 * @returns {string[]}
 */
const unique = parts => [...new Set(parts)];

/**
 * Render one method-pattern argument or return guard to a TS type, recording
 * any referenced remotable labels in `refs`.
 *
 * @param {unknown} node
 * @param {Set<string>} refs
 * @returns {string}
 */
const patternToTs = (node, refs) => {
  const ps = passStyleOf(node);
  if (ps === 'string') {
    return JSON.stringify(node);
  }
  if (ps === 'number' || ps === 'boolean') {
    return String(node);
  }
  if (ps === 'bigint') {
    return `${String(node)}n`;
  }
  if (ps !== 'tagged') {
    return 'unknown';
  }
  const tag = getTag(/** @type {any} */ (node));
  const { payload } = /** @type {{ payload: any }} */ (node);
  switch (tag) {
    case 'match:string':
      return 'string';
    case 'match:symbol':
      return 'symbol';
    case 'match:bigint':
      return 'bigint';
    case 'match:number':
    case 'match:nat':
      return 'number';
    case 'match:boolean':
      return 'boolean';
    case 'match:undefined':
      return 'undefined';
    case 'match:null':
      return 'null';
    case 'match:remotable': {
      const label = String(payload.label);
      refs.add(label);
      return label;
    }
    case 'match:kind': {
      switch (String(payload)) {
        case 'string':
          return 'string';
        case 'number':
          return 'number';
        case 'bigint':
          return 'bigint';
        case 'boolean':
          return 'boolean';
        case 'undefined':
          return 'undefined';
        case 'null':
          return 'null';
        case 'symbol':
          return 'symbol';
        case 'promise':
          return 'Promise<unknown>';
        case 'remotable':
          return 'object';
        case 'error':
          return 'Error';
        case 'copyArray':
          return 'unknown[]';
        case 'copyRecord':
          return 'Record<string, unknown>';
        default:
          return 'unknown';
      }
    }
    case 'match:eq': {
      const vps = passStyleOf(payload);
      if (vps === 'string') {
        return JSON.stringify(payload);
      }
      if (vps === 'number' || vps === 'boolean') {
        return String(payload);
      }
      if (vps === 'bigint') {
        return `${String(payload)}n`;
      }
      if (payload === undefined) {
        return 'undefined';
      }
      if (payload === null) {
        return 'null';
      }
      return 'unknown';
    }
    case 'match:or': {
      const parts = /** @type {unknown[]} */ (payload);
      // `M.eref(T)` is `M.or(T, M.promise())`; print it as `ERef<T>`.
      if (parts.length === 2) {
        const promiseIdx = parts.findIndex(
          p =>
            passStyleOf(p) === 'tagged' &&
            getTag(/** @type {any} */ (p)) === 'match:kind' &&
            String(/** @type {{ payload: any }} */ (p).payload) === 'promise',
        );
        if (promiseIdx !== -1) {
          return `ERef<${patternToTs(parts[1 - promiseIdx], refs)}>`;
        }
      }
      return unique(parts.map(p => patternToTs(p, refs))).join(' | ');
    }
    case 'match:and':
      return unique(
        /** @type {unknown[]} */ (payload).map(p => patternToTs(p, refs)),
      ).join(' & ');
    case 'match:arrayOf': {
      const element = Array.isArray(payload) ? payload[0] : payload;
      return `Array<${patternToTs(element, refs)}>`;
    }
    case 'match:recordOf': {
      const [keyPattern, valuePattern] = payload;
      return `Record<${patternToTs(keyPattern, refs)}, ${patternToTs(
        valuePattern,
        refs,
      )}>`;
    }
    default:
      // `M.await(...)` arg wrappers and other guard:* nodes carry an inner
      // `argGuard`; unwrap to the settled shape. Anything else is opaque.
      if (payload && typeof payload === 'object' && 'argGuard' in payload) {
        return patternToTs(payload.argGuard, refs);
      }
      return 'unknown';
  }
};

/**
 * @param {import('@endo/patterns').MethodGuard} methodGuard
 * @param {Set<string>} refs
 * @returns {string}
 */
const methodSignature = (methodGuard, refs) => {
  const {
    argGuards = [],
    optionalArgGuards = [],
    restArgGuard,
    returnGuard,
  } = getMethodGuardPayload(methodGuard);
  const params = [];
  argGuards.forEach((g, i) => params.push(`arg${i}: ${patternToTs(g, refs)}`));
  optionalArgGuards.forEach((g, i) =>
    params.push(`arg${argGuards.length + i}?: ${patternToTs(g, refs)}`),
  );
  if (restArgGuard) {
    params.push(`...rest: ${patternToTs(restArgGuard, refs)}`);
  }
  return `(${params.join(', ')}) => ${patternToTs(returnGuard, refs)}`;
};

/**
 * @param {import('@endo/patterns').InterfaceGuard} interfaceGuard
 * @param {Set<string>} refs
 * @returns {TypeMember[]}
 */
const interfaceMembers = (interfaceGuard, refs) => {
  const { methodGuards } = getInterfaceGuardPayload(interfaceGuard);
  return Object.keys(methodGuards)
    .sort()
    .map(name => ({
      name,
      signature: methodSignature(methodGuards[name], refs),
    }));
};

/**
 * The guard renderer: build a {@link GlobalTypeIR} by walking the root
 * `M.interface` guard and rendering the transitive closure of the remotable
 * interfaces it reaches as supporting `type` aliases. A remotable label present
 * in `registry` is rendered from its guard; a label not registered renders as
 * an opaque `unknown` alias.
 *
 * `ERef<T>` is declared first because every eventual-send return prints as
 * `ERef<...>`; that convention belongs to the guard walker, not to any
 * particular exo.
 *
 * @param {object} config
 * @param {Map<string, import('@endo/patterns').InterfaceGuard>} config.registry
 *   Remotable label -> interface guard, keyed by the label the guards use.
 * @param {string} config.rootLabel The label of the root remotable.
 * @returns {GlobalTypeIR}
 */
export const extractGuardIR = ({ registry, rootLabel }) => {
  /** @type {Set<string>} */
  const refs = new Set();
  const rootGuard = registry.get(rootLabel);
  if (!rootGuard) {
    throw new Error(`no guard registered for ${rootLabel}`);
  }
  const members = interfaceMembers(rootGuard, refs);

  /** @type {AuxType[]} */
  const interfaceAux = [];
  const done = new Set([rootLabel]);
  const queue = [...refs];
  while (queue.length) {
    const name = /** @type {string} */ (queue.shift());
    if (!done.has(name)) {
      done.add(name);
      const guard = registry.get(name);
      if (!guard) {
        interfaceAux.push({ name, text: 'unknown' });
      } else {
        /** @type {Set<string>} */
        const innerRefs = new Set();
        interfaceAux.push({
          name,
          text: renderObjectType(interfaceMembers(guard, innerRefs)),
        });
        for (const ref of innerRefs) {
          if (!done.has(ref)) {
            queue.push(ref);
          }
        }
      }
    }
  }
  interfaceAux.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // `ERef<T>` is referenced by every eventual-send return; declare it first.
  const auxTypes = [
    { name: 'ERef<T>', text: 'T | Promise<T>' },
    ...interfaceAux,
  ];
  return harden({ rootName: rootLabel, members, auxTypes });
};
harden(extractGuardIR);

// #endregion
