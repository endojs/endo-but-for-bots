# F063: scoper assertion invariants

Source-reviewed against `a3f47e5a5`, with the accompanying
`ironhorse-compile/src/scoper/invariants.rs` regression tests.
This completes the source review of the seven previously unexamined
`expect`/`unwrap` shapes in `scoper.rs`; it does not close F063.
The two earlier traversal rosters remain empirical evidence, not a proof of compiler totality.
This audit does not cover every indexing operation, arithmetic overflow or the coder's assertions.

## Boundary and failure model

The claim is about source compilation, not arbitrary hand-constructed ASTs.
The parser returns a Program or Module root and assigns node identities before the scoper runs.
The parser-exit scanner and node-identity tests hold that separate prerequisite.
The AST is immutable throughout both scoper passes.
Binding runs only after hoisting succeeds.
A returned error or meter refusal discards the private `Scoper`; no caller resumes its
partially updated state.
Consequently the restoration arguments below concern successful returns, not error paths.

The public `scope_program` entry keeps the parser's Program scope convention, whereas
the compiler sets the root's `EVAL` flag before scoping either Script or Eval.
The index tests exercise both conventions, including strictness and Module.

## Current scope and function scope: twelve asserting readers

`scope_new` appends a scope with the current scope as parent, then enters it.
`hoist_field_init_scope` does the same for its synthetic function scope.
These are the only hoist-time entries; `fx_scope_hoisted` exits to the recorded parent.
The Program and Module visitors open their root scope before visiting any child and close it last.
Every nested scope visitor closes scopes in reverse creation order, after its last child visit.
In particular, a named class closes its body scope before its symbol scope, and a catch with
a parameter closes its statement scope before its parameter scope.
Neither dispatch nor the generic child walker visits a sibling after the root closes.
Thus a hoist-time `scope` reader is inside the root or a nested scope.

Binding enters the hoist receipt through `fx_scope_binding` and exits through
`fx_scope_bound`, which restores the same parent relation.
The child-traversal agreement needed to obtain those receipts is a separate prerequisite:
the `scope_of` roster in `tests/scoper_totality.rs`, not something this argument proves.
With that prerequisite, the same entry/exit argument covers bind-time `scope` readers.

Program and Module hoisting also initialize `function_scope` before their children.
Ordinary functions, declaration functions (`hoist_function_no_self`) and synthetic field
functions save it, install their own scope before visiting parameters or values, and restore it
afterward.
Those are all assignments to the field.
Its only asserting readers are `hoist_declare` and `hoist_define`, inside those root traversals.
Unlike `body_scope`, no nested visitor clears `function_scope` to `None`.
The root assignments deliberately do not restore it; no visitor runs after root exit.

The phase tests check that nested traversal leaves `scope == None` after each complete pass
and restores `function_scope` to the root after hoisting.
Fixtures place declarations and accesses after nested functions, classes and catches.
These are checks on the argument, not instrumentation of every intermediate transition.
The separate `body_scope` parameter-default window remains covered by its existing roster.

## Declaration indexes: four readers in two accessor pairs

`new_declare` allocates a stable ID in one scope; it does not publish a lookup result.
Every production caller inserts that declaration through `scope_add_declare` in the same scope.
Insertion creates the lazy index, grows its position vector to `next_id`, records the list
position, and publishes the name lookup before returning the ID.
The synthetic disposal declaration of a `using` is inserted through the same path.

The IDs consumed by `declare_ref` and `declare_mut` have three sources:

- `scope_get_declare` reads a name index populated by insertion or reindexing.
- `scope_lookup` returns one of those IDs, or a function closure alias it inserts before returning.
- Class-member and instance-initializer receipts retain IDs returned by insertion.
  These identify `Const` declarations in the class scope, not temporary placeholders.

The only removal is at hoist-time Block exit: `NoToken` var placeholders are dropped,
then `reindex_declarations` clears the names and positions and rebuilds both from survivors.
No placeholder ID is retained for binding: the hoist conflict checks consume lookup results
locally, and the class receipts contain the surviving constants just described.
Closure aliases also use `NoToken`, but live in Function scopes and are inserted during
binding, after placeholder removal is over.
No declaration removal occurs during binding.

Eval uses newest-first name lookup while its list is accumulated in insertion order.
`run_goal_with_access_log` reverses that list only after both passes, immediately before
returning `ScopeTree`, which does not expose the private declaration indexes.
There is no indexed declaration read after the reversal.

The tests reconstruct every private name/position index by scanning surviving declarations
after hoist and again after bind.
They check vacant positions for removed IDs, alias targets and recorded resolutions.
Fixtures include repeated vars, duplicate sloppy parameters, captured lexicals, disposal
slots, private accessor pairs, computed fields, imports and re-exports.
A derived-constructor fixture requires a nonempty `super_instance_init` receipt and checks
that its alias targets the class's instance initializer declaration.
The existing lazy-index unit test separately checks both mutable and immutable access to a
survivor that moved when a predecessor was removed.

## Field-init hoist receipts: two readers

Both instance paths use the same `class_has_instance_field` predicate on the same immutable
class node.
The hoist path inserts the receipt after successfully hoisting the initializer values.
No operation removes a receipt.
Therefore a bind-time instance lookup has a receipt, subject to the traversal prerequisite above.

The static paths use different predicates, so their equivalence needs checking.
Binding requests a static initializer when its static-method or static-data list is nonempty.
Its list-building cases and `class_has_constructor_init_member` agree as follows:

| Member | Instance initializer | Static initializer |
|---|---|---|
| Constructor or public method/accessor, including computed names | No | No |
| Public, computed or private instance data field | Yes | No |
| Private instance method/accessor | Yes | No |
| Public, computed or private static data field | No | Yes |
| Private static method/accessor | No | Yes |
| Static block | No | Yes |

The phase test gives each row explicit expected booleans, with individual getter/setter,
computed, uninitialized-field and mixed-member fixtures.
It asserts the expected hoist receipt before binding, checks its parent and Function kind,
then verifies binding consumed the same scope ID.
Private-method-only classes are important: they need a field function even with no field
value expressions to hoist.
Static-block fixtures must finish scoping; downstream coder support is irrelevant to this test.

## Catch statement scope: one reader

`hoist_catch` and `bind_catch` use the identical predicate on child 0:
`Some(Item::Node(_))` means a parameter is present.
For that branch, successful hoisting records `(parameter_scope, Some(statement_scope))`.
For the absent-parameter branch it records `(statement_scope, None)` and binding never unwraps
the secondary slot.
The immutable AST and unique node IDs keep the predicate and receipt paired across passes.

The phase test pins the receipt and its parent before binding for absent, simple, array-pattern,
object-pattern and computed-pattern parameters, including nested functions in defaults and
function declarations in the catch body.

## Reproduction and limits

Run from the repository root:

```sh
cargo test --locked -p ironhorse-compile scoper::invariants --lib
cargo test --locked --release -p ironhorse-compile scoper::invariants --lib
cargo test --locked -p ironhorse-compile --test scoper_totality
```

Four independent temporary mutations were checked, then reverted:

- Leaving removed declarations' position entries populated fails the index comparison.
- Recording no secondary scope for a catch parameter fails the catch receipt check.
- Requiring a nonempty data-value list before hoisting a static initializer fails on a
  private-method-only class.
- Clearing rather than restoring `function_scope` after field hoisting makes the
  declaration-index fixture panic at `hoist_declare`'s `function_scope.unwrap()`.

No new source-triggered panic was found in these seven shapes.
That negative result does not close the wider finding: the coder bookkeeping audit and
reproducibility of the earlier generated-source run remain outstanding.
The finite traversal rosters also remain a regression floor, not a proof about all source text.
