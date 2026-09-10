//! A table-growing relink must not revert guest edits to intrinsics.
//!
//! `install_intrinsic_bindings`' name-keyed branches are gated by the
//! relink's append-only `keep` filter, but its well-known-SYMBOL
//! branches (`@@toStringTag` tags, `@@iterator`/`@@asyncIterator`
//! identities, the dispose aliases) depend on no program name and the
//! filter cannot gate them — symbol-key ids mint top-down from
//! `u16::MAX`, so every one reads as "appended". Before the fix they
//! re-ran on every relink: a crank-1 monkeypatch of
//! `String.prototype[Symbol.iterator]` was silently reverted, a
//! crank-1 `delete DataView.prototype[Symbol.toStringTag]` came back,
//! and the Segments branch minted fresh iterator functions per relink
//! (review of the llm-rebase merge). They now run on the FULL link
//! only.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

#[test]
fn a_growing_relink_preserves_a_symbol_keyed_monkeypatch() {
    // The patch function's IDENTITY is the witness (a cross-crank CALL
    // is separately impossible — the pinned self-contained-crank
    // contract — so the read-back compares references, which is also
    // exactly what a reinstall would break).
    let crank1 = "var p = 0; var probe = 0; \
                  p = function () { return 'patched'; }; \
                  String.prototype[Symbol.iterator] = p; \
                  probe = String.prototype[Symbol.iterator] === p; probe";
    let (b1, n1) = compile(crank1);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o = m.run(&b1);
    assert!(o.completed, "patch crank: {:?}", o.halt);
    assert_eq!(o.result, "true");

    // A crank that GROWS the table (fresh names) relinks; the patch
    // must survive the appended-ids install pass.
    let crank2 = "var p; var probe; var freshName = 0; freshName = 1; \
                  probe = String.prototype[Symbol.iterator] === p; probe";
    let (b2, n2) = compile(crank2);
    let relinked = m.relink_crank(&b2, &n2).expect("relink");
    let o2 = m.run(&relinked);
    assert!(o2.completed, "read-back crank: {:?}", o2.halt);
    assert_eq!(
        o2.result, "true",
        "the relink reinstalled the intrinsic over the guest's patch"
    );
}

#[test]
fn a_growing_relink_preserves_a_symbol_keyed_deletion() {
    let crank1 = "var probe = 0; \
                  delete DataView.prototype[Symbol.toStringTag]; \
                  probe = DataView.prototype[Symbol.toStringTag] === undefined; probe";
    let (b1, n1) = compile(crank1);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o = m.run(&b1);
    assert!(o.completed, "delete crank: {:?}", o.halt);
    assert_eq!(o.result, "true");

    let crank2 = "var probe; var anotherFresh = 0; anotherFresh = 2; \
                  probe = DataView.prototype[Symbol.toStringTag] === undefined; probe";
    let (b2, n2) = compile(crank2);
    let relinked = m.relink_crank(&b2, &n2).expect("relink");
    let o2 = m.run(&relinked);
    assert!(o2.completed, "read-back crank: {:?}", o2.halt);
    assert_eq!(
        o2.result, "true",
        "the relink resurrected a property the guest deleted"
    );
}

// ---- Wave-6 W6-7: the keep-gate's runtime-intern false negative ------
//
// The append-only filter (`id > old_len`) conflates "this id existed
// before the unit" with "this binding was installed by an earlier
// link". A computed string key (`o['Math']`) interns the NAME without
// any install having seen it; the next unit to reference `Math`
// textually mapped onto the pre-existing id, the filter refused it,
// and the global was never bound.

#[test]
fn a_runtime_interned_name_does_not_block_a_later_textual_install() {
    // JSON.parse is the reachable intern-without-install path: it
    // interns every object key straight through `intern_key` (the
    // computed-access path refuses boot-default names by design).
    let crank1 = "var j = 0; j = JSON.parse('{\"Math\":1}'); 0;";
    let (b1, n1) = compile(crank1);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o = m.run(&b1);
    assert!(o.completed, "intern crank: {:?}", o.halt);

    let crank2 = "var j; var t = 0; t = Math.floor(1.5); t";
    let (b2, n2) = compile(crank2);
    let relinked = m.relink_crank(&b2, &n2).expect("relink");
    let o2 = m.run(&relinked);
    assert!(
        o2.completed,
        "the runtime-interned name blocked the textual install: {:?}",
        o2.halt
    );
    assert_eq!(o2.result, "1");
}

/// The same gap through the eval bridge, on a live machine with no
/// store involved: the unit's keep filter refused the pre-interned id.
#[test]
fn a_runtime_interned_name_does_not_block_a_later_eval_install() {
    struct TestCompiler;
    impl ironhorse_vm::SourceCompiler for TestCompiler {
        fn compile_source(
            &self,
            source: &str,
            strict: bool,
            raw_budget: u64,
            charge: &mut dyn FnMut(u64) -> bool,
        ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
            match ironhorse_compile::compile_atoms_budgeted_with_limit(
                source,
                ironhorse_compile::Goal::Eval,
                strict,
                raw_budget,
                charge,
            ) {
                Ok(compiled) => Ok(ironhorse_vm::CompiledSource {
                    bytecode: compiled.bytecode,
                    symbols: compiled.symbols,
                    parse_meter_raw: compiled.parse_meter_raw,
                    parse_computrons: compiled.parse_computrons,
                }),
                Err(ironhorse_compile::CompileError::MeterAbort) => {
                    Err(ironhorse_vm::SourceCompileError::MeterAbort)
                }
                Err(ironhorse_compile::CompileError::Parse(error)) => match error.kind {
                    ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                        kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                        ..
                    }) => Err(ironhorse_vm::SourceCompileError::HeapExhausted),
                    ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                        kind: ironhorse_compile::LexErrorKind::RegExpBudgetExceeded,
                        ..
                    }) => Err(ironhorse_vm::SourceCompileError::MeterAbort),
                    ironhorse_compile::ParseErrorKind::Unsupported => Err(
                        ironhorse_vm::SourceCompileError::Unsupported(error.to_string()),
                    ),
                    _ => Err(ironhorse_vm::SourceCompileError::Syntax(error.message)),
                },
            }
        }
    }
    let src = "var j = 0; var t = 0; \
               j = JSON.parse('{\"Math\":1}'); \
               t = eval('Math.floor(1.5)'); t";
    let (b, n) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    m.set_source_compiler(std::rc::Rc::new(TestCompiler));
    let o = m.run(&b);
    assert!(o.completed, "eval crank: {:?}", o.halt);
    assert_eq!(o.result, "1");
}

/// F060: name-based partial installation must preserve both descriptor kinds
/// and deletion, even when a later crank introduces another Error constructor.
#[test]
fn relink_preserves_guest_intrinsic_edits() {
    for target in [
        "Error.prototype",
        "Object.getPrototypeOf(Object.getPrototypeOf((async function* () {})()))",
    ] {
        let key = if target == "Error.prototype" {
            "stack"
        } else {
            "constructor"
        };
        for edit in [
            format!("Object.defineProperty(target, '{key}', {{value: 73, configurable: true}})"),
            format!("Object.defineProperty(target, '{key}', {{get: function () {{ return 73; }}, configurable: true}})"),
            format!("delete target['{key}']"),
        ] {
            let deleted = edit.starts_with("delete");
            let check = if deleted {
                format!("!Object.prototype.hasOwnProperty.call(target, '{key}')")
            } else {
                format!("target['{key}'] === 73")
            };
            let (code, names) = compile(&format!("var target = {target}; {edit}; {check}"));
            let mut vm = Interp::new();
            let (initial, initial_names) = compile("0");
            vm.link_intrinsics(&initial_names);
            assert!(vm.run(&initial).completed);
            let code = vm.relink_crank(&code, &names).expect("first intrinsic use");
            let result = vm.run(&code);
            assert!(result.completed, "{target}: {edit}: {:?}", result.halt);
            assert_eq!(result.result, "true", "initial edit: {edit}");
            let (code, names) = compile(&format!("var target; var freshName2A = RangeError; {check}"));
            let code = vm.relink_crank(&code, &names).expect("relink");
            let result = vm.run(&code);
            assert!(result.completed, "{target}: {edit}: {:?}", result.halt);
            assert_eq!(result.result, "true", "relink reverted: {target}: {edit}");
        }
    }
}
