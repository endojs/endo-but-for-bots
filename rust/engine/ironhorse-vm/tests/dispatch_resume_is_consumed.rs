//! A catchable throw out of a native re-entered from the dispatch loop
//! resumes the guest's handler; it never leaves the loop as a result
//! (architecture review F006).
//!
//! `Halt::Resume(pc)` is an internal control transfer: "the handler is at
//! `pc`, continue there". Five dispatch arms propagated a native's result
//! with a raw `Err(halt) => return halt`, so when the native (a throwing
//! setter behind a `with`, a `toString` in a template literal, a `valueOf`
//! under `++`) raised through a live guest `try`, the `Resume` escaped the
//! loop, the crank ended `completed=false, halt=Resume(110)`, and the
//! embedder rendered an internal pc to the operator as the outcome of a
//! program ordinary JavaScript says was handled. XS completes every one
//! of these with the catch having run.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn assert_completes(source: &str, expected: &str) {
    let out = run(source);
    assert!(
        out.completed,
        "the guest handler must run and the program complete (XS does); \
         halt: {:?}\n  {source}",
        out.halt
    );
    assert_eq!(out.result, expected, "{source}");
}

#[test]
fn a_throwing_tostring_in_a_template_literal_is_caught() {
    assert_completes(
        "var r=0; var o={toString(){throw 2;}}; try{`${o}`}catch(e){r='caught:'+e} r",
        "caught:2",
    );
}

#[test]
fn a_throwing_setter_behind_with_is_caught() {
    assert_completes(
        "var r=0; var o={set x(v){throw 5;}}; with(o){ try{ x=1 }catch(e){r='caught:'+e} } r",
        "caught:5",
    );
}

#[test]
fn a_throwing_getter_behind_with_is_caught() {
    assert_completes(
        "var r=0; var o={get x(){throw 8;}}; with(o){ try{ x }catch(e){r='caught:'+e} } r",
        "caught:8",
    );
}

#[test]
fn a_throwing_valueof_under_update_is_caught() {
    assert_completes(
        "var r=0; var o={valueOf(){throw 7;}}; try{ o++ }catch(e){r='caught:'+e} r",
        "caught:7",
    );
    assert_completes(
        "var r=0; var o={valueOf(){throw 9;}}; try{ o-- }catch(e){r='caught:'+e} r",
        "caught:9",
    );
}

#[test]
fn a_throwing_iterator_getter_in_for_of_is_caught() {
    assert_completes(
        "var r=0; var o={get [Symbol.iterator](){throw 4;}}; \
         try{ for (var x of o) {} }catch(e){r='caught:'+e} r",
        "caught:4",
    );
    assert_completes(
        "var r=0; var o={[Symbol.iterator](){throw 6;}}; \
         try{ for (var x of o) {} }catch(e){r='caught:'+e} r",
        "caught:6",
    );
}

#[test]
fn the_already_guarded_shapes_still_complete() {
    // The sibling arms that went through `dispatch_result!` all along.
    assert_completes(
        "var r=0; var o={set x(v){throw 1;}}; try{o.x=1}catch(e){r='caught:'+e} r",
        "caught:1",
    );
    assert_completes(
        "var r=0; var o={get x(){throw 4;}}; try{o.x}catch(e){r='caught:'+e} r",
        "caught:4",
    );
    assert_completes(
        "var r=0; var k={toString(){throw 3;}}; var o={}; try{o[k]=1}catch(e){r='caught:'+e} r",
        "caught:3",
    );
}
