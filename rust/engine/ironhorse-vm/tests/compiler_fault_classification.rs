//! A compiler fault and a compiler coverage gap are different halts
//! (architecture finding F063).
//!
//! F063's impact clause is a classification one: when the compiler panicked,
//! every embedder's `catch_unwind` folded the payload into
//! `SourceCompileError::Unsupported`, so the VM raised
//! `Halt::NotImplemented("eval:compiler-unimplemented")` — the same label an
//! honestly unported construct raises. A guest-triggerable engine fault was
//! therefore indistinguishable from a coverage gap, both to the guest and to
//! the test262 harness's accounting, and the fuzzers' honest-skip machinery
//! treated it as a registered skip rather than a bug.
//!
//! The classification now exists (`SourceCompileError::Invariant`), so this
//! file holds the part of it that can only be checked at the VM seam: that
//! the two errors produce two different halts, and that the fault-shaped one
//! is uncatchable. `ironhorse-compile/tests/compiler_totality.rs` holds the
//! producing half — that a panic inside the compiler becomes
//! `CompileError::Invariant` rather than a parse reject.
//!
//! The stubs below return each error directly rather than provoking a real
//! compiler panic. That is deliberate: a source string that panics today's
//! coder is exactly what F063 says has not been enumerated, so a test that
//! needed one would be untestable by construction. What is testable — and is
//! what the finding's impact clause is about — is the seam's behaviour once
//! an error of each kind arrives.

use std::rc::Rc;

use ironhorse_vm::{CompiledSource, Halt, Interp, RunOutcome, SourceCompileError, SourceCompiler};

/// A compiler whose every compile is an engine fault.
struct Faulting;
impl SourceCompiler for Faulting {
    fn compile_source(
        &self,
        _source: &str,
        _strict: bool,
        _raw_budget: u64,
        _charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        // The detail carries a marker a leak would make visible.
        Err(SourceCompileError::Invariant(
            "coder invariant: LEAKED-PANIC-TEXT".into(),
        ))
    }
}

/// A compiler whose every compile is an honest coverage gap.
struct Gapped;
impl SourceCompiler for Gapped {
    fn compile_source(
        &self,
        _source: &str,
        _strict: bool,
        _raw_budget: u64,
        _charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        Err(SourceCompileError::Unsupported("class static block".into()))
    }
}

/// A compiler whose every compile is a spec early error.
struct Rejecting;
impl SourceCompiler for Rejecting {
    fn compile_source(
        &self,
        _source: &str,
        _strict: bool,
        _raw_budget: u64,
        _charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        Err(SourceCompileError::Syntax("no identifier".into()))
    }
}

fn run_with(compiler: Rc<dyn SourceCompiler>, source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    let mut m = Interp::new();
    m.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    m.set_source_compiler(compiler);
    m.run(&bytecode)
}

/// The claim, stated as the one assertion that would have failed before:
/// the two errors do NOT share a halt.
#[test]
fn a_compiler_fault_and_a_coverage_gap_are_different_halts() {
    let fault = run_with(Rc::new(Faulting), "eval('1')");
    let gap = run_with(Rc::new(Gapped), "eval('1')");
    assert_eq!(
        fault.halt,
        Halt::EngineInvariant("eval:compiler-invariant"),
        "a compiler fault must name itself as one"
    );
    assert_eq!(
        gap.halt,
        Halt::NotImplemented("eval:compiler-unimplemented"),
        "an unported construct must stay an honest named skip"
    );
    assert_ne!(
        fault.halt, gap.halt,
        "the fault and the gap collapsed back into one label, which is \
         exactly what F063 reported"
    );
}

/// And a real early error is neither of them: it is a catchable realm
/// `SyntaxError`, so the program completes. Without this the previous test
/// is satisfied by a seam that turns everything into a halt.
#[test]
fn a_spec_early_error_is_still_catchable() {
    let out = run_with(
        Rc::new(Rejecting),
        "var r = 0; try { eval('var'); } catch (e) { r = e instanceof SyntaxError; } r",
    );
    assert!(out.completed, "a SyntaxError is catchable: {:?}", out.halt);
    assert_eq!(out.result, "true");
}

/// A fault is uncatchable. `Halt::NotImplemented` is too, so this is not
/// what distinguishes them — but a classification that let a guest swallow
/// an engine fault would be worse than the shared label it replaced.
#[test]
fn a_compiler_fault_cannot_be_caught_by_the_guest() {
    let out = run_with(
        Rc::new(Faulting),
        "var r = 'uncaught'; try { eval('1'); } catch (e) { r = 'caught'; } r",
    );
    assert!(
        !out.completed,
        "the guest caught an engine fault and completed with {:?}",
        out.result
    );
    assert_eq!(out.halt, Halt::EngineInvariant("eval:compiler-invariant"));
    assert!(
        out.halt.is_panic(),
        "a compiler fault must sit in the settled uncatchable core"
    );
}

/// The panic payload must not reach the guest or the outcome. It is
/// arbitrary text from inside the compiler — a source fragment, a slot
/// index, an assertion message — and the `Halt` label is deliberately a
/// `&'static str` so there is nowhere for it to go.
#[test]
fn the_panic_payload_does_not_escape_to_the_guest() {
    let out = run_with(Rc::new(Faulting), "eval('1')");
    let rendered = format!("{:?} {}", out.halt, out.result);
    assert!(
        !rendered.contains("LEAKED-PANIC-TEXT"),
        "the compiler's panic text reached the guest-visible outcome: \
         {rendered}"
    );
}

/// The `compile_source_units` default forwards to `compile_source`, so the
/// UTF-16 bridge classifies the same way rather than falling back to the
/// `Unsupported` the default's own scalar check raises.
#[test]
fn the_utf16_bridge_classifies_a_fault_the_same_way() {
    let out = run_with(Rc::new(Faulting), "eval('\\u0031')");
    assert_eq!(
        out.halt,
        Halt::EngineInvariant("eval:compiler-invariant"),
        "the units path must not launder a fault into a coverage gap"
    );
}
