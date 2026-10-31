// Temporary audit probe (ONT-14 consequence verification). Frozen Machine::new().
use ironhorse_runtime::IronhorseSourceCompiler;
use std::rc::Rc;

fn ev(c: &ironhorse_vm::Compartment, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let r = c.evaluate_with_symbols(&code, &symbols);
    if !r.completed {
        return format!("HALT {:?} {}", r.halt, r.result);
    }
    r.result
}

#[test]
fn start_evaluator_routes() {
    let machine = ironhorse_vm::Machine::new();
    let mut start = machine.start_compartment();
    start.set_source_compiler(Rc::new(IronhorseSourceCompiler));
    let mut b = machine.new_compartment();
    b.set_source_compiler(Rc::new(IronhorseSourceCompiler));
    println!("frozen: {}", ev(&start, "Object.isFrozen(Function.prototype)"));
    println!(
        "start setup: {}",
        ev(&start, "var answer = 17; var e = eval; var F = Function; function wrapEval(s) { return (0, eval)(s); } function wrapFunction(s) { return Function(s)(); } 0")
    );
    for name in ["e", "F", "wrapEval", "wrapFunction"] {
        b.define_global_value(&format!("S_{name}"), &start.global_value(name).unwrap()).unwrap();
    }
    println!(
        "host-endowed, from b: {}",
        ev(&b, "var answer = 99; ['bare eval=' + S_e('answer'), 'bare Function=' + S_F('return answer')(), 'wrapped eval=' + S_wrapEval('answer'), 'wrapped Function=' + S_wrapFunction('return answer'), 'map(eval)=' + ['answer'].map(S_e)[0]].join(' ')")
    );
    println!(
        "job from b: {}",
        ev(&b, "var got; Promise.resolve('answer').then(S_e).then(v => { got = v; }); 0")
    );
    println!("pump: {:?}", machine.run_promise_jobs().halt);
    println!("job result in b: {}", ev(&b, "String(got)"));
    // Guest-only route: the start compartment builds the child itself.
    println!(
        "guest route: {}",
        ev(&start, "typeof Compartment === 'function' ? (function () { var c = new Compartment({ globals: { answer: 5, se: eval, sF: Function, sw: wrapEval } }); return ['bare eval=' + c.evaluate('se(\"answer\")'), 'bare Function=' + c.evaluate('sF(\"return answer\")()'), 'wrapped=' + c.evaluate('sw(\"answer\")')].join(' '); })() : 'no Compartment'")
    );
}
