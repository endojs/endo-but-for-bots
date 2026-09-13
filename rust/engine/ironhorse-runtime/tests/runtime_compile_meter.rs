use ironhorse_compile::{compile_atoms_with, compile_atoms_with_budget, ParseErrorKind};
use ironhorse_runtime::IronhorseSourceCompiler;
use ironhorse_vm::{CompiledSource, Halt, Interp, RunOutcome, SourceCompileError, SourceCompiler};
use std::{cell::Cell, rc::Rc};

struct ObservedCompiler {
    raw: Rc<Cell<u64>>,
    metered: bool,
}
impl SourceCompiler for ObservedCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        if self.metered {
            IronhorseSourceCompiler.compile_source(source, strict, budget, &mut |delta| {
                self.raw.set(self.raw.get() + delta);
                charge(delta)
            })
        } else {
            compile_atoms_with(source, strict)
                .map(|(bytecode, symbols)| CompiledSource {
                    bytecode,
                    symbols,
                    parse_meter_raw: 0,
                    parse_computrons: 0,
                })
                .map_err(|e| match e.kind {
                    ParseErrorKind::Unsupported => SourceCompileError::Unsupported(e.to_string()),
                    _ => SourceCompileError::Syntax(e.message),
                })
        }
    }
}

fn run(source: &str, compiler: Rc<dyn SourceCompiler>, arm: bool) -> (Interp, RunOutcome) {
    let (code, symbols) = compile_atoms_with(source, false).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    vm.set_source_compiler(compiler);
    if arm {
        vm.arm_meter(1, Box::new(|spent| spent <= 32));
    }
    let outcome = vm.run(&code);
    (vm, outcome)
}

#[test]
fn eval_function_nested_eval_and_caught_syntax_charge_once() {
    for source in [
        "eval('1+2')",
        "Function('x', 'return x+1')(2)",
        "eval(\"eval('1+2')\")",
        "try { eval('var ='); } catch(e) { e.name; }",
    ] {
        let raw = Rc::new(Cell::new(0));
        let (metered, out) = run(
            source,
            Rc::new(ObservedCompiler {
                raw: raw.clone(),
                metered: true,
            }),
            false,
        );
        let (legacy, old) = run(
            source,
            Rc::new(ObservedCompiler {
                raw: Rc::new(Cell::new(0)),
                metered: false,
            }),
            false,
        );
        assert!(out.completed, "{:?}", out.halt);
        assert_eq!(out.result, old.result);
        assert!(raw.get() > 0);
        assert_eq!(
            metered.meter_index() - legacy.meter_index(),
            raw.get(),
            "{source}"
        );
    }
}

#[test]
fn compilation_refusal_is_uncatchable_and_adds_no_dynamic_segment() {
    for call in ["eval", "Function"] {
        let payload = format!("/*{}*/1", "x".repeat(10000));
        let source = format!("try {{ {call}({payload:?}); }} catch(e) {{ 999; }}");
        let raw = Rc::new(Cell::new(0));
        let (vm, out) = run(
            &source,
            Rc::new(ObservedCompiler {
                raw: raw.clone(),
                metered: true,
            }),
            true,
        );
        assert_eq!(out.halt, Halt::MeterAbort);
        assert!(!out.completed);
        assert!(!vm.is_quiescent());
        assert_eq!(
            vm.retained_code_segment_count(),
            0,
            "no dynamic program retained"
        );
        assert!(raw.get() >= (payload.len() as u64) * (1 << 14));
    }
}

#[test]
fn compiler_errors_and_unwinds_retain_live_charges() {
    for source in ["'unterminated", "var =", "class C { static { let x=1; } }"] {
        let mut raw = 0;
        let result =
            IronhorseSourceCompiler.compile_source(source, false, u64::MAX, &mut |delta| {
                raw += delta;
                true
            });
        assert!(result.is_err());
        assert!(raw >= (source.len() as u64) * (1 << 14));
    }
    let source = "'unterminated";
    let mut raw = 0;
    let result = IronhorseSourceCompiler.compile_source(source, false, u64::MAX, &mut |delta| {
        raw += delta;
        false
    });
    assert!(matches!(result, Err(SourceCompileError::MeterAbort)));
    assert_eq!(raw, (source.len() as u64) * (1 << 14));
}

#[test]
fn compiler_receipt_matches_budget_api() {
    let source = "var x=1; x+2";
    let expected = compile_atoms_with_budget(source, false, u64::MAX).parse_meter_raw;
    let mut raw = 0;
    let output = IronhorseSourceCompiler
        .compile_source(source, false, expected, &mut |delta| {
            raw += delta;
            true
        })
        .ok()
        .unwrap();
    assert_eq!(output.parse_meter_raw, expected);
    assert_eq!(raw, expected);
    let result = IronhorseSourceCompiler.compile_source(source, false, expected - 1, &mut |_| true);
    assert!(matches!(result, Err(SourceCompileError::MeterAbort)));
}

struct MisbehavingCompiler(bool);
impl SourceCompiler for MisbehavingCompiler {
    fn compile_source(
        &self,
        _: &str,
        _: bool,
        _: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        if self.0 {
            charge(100 << 16);
            Err(SourceCompileError::Syntax("ignored refusal".into()))
        } else {
            let (bytecode, symbols) = compile_atoms_with("1", false).unwrap();
            Ok(CompiledSource {
                bytecode,
                symbols,
                parse_meter_raw: 1,
                parse_computrons: 0,
            })
        }
    }
}

#[test]
fn ignored_refusal_and_forged_receipt_cannot_execute_output() {
    let (_, out) = run(
        "try { eval('1') } catch(e) {999}",
        Rc::new(MisbehavingCompiler(true)),
        true,
    );
    assert_eq!(out.halt, Halt::MeterAbort);
    let (_, out) = run("eval('1')", Rc::new(MisbehavingCompiler(false)), false);
    assert_eq!(
        out.halt,
        Halt::EngineInvariant("eval:compile-charge-receipt")
    );
}

struct ExhaustAddressability;
impl SourceCompiler for ExhaustAddressability {
    fn compile_source(
        &self,
        _: &str,
        _: bool,
        budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        assert!(!charge(budget));
        Err(SourceCompileError::MeterAbort)
    }
}

#[test]
fn exhausting_raw_addressability_halts_without_unwind() {
    let (_, out) = run("eval('1')", Rc::new(ExhaustAddressability), false);
    assert_eq!(out.halt, Halt::MeterAbort);
}

#[test]
fn utf16_production_entry_preserves_surrogates_receipts_and_refusal() {
    // Deliberately pass an actual lone surrogate, not six ASCII escape units.
    let mut source: Vec<u16> = "'".encode_utf16().collect();
    source.push(0xd800);
    source.extend("'.charCodeAt(0)".encode_utf16());
    let mut raw = 0;
    let compiled = IronhorseSourceCompiler
        .compile_source_units(&source, false, u64::MAX, &mut |delta| {
            raw += delta;
            true
        })
        .unwrap_or_else(|_| panic!("UTF-16 source should compile"));
    assert!(raw > 0);
    assert_eq!(compiled.parse_meter_raw, raw);
    assert_eq!(compiled.parse_computrons, raw >> 16);
    let mut vm = Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&compiled.symbols));
    let result = vm.run(&compiled.bytecode);
    assert!(result.completed, "{:?}", result.halt);
    assert_eq!(result.result, "55296");
    for budget in [0, raw - 1] {
        assert!(matches!(
            IronhorseSourceCompiler.compile_source_units(&source, false, budget, &mut |_| true),
            Err(SourceCompileError::MeterAbort)
        ));
    }
    let mut consulted = false;
    assert!(matches!(
        IronhorseSourceCompiler.compile_source_units(&source, false, u64::MAX, &mut |_| {
            consulted = true;
            false
        }),
        Err(SourceCompileError::MeterAbort)
    ));
    assert!(consulted);
}

#[test]
fn sibling_realms_keep_independent_source_compilers() {
    let machine = ironhorse_vm::Machine::new();
    let mut a = machine.new_compartment();
    let b = machine.new_compartment();
    a.set_source_compiler(Rc::new(IronhorseSourceCompiler));
    let run = |compartment: &ironhorse_vm::Compartment, source: &str| {
        let (code, symbols) = compile_atoms_with(source, false).unwrap();
        compartment.evaluate_with_symbols(&code, &symbols)
    };
    let first = run(&a, "var n=7; eval('n+1')");
    assert!(first.completed, "{:?}", first.halt);
    assert_eq!(first.result, "8");
    assert_eq!(
        run(&b, "eval('1')").halt,
        Halt::NotImplemented("eval:no-compiler")
    );
    assert!(run(&b, "1").completed);
    assert_eq!(run(&a, "Function('return n+2')()").result, "9");
}

fn compartment_eval(compartment: &ironhorse_vm::Compartment, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let result = compartment.evaluate_with_symbols(&code, &symbols);
    assert!(result.completed, "{source}: {:?}", result.halt);
    result.result
}

#[test]
fn evaluators_retain_target_globals_when_shared_and_after_origin_drop() {
    let machine = ironhorse_vm::Machine::new();
    let mut a = machine.new_compartment();
    let mut b = machine.new_compartment();
    a.set_source_compiler(Rc::new(IronhorseSourceCompiler));
    b.set_source_compiler(Rc::new(IronhorseSourceCompiler));
    compartment_eval(
        &a,
        "var answer = 42; var e = eval; var F = Function; var read = () => eval('answer'); 0",
    );
    b.define_global_value("evalA", &a.global_value("e").unwrap())
        .unwrap();
    b.define_global_value("FunctionA", &a.global_value("F").unwrap())
        .unwrap();
    b.define_global_value("readA", &a.global_value("read").unwrap())
        .unwrap();
    assert_eq!(compartment_eval(&b, "var answer = 99; evalA('answer') + ':' + FunctionA('return answer')() + ':' + readA() + ':' + eval('answer')"), "42:42:42:99");
    assert_ne!(
        a.global_object_identity("e"),
        b.global_object_identity("eval")
    );
    assert_ne!(
        a.global_object_identity("F"),
        b.global_object_identity("Function")
    );
    drop(a);
    machine.collect().unwrap();
    assert_eq!(
        compartment_eval(
            &b,
            "readA() + ':' + evalA('answer') + ':' + FunctionA('return answer')()"
        ),
        "42:42:42"
    );
}

#[test]
fn foreign_eval_bound_to_the_name_eval_does_not_capture_caller_locals() {
    let machine = ironhorse_vm::Machine::new();
    let mut a = machine.new_compartment();
    let mut b = machine.new_compartment();
    a.set_source_compiler(Rc::new(IronhorseSourceCompiler));
    b.set_source_compiler(Rc::new(IronhorseSourceCompiler));
    compartment_eval(&a, "var answer = 42; 0");
    b.define_global_value("eval", &a.global_value("eval").unwrap())
        .unwrap();
    assert_eq!(
        compartment_eval(
            &b,
            "var answer = 99; (function(){ var answer = 100; return eval('answer') })()"
        ),
        "42"
    );
}

#[test]
fn retained_generator_and_async_frames_keep_their_compartment_globals() {
    let machine = ironhorse_vm::Machine::new();
    let a = machine.new_compartment();
    let mut b = machine.new_compartment();
    compartment_eval(&a, "var answer = 42; function* values(){yield answer; yield answer + 1} var gen = values(); var resolve; var p = new Promise(r => resolve = r); var state = {n: 0}; async function run(){await p; state.n = answer} run(); 0");
    b.define_global_value("gen", &a.global_value("gen").unwrap())
        .unwrap();
    b.define_global_value("resolve", &a.global_value("resolve").unwrap())
        .unwrap();
    b.define_global_value("state", &a.global_value("state").unwrap())
        .unwrap();
    drop(a);
    machine.collect().unwrap();
    assert_eq!(
        compartment_eval(&b, "var answer = 99; gen.next().value"),
        "42"
    );
    machine.collect().unwrap();
    assert_eq!(compartment_eval(&b, "gen.next().value"), "43");
    compartment_eval(&b, "resolve(); 0");
    assert!(machine.run_promise_jobs().completed);
    assert_eq!(compartment_eval(&b, "state.n"), "42");
}

#[test]
fn shared_dynamic_constructors_use_the_explicit_default_evaluator_service() {
    let machine = ironhorse_vm::Machine::new();
    machine
        .set_source_compiler(Rc::new(IronhorseSourceCompiler))
        .unwrap();
    let a = machine.new_compartment();
    compartment_eval(&machine.start_compartment(), "var answer = 17; 0");
    compartment_eval(&a, "var answer = 42; 0");
    assert_eq!(
        compartment_eval(&a, "(()=>{}).constructor('return answer')()"),
        "17"
    );
    assert_eq!(
        compartment_eval(
            &a,
            "(function*(){}).constructor('yield answer')().next().value"
        ),
        "17"
    );
    compartment_eval(
        &a,
        "var result; (async function(){}).constructor('return answer')().then(x => result=x); 0",
    );
    assert!(machine.run_promise_jobs().completed);
    assert_eq!(compartment_eval(&a, "result"), "17");
}
