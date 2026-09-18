//! A `prototype` FIELD is only an early error when it is static (F063).
//!
//! `ClassElement : static FieldDefinition ;` is the production ECMA-262
//! §15.7.1 hangs the early error on — "It is a Syntax Error if PropName of
//! FieldDefinition is either `prototype` or `constructor`". The non-static
//! `FieldDefinition` production forbids `constructor` alone, so
//! `class C { prototype = 1; }` is ordinary valid source.
//!
//! `fxClassExpression` (`xsSyntaxical.c:2733`) tests the symbol without
//! consulting its own `aStaticFlag`, one line after the `#constructor` and
//! `constructor` tests that are correctly unconditional. The port had carried
//! that over verbatim, so both engines refused a valid class body. Rejecting
//! the static case keeps working from the same site, now gated.
//!
//! This is a deliberate divergence from the pinned oracle in the direction of
//! the spec, the same direction as `for (let x, y in {})` and the Annex B
//! `for-in` head initializer already on this branch. XS was measured refusing
//! every accepted cell below that names `prototype` outside a computed or
//! private key.
//!
//! **Why neither existing gate found it.** There is no test262 fixture for a
//! non-static `prototype` field at the pinned revision — the four
//! `*propname-prototype*` files are all static — so the corpus sweep had
//! nothing to sweep, and the whole-corpus differential over all 53,575 sources
//! in three goals reported 0 of 160,854 outcomes changed by the fix. It is
//! valid source that no corpus contains, which is the gap a generated matrix
//! exists to cover and the reason this file is checked in beside it.
//!
//! Every verdict below was taken from Node 22 first and then asserted here.

use ironhorse_compile::{compile_atoms_goal, Goal};

/// The five goal/strictness modes a class body can reach the compiler through.
/// Nothing in this roster is goal-sensitive, which is the point: a class early
/// error that fires in one goal and not another would show up here.
const MODES: &[(Goal, bool)] = &[
    (Goal::Script, false),
    (Goal::Script, true),
    (Goal::Module, false),
    (Goal::Eval, false),
    (Goal::Eval, true),
];

/// Valid source. Everything that is not `static` plus the keys the early error
/// does not reach: computed and private, which have no `PropName` of
/// `"prototype"` to test.
const ACCEPTED: &[&str] = &[
    // The shape the port refused. With an initializer, without one, and with
    // the semicolon supplied by ASI.
    "class C { prototype = 1; }",
    "class C { prototype; }",
    "class C { prototype = 1 }",
    "(class { prototype = 1; });",
    "class C extends Object { prototype = 1; }",
    // A string-literal key has PropName "prototype" too, and is equally fine
    // when not static.
    "class C { 'prototype' = 1; }",
    // Methods and accessors named `prototype` were never refused when
    // non-static; they are controls for the gate, not new behaviour.
    "class C { prototype(){} }",
    "class C { get prototype(){} }",
    "class C { set prototype(v){} }",
    "class C { *prototype(){} }",
    "class C { async prototype(){} }",
    // A private name is its own namespace: `#prototype` is not `prototype`,
    // static or not.
    "class C { #prototype = 1; }",
    "class C { static #prototype = 1; }",
    // A computed key has no static PropName, so the early error cannot apply
    // even though the runtime name is the same string.
    "class C { [\"prototype\"] = 1; }",
    "class C { static [\"prototype\"] = 1; }",
    // Two fields of the same name are not an error the way two private names
    // would be.
    "class C { prototype = 1; prototype = 2; }",
    // A numeric key, static or not, to show the gate did not open the field
    // branch generally.
    "class C { 0 = 1; }",
    "class C { static 0 = 1; }",
    // `static constructor(){}` is a METHOD named constructor, which is legal;
    // only the field form is refused. The control for the neighbouring test.
    "class C { static constructor(){} }",
];

/// Still refused, and the reason this is a gate rather than a deletion.
const REFUSED: &[&str] = &[
    "class C { static prototype = 1; }",
    "class C { static prototype; }",
    "class C { static 'prototype' = 1; }",
    // The static METHOD form, refused from its own site a few lines earlier.
    "class C { static prototype(){} }",
    "class C { static get prototype(){} }",
    "class C { static *prototype(){} }",
    "class C { static async prototype(){} }",
    // A valid field and an invalid static method in one body: the second must
    // still be refused, so the gate cannot be read as "stop checking once a
    // `prototype` field parsed".
    "class C { prototype = 1; static prototype(){} }",
    // `constructor` stays unconditional, which is what the spec says.
    "class C { constructor = 1; }",
    "class C { static constructor = 1; }",
];

#[test]
fn a_non_static_prototype_field_compiles_in_every_mode() {
    for source in ACCEPTED {
        for &(goal, strict) in MODES {
            compile_atoms_goal(source, goal, strict)
                .unwrap_or_else(|error| panic!("{goal:?}, strict={strict}: {source}: {error:?}"));
        }
    }
}

#[test]
fn a_static_prototype_field_is_still_a_syntax_error_in_every_mode() {
    let mut failures = Vec::new();
    for source in REFUSED {
        for &(goal, strict) in MODES {
            if let Ok(_) = compile_atoms_goal(source, goal, strict) {
                failures.push(format!("{source:?} ({goal:?}, strict={strict}) compiled"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
