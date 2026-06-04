/* eslint max-lines: 0 */

import * as h from './hidden.js';

/*
 * Collects all of the identifiers on the left-hand-side of an exported
 * assignment expression, deeply exploring complex destructuring assignment.
 * In an export assignment, every one of these identifiers is an exported name.
 *
 * ```
 * export const pattern = ...;
 * export let pattern = ...;
 * export var pattern = ...;
 * ```
 */
const collectPatternIdentifiers = (path, pattern) => {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern];
    case 'RestElement':
      return collectPatternIdentifiers(path, pattern.argument);
    case 'ObjectProperty':
      return collectPatternIdentifiers(path, pattern.value);
    case 'ObjectPattern':
      return pattern.properties.flatMap(prop =>
        collectPatternIdentifiers(path, prop),
      );
    case 'ArrayPattern':
      return pattern.elements.flatMap(pat => {
        if (pat === null) return [];
        // Non-elided pattern.
        return collectPatternIdentifiers(path, pat);
      });
    case 'AssignmentPattern':
      return collectPatternIdentifiers(path, pattern.left);
    default:
      throw path.buildCodeFrameError(
        `Pattern type ${pattern.type} is not recognized`,
      );
  }
};

function makeModulePlugins(options) {
  const {
    sourceType,
    exportAlls,
    fixedExportMap,
    imports,
    importDecls,
    importSources,
    reexportMap,
    liveExportMap,
    importMeta,
    dynamicImport,
  } = options;

  if (sourceType !== 'module') {
    throw Error(`Module sourceType must be 'module'`);
  }

  const updaterSources = Object.create(null);
  /**
   * Indicates that a name is declared at the top level and is never
   * reassigned.
   * All of these declarations are discovered in the analysis pass by visiting
   * every function, class, and declaration.
   *
   * @type {Record<string, boolean>}
   */
  const topLevelIsOnce = Object.create(null);
  /**
   * Indicates that a local name is declared at the top level and exported, and
   * lists all of the corresponding exported names that should be updated if it
   * changes.
   * All of these declarations are discovered in the analysis pass by visiting
   * every export declaration.
   *
   * @type {Record<string, Array<string>>}
   */
  const topLevelExported = Object.create(null);

  const rewriteModules =
    pass =>
    ({ types: t }) => {
      const replace = (
        src,
        node = t.expressionStatement(t.identifier('null')),
      ) => {
        node.loc = src.loc;
        node.comments = [...(src.leadingComments || [])];
        t.inheritsComments(node, src);
        return node;
      };

      const allowedHiddens = new WeakSet();
      const rewrittenDecls = new WeakSet();
      const rewrittenAssignments = new WeakSet();
      const rewrittenUpdates = new WeakSet();
      const hiddenIdentifier = hi => {
        const ident = t.identifier(hi);
        allowedHiddens.add(ident);
        return ident;
      };
      const hOnceId = hiddenIdentifier(h.HIDDEN_ONCE);
      const hLiveId = hiddenIdentifier(h.HIDDEN_LIVE);
      // Maps the in-AST local name of a top-level exported live binding
      // to the original (source-level, exported) name. For
      // `let`/`var`/`function` declarations the local has been renamed
      // to `$c_NAME` via Babel's scope rename in the Program-enter
      // sweep, so the key is `$c_NAME` and the value is `NAME`; for
      // `class` declarations the name is not rewritten and the entry
      // (added later by the ClassDeclaration handler) is an identity
      // mapping (`NAME` -> `NAME`).
      //
      // The AssignmentExpression and UpdateExpression visitors consult
      // this map to instrument reassignments with a `$h_live.NAME(...)`
      // publish call so the bundled live cell is updated. Without that
      // instrumentation, `export let X = 1; X = 2;` leaves the bundled
      // `X` export observably stuck at the initial value
      // (endojs/endo#2982); the prior implementation relied on the SES
      // moduleLexicals scope-proxy set-trap to surface the assignment,
      // but a raw `nestedEvaluate` bundle runs outside any such
      // compartment.
      /** @type {Map<string, string>} */
      const liveSoftened = new Map();
      const soften = id => {
        // Remap the name to $c_name. Used by the declaration handlers
        // when the binding was not pre-renamed by the Program-enter
        // sweep (the `hoistedDecls` path which constructs identifiers
        // de novo).
        const { name } = id;
        id.name = `${h.HIDDEN_CONST_VAR_PREFIX}${name}`;
        allowedHiddens.add(id);
      };

      /**
       * Adds an exported name to the module static record private metadata,
       * indicating that it is updated live as opposted to a constant
       * or variable that is only initialized once and never reassigned.
       *
       * Any top-level exported `function`, `let`, or `var` declaration is a
       * "live" binding unless it's initialized and never reassigned anywhere
       * in the module.
       * As are any other top-level exported `var` declarations because they
       * require hoisting.
       *
       * This method gets called in the transform phase.
       * The returned hidden variable name may be used to transform
       * a declaration, particularly for an export class statement.
       *
       * @param {string} name - the local name of the exported variable.
       */
      const markLiveExport = name => {
        for (const importTo of topLevelExported[name]) {
          liveExportMap[importTo] = [name, true];
        }
        return hLiveId;
      };

      /**
       * Adds an exported name to the module static record private metadata,
       * indicating that it is updated fixed, either because it is a constant
       * or because it is initialized and never reassigned.
       *
       * This method gets called in the transform phase.
       * The returned hidden variable name may be used to transform
       * a declaration, particularly for an export class statement.
       *
       * @param {string} name - the local name of the exported variable.
       */
      const markFixedExport = name => {
        for (const importTo of topLevelExported[name]) {
          fixedExportMap[importTo] = [name];
        }
        return hOnceId;
      };

      /**
       * Adds an exported name to the module static record private metadata,
       * indicating whether it is fixed or live depending on whether
       * there are any assignments to the bound variable except for
       * its declaration.
       *
       * This function gets called in the cases where whether the export is
       * live or fixed depends only on whether the export gets assigned
       * anywhere outside its declaration: exported function declarations and
       * exported variables initialized to function declarations.
       *
       * This method gets called in the transform phase.
       * The returned hidden variable name may be used to transform
       * a declaration, particularly for an export class statement.
       *
       * @param {string} name - the local name of the exported variable.
       */
      const markExport = name => {
        if (topLevelIsOnce[name]) {
          return markFixedExport(name);
        } else {
          return markLiveExport(name);
        }
      };

      const rewriteVars = (vids, isConst, needsHoisting) => {
        const replacements = [];
        for (const id of vids) {
          // The Program-enter sweep may have already softened this id
          // via scope rename. Recover the original (source-level)
          // name from `liveSoftened` so the publish call and the
          // `topLevelExported` / `topLevelIsOnce` lookups (which are
          // keyed by the original name) continue to work.
          const currentName = id.name;
          const preRenamedOriginal = liveSoftened.get(currentName);
          const name =
            preRenamedOriginal !== undefined ? preRenamedOriginal : currentName;
          if (!isConst && !topLevelIsOnce[name]) {
            if (topLevelExported[name]) {
              // Just add $h_live.name($c_name);
              if (preRenamedOriginal === undefined) {
                soften(id);
                liveSoftened.set(id.name, name);
              } else {
                allowedHiddens.add(id);
              }
              replacements.push(
                t.expressionStatement(
                  t.callExpression(
                    t.memberExpression(hLiveId, t.identifier(name)),
                    [t.identifier(id.name)],
                  ),
                ),
              );
              markLiveExport(name);
            }
          } else if (topLevelExported[name]) {
            if (needsHoisting) {
              // Hoist the declaration and soften.
              if (needsHoisting === 'function') {
                if (!topLevelIsOnce[name]) {
                  if (preRenamedOriginal === undefined) {
                    soften(id);
                    liveSoftened.set(id.name, name);
                  } else {
                    allowedHiddens.add(id);
                  }
                }
                options.hoistedDecls.push([
                  name,
                  topLevelIsOnce[name],
                  id.name,
                ]);
                markExport(name);
              } else {
                // Rewrite to be just name = value.
                if (preRenamedOriginal === undefined) {
                  soften(id);
                  liveSoftened.set(id.name, name);
                } else {
                  allowedHiddens.add(id);
                }
                options.hoistedDecls.push([name]);
                replacements.push(
                  t.expressionStatement(
                    t.assignmentExpression(
                      '=',
                      t.identifier(name),
                      t.identifier(id.name),
                    ),
                  ),
                );
                markLiveExport(name);
              }
            } else {
              // Just add $h_once.name(name);
              replacements.push(
                t.expressionStatement(
                  t.callExpression(
                    t.memberExpression(hOnceId, t.identifier(id.name)),
                    [t.identifier(id.name)],
                  ),
                ),
              );
              markFixedExport(name);
            }
          }
        }
        return replacements;
      };

      const rewriteExportDeclaration = path => {
        // Find all the declared identifiers.
        if (rewrittenDecls.has(path.node)) {
          return;
        }
        const decl = path.node;
        const declarations = decl.declarations || [decl];
        const vids = declarations.flatMap(({ id }) =>
          collectPatternIdentifiers(path, id),
        );

        // Create the export calls.
        const isConst = decl.kind === 'const';
        const additions = rewriteVars(
          vids,
          isConst,
          decl.type === 'FunctionDeclaration'
            ? 'function'
            : !isConst && decl.kind !== 'let',
        );

        if (additions.length > 0) {
          if (decl.type === 'VariableDeclaration') {
            rewrittenDecls.add(decl);
          }
          path.insertAfter(additions);
        }
      };

      const visitor = {
        Identifier(path) {
          if (options.allowHidden || allowedHiddens.has(path.node)) {
            return;
          }
          // Ensure the parse doesn't already include our required hidden identifiers.
          // console.log(`have identifier`, path.node);
          const i = h.HIDDEN_IDENTIFIERS.indexOf(path.node.name);
          if (i >= 0) {
            throw path.buildCodeFrameError(
              `The ${h.HIDDEN_IDENTIFIERS[i]} identifier is reserved`,
            );
          }
          if (path.node.name.startsWith(h.HIDDEN_CONST_VAR_PREFIX)) {
            throw path.buildCodeFrameError(
              `The ${path.node.name} constant variable is reserved`,
            );
          }
        },
        CallExpression(path) {
          // import(FOO) -> $h_import(FOO)
          if (path.node.callee.type === 'Import') {
            dynamicImport.present = true;
            path.node.callee = hiddenIdentifier(h.HIDDEN_IMPORT);
          }
        },
      };

      const importMetaVisitor = {
        MetaProperty(path) {
          if (
            path.node.meta &&
            path.node.meta.name === 'import' &&
            path.node.property.name === 'meta'
          ) {
            importMeta.present = true;
            path.replaceWithMultiple([
              replace(path.node, hiddenIdentifier(h.HIDDEN_META)),
            ]);
          }
        },
      };

      // Build a publish-call expression that pushes the current value of
      // the softened local through `$h_live.NAME(...)`. NAME is the
      // original source-level local name (which is also the exported
      // name).
      const publishLiveCall = (originalName, softenedName) => {
        const arg = t.identifier(softenedName);
        allowedHiddens.add(arg);
        return t.callExpression(
          t.memberExpression(hLiveId, t.identifier(originalName)),
          [arg],
        );
      };

      // True if the named binding is a top-level export that is reassigned
      // somewhere in the module (i.e., live, not once). Consulted by the
      // Program-enter rename sweep to decide which bindings to soften and
      // by the declaration handlers to skip already-pre-renamed entries.
      const isTopLevelLiveExport = name =>
        topLevelExported[name] !== undefined && !topLevelIsOnce[name];

      // Instrument a `for (X of arr) ...` / `for (X in obj) ...` loop
      // whose `left` is a bare Identifier (no fresh declaration) when
      // `X` names a top-level live export. The loop's per-iteration
      // rebinding is the loop's `left`, not an AssignmentExpression, so
      // the AssignmentExpression visitor does not see it; prepend a
      // publish statement to the loop body so each iteration propagates
      // to the bundled live cell.
      const instrumentLoopRebind = path => {
        const { left } = path.node;
        if (!left || left.type !== 'Identifier') {
          // `for (let X of arr) ...` introduces a fresh local that
          // shadows the outer binding; no publish needed.
          return;
        }
        const originalName = liveSoftened.get(left.name);
        if (originalName === undefined) {
          return;
        }
        allowedHiddens.add(left);
        const publishStmt = t.expressionStatement(
          publishLiveCall(originalName, left.name),
        );
        let { body } = path.node;
        if (body.type !== 'BlockStatement') {
          // `for (X of arr) stmt;` → `for (X of arr) { stmt; }`
          body = t.blockStatement([body]);
          path.node.body = body;
        }
        body.body.unshift(publishStmt);
      };

      const moduleVisitor = (doAnalyze, doTransform) => ({
        // Pre-rename every top-level exported live `let`/`var`/`function`
        // binding to `$c_NAME` before any other transform-pass visitor
        // descends into the program body. Scope-aware renaming via
        // `path.scope.rename` propagates the rename to every reference
        // (reads and writes) in the binding's scope, so subsequent
        // visitors see the softened form everywhere. Doing the rename in
        // a single up-front sweep avoids the ordering quirk where
        // `ExportNamedDeclaration#replaceWithMultiple` re-orders the
        // declaration's processing relative to sibling assignment
        // statements (the declaration visitor would otherwise fire
        // *after* the assignment visitor that needs the rename to have
        // already happened). Class declarations are handled separately
        // by the `ClassDeclaration` visitor and are not renamed: the
        // local keeps the source name so the existing publish call
        // (`$h_live.NAME(NAME)`) reads the right binding.
        Program: {
          enter(path) {
            if (!doTransform) {
              return;
            }
            // Walk the program body for live let/var/function decls. We
            // discriminate class from function/var/let by inspecting
            // each top-level declaration's AST node type. Iterating
            // `topLevelExported` alone is not enough because that map
            // does not record the declaration kind.
            const visited = new Set();
            const handleDecl = name => {
              if (visited.has(name)) return;
              visited.add(name);
              if (!isTopLevelLiveExport(name)) return;
              const newName = `${h.HIDDEN_CONST_VAR_PREFIX}${name}`;
              if (path.scope.hasBinding(name)) {
                path.scope.rename(name, newName);
                liveSoftened.set(newName, name);
              }
            };
            const considerDecl = decl => {
              if (!decl) return;
              if (
                decl.type === 'VariableDeclaration' ||
                decl.type === 'FunctionDeclaration'
              ) {
                const vids = (decl.declarations || [decl]).flatMap(({ id }) =>
                  collectPatternIdentifiers(path, id),
                );
                for (const { name } of vids) {
                  handleDecl(name);
                }
              }
              // ClassDeclaration is intentionally skipped here so the
              // local keeps its source name. The ClassDeclaration
              // handler tracks reassignment-instrumentation in
              // `liveSoftened` via an identity mapping.
            };
            for (const node of path.node.body) {
              if (
                node.type === 'VariableDeclaration' ||
                node.type === 'FunctionDeclaration'
              ) {
                considerDecl(node);
              } else if (
                node.type === 'ExportNamedDeclaration' &&
                node.declaration
              ) {
                considerDecl(node.declaration);
              }
            }
          },
        },
        // Reassignment instrumentation for top-level exported live
        // bindings. After the Program-enter rename sweep, AST nodes that
        // reference a live binding carry the softened name; assignments
        // visited here see e.g. `$c_letVal = 'updated'`. We append a
        // `$h_live.letVal($c_letVal)` publish call so the bundled cell
        // is updated. For class declarations (whose name is not
        // softened), the lhs name is the original and `liveSoftened`
        // records an identity mapping.
        AssignmentExpression(path) {
          if (!doTransform) {
            return;
          }
          if (rewrittenAssignments.has(path.node)) {
            return;
          }
          const lhs = path.node.left;
          if (!lhs) {
            return;
          }
          if (lhs.type === 'Identifier') {
            const originalName = liveSoftened.get(lhs.name);
            if (originalName === undefined) {
              return;
            }
            rewrittenAssignments.add(path.node);
            allowedHiddens.add(lhs);
            const finalRef = t.identifier(lhs.name);
            allowedHiddens.add(finalRef);
            // Replace `$c_NAME op= rhs` with
            //   ($c_NAME op= rhs, $h_live.NAME($c_NAME), $c_NAME)
            // The trailing reference preserves the assignment's
            // evaluated value for any enclosing expression context.
            path.replaceWith(
              t.sequenceExpression([
                path.node,
                publishLiveCall(originalName, lhs.name),
                finalRef,
              ]),
            );
            path.skip();
            return;
          }
          if (lhs.type === 'ObjectPattern' || lhs.type === 'ArrayPattern') {
            // Destructuring rebinds each identifier in the pattern.
            // After the Program-enter rename sweep, references to live
            // exports inside the pattern carry the softened name (e.g.
            // `({ X } = obj)` becomes `({ X: $c_X } = obj)` via
            // shorthand-property expansion). Collect every bound
            // identifier whose name is a softened live export and emit
            // a publish call per match. Destructuring assignment is
            // always `=`, not a compound operator, so the assignment's
            // evaluated value is the RHS; capture it into a scope-
            // unique scratch local to preserve any enclosing-expression
            // value (e.g. `let v = ({ X } = obj)`).
            const boundIds = collectPatternIdentifiers(path, lhs);
            const liveTargets = [];
            for (const id of boundIds) {
              const originalName = liveSoftened.get(id.name);
              if (originalName !== undefined) {
                allowedHiddens.add(id);
                liveTargets.push({ originalName, softenedName: id.name });
              }
            }
            if (liveTargets.length === 0) {
              return;
            }
            rewrittenAssignments.add(path.node);
            const tmp = path.scope.generateUidIdentifier('destrAssign');
            allowedHiddens.add(tmp);
            // Hoist a `var` declaration for the scratch at the
            // enclosing function or program scope; the scratch is read
            // only inside the rewritten SequenceExpression, but the
            // declaration ensures the bare identifier resolves.
            path.scope.push({ id: t.identifier(tmp.name), kind: 'var' });
            const captureLhs = t.identifier(tmp.name);
            allowedHiddens.add(captureLhs);
            const elements = [
              t.assignmentExpression('=', captureLhs, path.node),
            ];
            for (const { originalName, softenedName } of liveTargets) {
              elements.push(publishLiveCall(originalName, softenedName));
            }
            const finalTmp = t.identifier(tmp.name);
            allowedHiddens.add(finalTmp);
            elements.push(finalTmp);
            path.replaceWith(t.sequenceExpression(elements));
            path.skip();
          }
        },
        UpdateExpression(path) {
          if (!doTransform) {
            return;
          }
          if (rewrittenUpdates.has(path.node)) {
            return;
          }
          const arg = path.node.argument;
          if (!arg || arg.type !== 'Identifier') {
            return;
          }
          const originalName = liveSoftened.get(arg.name);
          if (originalName === undefined) {
            return;
          }
          rewrittenUpdates.add(path.node);
          allowedHiddens.add(arg);
          if (path.node.prefix) {
            // Prefix `++X` / `--X` evaluates to the **new** value of
            // `X` (ECMA-262 §13.4.3.1 PrefixIncrement, §13.4.4.1
            // PrefixDecrement). Rewrite as
            //   (<op>$c_NAME, $h_live.NAME($c_NAME), $c_NAME)
            // so the SequenceExpression's value matches the spec.
            const finalRef = t.identifier(arg.name);
            allowedHiddens.add(finalRef);
            path.replaceWith(
              t.sequenceExpression([
                path.node,
                publishLiveCall(originalName, arg.name),
                finalRef,
              ]),
            );
            path.skip();
            return;
          }
          // Postfix `X++` / `X--` evaluates to the **old** value of
          // `X` (ECMA-262 §13.4.4.1 PostfixIncrement, §13.4.5.1
          // PostfixDecrement). The earlier shape appended a trailing
          // read of `$c_NAME`, which returns the **new** value: that
          // is observably wrong for any consumer of the expression's
          // value (`const m = X++;` must bind `m` to the pre-update
          // value of `X`). Capture the UpdateExpression's own value
          // into a scope-unique scratch local before the publish and
          // the trailing read so the SequenceExpression's value is
          // the pre-update value the spec requires.
          const tmp = path.scope.generateUidIdentifier('postfix');
          allowedHiddens.add(tmp);
          path.scope.push({ id: t.identifier(tmp.name), kind: 'var' });
          const captureLhs = t.identifier(tmp.name);
          allowedHiddens.add(captureLhs);
          const finalTmp = t.identifier(tmp.name);
          allowedHiddens.add(finalTmp);
          // ($c_tmp = X++, $h_live.NAME($c_NAME), $c_tmp)
          path.replaceWith(
            t.sequenceExpression([
              t.assignmentExpression('=', captureLhs, path.node),
              publishLiveCall(originalName, arg.name),
              finalTmp,
            ]),
          );
          path.skip();
        },
        // `for (X of arr) { ... }` / `for (X in obj) { ... }` rebinds
        // the top-level live export on each iteration. The rebinding
        // is the loop's `left` (an Identifier when no fresh
        // declaration is introduced), not an AssignmentExpression, so
        // the AssignmentExpression visitor never sees it. Prepend a
        // `$h_live.NAME($c_NAME)` publish statement to the loop body
        // so each iteration's rebinding propagates to the bundled live
        // cell.
        //
        // `for (let X of arr) ...` (with a fresh declaration) is
        // **not** a rebinding of a top-level export; the loop's `X`
        // shadows the outer binding. Those cases land in
        // instrumentLoopRebind with `left.type === 'VariableDeclaration'`
        // and are skipped.
        ForOfStatement(path) {
          if (!doTransform) {
            return;
          }
          instrumentLoopRebind(path);
        },
        ForInStatement(path) {
          if (!doTransform) {
            return;
          }
          instrumentLoopRebind(path);
        },
        // We handle all the import and export productions.
        ImportDeclaration(path) {
          if (doAnalyze) {
            const specs = path.node.specifiers;
            const specifier = path.node.source.value;
            let myImportSources = importSources[specifier];
            if (!myImportSources) {
              myImportSources = Object.create(null);
              importSources[specifier] = myImportSources;
            }
            /** @type {Array} */
            let myImports = imports[specifier];
            if (!myImports) {
              myImports = [];
              imports[specifier] = myImports;
            }
            if (!specs) {
              return;
            }
            for (const spec of specs) {
              const importTo = spec.local.name;
              importDecls.push(importTo);
              let importFrom;
              switch (spec.type) {
                // import importTo from 'module';
                case 'ImportDefaultSpecifier':
                  importFrom = 'default';
                  break;
                // import * as importTo from 'module';
                case 'ImportNamespaceSpecifier':
                  importFrom = '*';
                  break;
                // import { importFrom as importTo } from 'module';
                case 'ImportSpecifier':
                  importFrom = spec.imported.name;
                  break;
                default:
                  throw path.buildCodeFrameError(
                    `Unrecognized import specifier type ${spec.type}`,
                  );
              }
              if (myImports && myImports.indexOf(importFrom) < 0) {
                myImports.push(importFrom);
              }

              if (myImportSources) {
                let myUpdaterSources = myImportSources[importFrom];
                if (!myUpdaterSources) {
                  myUpdaterSources = [];
                  myImportSources[importFrom] = myUpdaterSources;
                }

                myUpdaterSources.push(
                  `${h.HIDDEN_A} => (${importTo} = ${h.HIDDEN_A})`,
                );
                updaterSources[importTo] = myUpdaterSources;
              }
            }
          }
          if (doTransform) {
            // Nullify the import declaration.
            path.replaceWithMultiple([]);
          }
        },
        ExportDefaultDeclaration(path) {
          // export default FOO -> $h_once.default(FOO)
          if (doAnalyze) {
            fixedExportMap.default = ['default'];
          }
          if (doTransform) {
            const id = t.identifier('default');
            const cid = t.identifier('default');
            soften(cid);
            const callee = t.memberExpression(
              hiddenIdentifier(h.HIDDEN_ONCE),
              id,
            );
            let expr = path.node.declaration;
            const decl = path.node.declaration;
            if (expr.type === 'ClassDeclaration') {
              expr = t.classExpression(expr.id, expr.superClass, expr.body);
            } else if (expr.type === 'FunctionDeclaration') {
              expr = t.functionExpression(
                expr.id,
                expr.params,
                expr.body,
                expr.generator,
                expr.async,
              );
            }

            if (decl.id) {
              // Just keep the same declaration and mark it as the default.
              path.replaceWithMultiple([
                replace(path.node, decl),
                t.expressionStatement(t.callExpression(callee, [decl.id])),
              ]);
              return;
            }

            // const {default: $c_default} = {default: (XXX)}; $h_once.default($c_default);
            path.replaceWithMultiple([
              replace(
                path.node,
                t.variableDeclaration('const', [
                  t.variableDeclarator(
                    t.objectPattern([t.objectProperty(id, cid)]),
                    t.objectExpression([t.objectProperty(id, expr)]),
                  ),
                ]),
              ),
              t.expressionStatement(t.callExpression(callee, [cid])),
            ]);
          }
        },
        ClassDeclaration(path) {
          const ptype = path.parent.type;
          if (ptype !== 'Program' && ptype !== 'ExportNamedDeclaration') {
            return;
          }

          const { name } = path.node.id;
          if (doAnalyze) {
            topLevelIsOnce[name] = path.scope.getBinding(name).constant;
          }
          if (doTransform) {
            if (topLevelExported[name]) {
              if (!topLevelIsOnce[name]) {
                // The class declaration is reassigned somewhere in the
                // module. The class declaration is not renamed (the
                // Program-enter sweep excludes class kinds), so the
                // AssignmentExpression visitor must recognise the
                // un-softened class name on the LHS; record an identity
                // mapping for it.
                liveSoftened.set(name, name);
              }
              const callee = t.memberExpression(markExport(name), path.node.id);
              path.replaceWithMultiple([
                path.node,
                t.expressionStatement(t.callExpression(callee, [path.node.id])),
              ]);
            }
          }
        },
        FunctionDeclaration(path) {
          const ptype = path.parent.type;
          if (ptype !== 'Program' && ptype !== 'ExportNamedDeclaration') {
            return;
          }

          const { name } = path.node.id;
          if (doAnalyze) {
            topLevelIsOnce[name] = path.scope.getBinding(name).constant;
            // console.error('have function', name, 'is', topLevelIsOnce[name]);
          }
          if (doTransform) {
            // Match either the un-renamed original name (which is
            // what `topLevelExported` is keyed by) or the softened
            // name installed by the Program-enter sweep (which is
            // recorded in `liveSoftened`).
            const original = liveSoftened.get(name);
            const effectiveName = original !== undefined ? original : name;
            if (topLevelExported[effectiveName]) {
              rewriteExportDeclaration(path);
              markExport(effectiveName);
            }
          }
        },
        VariableDeclaration(path) {
          const ptype = path.parent.type;
          if (ptype !== 'Program' && ptype !== 'ExportNamedDeclaration') {
            return;
          }

          // We may need to rewrite this topLevelDecl later.
          const vids = path.node.declarations.flatMap(({ id }) =>
            collectPatternIdentifiers(path, id),
          );
          if (doAnalyze) {
            for (const { name } of vids) {
              topLevelIsOnce[name] = path.scope.getBinding(name).constant;
            }
          }
          if (doTransform) {
            for (const { name } of vids) {
              // Match either the un-renamed original name (which is
              // what `topLevelExported` is keyed by) or the softened
              // name installed by the Program-enter sweep (which is
              // recorded in `liveSoftened`).
              const original = liveSoftened.get(name);
              if (topLevelExported[name] || original !== undefined) {
                rewriteExportDeclaration(path);
                break;
              }
            }
          }
        },
        ExportAllDeclaration(path) {
          const { source } = path.node;
          if (doAnalyze) {
            const specifier = source.value;
            let myImportSources = importSources[specifier];
            if (!myImportSources) {
              myImportSources = Object.create(null);
              importSources[specifier] = myImportSources;
            }
            let myImports = imports[specifier];
            if (!myImports) {
              // Ensure that the specifier is imported.
              myImports = [];
              imports[specifier] = myImports;
            }
            exportAlls.push(specifier);
          }
          if (doTransform) {
            path.replaceWithMultiple([]);
          }
        },
        ExportNamedDeclaration(path) {
          const { declaration: decl, specifiers: specs, source } = path.node;

          if (doAnalyze) {
            let myImportSources;
            let myImports;
            if (source) {
              const specifier = source.value;
              myImportSources = importSources[specifier];
              if (!myImportSources) {
                myImportSources = Object.create(null);
                importSources[specifier] = myImportSources;
              }
              myImports = imports[specifier];
              if (!myImports) {
                myImports = [];
                imports[specifier] = myImports;
              }
            }

            if (decl) {
              const declarations = decl.declarations || [decl];
              const vids = declarations.flatMap(({ id }) =>
                collectPatternIdentifiers(path, id),
              );
              for (const { name } of vids) {
                let tle = topLevelExported[name];
                if (!tle) {
                  tle = [];
                  topLevelExported[name] = tle;
                }
                tle.push(name);
              }
            }

            for (const spec of specs) {
              const { local, exported } = spec;
              const importFrom =
                spec.type === 'ExportNamespaceSpecifier' ? '*' : local.name;
              let myUpdaterSources;
              // If local.name is reexported we omit it.
              const importTo = exported.name;

              if (source) {
                // If source is defined, it's a reexport from a different module.
                // In this case we want to collect the local and reexported name.
                // If there's no `as newName`, the ExportNamedDeclaration will
                // have the `exported` field anyway, representing the same
                // identifier as `local`.
                // For `ExportNamespaceSpecifier` (`export * as ns from 'src'`)
                // there is no `local` at all; the imported name we forward is
                // `'*'`, captured in `importFrom` above.

                if (!reexportMap[source.value]) {
                  reexportMap[source.value] = [];
                }
                reexportMap[source.value].push([importFrom, exported.name]);
                // Don't populate importSources here, so the live binding won't get
                // generated by the transform
              } else {
                myUpdaterSources = updaterSources[importFrom];
                if (myImportSources) {
                  myUpdaterSources = myImportSources[importFrom];
                  if (!myUpdaterSources) {
                    myUpdaterSources = [];
                    myImportSources[importFrom] = myUpdaterSources;
                  }
                  updaterSources[importTo] = myUpdaterSources;
                  myImports.push(importFrom);
                }
              }

              if (myUpdaterSources) {
                // If there are updaters, we must have a local
                // name, so update it with this export.
                const ident = topLevelIsOnce[importFrom]
                  ? h.HIDDEN_ONCE
                  : h.HIDDEN_LIVE;
                myUpdaterSources.push(
                  `${ident}[${JSON.stringify(importFrom)}]`,
                );

                liveExportMap[importTo] = [importFrom, false];
              }

              if (!(source || myUpdaterSources)) {
                let tle = topLevelExported[importFrom];
                if (!tle) {
                  tle = [];
                  topLevelExported[importFrom] = tle;
                }
                tle.push(importTo);
              }
            }
          }
          if (doTransform) {
            path.replaceWithMultiple(decl ? [replace(path.node, decl)] : []);
          }
        },
      });

      // Add the module visitor.
      switch (pass) {
        case 0:
          return {
            visitor: {
              ...visitor,
              ...moduleVisitor(true, false),
            },
          };
        case 1:
          return {
            visitor: {
              ...moduleVisitor(false, true),
              ...importMetaVisitor,
            },
          };
        default:
          throw TypeError(`Unrecognized module pass ${pass}`);
      }
    };

  return {
    analyzePlugin: rewriteModules(0),
    transformPlugin: rewriteModules(1),
  };
}

export default makeModulePlugins;
