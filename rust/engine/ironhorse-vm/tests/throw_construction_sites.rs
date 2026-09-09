//! Source locks on the private thrown-value protocol and its host boundary.
//! Match Rust tokens through the shared lexer so comments, literals, spacing,
//! and aliases cannot hide an additional throw construction.

use ironhorse_vm::source_scan::{
    code_only, matching_delimiter, rs_files, token_body, token_positions, tokens, Token,
};

const SRC: &str = include_str!("../src/interp.rs");

/// Match both `Halt::member` and `<crate::Halt>::member`. Qualified
/// inherent-method paths are stable Rust and must not bypass the allowlist.
/// Keep the end separately: the closing `>` changes the path's token width.
fn associated_paths(code: &[Token<'_>], path: &str) -> Vec<(usize, usize)> {
    let (owner, member) = path.split_once("::").expect("associated path");
    token_positions(code, member)
        .into_iter()
        .filter_map(|member_at| {
            if member_at < 3 || code[member_at - 1].text != ":" || code[member_at - 2].text != ":" {
                return None;
            }
            let mut owner_at = member_at - 3;
            if code[owner_at].text == ">" {
                owner_at = owner_at.checked_sub(1)?;
            }
            (code[owner_at].text == owner).then_some((owner_at, member_at + 1))
        })
        .collect()
}

/// Patterns use a trailing `..`; constructions must supply every field.
/// A rest-less pattern is deliberately rejected too: the source lock requires
/// a spelling that keeps construction and matching distinguishable.
fn throw_constructions(code: &[Token<'_>], variant: &str) -> Vec<usize> {
    associated_paths(code, variant)
        .into_iter()
        .filter(|&(_, open)| {
            assert_eq!(code[open].text, "{", "throw variants must use braces");
            let close = matching_delimiter(code, open);
            !(code[close - 1].text == "." && code[close - 2].text == ".")
        })
        .map(|(at, _)| at)
        .collect()
}

/// Aliasing the protocol or importing its variants would hide constructions
/// from a qualified-path scan. Keep all such spellings out of engine code.
fn protocol_aliases(code: &[Token<'_>]) -> Vec<usize> {
    let mut bad = Vec::new();
    for keyword in ["use", "type"] {
        for at in token_positions(code, keyword) {
            let end = code[at..]
                .iter()
                .position(|t| t.text == ";")
                .map_or(code.len(), |n| at + n);
            if code[at + 1..end]
                .iter()
                .any(|t| matches!(t.text, "Halt" | "Step"))
            {
                bad.push(at);
            }
        }
    }
    bad
}

#[test]
fn halt_throw_carries_the_thrown_value() {
    let source = code_only(SRC);
    let code = tokens(&source);
    let halt = &code[token_body(&code, "pub enum Halt")];
    assert_eq!(
        token_positions(halt, "Throw { value: Slot, rendered: String }").len(),
        1
    );
    let step = &code[token_body(&code, "enum Step")];
    assert_eq!(token_positions(step, "Threw { value: Slot, }").len(), 1);
}

#[test]
fn halt_throw_is_constructed_only_where_the_jump_chain_was_unwound() {
    let source = code_only(SRC);
    let code = tokens(&source);
    let production = production_tokens(&code);
    let engine = production.as_slice();
    assert!(
        protocol_aliases(engine).is_empty(),
        "do not alias Halt/Step or import their variants"
    );
    // Separate the private throw path from public host construction: changing
    // an allowed Step::Threw site into Step::Host(Halt::Throw) must also fail.
    for (variant, allowed) in [
        ("Step::Threw", vec![("fn raise_js(", 1)]),
        (
            "Halt::Throw",
            vec![("fn finish_step(", 1), ("pub fn synthetic_throw(", 1)],
        ),
        ("Self::Throw", vec![]),
        ("Self::Threw", vec![]),
    ] {
        let sites = throw_constructions(engine, variant);
        let mut accepted = Vec::new();
        for (marker, expected) in allowed {
            let body = token_body(engine, marker);
            let local: Vec<_> = sites
                .iter()
                .copied()
                .filter(|at| body.contains(at))
                .collect();
            assert_eq!(
                local.len(),
                expected,
                "{marker}: unexpected {variant} construction count"
            );
            accepted.extend(local);
        }
        for at in sites {
            assert!(
                accepted.contains(&at),
                "{variant} constructed outside its boundary at line {}",
                source[..engine[at].start].matches('\n').count() + 1
            );
        }
    }
    let synthetic = token_positions(engine, "Halt::synthetic_throw(");
    let host_coerced = token_body(engine, "pub fn host_coerced(");
    assert_eq!(
        synthetic.len(),
        1,
        "only the harness's host_coerced verb may synthesize a throw"
    );
    assert!(host_coerced.contains(&synthetic[0]));
}

#[test]
fn construction_scan_sees_comments_whitespace_and_code_after_literals() {
    for source in [
        "Step::Threw { value }",
        "Step :: Threw /* bypass */ { value }",
        "Step\n::\nThrew\n{ value }",
        "let url = \"https://example/\"; Step::Threw { value }",
        "let message = \"} Step::Threw {\"; Step::Threw { value }",
    ] {
        let source = code_only(source);
        assert_eq!(
            throw_constructions(&tokens(&source), "Step::Threw").len(),
            1,
            "{source}"
        );
    }
    let source =
        code_only("impl Step { fn bypass(value: Slot) -> Self { Self::Threw { value } } }");
    assert_eq!(
        throw_constructions(&tokens(&source), "Self::Threw").len(),
        1
    );
    let source =
        code_only("/* Step::Threw { value } */ match s { Step::Threw { value, .. } => value }");
    assert!(throw_constructions(&tokens(&source), "Step::Threw").is_empty());
}

#[test]
fn construction_scan_rejects_aliases_and_imported_variants() {
    for source in [
        "use Step::Threw;",
        "use Step /* bypass */ :: { Threw };",
        "use self::{Step as Control};",
        "use Halt::*;",
        "type Control = Step;",
        "type Outcome = crate::Halt;",
    ] {
        let source = code_only(source);
        assert_eq!(protocol_aliases(&tokens(&source)).len(), 1, "{source}");
    }
}

/// Exclude complete test modules, functions, and blocks, never production after them.
/// Any new shape of cfg(test) item needs an explicit scanner update.
fn production_tokens<'s>(code: &[Token<'s>]) -> Vec<Token<'s>> {
    // A test-only external module carries its own crate-level cfg so the
    // recursive file scan can recognize the same boundary as rustc.
    if token_positions(code, "#![cfg(test)]").first() == Some(&0) {
        return Vec::new();
    }
    let mut excluded = vec![false; code.len()];
    for at in token_positions(code, "#[cfg(test)]") {
        let mut item = at + tokens("#[cfg(test)]").len();
        if code[item].text == "pub" {
            item += 1;
            if code[item].text == "(" {
                item = matching_delimiter(code, item) + 1;
            }
        }
        assert!(
            matches!(code[item].text, "mod" | "fn" | "{"),
            "unrecognized cfg(test) item"
        );
        if code[item].text == "mod" && code.get(item + 2).is_some_and(|t| t.text == ";") {
            excluded[at..=item + 2].fill(true);
            continue;
        }
        let open = item
            + code[item..]
                .iter()
                .position(|token| token.text == "{")
                .unwrap();
        let close = matching_delimiter(code, open);
        excluded[at..=close].fill(true);
    }
    code.iter()
        .zip(excluded)
        .filter_map(|(token, excluded)| (!excluded).then_some(*token))
        .collect()
}

fn consumer_protocol_aliases(code: &[Token<'_>]) -> Vec<usize> {
    let mut bad = Vec::new();
    for keyword in ["use", "type"] {
        for at in token_positions(code, keyword) {
            let end = code[at..]
                .iter()
                .position(|t| t.text == ";")
                .map_or(code.len(), |n| at + n);
            let statement = &code[at + 1..end];
            // Plain imports/re-exports of Halt are necessary in consumers.
            // Renaming it or importing variants/constructors would hide uses.
            if statement.iter().enumerate().any(|(i, t)| {
                matches!(t.text, "Throw" | "Threw" | "synthetic_throw")
                    || (matches!(t.text, "Halt" | "Step")
                        && (keyword == "type"
                            || statement
                                .get(i + 1)
                                .is_some_and(|next| matches!(next.text, "as" | ":"))))
            }) {
                bad.push(at);
            }
        }
    }
    bad
}

/// A per-file/function/count allowlist: moving a permitted construction into
/// another module or adding a second construction inside that function fails.
fn cross_file_violations(path: &str, source: &str) -> Vec<String> {
    let source = code_only(source);
    let all = tokens(&source);
    let code = production_tokens(&all);
    let mut bad = Vec::new();
    // Native catches use the carried throw value. Permit the renderer save
    // and opcode reads only in their current owning module; all child modules
    // are covered by this same recursive lock.
    let accepted: Vec<_> = if path == "ironhorse-vm/src/interp.rs" {
        [
            "let saved_exception = self.exception;",
            "let ex = self.exception;",
            "let v = self.exception;",
            "let current = self.exception;",
        ]
        .iter()
        .flat_map(|pattern| token_positions(&code, pattern).into_iter().map(|at| at + 3))
        .collect()
    } else {
        Vec::new()
    };
    for receiver in ["self", "machine"] {
        for at in token_positions(&code, &format!("{receiver}.exception")) {
            let suffix = &code[at + 3..];
            let assignment = suffix.first().is_some_and(|token| token.text == "=")
                && !suffix.get(1).is_some_and(|token| token.text == "=");
            if !assignment && !accepted.contains(&at) {
                bad.push(format!(
                    "{path}: exception-register read at byte {}",
                    code[at].start
                ));
            }
        }
    }
    for at in consumer_protocol_aliases(&code) {
        bad.push(format!("{path}: protocol alias at byte {}", code[at].start));
    }
    for variant in [
        "Step::Threw",
        "Halt::Throw",
        "Self::Throw",
        "Self::Threw",
        "Halt::synthetic_throw",
        "Self::synthetic_throw",
    ] {
        let sites = if variant.ends_with("synthetic_throw") {
            associated_paths(&code, variant)
                .into_iter()
                .map(|(at, _)| at)
                .collect()
        } else {
            throw_constructions(&code, variant)
        };
        let allowed: &[(&str, usize)] = match (path, variant) {
            ("ironhorse-vm/src/interp.rs", "Step::Threw") => &[("fn raise_js(", 1)],
            ("ironhorse-vm/src/interp.rs", "Halt::Throw") => {
                &[("fn finish_step(", 1), ("pub fn synthetic_throw(", 1)]
            }
            ("ironhorse-vm/src/interp.rs", "Halt::synthetic_throw") => {
                &[("pub fn host_coerced(", 1)]
            }
            ("ironhorse-262/src/lib.rs", "Halt::synthetic_throw") => {
                &[("pub fn dual_run_with(", 1), ("pub fn dual_run_cranks(", 1)]
            }
            _ => &[],
        };
        let mut accepted = Vec::new();
        for &(marker, count) in allowed {
            let body = token_body(&code, marker);
            let local: Vec<_> = sites
                .iter()
                .copied()
                .filter(|at| body.contains(at))
                .collect();
            if local.len() != count {
                bad.push(format!(
                    "{path}: {marker}: expected {count} {variant} sites, found {}",
                    local.len()
                ));
            }
            accepted.extend(local);
        }
        for at in sites {
            if !accepted.contains(&at) {
                let line = source[..code[at].start].matches('\n').count() + 1;
                bad.push(format!("{path}:{line}: unapproved {variant}"));
            }
        }
    }
    bad
}

#[test]
fn throw_boundaries_are_locked_across_vm_and_production_consumers() {
    let engine = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut bad = Vec::new();
    // Discover recursively so a newly added module or binary cannot bypass
    // the lock by being absent from a manually maintained file list.
    for package in ["ironhorse-vm", "ironhorse-262", "ironhorse-fuzz"] {
        for file in rs_files(&engine.join(package).join("src")) {
            let path = file.strip_prefix(engine).unwrap().to_str().unwrap();
            let source = std::fs::read_to_string(&file).unwrap();
            bad.extend(cross_file_violations(path, &source));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn second_module_mutations_cannot_create_or_synthesize_throws() {
    let path = "ironhorse-vm/src/compartment.rs";
    let original = include_str!("../src/compartment.rs");
    assert!(cross_file_violations(path, original).is_empty());
    for injected in [
        "fn bypass(value: Slot) { Halt::Throw { value, rendered: String::new() }; }",
        "fn bypass(value: Slot) { Step::Threw { value }; }",
        "fn bypass(value: Slot) { Halt::r#Throw { value, rendered: String::new() }; }",
        "fn bypass() { Halt::r#synthetic_throw(\"bad\"); }",
        "fn bypass() { <crate::Halt>::synthetic_throw(\"bad\"); }",
        "fn bypass() { <Halt>::r#synthetic_throw(\"bad\"); }",
        "impl Halt { fn bypass() { <Self>::synthetic_throw(\"bad\"); } }",
        "fn bypass(value: Slot) { <Halt>::Throw { value, rendered: String::new() }; }",
        "impl Step { fn bypass(value: Slot) { <Self>::Threw { value }; } }",
        "fn bypass() { Halt::synthetic_throw(\"bad\"); }",
        "fn bypass() { let synth = Halt::synthetic_throw; synth(\"bad\"); }",
        "use crate::Halt as Outcome;",
        "use crate::Halt::{Throw};",
        "type Outcome = crate::Halt;",
    ] {
        // This sits AFTER compartment's cfg(test) module, exercising the old
        // truncate-at-first-test shortcut as well as the second-file gap.
        let mutated = format!("{original}\n{injected}");
        assert!(
            !cross_file_violations(path, &mutated).is_empty(),
            "{injected}"
        );
    }
    let tests_only = "#[cfg(test)] mod tests { fn example() { Halt::synthetic_throw(\"test\"); } }";
    assert!(cross_file_violations("ironhorse-fuzz/src/new.rs", tests_only).is_empty());
    assert!(!cross_file_violations(
        "ironhorse-fuzz/src/new.rs",
        &format!("{tests_only} fn bad() {{ Halt::synthetic_throw(\"bad\"); }}")
    )
    .is_empty());
}

#[test]
fn inline_test_blocks_do_not_hide_later_production_throws() {
    let source = code_only("fn run() { #[cfg(test)] { if enabled() { probe(); } } } fn raise_js() { Step::Threw { value } }");
    let production = production_tokens(&tokens(&source));
    assert_eq!(throw_constructions(&production, "Step::Threw").len(), 1);
    assert_eq!(token_positions(&production, "probe()").len(), 0);
    assert_eq!(token_positions(&production, "fn raise_js(").len(), 1);
    assert!(!cross_file_violations(
        "ironhorse-fuzz/src/new.rs",
        "fn run() { #[cfg(test)] { probe(); } Halt::synthetic_throw(\"bad\"); }"
    )
    .is_empty());
}

#[test]
fn external_test_modules_do_not_hide_following_production() {
    let file = "ironhorse-vm/src/example.rs";
    assert!(cross_file_violations(
        file,
        "#![cfg(test)] fn example() { Halt::synthetic_throw(\"test\"); }"
    )
    .is_empty());
    assert!(!cross_file_violations(
        file,
        "#[cfg(test)] mod tests; fn bad() { Halt::synthetic_throw(\"bad\"); }"
    )
    .is_empty());
    assert!(!cross_file_violations(
        file,
        "fn bad() { Halt::synthetic_throw(\"bad\"); } #[cfg(test)] mod tests;"
    )
    .is_empty());
}

#[test]
fn moved_async_catches_cannot_read_the_exception_register() {
    let path = "ironhorse-vm/src/interp/suspend.rs";
    let original = include_str!("../src/interp/suspend.rs");
    assert!(cross_file_violations(path, original).is_empty());
    let arm = "Step::Threw { value: reason, .. } => {";
    assert_eq!(original.matches(arm).count(), 2);
    for receiver in ["self", "machine"] {
        let mutated = original.replace(arm, &format!("{arm} let reason = {receiver}.exception;"));
        let bad = cross_file_violations(path, &mutated);
        assert_eq!(bad.len(), 2, "both async catches must be checked: {bad:?}");
        assert!(bad
            .iter()
            .all(|message| message.contains("exception-register read")));
    }
}
