# Babel visitor exhaustiveness sentinel

## When to use

When auditing or extending a Babel-based AST transform, you want
compile-time evidence that the visitor handles every relevant node
type. Add a sentinel function that switches over `Node['type']` and
uses `assertNever` on the default case. If a future
`@babel/types` upgrade introduces a new node type the visitor doesn't
classify, the sentinel fails to compile.

## How

```ts
import type { Node } from '@babel/types';

const assertNever = (x: never): never => {
  throw new Error(`unexpected node type: ${(x as { type: string }).type}`);
};

/**
 * Asserts at compile time that the visitor's case list is exhaustive
 * over @babel/types Node variants under the parser configuration we
 * use.  Each case must either be visited by the visitor (return
 * "visited"), descended into without rewriting (return "transparent"),
 * or be unreachable in our parser config (return "unreachable").
 */
const classifyNode = (n: Node): 'visited' | 'transparent' | 'unreachable' => {
  switch (n.type) {
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration':
    case 'ExportAllDeclaration':
      return 'visited';

    case 'Program':
    case 'BlockStatement':
      return 'transparent';

    case 'JSXElement':           // not enabled by parser
    case 'TSImportType':         // not enabled by parser
    case 'FlowDeclareInterface': // not enabled by parser
      return 'unreachable';

    // … exhaustive list …

    default:
      return assertNever(n);
  }
};
```

The sentinel doesn't have to be invoked at runtime; its presence in
the type-checked source is what matters. The package's `tsconfig.json`
must include the sentinel file.

## Bug-class footguns the sentinel catches

The audit also revealed footguns specific to Babel + module-source:

- `import.meta` access through a destructure — visitors must fire on
  `MetaProperty` (with `meta.name === 'import' && property.name ===
  'meta'`), not just on the dotted full form.
- Direct eval through parentheses or comma — `(0, eval)("…")`,
  `(eval)("…")`. Detection must look at the callee's *innermost*
  identifier, not the surface form.
- `import()` in unusual positions — as an argument to `await`, as the
  tag of a tagged template, in `JSXExpressionContainer`, as
  `import?.(...)` (optional dynamic import).
- Re-export from string source — `export { x } from 'foo'`, `export *
  from 'foo'`, `export * as ns from 'foo'`. Each shape uses a
  different specifier type. **`ExportNamespaceSpecifier` has no
  `local` property** — destructuring `local` indiscriminately is the
  bug that PR 74 fixed.

## Pitfalls

- TS exhaustiveness only checks the discriminated union. If the
  visitor walks `node.value` or `node.callee` and those have node-
  shape sub-unions, you may need a *recursive* sentinel.
- The sentinel becomes brittle if the `@babel/parser` plugins list
  changes (e.g., enabling JSX). Re-classify when plugins change.
- **`path.buildCodeFrameError(...)` requires a Hub.** Calling
  `traverse(ast, visitor)` initializes child paths with
  `hub === undefined`, so any visitor that fires the
  `path.buildCodeFrameError` guard immediately re-throws the
  cryptic `TypeError: Cannot read properties of undefined
  (reading 'buildError')` instead of the intended SyntaxError.
  The fix is to construct a synthetic wrapper `parentPath`
  carrying a `Hub` and pass it as the fifth argument to
  `traverse(parent, opts, scope, state, parentPath)`. Per
  `NodePath.get`, `if (!hub && parentPath) hub = parentPath.hub;`,
  so child paths inherit the hub. This is the second crash from
  endojs/endo#1596, fixed in PR 74's follow-up commit.
- **`@babel/traverse` named exports are on the namespace, not on
  `default`.** The default export of `@babel/traverse` is the
  callable `traverse` function. `Hub`, `NodePath`, `Scope`, and
  `visitors` are *named* exports on the module namespace itself.
  The Endo idiom `const x = babelTraverse.default || babelTraverse`
  works for getting at the callable, but destructuring named
  exports requires reading from `babelTraverse` directly:
  `const { Hub, NodePath } = babelTraverse;`. The default-or-namespace
  shim returns the callable's own properties (`visitors`, `cache`,
  …) but *not* the namespace's named exports, which silently
  yields `undefined` for `Hub`/`NodePath` if you read from there.
- **When chasing a TypeError that mentions a property name not
  present in the codebase, grep the message in `node_modules` too.**
  The `(reading 'buildError')` crash from #1596 has no `buildError`
  identifier in `module-source/src/`; it lives in
  `@babel/traverse/lib/path/index.js` as `this.hub.buildError(...)`.
  The data-flow link is the analyzer's `path.buildCodeFrameError`
  call, which dispatches into Babel's hub. Treat third-party
  source as part of the search surface for analyzer bugs.

## Session example

PR 74 (`audit(module-source): Babel visitor coverage + fix
export-namespace re-export`) introduced an `AUDIT.md` walking every
visitor in `babel-plugin.js` plus the sentinel pattern. The audit
also turned up a real bug: `export * as ns from 'src'` threw
`TypeError: Cannot read properties of undefined (reading 'name')`
because `ExportNamespaceSpecifier` nodes have no `local` property.
Fixed in commit `914addd25f`.

A follow-up commit (`e9631f5759`) on the same PR addressed the
second half of endojs/endo#1596: the `(reading 'buildError')` crash
that fires whenever any visitor's `path.buildCodeFrameError` guard
trips, because `traverse(ast, visitor)` initializes child paths
with `hub === undefined`. Fix wraps the AST in a synthetic
`parentPath` carrying a `Hub` and threads it through both passes,
so child paths inherit the hub and the intended SyntaxError reaches
the caller. Two pre-existing reserved-identifier tests were
sharpened to assert `instanceOf: SyntaxError` plus a `t.notRegex`
against the buildError-undefined TypeError, making them
load-bearing on the Hub wiring.
