# House style: arrow and method syntax over the `function` keyword

We do not use the `function` keyword in this repository's package sources
except in the specific categories listed under [Legitimate exceptions](#legitimate-exceptions).
New code uses arrow functions or concise method syntax instead.

## Rationale

`function`-keyword functions carry four distinct hazards inside
hardened-JavaScript code:

1. They have both `[[Construct]]` and `[[Call]]` behaviors, so they can be
   invoked with `new` even when the author never intended a constructor.
2. They have an initial `prototype` property that points at an irrelevant
   prototype object.
3. Because of that extra object, `freeze` is not equivalent to `harden`;
   the prototype object remains mutable and leaves hazardous reachable state.
4. Function-keyword declarations additionally have hoisting hazards.
   A function declaration is hoisted and fully initialized before the module
   body runs — it has no temporal dead zone — so in an import cycle one side
   can observe the function as a value before the rest of the module has run,
   masking initialization-order bugs.

The arrow function `() => {}` form has none of these hazards: no
`[[Construct]]`, no `prototype`, no early initialization (a `const` binding
stays in its temporal dead zone until evaluated), and `freeze` is equivalent to
`harden`.
Concise-method syntax (`{ name() {} }`, `{ get name() {} }`,
`{ set name(v) {} }`) likewise has no `[[Construct]]` and no `prototype`,
while still binding `this`.

This rule was codified following erights's review on
[endojs/endo-but-for-bots#468](https://github.com/endojs/endo-but-for-bots/pull/468#issuecomment-3439684004).
The conversion itself landed on
[endojs/endo-but-for-bots#474](https://github.com/endojs/endo-but-for-bots/pull/474).

## Conversion rules

- Use an arrow function (`(...) => {}`) when the function does not use `this`
  and is never called with `new`.
- Use concise method syntax (`{ name(...) {} }`, `{ get name() {} }`,
  `{ set name(v) {} }`) when the function uses `this` (or `super`) but is
  never called with `new`.
  For a prototype monkey-patch that needs the method's `name` to surface in
  stack traces and diagnostics, write the methods as concise methods on an
  object literal and assign them onto the prototype (see
  `packages/init/src/node-async-local-storage-patch.js`): concise methods retain
  `name` while having no `[[Construct]]` and no `prototype`, so a named
  function expression is not needed for this case.
- Leave the `function` keyword in place for the legitimate-exception categories
  listed below.

The net behavioral diff when converting is intended to be zero: every
conversion preserves arity, return value, and `this` binding.
Hoisting changes from converting declarations are intentional (that is part of
the goal) but must not break existing call sites.

## Legitimate exceptions

The following uses of the `function` keyword stay in place.

### Constructor emulation

When the function is invoked with `new` (or is intended to be invokable with
`new`) to emulate a built-in constructor or a class constructor that
legitimately needs `[[Construct]]` and a `prototype` property:

- `packages/immutable-arraybuffer/src/lib.js`: `function PseudoTypedArray`,
  emulates a built-in TypedArray constructor (uses `new.target`,
  `construct(...)`, and exposes `prototype`).
- `packages/eventual-send/src/handled-promise.js`:
  `function baseHandledPromise`, which the author already documented as
  "*needs* to be a `function X` so that we can use it as a constructor"
  (uses `new.target`).
- `packages/ses/src/tame-function-constructors.js`:
  `const InertConstructor = function () { throw TypeError(...) }`.
  The inert-constructor pattern depends on the function having `[[Construct]]`
  and a writable `prototype` property so SES can rewire it to point at the
  original constructor's prototype.
- Similar inert-constructor patterns inside SES's `tame-date-constructor`,
  `tame-regexp-constructor`, `tame-error-constructor`,
  `tame-v8-error-constructor`, `tame-symbol-constructor`,
  `make-function-constructor`.
  Each one is replacing a built-in constructor; the replacement must itself be
  a constructor.

### Generator and async-generator function expressions

ECMAScript provides no arrow-function spelling for generators or
async-generators.
A `function*` or `async function*` expression is the only way to write one.
These cannot be invoked with `new` (the spec marks them non-constructable), so
the `[[Construct]]` hazard does not apply, but the function still has a
`prototype` property pointing at the generator's prototype, so `freeze` is not
equivalent to `harden`.
The author must remember to harden the wrapping closure, not just freeze it.
We accept this trade-off because the alternative is no generator at all.

Examples kept under this exception:

- `packages/trampoline/src/trampoline.js`: `function* () {}` sentinel.
- `packages/captp/src/atomics.js`:
  `harden(async function* trapHost([isReject, serialized]) { ... })`.

### Vendored or third-party-derived code

Code we received from upstream projects and only lightly modify keeps the
upstream style so future merges remain tractable:

- `packages/cjs-module-analyzer/index.js`: a port of `es-module-lexer` by
  Guy Bedford.
  The file uses around 38 inner `function` declarations as a single-pass lexer
  with mutual recursion; `no-use-before-define` is intentionally disabled.
  Converting these to arrows would force a manual reorder and risk a
  performance regression in a hot path.
- `packages/test262-runner/test262/`: the upstream tc39/test262 suite,
  vendored under the tc39 LICENSE.
  Out of scope by license.

### Sloppy-mode `this` detection

`packages/ses/src/assert-sloppy-mode.js`:
`function getThis() { return this; }`.
The whole point of this function is that it returns the calling-context `this`
(which is `globalThis` in sloppy mode and `undefined` in strict mode), so SES
can detect the ambient strictness.
Arrow functions and concise methods bind `this` lexically, which would make
`getThis()` return the module-scope `this` (always `undefined` under modules),
defeating the check.

### TypeScript assertion functions

`function assertX(...): asserts x is Y` requires a function declaration under
the current TypeScript checker; converting to an arrow drops the `asserts`
narrowing and the compiler emits TS2775 ("Assertions require every name in the
call target to be declared with an explicit type annotation").
Where the function is an assertion, the declaration stays.
Concrete site:
`packages/compartment-mapper/src/compartment-map.js`:
`function assertModuleConfiguration`.

### Module-init-time forward references

If the function is referenced by name during module top-level evaluation
(not from inside another function body), converting the declaration to a
`const` arrow puts the reference into TDZ.
We do not reorder the file to work around this; we keep the `function`
declaration and add a note.
Concrete sites:

- `packages/captp/src/captp.js`: `convertValToSlot` and `convertSlotToVal`
  are passed as arguments to `makeMarshal(...)` during module init from
  hundreds of lines earlier than their declarations.
- `packages/ocapn/src/client/ocapn.js`: `function serializeAndSendMessage`
  is passed into `makeOcapnCommsKit({...rawSend: serializeAndSendMessage})`
  during module init before its declaration.
- `packages/eslint-plugin/lib/rules/assert-fail-as-throw.js`: top-level
  `safeRequire(...)` calls at file head precede `function safeRequire`'s
  declaration further down.
  The file is adopted from mysticatea/eslint-plugin-node with an explicit
  `/* eslint-disable no-use-before-define */` at the top to permit the
  hoisting; converting it would force a full reorder of code we want to keep
  diff-tractable against upstream.

### Vendored runtime template literals

The bundler in `packages/compartment-mapper/src/bundle-mjs.js` and
`packages/compartment-mapper/src/bundle-cjs.js` builds output JavaScript from
template-literal `runtime` strings.
The `function observeImports` and `function wrapCjsFunctor` inside those
strings are the bundler's output code, not module-side code, and are out of
scope.

## Applying this rule to new code

When writing a new function:

1. Does it need `[[Construct]]` (called with `new`) or a `prototype` property?
   Use a `class` or a `function`-keyword function, and document why.
2. Does it need a `this` binding?
   Use concise method syntax inside an object literal or class body.
3. Otherwise, use an arrow function.

When converting existing `function`-keyword code, verify that the conversion
falls outside all exception categories above, run `yarn test` for the affected
package, and confirm the behavioral diff is zero.
