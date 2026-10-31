// AUDIT PROBE (temporary, integration-fuzz-oracle region): re-run of the prior
// reviewer's probes 1 and 3. Deleted after use.
// AUDIT PROBE (temporary): the thixotrope worker's `Compiler` (copied from
// rust/thixotrope-ironhorse-worker/src/main.rs:17-116, which overrides only
// compile_source / compile_source_units) versus IronhorseSourceCompiler on a
// direct eval that needs its caller's EvalContext.
use ironhorse_runtime::IronhorseSourceCompiler;
use ironhorse_vm::{CompiledSource, Interp, SourceCompileError, SourceCompiler};
use std::rc::Rc;

struct ThixotropeCompiler;
impl SourceCompiler for ThixotropeCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        match ironhorse_compile::compile_atoms_budgeted_firewalled(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            raw_budget,
            charge,
        ) {
            Ok(c) => Ok(CompiledSource {
                bytecode: c.bytecode,
                symbols: c.symbols,
                parse_meter_raw: c.parse_meter_raw,
                parse_computrons: c.parse_computrons,
            }),
            Err(ironhorse_compile::CompileError::MeterAbort) => Err(SourceCompileError::MeterAbort),
            Err(ironhorse_compile::CompileError::Invariant(d)) => {
                Err(SourceCompileError::Invariant(d))
            }
            Err(ironhorse_compile::CompileError::Parse(e)) => match e.kind {
                ironhorse_compile::ParseErrorKind::Unsupported => {
                    Err(SourceCompileError::Unsupported(e.to_string()))
                }
                _ => Err(SourceCompileError::Syntax(e.message)),
            },
        }
    }
    fn compile_source_units(
        &self,
        source: &[u16],
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        match ironhorse_compile::compile_atoms_units_budgeted_firewalled(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            raw_budget,
            charge,
        ) {
            Ok(c) => Ok(CompiledSource {
                bytecode: c.bytecode,
                symbols: c.symbols,
                parse_meter_raw: c.parse_meter_raw,
                parse_computrons: c.parse_computrons,
            }),
            Err(ironhorse_compile::CompileError::MeterAbort) => Err(SourceCompileError::MeterAbort),
            Err(ironhorse_compile::CompileError::Invariant(d)) => {
                Err(SourceCompileError::Invariant(d))
            }
            Err(ironhorse_compile::CompileError::Parse(e)) => match e.kind {
                ironhorse_compile::ParseErrorKind::Unsupported => {
                    Err(SourceCompileError::Unsupported(e.to_string()))
                }
                _ => Err(SourceCompileError::Syntax(e.message)),
            },
        }
    }
}

fn run(source: &str, compiler: Rc<dyn SourceCompiler>) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms_with(source, false).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    vm.set_source_compiler(compiler);
    let out = vm.run(&code);
    format!("completed={} result={:?} halt={:?}", out.completed, out.result, out.halt)
}

#[test]
fn probe_eval_context() {
    let cases = [
        "class B { get x() { return 42; } } class C extends B { m() { return eval('super.x'); } } String(new C().m())",
        "var r; function F() { r = eval('new.target') === F; } new F(); String(r)",
        "class P { #x = 7; m() { return eval('this.#x'); } } String(new P().m())",
        "try { class B { get x() { return 42; } } class C extends B { m() { return eval('super.x'); } } String(new C().m()) } catch (e) { 'caught ' + e }",
    ];
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            for c in cases {
                println!("CASE {c}");
                println!("  runtime    : {}", run(c, Rc::new(IronhorseSourceCompiler)));
                println!("  thixotrope : {}", run(c, Rc::new(ThixotropeCompiler)));
            }
        })
        .unwrap()
        .join()
        .unwrap();
}

// AUDIT PROBE (temporary): the endo embedding compiles every top-level crank
// with `compile_atoms_with_meter` (= Goal::Eval, rust/endo/src/ironhorse_engine.rs:593),
// the thixotrope worker with Goal::Script (main.rs:131-133). Replicate the
// embedding's VM calls (ironhorse_engine.rs:741-771) on one compartment, two
// cranks, under each goal.
use ironhorse_vm::{Machine, Meter};

fn cranks(goal: ironhorse_compile::Goal, sources: &[&str]) -> Vec<String> {
    let vm = Machine::new();
    vm.set_source_compiler(Rc::new(IronhorseSourceCompiler)).unwrap();
    let mut comp = vm.new_compartment();
    comp.set_source_compiler(Rc::new(IronhorseSourceCompiler));
    let mut out = Vec::new();
    for s in sources {
        let meter = ironhorse_compile::ParseMeter::with_budget(u64::MAX);
        let (code, symbols) =
            ironhorse_compile::compile_atoms_goal_with_meter(s, goal, false, meter).unwrap();
        let o = vm.evaluate_compartment_with_symbols_continuing_meter_shared(
            &comp,
            code.into(),
            &symbols,
            Meter::new(),
            None,
        );
        out.push(format!("completed={} result={:?} halt={:?}", o.completed, o.result, o.halt));
    }
    out
}

#[test]
fn probe_goal() {
    let seqs: [&[&str]; 3] = [
        &["'use strict'; var counter = 41; function inc() { return ++counter; } 'defined'", "inc()"],
        &["'use strict'; var g = 1; typeof globalThis.g"],
        &["var y = 1; String(delete globalThis.y) + ' ' + typeof globalThis.y"],
    ];
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            for seq in seqs {
                println!("SEQ {seq:?}");
                for (goal, name) in [
                    (ironhorse_compile::Goal::Eval, "endo (Eval goal)  "),
                    (ironhorse_compile::Goal::Script, "thixo (Script goal)"),
                ] {
                    for (i, r) in cranks(goal, seq).into_iter().enumerate() {
                        println!("  {name} crank {i}: {r}");
                    }
                }
            }
        })
        .unwrap()
        .join()
        .unwrap();
}
