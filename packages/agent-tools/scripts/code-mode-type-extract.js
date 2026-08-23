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
import { dirname, join, resolve } from 'node:path';
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

// #region shared renderer and graph-bounded locality expansion

const EXPANSION_MAX_DEPTH = 32;
const EXPANSION_MAX_NODES = 100_000;
const DECLARATION_MAX_CHARACTERS = 100_000;
const INLINE_DATA_LEAF_MAX_LINES = 5;

/**
 * Find aliases that participate in a recursive strongly connected component.
 * A one-node component is recursive only when it has a self-edge.
 *
 * @param {Map<string, ts.TypeAliasDeclaration>} aliases
 * @returns {Set<string>}
 */
const recursiveAliasNames = aliases => {
  const names = new Set(aliases.keys());
  /** @type {Map<string, Set<string>>} */
  const edges = new Map();
  for (const [name, declaration] of aliases) {
    const references = new Set();
    const visit = node => {
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        names.has(node.typeName.text)
      ) {
        references.add(node.typeName.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.type);
    edges.set(name, references);
  }

  let nextIndex = 0;
  /** @type {string[]} */
  const stack = [];
  const onStack = new Set();
  /** @type {Map<string, number>} */
  const indices = new Map();
  /** @type {Map<string, number>} */
  const lowLinks = new Map();
  const recursive = new Set();

  /** @param {string} name */
  const visitComponent = name => {
    indices.set(name, nextIndex);
    lowLinks.set(name, nextIndex);
    nextIndex += 1;
    stack.push(name);
    onStack.add(name);

    for (const reference of /** @type {Set<string>} */ (edges.get(name))) {
      if (!indices.has(reference)) {
        visitComponent(reference);
        lowLinks.set(
          name,
          Math.min(
            /** @type {number} */ (lowLinks.get(name)),
            /** @type {number} */ (lowLinks.get(reference)),
          ),
        );
      } else if (onStack.has(reference)) {
        lowLinks.set(
          name,
          Math.min(
            /** @type {number} */ (lowLinks.get(name)),
            /** @type {number} */ (indices.get(reference)),
          ),
        );
      }
    }

    if (lowLinks.get(name) !== indices.get(name)) {
      return;
    }
    /** @type {string[]} */
    const component = [];
    let member;
    do {
      member = /** @type {string} */ (stack.pop());
      onStack.delete(member);
      component.push(member);
    } while (member !== name);
    if (
      component.length > 1 ||
      /** @type {Set<string>} */ (edges.get(name)).has(name)
    ) {
      for (const recursiveName of component) {
        recursive.add(recursiveName);
      }
    }
  };

  for (const name of names) {
    if (!indices.has(name)) {
      visitComponent(name);
    }
  }
  return recursive;
};

/**
 * ERef is a deliberately retained primitive anchor. Its compact generic name
 * communicates eventual delivery more clearly than repeating `T | Promise<T>`
 * at every capability edge.
 *
 * @param {string} name
 * @param {ts.TypeAliasDeclaration} declaration
 */
const isPrimitiveAnchor = (name, declaration) =>
  name.endsWith('ERef') && declaration.typeParameters?.length === 1;

/**
 * Flatten the root and small, single-use, data-only leaf aliases into their
 * use sites. Recursive SCCs, aliases with methods, and aliases referenced from
 * multiple sites remain named so the generated prompt keeps semantic names and
 * does not duplicate capability or data shapes. Generic aliases substitute
 * their actual type arguments while expanding. Hard depth, node, and output
 * budgets fail generation before a future source graph can recurse or grow
 * exponentially without bound.
 *
 * @param {string} source
 * @param {string} rootName
 * @param {string} globalName
 * @returns {{ aux: string, body: string }}
 */
const flattenDeclaration = (source, rootName, globalName) => {
  const sourceFile = ts.createSourceFile(
    'code-mode-rollup.d.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const allAliases = new Map(
    sourceFile.statements
      .filter(statement => ts.isTypeAliasDeclaration(statement))
      .map(statement => [statement.name.text, statement]),
  );
  const root = allAliases.get(rootName);
  if (root === undefined) {
    throw new Error(`missing generated root alias: ${rootName}`);
  }
  const aliases = new Map(allAliases);
  aliases.delete(rootName);
  const requiredAnchors = recursiveAliasNames(aliases);
  for (const [name, declaration] of aliases) {
    if (isPrimitiveAnchor(name, declaration)) {
      requiredAnchors.add(name);
    }
  }

  const docs = new Map(
    [...allAliases].map(([name, declaration]) => [
      name,
      ts
        .getJSDocCommentsAndTags(declaration)
        .filter(node => ts.isJSDoc(node))
        .map(node => node.getText(sourceFile))
        .join('\n'),
    ]),
  );
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  });

  /**
   * @param {ts.TypeAliasDeclaration} declaration
   * @returns {boolean}
   */
  const isDataOnlyLeaf = declaration => {
    let hasMethod = false;
    let hasAliasReference = false;
    const visit = node => {
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        aliases.has(node.typeName.text)
      ) {
        hasAliasReference = true;
      }
      if (
        ts.isMethodSignature(node) ||
        ts.isCallSignatureDeclaration(node) ||
        ts.isConstructSignatureDeclaration(node) ||
        ts.isFunctionTypeNode(node)
      ) {
        hasMethod = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.type);
    return !hasMethod && !hasAliasReference;
  };

  /** @typedef {{ node: ts.TypeNode, substitutions: Map<string, TypeBinding> }} TypeBinding */

  /**
   * @param {Set<string>} anchors
   * @returns {{ aux: string, body: string }}
   */
  const renderWithAnchors = anchors => {
    const emittedDocs = new Set([rootName]);
    let visitedNodes = 0;

    /**
     * @param {ts.TypeNode} type
     * @param {Map<string, TypeBinding>} [initialSubstitutions]
     * @returns {ts.TypeNode}
     */
    const expandType = (type, initialSubstitutions = new Map()) => {
      const transformed = ts.transform(type, [
        context => {
          /**
           * @param {ts.Node} node
           * @param {Map<string, TypeBinding>} substitutions
           * @param {Set<string>} expanding
           * @param {number} depth
           * @returns {ts.VisitResult<ts.Node>}
           */
          const expand = (node, substitutions, expanding, depth) => {
            visitedNodes += 1;
            if (visitedNodes > EXPANSION_MAX_NODES) {
              throw new Error(
                `generated declaration exceeds ${EXPANSION_MAX_NODES} expanded nodes`,
              );
            }
            if (depth > EXPANSION_MAX_DEPTH) {
              throw new Error(
                `generated declaration exceeds expansion depth ${EXPANSION_MAX_DEPTH}`,
              );
            }
            if (
              !ts.isTypeReferenceNode(node) ||
              !ts.isIdentifier(node.typeName)
            ) {
              return ts.visitEachChild(
                node,
                child => expand(child, substitutions, expanding, depth),
                context,
              );
            }

            const name = node.typeName.text;
            const binding = substitutions.get(name);
            if (binding !== undefined && node.typeArguments === undefined) {
              return expand(
                binding.node,
                binding.substitutions,
                expanding,
                depth + 1,
              );
            }
            if (name === rootName) {
              return ts.factory.createTypeQueryNode(
                ts.factory.createIdentifier(globalName),
              );
            }
            const declaration = aliases.get(name);
            if (declaration === undefined || anchors.has(name)) {
              return ts.visitEachChild(
                node,
                child => expand(child, substitutions, expanding, depth),
                context,
              );
            }
            if (expanding.has(name)) {
              throw new Error(`unanchored recursive type alias: ${name}`);
            }

            const nextExpanding = new Set(expanding);
            nextExpanding.add(name);
            /** @type {Map<string, TypeBinding>} */
            const aliasSubstitutions = new Map();
            for (const [index, parameter] of (
              declaration.typeParameters ?? []
            ).entries()) {
              const argument = node.typeArguments?.[index];
              if (argument !== undefined) {
                aliasSubstitutions.set(parameter.name.text, {
                  node: argument,
                  substitutions,
                });
              } else if (parameter.default !== undefined) {
                aliasSubstitutions.set(parameter.name.text, {
                  node: parameter.default,
                  substitutions: aliasSubstitutions,
                });
              } else {
                aliasSubstitutions.set(parameter.name.text, {
                  node: ts.factory.createKeywordTypeNode(
                    ts.SyntaxKind.UnknownKeyword,
                  ),
                  substitutions: new Map(),
                });
              }
            }
            let replacement = /** @type {ts.TypeNode} */ (
              expand(
                declaration.type,
                aliasSubstitutions,
                nextExpanding,
                depth + 1,
              )
            );
            const doc = docs.get(name);
            if (doc !== undefined && doc !== '' && !emittedDocs.has(name)) {
              emittedDocs.add(name);
              replacement = ts.addSyntheticLeadingComment(
                ts.factory.createParenthesizedType(replacement),
                ts.SyntaxKind.MultiLineCommentTrivia,
                doc.slice(2, -2),
                true,
              );
            }
            return replacement;
          };
          return node =>
            /** @type {ts.TypeNode} */ (
              expand(node, initialSubstitutions, new Set(), 0)
            );
        },
      ]);
      const [result] = transformed.transformed;
      transformed.dispose();
      return /** @type {ts.TypeNode} */ (result);
    };

    const body = printer.printNode(
      ts.EmitHint.Unspecified,
      expandType(root.type),
      sourceFile,
    );
    const retainedAliases = [...aliases]
      .filter(([name]) => anchors.has(name))
      .sort(([leftName], [rightName]) => {
        const leftPosition = /** @type {number} */ (
          firstReferencePositions.get(leftName)
        );
        const rightPosition = /** @type {number} */ (
          firstReferencePositions.get(rightName)
        );
        return (
          leftPosition - rightPosition ||
          /** @type {number} */ (aliasPositions.get(leftName)) -
            /** @type {number} */ (aliasPositions.get(rightName))
        );
      })
      .map(([, declaration]) => {
        const expanded = expandType(declaration.type);
        const updated = ts.factory.updateTypeAliasDeclaration(
          declaration,
          declaration.modifiers,
          declaration.name,
          declaration.typeParameters,
          expanded,
        );
        return printer.printNode(ts.EmitHint.Unspecified, updated, sourceFile);
      });
    const rootDoc = docs.get(rootName);
    const aux = [
      ...(rootDoc === undefined || rootDoc === '' ? [] : [rootDoc]),
      ...retainedAliases,
    ].join('\n');
    if (aux.length + body.length > DECLARATION_MAX_CHARACTERS) {
      throw new Error(
        `generated declaration exceeds ${DECLARATION_MAX_CHARACTERS} characters`,
      );
    }
    return { aux, body };
  };

  /** @type {Map<string, number>} */
  const referenceCounts = new Map([...aliases.keys()].map(name => [name, 0]));
  for (const [, declaration] of allAliases) {
    const visit = node => {
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        aliases.has(node.typeName.text)
      ) {
        const name = node.typeName.text;
        referenceCounts.set(
          name,
          /** @type {number} */ (referenceCounts.get(name)) + 1,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.type);
  }
  const firstReferencePositions = new Map(
    [...aliases.keys()].map(name => [name, Number.POSITIVE_INFINITY]),
  );
  /** @type {Map<string, number>} */
  const aliasPositions = new Map(
    [...aliases.keys()].map((name, index) => [name, index]),
  );
  const recordReference = node => {
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      firstReferencePositions.has(node.typeName.text)
    ) {
      firstReferencePositions.set(
        node.typeName.text,
        Math.min(
          /** @type {number} */ (
            firstReferencePositions.get(node.typeName.text)
          ),
          node.getStart(sourceFile),
        ),
      );
    }
    ts.forEachChild(node, recordReference);
  };
  recordReference(sourceFile);
  const anchors = new Set(aliases.keys());
  for (const [name, declaration] of aliases) {
    const rendered = printer.printNode(
      ts.EmitHint.Unspecified,
      declaration.type,
      sourceFile,
    );
    const isSmall = rendered.split('\n').length <= INLINE_DATA_LEAF_MAX_LINES;
    if (
      !requiredAnchors.has(name) &&
      referenceCounts.get(name) === 1 &&
      isSmall &&
      isDataOnlyLeaf(declaration)
    ) {
      anchors.delete(name);
    }
  }
  return renderWithAnchors(anchors);
};

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
 * root `type` from `members`, flatten bounded data leaves into their use sites,
 * and return the root object itself as the `body` spliced after
 * `declare const <name>:`. Recursive SCCs, compact primitive anchors,
 * capability aliases, shared aliases, and larger data shapes remain in `aux`.
 *
 * @param {GlobalTypeIR} ir
 * @param {{ globalName: string, auxPrefix?: string }} options
 * @returns {{ aux: string, body: string }}
 */
export const renderDeclaration = (ir, options) => {
  const { globalName, auxPrefix = '' } = options;
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
  return harden(
    flattenDeclaration(renderAuxTypes(aux), ir.rootName, globalName),
  );
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
 * Index the `export ... from '<specifier>'` re-exports a declaration source
 * introduces. A package's published type entry point is often a pure re-export
 * index (`@endo/daemon`'s `types.d.ts`, the platform `*-types-index.d.ts`
 * files), so a name a source does not declare itself may still be reachable
 * through one.
 *
 * A named re-export binds exactly like an import. A star re-export names no
 * member, so it contributes a module to search when a name is neither declared
 * nor imported.
 *
 * @param {readonly ts.Statement[]} statements
 * @param {Map<string, ImportBinding>} importMap
 * @param {string[]} starExports
 */
const collectExportBindings = (statements, importMap, starExports) => {
  for (const stmt of statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const specifier = stmt.moduleSpecifier.text;
      const { exportClause } = stmt;
      if (exportClause === undefined) {
        starExports.push(specifier);
      } else if (ts.isNamedExports(exportClause)) {
        for (const element of exportClause.elements) {
          importMap.set(element.name.text, {
            specifier,
            exportedName: (element.propertyName ?? element.name).text,
          });
        }
      }
    }
  }
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
  const importMap = collectImportBindings(sourceFile.statements);
  /** @type {string[]} */
  const starExports = [];
  collectExportBindings(sourceFile.statements, importMap, starExports);
  return { sourceFile, aliasMap, importMap, starExports };
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
  const importMap = collectImportBindings(
    moduleBody.statements,
    collectImportBindings(sourceFile.statements),
  );
  /** @type {string[]} */
  const starExports = [];
  collectExportBindings(sourceFile.statements, importMap, starExports);
  collectExportBindings(moduleBody.statements, importMap, starExports);
  return { sourceFile, aliasMap, importMap, starExports };
};

/** @typedef {{ sourceFile: ts.SourceFile, aliasMap: Map<string, ts.TypeAliasDeclaration | ts.InterfaceDeclaration>, importMap: Map<string, ImportBinding>, starExports: string[] }} ParsedTypeModule */

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
 * A relative specifier stays inside the package the referring source belongs
 * to, so it is followed as well: a published type entry point that re-exports
 * from `./src/types.js` is only useful if that hop resolves. The runtime
 * extension is rewritten to the declaration source beside it.
 *
 * @param {string} moduleName
 * @param {string} fromFile
 * @returns {string | undefined}
 */
const resolveTypeModule = (moduleName, fromFile) => {
  if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
    const resolved = resolve(dirname(fromFile), moduleName);
    const candidates = /\.(?:d\.)?ts$/u.test(resolved)
      ? [resolved]
      : [
          `${resolved.replace(/\.js$/u, '')}.d.ts`,
          `${resolved.replace(/\.js$/u, '')}.ts`,
        ];
    return candidates.find(candidate => existsSync(candidate));
  }
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
 * Build a {@link GlobalTypeIR} by locating the named root type in a parsed
 * TypeScript declaration source, then printing the kept members and the
 * supporting aliases they reach with the `typescript` printer.
 *
 * The root is a `type` alias or an `interface`, and so is any type reached from
 * it. A capability's own declaration source is written for TypeScript rather
 * than for a prompt, so the printer normalizes what it finds: an `extends`
 * clause is flattened into the members it contributes, a method signature is
 * printed as a function-typed member, and a method overload set is printed as
 * one member whose type carries a call signature apiece. The result is a flat
 * object type per capability, which is the shape a prompt declaration and a
 * runtime `M.interface` guard both have.
 *
 * With a `memberFilter`, only the named members (and the types they reach) are
 * kept; this is how a read-only or otherwise narrowed variant is produced from
 * the same source.
 *
 * @param {object} config
 * @param {ParsedTypeModule} config.rootModule The parsed declaration source.
 * @param {string} config.rootType Name of the root type to print.
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
  /**
   * Keys of the declarations the root type resolves through, filled in by the
   * root walk before any member is printed.
   *
   * @type {Set<string>}
   */
  const rootAliasKeys = new Set();

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

  /** @typedef {{ declaration: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined, fileName: string, key: string }} FoundDeclaration */

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
    return fileName === undefined
      ? undefined
      : findInModule(fileName, name, new Set());
  };

  /**
   * The declaration a module supplies for `name`, whether it declares the name
   * itself or re-exports it. A name is looked for in the module's own
   * declarations, then behind its import and named-re-export bindings, then in
   * the modules it re-exports wholesale.
   *
   * The key names the module that finally declares the type, so two routes to
   * the same declaration share one emitted alias.
   *
   * @param {string} fileName
   * @param {string} name
   * @param {Set<string>} visited Guards a re-export cycle.
   * @returns {FoundDeclaration | undefined}
   */
  function findInModule(fileName, name, visited) {
    const key = `${sourceKey(fileName)}${name}`;
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);
    const module = moduleFor(fileName);
    const declaration = module.aliasMap.get(name);
    if (declaration !== undefined) {
      return { declaration, fileName, key };
    }
    const binding = module.importMap.get(name);
    if (binding !== undefined) {
      const target = resolveTypeModule(binding.specifier, fileName);
      if (target !== undefined) {
        const found = findInModule(target, binding.exportedName, visited);
        if (found !== undefined) {
          return found;
        }
      }
    }
    for (const specifier of module.starExports) {
      const target = resolveTypeModule(specifier, fileName);
      if (target !== undefined) {
        const found = findInModule(target, name, visited);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  }

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

  /**
   * The declaration a bare type name refers to from `fromFile`: one the module
   * declares, one it re-exports, or one it imports from a followable `@endo/*`
   * package.
   *
   * @param {string} name
   * @param {string} fromFile
   * @returns {FoundDeclaration | undefined}
   */
  const resolveReference = (name, fromFile) => {
    const found = findInModule(fromFile, name, new Set());
    if (found !== undefined) {
      return found;
    }
    // The extended filesystem source re-exports ERef from @endo/eventual-send
    // without declaring it locally, and @endo/eventual-send publishes no type
    // source to follow.
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
   * @typedef {{ element: ts.TypeElement, fileName: string }} OwnedMember
   *   A member signature paired with the declaration source it was read from,
   *   so its own type references still resolve in the module that wrote them
   *   after `extends` has merged members across modules.
   */

  /**
   * Group an object type's own elements by member name. A name carries more
   * than one element only when the source declares a method overload set.
   *
   * An element with no name (an index or call signature) describes no named
   * member, so it contributes nothing a prompt object type can print.
   *
   * @param {readonly ts.TypeElement[]} elements
   * @param {string} fileName
   * @returns {Map<string, OwnedMember[]>}
   */
  const ownMembers = (elements, fileName) => {
    /** @type {Map<string, OwnedMember[]>} */
    const map = new Map();
    for (const element of elements) {
      if (element.name !== undefined) {
        const name = element.name.getText();
        const owned = map.get(name);
        if (owned === undefined) {
          map.set(name, [{ element, fileName }]);
        } else {
          owned.push({ element, fileName });
        }
      }
    }
    return map;
  };

  /**
   * The members a declaration contributes, keyed by member name, with the
   * members of every interface it extends merged in first.
   *
   * @param {ts.TypeAliasDeclaration | ts.InterfaceDeclaration} declaration
   * @param {string} fileName
   * @param {Set<string>} seen Declarations already on this walk, so a
   *   self-referential alias or heritage cycle terminates.
   * @param {Set<string>} [aliasKeys] When set, records every declaration the
   *   walk resolves through, so a member referring back to one of them can
   *   print as the root name instead of as a duplicate alias.
   * @returns {Map<string, OwnedMember[]>}
   */
  function declarationMembers(declaration, fileName, seen, aliasKeys) {
    if (ts.isTypeAliasDeclaration(declaration)) {
      return typeNodeMembers(declaration.type, fileName, seen, aliasKeys);
    }
    /** @type {Map<string, OwnedMember[]>} */
    const merged = new Map();
    for (const clause of declaration.heritageClauses ?? []) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const base of clause.types) {
          for (const [name, owned] of baseMembers(base, fileName, seen)) {
            merged.set(name, owned);
          }
        }
      }
    }
    // A redeclared member replaces the inherited one outright, the way a
    // derived interface shadows its base rather than overloading it.
    for (const [name, owned] of ownMembers(declaration.members, fileName)) {
      merged.set(name, owned);
    }
    return merged;
  }

  /**
   * The members one `extends` clause entry contributes, following the base
   * across packages with the same machinery a type reference uses.
   *
   * A base the walk cannot reach is a hole in the printed surface rather than
   * an over-broad type, so it fails loudly instead of silently dropping the
   * members it would have supplied. Type arguments are not substituted, so a
   * generic base fails the same way.
   *
   * @param {ts.ExpressionWithTypeArguments} base
   * @param {string} fileName
   * @param {Set<string>} seen
   * @returns {Map<string, OwnedMember[]>}
   */
  function baseMembers(base, fileName, seen) {
    if (!ts.isIdentifier(base.expression)) {
      throw new Error(
        `unsupported extends clause ${base.getText()} in ${fileName}`,
      );
    }
    const name = base.expression.text;
    const found = resolveReference(name, fileName);
    if (found === undefined || found.declaration === undefined) {
      throw new Error(
        `cannot flatten extends ${name}: no reachable declaration from ${fileName}`,
      );
    }
    if (
      found.declaration.typeParameters !== undefined &&
      found.declaration.typeParameters.length > 0
    ) {
      throw new Error(
        `cannot flatten extends ${name}: a generic base's type arguments are not substituted`,
      );
    }
    if (seen.has(found.key)) {
      return new Map();
    }
    return declarationMembers(
      found.declaration,
      found.fileName,
      new Set(seen).add(found.key),
    );
  }

  /**
   * The members an object type expression contributes: a type literal's own,
   * an intersection's merged, or those of the declaration a reference or an
   * `import(...)` type names.
   *
   * @param {ts.TypeNode} node
   * @param {string} fileName
   * @param {Set<string>} seen
   * @param {Set<string>} [aliasKeys]
   * @returns {Map<string, OwnedMember[]>}
   */
  function typeNodeMembers(node, fileName, seen, aliasKeys) {
    if (ts.isTypeLiteralNode(node)) {
      return ownMembers(node.members, fileName);
    }
    if (ts.isIntersectionTypeNode(node)) {
      /** @type {Map<string, OwnedMember[]>} */
      const merged = new Map();
      // An intersection operand contributes members to the root without being
      // another name for it, so its declaration keeps its own alias.
      for (const part of node.types) {
        for (const [name, owned] of typeNodeMembers(part, fileName, seen)) {
          merged.set(name, owned);
        }
      }
      return merged;
    }
    let found;
    if (ts.isImportTypeNode(node)) {
      found = importedDeclaration(node, fileName);
    } else if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      found = resolveReference(node.typeName.text, fileName);
    }
    if (
      found !== undefined &&
      found.declaration !== undefined &&
      !seen.has(found.key)
    ) {
      if (aliasKeys !== undefined) {
        aliasKeys.add(found.key);
      }
      return declarationMembers(
        found.declaration,
        found.fileName,
        new Set(seen).add(found.key),
        aliasKeys,
      );
    }
    throw new Error(`${rootType} must resolve to object type members`);
  }

  /**
   * @param {OwnedMember[]} owned
   * @returns {string}
   */
  const optionalToken = owned =>
    owned[owned.length - 1].element.questionToken === undefined ? '' : '?';

  /**
   * Print one member's type: a property's declared type, a method's signature
   * folded into a function type, and an overload set folded into an object
   * type carrying one call signature apiece.
   *
   * @param {OwnedMember[]} owned
   * @returns {string}
   */
  const memberSignature = owned => {
    const { fileName } = owned[0];
    /** @param {ts.TypeNode} node */
    const print = node =>
      printer.printNode(
        ts.EmitHint.Unspecified,
        transformType(node, fileName),
        moduleFor(fileName).sourceFile,
      );
    const overloads = owned
      .map(member => member.element)
      .filter(ts.isMethodSignature);
    if (overloads.length > 1) {
      return print(
        ts.factory.createTypeLiteralNode(
          overloads.map(method =>
            ts.factory.createCallSignature(
              method.typeParameters,
              method.parameters,
              method.type,
            ),
          ),
        ),
      );
    }
    const { element } = owned[owned.length - 1];
    if (ts.isMethodSignature(element)) {
      return print(
        ts.factory.createFunctionTypeNode(
          element.typeParameters,
          element.parameters,
          element.type ??
            ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
      );
    }
    if (ts.isPropertySignature(element) && element.type !== undefined) {
      return print(element.type);
    }
    return 'unknown';
  };

  // The indentation the TypeScript printer gives a nested object type, so an
  // assembled alias body reads the same as a printed one.
  const auxIndent = '    ';

  /**
   * @param {Map<string, OwnedMember[]>} memberMap
   * @returns {string}
   */
  const renderMemberBlock = memberMap => {
    const lines = [...memberMap].map(([name, owned]) => {
      const signature = memberSignature(owned)
        .split('\n')
        .join(`\n${auxIndent}`);
      return `${auxIndent}${name}${optionalToken(owned)}: ${signature};`;
    });
    return lines.length === 0 ? '{}' : `{\n${lines.join('\n')}\n}`;
  };

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
    // An interface is printed from its flattened member map so inherited
    // members, method signatures, and overload sets survive; a type alias is
    // printed as authored.
    const text = ts.isTypeAliasDeclaration(current)
      ? printer.printNode(
          ts.EmitHint.Unspecified,
          transformType(current.type, fileName),
          moduleFor(fileName).sourceFile,
        )
      : renderMemberBlock(
          declarationMembers(current, fileName, new Set([key])),
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
         * @param {string} fallbackName Name to look the declaration up by when
         *   it is a builtin with no declaration node of its own.
         */
        const referenceTo = (found, typeArguments, visit, fallbackName) => {
          const transformedArguments =
            typeArguments &&
            ts.factory.createNodeArray(
              typeArguments.map(
                argument =>
                  /** @type {ts.TypeNode} */ (ts.visitNode(argument, visit)),
              ),
            );
          // The synthesized root declaration is the canonical name for every
          // reference back to it, however many re-export or `import(...)`
          // hops the root was reached through.  Allocating one of those as an
          // auxiliary alias would print a duplicate of the root surface under
          // an imported-looking name.
          if (rootAliasKeys.has(found.key)) {
            return ts.factory.createTypeReferenceNode(
              rootType,
              transformedArguments,
            );
          }
          const outputName = ensureAlias(
            found.key,
            found.declaration?.name.text ?? fallbackName,
            found.fileName,
          );
          return ts.factory.createTypeReferenceNode(
            outputName.replace(/<.*>$/u, ''),
            transformedArguments,
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
              : referenceTo(
                  found,
                  current.typeArguments,
                  visit,
                  current.qualifier?.getText() ?? '',
                );
          }
          if (
            ts.isTypeReferenceNode(current) &&
            ts.isIdentifier(current.typeName)
          ) {
            const name = current.typeName.text;
            // A reference resolves through the module's own declarations, its
            // re-exports, and its imports alike; a name that is module-scoped
            // rather than a TypeScript global but reaches no `@endo/*`
            // declaration source collapses, so no unresolvable identifier
            // reaches the prompt.
            const found = resolveReference(name, fromFile);
            if (found !== undefined) {
              return referenceTo(found, current.typeArguments, visit, name);
            }
            if (moduleFor(fromFile).importMap.has(name)) {
              return unknownType();
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
  if (rootAlias === undefined) {
    throw new Error(`${rootType} is not declared by the root type source`);
  }
  const keep = name => !memberFilter || memberFilter.includes(name);

  // Every declaration the root resolves through - a re-export hop, an
  // `import(...)` alias, the interface that finally declares the members - is
  // the root under another name.
  rootAliasKeys.add(`${sourceKey(sourceFile.fileName)}${rootType}`);
  const rootMembers = declarationMembers(
    rootAlias,
    sourceFile.fileName,
    new Set(rootAliasKeys),
    rootAliasKeys,
  );

  /** @type {TypeMember[]} */
  const members = [];
  for (const [name, owned] of rootMembers) {
    if (keep(name)) {
      members.push({
        name: `${name}${optionalToken(owned)}`,
        signature: memberSignature(owned),
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
 * @param {string} config.rootType Name of the root type to print.
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
 * @param {string} config.rootType Name of the root type to print.
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
