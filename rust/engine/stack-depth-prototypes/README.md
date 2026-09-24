# Stack-depth refactoring prototypes

These patches are the experiments behind
[STACK-DEPTH-REFACTOR.md](../STACK-DEPTH-REFACTOR.md).
They are evidence for its measurements, not changes proposed for merging as they stand.
Each was measured against the unpatched engine in a scratch copy.
The report records what was measured and which differential suites they passed.

All of them apply to the tree at the commit that added this directory.
Apply one from the repository root:

```sh
git apply --directory=rust/engine rust/engine/stack-depth-prototypes/<patch>
```

| Patch | Report option | What it changes |
|---|---|---|
| `a1-thin-native-dispatch.patch` | A1 | `call_native_method_inner` and `call_native_inner` become thin matches that tail-call `#[inline(never)]` per-family functions, so a re-entry carries one family's frame instead of the union of every arm |
| `a2-dispatch-split-table.patch` | A2 | Splits `dispatch_at_inner` into outlined opcode handlers behind a table, so the recursive activation keeps little more than the handler that re-entered |
| `b1-b2-proxy-cursor-loops.patch` | B1, B2 | Cursor loops for trap-absent Proxy forwarding (a layer with a trap hands off to a separate function), and `instanceof` over bound functions as a loop, charging `native_depth` exactly as the recursion did |
| `b3-b4-json-parse-and-flat.patch` | B3, B4 (fast path) | `JSON.parse` over an explicit container stack, and the compact `flat` path as a depth-first walk with one cursor per open array |
| `d1a-compiler-outline-only.patch` | D1a | `#[inline(never)]` on the scoper's and coder's recursive arms, to shrink their frames |
| `d1a-d1c-compiler-worklists.patch` | D1a–D1c | D1a, plus worklists for two tree walks, explicit stacks in the scoper's hoist and bind arms, a coder spine for binary operators, and an iterative `Drop` for AST nodes |

Each patch was also built and tested on its own against the unpatched tree, with
`cargo test --release -p <crate> --no-fail-fast`:

| Patch | Crate | Tests |
|---|---|---|
| (none) | `ironhorse-vm` | 1,117 passed |
| (none) | `ironhorse-compile` | 221 passed |
| `a1-thin-native-dispatch.patch` | `ironhorse-vm` | 1,117 passed |
| `a2-dispatch-split-table.patch` | `ironhorse-vm` | 1,111 passed, **6 failed** |
| `b1-b2-proxy-cursor-loops.patch` | `ironhorse-vm` | 1,117 passed |
| `b3-b4-json-parse-and-flat.patch` | `ironhorse-vm` | 1,117 passed |
| `d1a-compiler-outline-only.patch` | `ironhorse-compile` | 221 passed |
| `d1a-d1c-compiler-worklists.patch` | `ironhorse-compile` | 221 passed |

A2's six failures are all in `ironhorse-vm/tests/dispatch_loop_control_transfer.rs`.
That file scans the source of `interp/dispatch.rs` to check that every exit from the dispatch
loop goes through the depth and meter guards.
The prototype copies `macro_rules! dispatch_halt` into its group functions ("declaration must
be unique"), and it leaves one raw return the scan cannot classify.
A production version of A2 must satisfy those checks or deliberately update the scanner.

`d1a-d1c-compiler-worklists.patch` contains D1a, so apply one or the other, not both.
The VM patches (`a*`, `b*`) were measured one at a time; whether they combine cleanly was not
checked.

The measurement data these patches were compared with lived in session scratch and was not kept.
The report inlines its key per-case numbers in Appendix B.
