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

| Patch | Report option (STACK-DEPTH-REFACTOR §4) | What it changes |
|---|---|---|
| `a1-thin-native-dispatch.patch` | A1, one family | Puts a thin dispatcher in front of `call_native_method_inner` that sends `Array.prototype.forEach` on a dense array to one `#[inline(never)]` function (`experiment_array_foreach`) and every other method to the renamed monolith (`call_native_method_inner_all`). It measures one family of A1; `call_native_inner` is unchanged. |
| `a2-dispatch-split-table.patch` | A2a | Moves `dispatch_at_inner`'s opcode arms into eight `#[inline(never)]` opcode-group functions chosen by one `match` on the opcode, so a re-entry carries the small loop frame plus one group's frame. Per-opcode handlers (A2b) are not prototyped. |
| `b1-b2-proxy-cursor-loops.patch` | B1, B2 | Cursor loops for trap-absent Proxy forwarding (a layer with a trap hands off to a separate function), and `instanceof` over bound functions as a loop, charging `native_depth` exactly as the recursion did |
| `b3-b4-json-parse-and-flat.patch` | B3, B4 (fast path) | `JSON.parse` over an explicit container stack, and the compact `flat` path as a depth-first walk with one cursor per open array |
| `d1a-compiler-outline-only.patch` | D1a | `#[inline(never)]` on the scoper's and coder's recursive arms, to shrink their frames |
| `d1a-d1c-compiler-worklists.patch` | D1a–D1c | D1a, plus worklists for two tree walks, explicit stacks in the scoper's hoist and bind arms, a coder spine for binary operators, and an iterative `Drop` for AST nodes. It also adds a public `scope_forget` hook to `ironhorse-compile/src/lib.rs` for the measurements. |

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
Three fail on the prototype's own code: it copies `macro_rules! dispatch_halt` into its group
functions (two scans require one declaration), and it leaves one raw return the scan cannot
classify.
The other three fail because the scans look only inside `dispatch_at_inner`, and the split moved
the raise sites, a mutation anchor and the `dispatch_result!`-wrapped handler calls out of it.
A production version of A2 must satisfy those checks or deliberately update the scanner.

`d1a-d1c-compiler-worklists.patch` contains D1a, so apply one or the other, not both.
A2 was measured on top of A1; the other VM patches were measured one at a time.
The four VM patches and `d1a-d1c-compiler-worklists.patch` touch disjoint files and apply
together.
Built together, they pass 1,332 of the 1,338 `ironhorse-vm` and `ironhorse-compile` tests, and
the six failures are the same six as A2's alone.
Their stack savings were not measured together.

The measurement data these patches were compared with lived in session scratch and was not kept.
The report inlines its key per-case numbers in Appendix B.
