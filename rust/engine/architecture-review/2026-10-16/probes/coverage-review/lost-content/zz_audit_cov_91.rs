//! TEMPORARY coverage probe (lost-content): closure capture append cost vs charge.
use ironhorse_vm::Interp;
use std::time::Instant;

fn src(k: usize, n: usize) -> String {
    let names: Vec<String> = (0..k).map(|i| format!("v{i}")).collect();
    let decl = names.iter().map(|s| format!("{s} = 0")).collect::<Vec<_>>().join(", ");
    let body = names.join("; ");
    format!("function outer() {{ var {decl}; return function () {{ {body}; }}; }} for (var j = 0; j < {n}; j++) outer(); 0")
}

#[test]
fn capture_append_scaling() {
    for k in [125usize, 500, 2000, 8000] {
        let n = 400_000 / k;
        let (b, s) = ironhorse_compile::compile_atoms(&src(k, n)).expect("compiles");
        let names = ironhorse_vm::parse_symbols(&s);
        let mut m = Interp::new();
        m.link_intrinsics(&names);
        let t = Instant::now();
        let out = m.run(&b);
        let ms = t.elapsed().as_secs_f64() * 1e3;
        println!(
            "AUDIT k={k:<5} n={n:<5} captures={:<7} completed={} computrons={:>10} ms={:>8.1} ns/computron={:>8.1}",
            k * n, out.completed, out.computrons, ms, ms * 1e6 / (out.computrons.max(1) as f64)
        );
    }
}
