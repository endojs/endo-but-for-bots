//! F120: restoring a catch scope must retain its original name mapping.
use ironhorse_vm::{parse_symbols, Interp};

struct Compiler;
impl ironhorse_vm::SourceCompiler for Compiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        let compiled = ironhorse_compile::compile_atoms_budgeted_with_limit(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            raw_budget,
            charge,
        )
        .expect("valid eval fixture within budget");
        Ok(ironhorse_vm::CompiledSource {
            bytecode: compiled.bytecode,
            symbols: compiled.symbols,
            parse_meter_raw: compiled.parse_meter_raw,
            parse_computrons: compiled.parse_computrons,
        })
    }
}

fn check(source: &str, expected: &str) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.set_source_compiler(std::rc::Rc::new(Compiler));
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    assert_eq!(outcome.result, expected, "{source}");
    if source.starts_with("var result=0;async") {
        assert_eq!(vm.global_string("result").as_deref(), Some("3"));
    }
}

#[test]
fn nested_catches_restore_shadowed_names_and_surviving_writes() {
    check(
        "function f(){let x=1;let result='';try {let x=2;try {let x=3;throw x} \
         catch(e){result+=x+':'+e;throw 4}}catch(e){result+=':'+x+':'+e} \
         return result+':'+x} f()",
        "2:3:1:4:1",
    );
    check(
        "function f(){let x=1;try{x=2;throw 3}catch(e){return x+e}}f()",
        "5",
    );
}

#[test]
fn scope_mutation_inside_try_keeps_captured_bindings() {
    check(
        "function f(){let x=1;let saved;try {let x=7;saved=()=>x;throw 2} \
         catch(e){return saved()+x+e}}f()",
        "10",
    );
    check(
        "function f(){var x=1;try{eval('var y=7; x=2');throw 3}catch(e){return x+y+e}}f()",
        "12",
    );
}

#[test]
fn suspended_try_restores_its_scope_for_throw_and_finally() {
    check(
        "var log='';function* g(){let x=1;try {let y=2;yield y;throw 3} \
         catch(e){log+=x+e}finally{log+='!'}}var it=g();it.next();it.next();log",
        "4!",
    );
    check(
        "var result=0;async function f(){let x=1;try{let y=2;await 0;throw y} \
         catch(e){result=x+e}}f();0",
        "0",
    );
}
