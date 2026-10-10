//! Source locks for F001/F006: every native raise uses the shared dispatch
//! macros, and only the owning activation consumes an unwind. The shared lexer
//! makes the checks independent of variable names, spacing, and comments.

use ironhorse_vm::source_scan::{code_only, token_body, token_positions, tokens, Token};

const SRC: &str = concat!(
    include_str!("../src/interp.rs"),
    include_str!("../src/interp/metering.rs"),
    include_str!("../src/interp/native_ids.rs"),
    include_str!("../src/interp/snapshot_rows.rs"),
    include_str!("../src/interp/intl_data.rs"),
    include_str!("../src/interp/admission.rs"),
    include_str!("../src/interp/apply.rs"),
    include_str!("../src/interp/code.rs"),
    include_str!("../src/interp/coerce.rs"),
    include_str!("../src/interp/enumerate.rs"),
    include_str!("../src/interp/environment.rs"),
    include_str!("../src/interp/errors.rs"),
    include_str!("../src/interp/eval.rs"),
    include_str!("../src/interp/frames.rs"),
    include_str!("../src/interp/function.rs"),
    include_str!("../src/interp/invoke.rs"),
    include_str!("../src/interp/iterable.rs"),
    include_str!("../src/interp/render.rs"),
    include_str!("../src/interp/strings.rs"),
    include_str!("../src/interp/unwind.rs"),
    "\n",
    include_str!("../src/interp/dispatch.rs"),
    include_str!("../src/interp/dispatch/property_read.rs"),
    include_str!("../src/interp/dispatch/private.rs"),
    include_str!("../src/interp/dispatch/super_property.rs"),
    include_str!("../src/interp/dispatch/operators.rs"),
    include_str!("../src/interp/dispatch/environment.rs"),
    include_str!("../src/interp/dispatch/iteration.rs"),
    include_str!("../src/interp/dispatch/property_write.rs")
);

fn unwrapped_raises(code: &[Token<'_>]) -> Vec<usize> {
    code.iter()
        .enumerate()
        .filter_map(|(at, token)| {
            if (token.text == "raise_js" || token.text.starts_with("catchable_"))
                && code.get(at + 1).is_some_and(|t| t.text == "(")
            {
                // `dispatch_halt!(receiver.raise(...), ...)`, or its `Flow`
                // twin in an outlined arm: whitespace and comments are
                // absent, but identifier boundaries remain intact.
                let wrapped = at >= 5
                    && matches!(code[at - 5].text, "dispatch_halt" | "dispatch_halt_flow")
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

/// An outlined arm's returns: each continues at an explicit program counter
/// or leaves with an explicitly constructed private Step, as the loop's exits
/// do.
fn raw_flow_returns(code: &[Token<'_>]) -> Vec<usize> {
    token_positions(code, "return")
        .into_iter()
        .filter(|at| {
            ![
                "Flow::Next(",
                "Flow::Exit(Step::Returned",
                "Flow::Exit(Step::Host(",
                "Flow::Exit(Step::Yielded(",
                "Flow::Exit(Step::Awaited(",
                "Flow::Exit(Step::AsyncYielded(",
            ]
            .iter()
            .any(|variant| token_positions(&code[at + 1..], variant).first() == Some(&0))
        })
        .collect()
}

/// An outlined arm's exits, returned or in tail position: each leaves with
/// an explicitly constructed private Step.
fn raw_flow_exits(code: &[Token<'_>]) -> Vec<usize> {
    token_positions(code, "Flow::Exit(")
        .into_iter()
        .filter(|at| {
            ![
                "Flow::Exit(Step::Returned",
                "Flow::Exit(Step::Host(",
                "Flow::Exit(Step::Yielded(",
                "Flow::Exit(Step::Awaited(",
                "Flow::Exit(Step::AsyncYielded(",
            ]
            .iter()
            .any(|variant| token_positions(&code[*at..], variant).first() == Some(&0))
        })
        .collect()
}

/// The arms outlined from the dispatch loop: every `fn exec_*`.
fn outlined_arms<'t>(code: &'t [Token<'t>]) -> Vec<(&'t str, &'t [Token<'t>])> {
    token_positions(code, "fn")
        .into_iter()
        .map(|at| code[at + 1].text)
        .filter(|name| name.starts_with("exec_"))
        .map(|name| (name, &code[token_body(code, &format!("fn {name}("))]))
        .collect()
}

/// The loop and its outlined arms, which together are the dispatch: every
/// raise, exit and native-result propagation in either is locked below.
fn dispatch_tokens<'t>(code: &'t [Token<'t>]) -> Vec<Token<'t>> {
    let mut all = code[token_body(code, "fn dispatch_at_inner(")].to_vec();
    for (_, body) in outlined_arms(code) {
        all.extend_from_slice(body);
    }
    all
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

/// [`macro_ownership_and_metering`] for the outlined arms' `Flow` macro: the
/// same depth and ownership test before an unwind leaves, and the same meter
/// check at a catch landing before the loop continues there.
fn flow_ownership_and_metering(code: &[Token<'_>]) -> bool {
    [
        "Step::Unwound(target) if $machine.call_stack.len() < $return_depth || !$machine.resume_target_belongs_to(target, $code) => { return Flow::Exit(Step::Unwound(target)); }",
        "Step::Unwound(target) => { $machine.assert_resume_target(target, $code); if $machine.check_meter() == MeterCheck::Abort { return Flow::Exit(Step::Host(Halt::MeterAbort)); } return Flow::Next(target.pc); }",
    ].iter().all(|pattern| token_positions(code, pattern).len() == 1)
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
    let body = dispatch_tokens(&code);
    assert!(
        body.iter()
            .filter(|t| t.text.starts_with("catchable_") || t.text == "raise_js")
            .count()
            > 20
    );
    assert!(
        unwrapped_raises(&body).is_empty(),
        "a raise bypasses the dispatch macro"
    );
    // The loop's own exits use the loop macros, an outlined arm's their
    // `Flow` twins: either one in the wrong place would not compile into the
    // right control transfer, and this keeps the two rosters apart.
    let loop_body = &code[token_body(&code, "fn dispatch_at_inner(")];
    assert!(token_positions(loop_body, "dispatch_halt_flow").is_empty());
    assert!(token_positions(loop_body, "dispatch_result_flow").is_empty());
    for (name, arm) in outlined_arms(&code) {
        assert!(
            token_positions(arm, "dispatch_halt!").is_empty()
                && token_positions(arm, "dispatch_result!").is_empty(),
            "{name} must use the Flow macros"
        );
    }
}

/// Every outlined arm is entered exactly once, by the loop, through
/// `dispatch_flow!`, and by nothing else; and every function that returns a
/// [`Flow`] is an outlined arm, so a handler cannot leave the scans below by
/// its name.
#[test]
fn every_outlined_arm_is_entered_once_from_the_loop() {
    let source = code_only(SRC);
    let code = tokens(&source);
    let loop_body = &code[token_body(&code, "fn dispatch_at_inner(")];
    let arms = outlined_arms(&code);
    assert!(arms.len() > 50);
    assert_eq!(token_positions(&code, "-> Flow").len(), arms.len());
    assert_eq!(token_positions(&code, "dispatch_flow!(").len(), arms.len());
    assert_eq!(
        token_positions(loop_body, "dispatch_flow!(").len(),
        arms.len()
    );
    for (name, _) in &arms {
        let call = format!("self.{name}(");
        assert_eq!(
            token_positions(&code, &call).len(),
            1,
            "{name} must have one call site"
        );
        assert_eq!(
            token_positions(loop_body, &format!("dispatch_flow!({call}")).len(),
            1,
            "{name} must be entered through dispatch_flow! in the loop"
        );
    }
}

#[test]
fn no_native_result_is_propagated_out_of_the_loop_by_hand() {
    let source = code_only(SRC);
    let code = tokens(&source);
    let line = |body: &[Token<'_>], at: &usize| source[..body[*at].start].matches('\n').count() + 1;
    let body = &code[token_body(&code, "fn dispatch_at_inner(")];
    let bad = raw_returns(body);
    assert!(
        bad.is_empty(),
        "unclassified raw returns at lines {:?}",
        bad.iter().map(|at| line(body, at)).collect::<Vec<_>>()
    );
    for (name, arm) in outlined_arms(&code) {
        let bad = raw_flow_returns(arm);
        assert!(
            bad.is_empty(),
            "{name}: unclassified raw returns at lines {:?}",
            bad.iter().map(|at| line(arm, at)).collect::<Vec<_>>()
        );
        let bad = raw_flow_exits(arm);
        assert!(
            bad.is_empty(),
            "{name}: unclassified exits at lines {:?}",
            bad.iter().map(|at| line(arm, at)).collect::<Vec<_>>()
        );
    }
    let all = dispatch_tokens(&code);
    assert!(token_positions(&all, "Err(Step::Unwound(").is_empty());
    // This tail loop returns Step: `break halt` is just as dangerous as
    // `return halt`, but bypasses a return-only source check. No dispatch
    // opcode needs a Rust break, so reject every spelling (including labels).
    assert!(
        token_positions(&all, "break").is_empty(),
        "dispatch must not exit via break"
    );
}

#[test]
fn an_unwind_leaves_dispatch_only_after_the_depth_test() {
    let source = code_only(SRC);
    let code = tokens(&source);
    let body = dispatch_tokens(&code);
    assert!(token_positions(&body, "Step::Unwound(").is_empty());
    assert!(unguarded_unwinds(&body).is_empty());
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
    let halt_flow = &code[token_body(&code, "macro_rules! dispatch_halt_flow")];
    assert!(flow_ownership_and_metering(halt_flow));
    let result_flow = &code[token_body(&code, "macro_rules! dispatch_result_flow")];
    assert_eq!(
        token_positions(
            result_flow,
            "Err(halt) => dispatch_halt_flow!(halt, $machine, $return_depth, $code)"
        )
        .len(),
        1
    );
    // The loop acts on an outlined arm's Flow in exactly one way.
    let flow = &code[token_body(&code, "macro_rules! dispatch_flow")];
    assert_eq!(
        token_positions(
            flow,
            "match $flow { Flow::Next(next) => $program_counter = next, Flow::Exit(step) => return step, }"
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
    // A live propagation site in an outlined arm, mutated into a `break`.
    let mutated = SRC.replacen(
        "Err(halt) => dispatch_halt_flow!(halt, self, return_depth, code),",
        "Err(halt) => break halt,",
        1,
    );
    assert_ne!(
        mutated, SRC,
        "mutation must replace a live propagation site"
    );
    let mutated = code_only(&mutated);
    let code = tokens(&mutated);
    assert_eq!(token_positions(&dispatch_tokens(&code), "break").len(), 1);
    let source = code_only(
        "dispatch_halt /* comment */ ! (self . catchable_type_error(), pc, self, return_depth)",
    );
    assert!(unwrapped_raises(&tokens(&source)).is_empty());
}

#[test]
fn control_scan_rejects_missing_depth_and_meter_guards() {
    let source_text = code_only(SRC);
    let code = tokens(&source_text);
    let body = &code[token_body(&code, "macro_rules! dispatch_halt")];
    let macro_source = &source_text[body[0].start..body.last().unwrap().start + 1];
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
    let body = &code[token_body(&code, "macro_rules! dispatch_halt_flow")];
    let macro_source = &source_text[body[0].start..body.last().unwrap().start + 1];
    for (before, after) in [
        ("if $machine.call_stack.len() < $return_depth", ""),
        ("$machine.check_meter()", "MeterCheck::Continue"),
        ("$machine.assert_resume_target(target, $code);", ""),
        ("|| !$machine.resume_target_belongs_to(target, $code)", ""),
    ] {
        assert!(macro_source.contains(before));
        let mutated = macro_source.replace(before, after);
        assert!(!flow_ownership_and_metering(&tokens(&mutated)), "{before}");
    }
    for source in [
        "return Flow::Exit(transfer);",
        "return Flow::Exit(Step::Unwound(target));",
        "return transfer;",
    ] {
        let source = code_only(source);
        assert_eq!(raw_flow_returns(&tokens(&source)).len(), 1, "{source}");
    }
    for source in [
        "Err(transfer) => Flow::Exit(transfer),",
        "{ self.pop(); Flow::Exit(Step::Unwound(target)) }",
        "return Flow::Exit( /* comment */ transfer);",
    ] {
        let source = code_only(source);
        assert_eq!(raw_flow_exits(&tokens(&source)).len(), 1, "{source}");
    }
    assert!(raw_flow_exits(&tokens("Flow::Exit(Step::Returned)")).is_empty());
}

const HANDLERS: &[&str] = &[
    include_str!("../src/interp/dispatch/property_read.rs"),
    include_str!("../src/interp/dispatch/private.rs"),
    include_str!("../src/interp/dispatch/super_property.rs"),
    include_str!("../src/interp/dispatch/operators.rs"),
    include_str!("../src/interp/dispatch/environment.rs"),
    include_str!("../src/interp/dispatch/iteration.rs"),
    include_str!("../src/interp/dispatch/property_write.rs"),
];

// Discover declarations independently of call sites: a new handler cannot
// silently fall outside this lock merely because its name changed.
fn handler_names(source: &str) -> Vec<String> {
    let source = code_only(source);
    let code = tokens(&source);
    token_positions(&code, "fn")
        .into_iter()
        .map(|at| code[at + 1].text.to_owned())
        .collect()
}

fn handler_call_is_wrapped(code: &[Token<'_>], name: &str) -> bool {
    let sites = token_positions(code, &format!("self.{name}("));
    sites.len() == 1
        && sites.iter().all(|&at| {
            if at < 3
                || !matches!(
                    code[at - 3].text,
                    "dispatch_result" | "dispatch_result_flow"
                )
                || code[at - 2].text != "!"
                || code[at - 1].text != "("
            {
                return false;
            }
            let mut depth = 0;
            for end in at + 3..code.len() {
                match code[end].text {
                    "(" => depth += 1,
                    ")" => {
                        depth -= 1;
                        if depth == 0 {
                            // The loop's macro takes the program counter it
                            // lands a catch at; the `Flow` twin returns it.
                            let tail = if code[at - 3].text == "dispatch_result" {
                                ", pc, self, return_depth, code)"
                            } else {
                                ", self, return_depth, code)"
                            };
                            return token_positions(&code[end + 1..], tail).first() == Some(&0);
                        }
                    }
                    _ => {}
                }
            }
            false
        })
}

fn handler_consumes_transfer(source: &str) -> bool {
    let source = code_only(source);
    let code = tokens(&source);
    [
        "Step::Unwound",
        "check_meter",
        "assert_resume_target",
        "resume_target_belongs_to",
        "dispatch_halt",
        "dispatch_result",
        "return_depth",
    ]
    .iter()
    .any(|pattern| !token_positions(&code, pattern).is_empty())
        || token_positions(&code, "return").iter().any(|&at| {
            !["Err(", "Ok("]
                .iter()
                .any(|pattern| token_positions(&code[at + 1..], pattern).first() == Some(&0))
        })
}

#[test]
fn extracted_handlers_leave_all_transfers_to_dispatch() {
    let source = code_only(SRC);
    let code = tokens(&source);
    let body = &dispatch_tokens(&code);
    for source in HANDLERS {
        assert!(!handler_consumes_transfer(source));
        let names = handler_names(source);
        assert!(!names.is_empty());
        for name in names {
            assert!(
                handler_call_is_wrapped(body, &name),
                "{name} must propagate through dispatch_result!"
            );
        }
    }
}

#[test]
fn handler_lock_rejects_discarded_errors_and_consumed_unwinds() {
    for source in [
        "self.dispatch_get_property(code, id);",
        "let _ = self.dispatch_get_property(code, id);",
        "return self.dispatch_get_property(code, id);",
        "dispatch_result!(self.dispatch_get_property(code, id), pc, self, 0, code);",
        "dispatch_result!(self.dispatch_get_property(code, id), other_pc, self, return_depth, code);",
        "dispatch_result!(self.dispatch_get_property(code, id), pc, other_machine, return_depth, code);",
        "dispatch_result!(self.dispatch_get_property(code, id), pc, self, return_depth, other_code);",
        "dispatch_result_flow!(self.dispatch_get_property(code, id), self, 0, code);",
        "dispatch_result_flow!(self.dispatch_get_property(code, id), other_machine, return_depth, code);",
        "dispatch_result_flow!(self.dispatch_get_property(code, id), self, return_depth, other_code);",
        "dispatch_result_flow!(self.dispatch_get_property(code, id), pc, self, return_depth, code);",
    ] {
        assert!(!handler_call_is_wrapped(
            &tokens(source),
            "dispatch_get_property"
        ));
    }
    assert!(handler_call_is_wrapped(
        &tokens(
            "dispatch_result!(self.dispatch_get_property(code, id), pc, self, return_depth, code);"
        ),
        "dispatch_get_property"
    ));
    assert!(handler_call_is_wrapped(
        &tokens(
            "dispatch_result_flow!(self.dispatch_get_property(code, id), self, return_depth, code);"
        ),
        "dispatch_get_property"
    ));
    for source in [
        "if let Err(Step::Unwound(target)) = result { return Ok(()); }",
        "self.check_meter();",
        "return halt;",
        "self.assert_resume_target(target, code);",
    ] {
        assert!(handler_consumes_transfer(source), "{source}");
    }
    for source in HANDLERS {
        let mutated = format!("{source}\nfn bad() {{ match result {{ Err(Step::Unwound(t)) => Ok(()), other => other }} }}");
        assert!(handler_consumes_transfer(&mutated));
    }
}

#[test]
fn source_roster_covers_every_dispatch_child() {
    let mut directories =
        vec![std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/interp/dispatch")];
    while let Some(directory) = directories.pop() {
        for entry in std::fs::read_dir(directory).expect("dispatch directory") {
            let path = entry.expect("directory entry").path();
            if path.is_dir() {
                directories.push(path);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                let source = std::fs::read_to_string(&path).expect("Rust source");
                assert!(
                    HANDLERS.contains(&source.as_str()),
                    "{} needs source-lock enrollment",
                    path.display()
                );
            }
        }
    }
}
