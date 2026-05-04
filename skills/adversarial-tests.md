# Adversarial tests for invariants

## When to use

When stress-testing a module that claims invariants — exos with
`M.interface()` guards, pass-style validators, parsers, schedulers,
anything documented to "always" or "never" do something. The
saboteur runs this play; reviewers in the `juror` role can also
draw on it for the security and correctness perspectives.

## The brainstorming list

Walk this list per invariant the module claims. Skip categories
that genuinely don't apply; default to "include" when uncertain.

### Boundary

- Empty input (`""`, `[]`, `{}`, `new Map()`, `new Set()`).
- One element where the implementation might assume zero or
  many.
- Off-by-one at indexed limits (`length`, `length - 1`,
  `length + 1`).
- The exact bucket boundary in any range coverage
  (`2 ** 31`, `2 ** 31 + 1`, `2 ** 32`, `2 ** 53`,
  `Number.MAX_SAFE_INTEGER`).
- Sentinel values (`-0`, `+0`, `NaN`, `Infinity`,
  `-Infinity`).

### Type confusion

- A `BigInt` where a `Number` is expected (and vice-versa).
- `undefined` vs missing argument vs explicit `null`.
- A `Symbol` as a key, value, or argument.
- A `Proxy` standing in for a "plain" object.
- A frozen object where the implementation assumes it can
  set a property.
- A class instance where `Object.create(null)` is expected,
  or vice-versa.
- A passable that is also somehow callable (e.g., a function
  that has been hardened and given a non-function `passStyle`).

### Adversarial values

- A `Proxy` whose getter throws on property access.
- A `Proxy` whose getter returns a different value each time
  (non-idempotent).
- An iterator that throws on `next()` after the first call.
- A `document.all`-like value: `typeof x === 'undefined'` is
  true but `x !== undefined` is true. (See PR 69.)
- An object whose `toString` / `valueOf` / `Symbol.toPrimitive`
  throws.
- A circular structure where the implementation walks
  recursively.
- A string that is not well-formed UTF-16 (`'\uD800'` alone).
- A value whose `constructor` property is an accessor whose
  getter throws.

### Reentrancy and ordering

- A callback that re-enters the function it was called from.
- A promise that resolves synchronously (which JS forbids, but
  a user-supplied `then` can simulate).
- An `async` callback that the implementation forgets to
  `await`.
- An init step that the caller skipped or reordered.
- Lookup before write, write after revocation, send after
  cancel — invariants that depend on ordering.

### SES-specific

- A hardened input that the implementation tries to mutate.
- An object created in a child compartment whose prototype the
  implementation expects to be the start compartment's
  prototype.
- A `passStyleOf` claim against a compartment-bound value.
- Behavior under `--feral-errors` versus default lockdown
  taming, when the test depends on stack visibility.

### Timing and state

- Two parallel invocations against shared state. Even if the
  module is single-threaded, async resolution order can
  reorder operations.
- Cancellation while an operation is in flight.
- A `Promise.race` that never settles, paired with a finalizer.

## How to write the test

Each adversarial test should:

1. **Name the invariant being attacked.** "rejects a Proxy
   whose getter throws on .length" beats "edge case 4".
2. **State the attack in a comment** in one sentence.
3. **Assert the specific failure mode** the module claims:
   throws a particular error class with a particular message,
   or rejects with a particular reason. Don't let `t.throws`
   catch any error; pin the class and message regex.
4. **Treat a non-failure as evidence.** If the module
   gracefully handles the gotcha, the test is shipped as
   defensive coverage that prevents future regression. If the
   module fails or behaves wrong, you have surfaced a bug, not
   a test; file it separately, do not silently fix it inside
   the test commit.

## Pitfalls

- **The category is endless.** Stop when the next gotcha
  would test a property the module does not claim. The
  saboteur is not required to enumerate every possible bad
  input; the goal is to cover the *invariants the module
  asserts*.
- **Tests that pass without exercising the code.** A
  `t.throwsAsync` against a non-existent method passes for
  the wrong reason. Confirm the exception came from the
  intended throw site by pinning the message.
- **Snapshot tests on adversarial output.** AVA's concordance
  pretty-printer can crash on iterator prototypes and the
  like. Use `t.is` / `t.true` with explicit identity or
  message checks. (See PR 60's `get-intrinsics.test.js`.)
- **Tests written from the implementation, not the contract.**
  An adversarial test should be readable against the module's
  documented contract alone. If the test only makes sense to
  someone who has read the implementation, it is a unit test,
  not an invariant test.
- **Stuffing every gotcha in one file.** Group by invariant;
  one test file per invariant cluster keeps failure messages
  focused.
