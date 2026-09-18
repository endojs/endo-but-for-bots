//! A template substitution must contain an expression (finding F063).
//!
//! `code_tagged_template` sizes the cooked and raw arrays it is about to fill
//! from `items.len()`, which is only the number of `TemplateMiddle` nodes if
//! the items strictly alternate `TemplateMiddle`, expression, `TemplateMiddle`,
//! … — the `code_catch` shape again, a consumer resting on a roster the
//! producer is assumed to hold.
//!
//! The producer did not hold it. `fxTemplateExpression` skips `fxCommaExpression`
//! when the token after `${` is `}`, and `template_expression` ported the skip
//! verbatim, so `` `a${}b` `` parsed to two ADJACENT `TemplateMiddle` nodes.
//! `TemplateSubstitutionTail` requires an `Expression`, so every such source is
//! a spec early error that both engines accepted; rejecting it is a deliberate
//! divergence from the pinned oracle's parser, in the direction of the spec,
//! and the same direction as the `for (let x, y in {})` rejection already on
//! this branch.
//!
//! The consequence was not a panic, which is why the test262 sweep over 53,575
//! sources did not find it and why a source audit had to: `language/expressions/
//! template-literal` has no empty-substitution fixture at the pinned revision.
//! It was a wrong premise. `` tag`a${}b${}c` `` produced three `TemplateMiddle`
//! items, `string_count` computed two, and `strings.length` was set to 2 before
//! three indices were written — correct only because writing index 2 of an
//! array extends it. The arithmetic was wrong and the array rescued it.
//!
//! Both halves are closed here: the parser rejects the empty substitution, and
//! the coder counts the items it is about to write instead of deriving the
//! count from the alternation.

use ironhorse_compile::{compile_atoms_goal, Goal, ParseErrorKind};

/// The five goal/strictness modes a template can reach the compiler through.
///
/// The parameter-list early error this finding already moved to the parser was
/// one-goal-wide when it was written coder-side, so a single-goal roster is how
/// this class of defect hides.
const MODES: &[(Goal, bool)] = &[
    (Goal::Script, false),
    (Goal::Script, true),
    (Goal::Module, false),
    (Goal::Eval, false),
    (Goal::Eval, true),
];

/// Every position an empty substitution can take, in every mode.
///
/// A panic would fail here too — `catch_unwind` reports it as such rather than
/// as a rejection — but the claim is stronger than totality: these are refused.
#[test]
fn an_empty_substitution_is_a_syntax_error_in_every_mode() {
    let mut failures = Vec::new();
    for source in [
        // The whole literal is one empty substitution.
        "`${}`;",
        "tag`${}`;",
        // Surrounded by cooked text, which is where the adjacent
        // `TemplateMiddle` pair is observable.
        "`a${}b`;",
        "tag`a${}b`;",
        // Several, so `string_count` and the written index count disagree by
        // more than one.
        "`${}${}`;",
        "tag`${}${}`;",
        "tag`a${}b${}c`;",
        "tag`a${}b${}c${}d`;",
        // Mixed with substitutions that do carry an expression, in both
        // orders: the empty one must not be excused by its neighbour.
        "`${}${1}`;",
        "`${1}${}`;",
        "tag`${}${1}`;",
        "tag`${1}${}`;",
        "`a${1}b${}c${2}d`;",
        // Whitespace and comments are not expressions.
        "`${ }`;",
        "`${\n}`;",
        "`${/*c*/}`;",
        "tag`${//c\n}`;",
        // Nested one level down, reached through an outer substitution that is
        // itself well formed.
        "`${`${}`}`;",
        "tag`${tag`${}`}`;",
        "`${(() => `${}`)()}`;",
        // In the positions where a template is easy to reach by a different
        // parser path: a member tag, a computed key, a parameter default and a
        // class field initializer. A template in an OPTIONAL chain is left out
        // of both rosters — `obj?.tag`...`` is its own spec early error, so it
        // would be refused here whatever the substitution held.
        "obj.tag`${}`;",
        "({ [`${}`]: 1 });",
        "function f(a = `${}`) {}",
        "class C { p = `${}`; }",
        "class C { static { `${}`; } }",
    ] {
        for &(goal, strict) in MODES {
            let owned = source.to_string();
            let result = std::panic::catch_unwind(move || compile_atoms_goal(&owned, goal, strict));
            if !matches!(result, Ok(Err(ref error)) if error.kind == ParseErrorKind::Syntax) {
                failures.push(format!(
                    "{source:?} ({goal:?}, strict={strict}): {result:?}"
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The controls, without which the test above passes by rejecting templates
/// wholesale.
///
/// Every substitution form that IS an expression, including the ones whose
/// first token is a `{`, `}` or a newline and which therefore sit closest to
/// the rejected shape.
#[test]
fn a_substitution_that_carries_an_expression_still_compiles_in_every_mode() {
    for source in [
        "`${1}`;",
        "tag`${1}`;",
        "`a${1}b${2}c`;",
        "tag`a${1}b${2}c`;",
        // No substitution at all: the loop the rejection lives in never runs.
        "``;",
        "tag``;",
        "`a`;",
        "tag`a`;",
        // An object literal, whose own `}` closes before the substitution's.
        "`${{}}`;",
        "`${ {a:1} }`;",
        "`${{a:{b:2}}}`;",
        // A comma expression, which is what the skipped call parses.
        "`${(1,2)}`;",
        // Bodies that contain `}` tokens of their own.
        "`${function(){}}`;",
        "`${(() => {})()}`;",
        "`${class{}}`;",
        "`${(function(){ return {}; })()}`;",
        // Whitespace and comments AROUND an expression are still fine.
        "`${ 1 }`;",
        "`${\n1\n}`;",
        "`${/*c*/1/*c*/}`;",
        // Nested templates, the shape the rejection recurses through.
        "`${`${1}`}`;",
        "tag`${tag`${1}`}`;",
        // The same parser paths the invalid roster reaches the compiler by.
        "obj.tag`${1}`;",
        "({ [`${1}`]: 1 });",
        "function f(a = `${1}`) {}",
        "class C { p = `${1}`; }",
    ] {
        for &(goal, strict) in MODES {
            compile_atoms_goal(source, goal, strict)
                .unwrap_or_else(|error| panic!("{goal:?}, strict={strict}: {source}: {error:?}"));
        }
    }
}
