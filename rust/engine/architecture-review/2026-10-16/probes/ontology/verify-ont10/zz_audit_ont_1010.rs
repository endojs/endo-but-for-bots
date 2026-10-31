// Temporary audit probe (ONT-10 verifier). Deleted after the run.
use ironhorse_262::report::{classify, Verdict};
use ironhorse_262::{dual_run_scripts, dual_run_with, Compiler};

#[test]
fn zz_audit_ont_1010() {
    // (a) Single-source path: an Unsupported compile becomes a Decode halt.
    let src = "var p; class C { static { let x = 1; } static { p = 2; } } p";
    let run = dual_run_with(src, Compiler::Ironhorse).expect("oracle");
    println!("SINGLE compile={:?}", run.ironhorse_compile);
    println!("SINGLE halt={:?} bytecode_len={}", run.ironhorse_halt, run.bytecode.len());
    println!("SINGLE oracle_completed={:?} oracle_result={:?}", run.agreement, run.oracle_result);

    // (b) Harness-shaped path (setup + subject), as xst::run_assembly calls it.
    let setup = "var assertOk = function (c) { if (!c) throw new Error('x'); }; undefined";
    let runs = dual_run_scripts(&[setup, src], None).expect("oracle");
    for (i, r) in runs.iter().enumerate() {
        println!(
            "PHASE {i}: compile={:?} halt={:?}",
            r.run.ironhorse_compile, r.run.ironhorse_halt
        );
    }

    // (c) A setup phase whose compile is Unsupported (setup_halt_verdict path).
    let runs = dual_run_scripts(&[src, "1"], None).expect("oracle");
    println!(
        "SETUP-UNSUPPORTED phases={} phase0 compile={:?} halt={:?}",
        runs.len(),
        runs[0].run.ironhorse_compile,
        runs[0].run.ironhorse_halt
    );

    for (outcome, reason) in [
        (Verdict::RunSkip, "parse-or-decode"),
        (Verdict::RunSkip, "compiler-unimplemented:parse"),
        (Verdict::Fail, "compiler-panicked:parse"),
    ] {
        println!("CLASSIFY {:?} {reason:?} => {}", outcome, classify(outcome, reason).as_str());
    }
}

// (d) Same root condition (key-space exhaustion) at relink.
#[test]
fn zz_audit_ont_1010_tablefull() {
    let mut m = ironhorse_vm::Interp::new();
    let first = "var r; try { var o = {}; for (var i = 0; i < 70000; i++) o['k' + i] = 1; r = 'ok'; } catch (e) { r = String(e); } r";
    let (code, symbols) = ironhorse_compile::compile_atoms(first).unwrap();
    let names = ironhorse_vm::parse_symbols(&symbols);
    m.link_intrinsics(&names);
    let out = m.run(&code);
    println!("CRANK1 completed={} result={:?} halt={:?}", out.completed, out.result, out.halt);
    let (code, symbols) =
        ironhorse_compile::compile_atoms("var someBrandNewIdentifier = 1; someBrandNewIdentifier").unwrap();
    let names = ironhorse_vm::parse_symbols(&symbols);
    match m.relink_crank(&code, &names) {
        Ok(_) => println!("CRANK2 relink ok"),
        Err(e) => {
            let halt = ironhorse_vm::Halt::Decode(ironhorse_vm::DecodeError::Relink(e.clone()));
            println!("CRANK2 relink refused: {e:?}; harness halt={halt:?} is_panic={}", halt.is_panic());
        }
    }
}
