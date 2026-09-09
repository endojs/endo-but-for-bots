//! Source locks for F001/F006: every native raise uses the shared dispatch
//! macros, and only the owning activation consumes an unwind. The shared lexer
//! makes the checks independent of variable names, spacing, and comments.

use ironhorse_vm::source_scan::{code_only, token_body, token_positions, tokens, Token};

const SRC: &str = concat!(
    include_str!("../src/interp.rs"),
    "\n",
    include_str!("../src/interp/dispatch.rs")
);

fn unwrapped_raises(code: &[Token<'_>]) -> Vec<usize> {
    code.iter()
        .enumerate()
        .filter_map(|(at, token)| {
            if (token.text == "raise_js" || token.text.starts_with("catchable_"))
                && code.get(at + 1).is_some_and(|t| t.text == "(")
            {
                // `dispatch_halt!(receiver.raise(...), ...)`: whitespace and
                // comments are absent, but identifier boundaries remain intact.
                let wrapped = at >= 5
                    && code[at - 5].text == "dispatch_halt"
                    && code[at - 4].text == "!"
                    && code[at - 3].text == "("
                    && code[at - 1].text == ".";
                (!wrapped).then_some(at)
            } else {
                None
            }
        })
        .collect()
}

/// All deliberate loop exits construct their private Step explicitly. A raw
/// `return transfer` can silently bypass unwind ownership regardless of the
/// identifier chosen for the native helper's error.
fn raw_returns(code: &[Token<'_>]) -> Vec<usize> {
    token_positions(code, "return")
        .into_iter()
        .filter(|at| {
            ![
                "Step::Returned",
                "Step::Host(",
                "Step::Yielded(",
                "Step::Awaited(",
                "Step::AsyncYielded(",
            ]
            .iter()
            .any(|variant| token_positions(&code[at + 1..], variant).first() == Some(&0))
        })
        .collect()
}

fn unguarded_unwinds(code: &[Token<'_>]) -> Vec<usize> {
    let guard = "if self.call_stack.len() < return_depth {";
    let guard_len = tokens(guard).len();
    token_positions(code, "return Step::Unwound(")
        .into_iter()
        .filter(|&at| {
            at < guard_len || token_positions(&code[at - guard_len..at], guard).is_empty()
        })
        .collect()
}

fn macro_ownership_and_metering(code: &[Token<'_>]) -> bool {
    [
        "Step::Unwound(target) if $machine.call_stack.len() < $return_depth || !$machine.resume_target_belongs_to(target, $code) => { return Step::Unwound(target); }",
        "Step::Unwound(target) => { $machine.assert_resume_target(target, $code); $program_counter = target.pc; if $machine.check_meter() == MeterCheck::Abort { return Step::Host(Halt::MeterAbort); } continue; }",
    ].iter().all(|pattern| token_positions(code, pattern).len() == 1)
}

#[test]
fn raise_js_yields_a_private_step() {
    let source = code_only(SRC);
    let code = tokens(&source);
    assert_eq!(
        token_positions(&code, "fn raise_js(&mut self, value: Slot) -> Step {").len(),
        1
    );
    assert!(token_positions(&code, "match self.raise_js(").is_empty());
}

#[test]
fn every_raise_in_the_dispatch_loop_goes_through_dispatch_halt() {
    let source = code_only(SRC);
    let code = tokens(&source);
    let body = &code[token_body(&code, "fn dispatch_at_inner(")];
    assert!(
        body.iter()
            .filter(|t| t.text.starts_with("catchable_") || t.text == "raise_js")
            .count()
            > 20
    );
    assert!(
        unwrapped_raises(body).is_empty(),
        "a raise bypasses the dispatch macro"
    );
}

#[test]
fn no_native_result_is_propagated_out_of_the_loop_by_hand() {
    let source = code_only(SRC);
    let code = tokens(&source);
    let body = &code[token_body(&code, "fn dispatch_at_inner(")];
    let bad = raw_returns(body);
    assert!(
        bad.is_empty(),
        "unclassified raw returns at lines {:?}",
        bad.iter()
            .map(|at| source[..body[*at].start].matches('\n').count() + 1)
            .collect::<Vec<_>>()
    );
    assert!(token_positions(body, "Err(Step::Unwound(").is_empty());
    // This tail loop returns Step: `break halt` is just as dangerous as
    // `return halt`, but bypasses a return-only source check. No dispatch
    // opcode needs a Rust break, so reject every spelling (including labels).
    assert!(
        token_positions(body, "break").is_empty(),
        "dispatch must not exit via break"
    );
}

#[test]
fn an_unwind_leaves_dispatch_only_after_the_depth_test() {
    let source = code_only(SRC);
    let code = tokens(&source);
    let body = &code[token_body(&code, "fn dispatch_at_inner(")];
    assert!(token_positions(body, "Step::Unwound(").is_empty());
    assert!(unguarded_unwinds(body).is_empty());
    let halt_macro = &code[token_body(&code, "macro_rules! dispatch_halt")];
    assert!(macro_ownership_and_metering(halt_macro));
    let result_macro = &code[token_body(&code, "macro_rules! dispatch_result")];
    assert_eq!(
        token_positions(
            result_macro,
            "Err(halt) => dispatch_halt!(halt, $program_counter, $machine, $return_depth, $code)"
        )
        .len(),
        1
    );
}

#[test]
fn control_scan_rejects_renamed_and_obscured_raw_returns() {
    for source in [
        "Err(transfer) => return transfer,",
        "Err(transfer) => { return /* explanation */ transfer; }",
        "let url = \"https://example\"; return transfer;",
        "return\ntransfer;",
        "let Step = transfer; return Step;",
    ] {
        let source = code_only(source);
        assert_eq!(raw_returns(&tokens(&source)).len(), 1, "{source}");
    }
    for source in [
        "Err(transfer) => break transfer,",
        "break /* comment */ transfer;",
        "break 'dispatch transfer;",
    ] {
        let source = code_only(source);
        assert_eq!(
            token_positions(&tokens(&source), "break").len(),
            1,
            "{source}"
        );
    }
    for source in [
        "return self.catchable_type_error();",
        "match self /* comment */ . raise_js(value) { transfer => return transfer }",
    ] {
        let source = code_only(source);
        assert_eq!(unwrapped_raises(&tokens(&source)).len(), 1, "{source}");
    }
    let mutated = SRC.replacen(
        "Err(halt) => dispatch_halt!(halt, pc, self, return_depth, code),",
        "Err(halt) => break halt,",
        1,
    );
    assert_ne!(
        mutated, SRC,
        "mutation must replace a live propagation site"
    );
    let mutated = code_only(&mutated);
    let code = tokens(&mutated);
    let body = &code[token_body(&code, "fn dispatch_at_inner(")];
    assert_eq!(token_positions(body, "break").len(), 1);
    let source = code_only(
        "dispatch_halt /* comment */ ! (self . catchable_type_error(), pc, self, return_depth)",
    );
    assert!(unwrapped_raises(&tokens(&source)).is_empty());
}

#[test]
fn control_scan_rejects_missing_depth_and_meter_guards() {
    let source = code_only(SRC);
    let code = tokens(&source);
    let body = &code[token_body(&code, "macro_rules! dispatch_halt")];
    let macro_source = &source[body[0].start..body.last().unwrap().start + 1];
    for (before, after) in [
        ("if $machine.call_stack.len() < $return_depth", ""),
        ("$machine.check_meter()", "MeterCheck::Continue"),
        ("$machine.assert_resume_target(target, $code);", ""),
        ("|| !$machine.resume_target_belongs_to(target, $code)", ""),
    ] {
        assert!(macro_source.contains(before));
        let mutated = macro_source.replace(before, after);
        assert!(!macro_ownership_and_metering(&tokens(&mutated)), "{before}");
    }
    let source = code_only("if unrelated { return Step /* comment */ :: Unwound(target); }");
    assert_eq!(unguarded_unwinds(&tokens(&source)).len(), 1);
}
