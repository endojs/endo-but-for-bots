//! TEMPORARY audit verifier probe (vm-natives-values). Deleted after the run.
use ironhorse_vm::Interp;
use std::time::Instant;

fn run(label: &str, src: &str, limit: Option<u64>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    let names = ironhorse_vm::parse_symbols(&s);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    if let Some(limit) = limit {
        m.arm_meter(100, Box::new(move |c| c <= limit));
    }
    let t = Instant::now();
    let out = m.run(&b);
    let ms = t.elapsed().as_secs_f64() * 1e3;
    println!(
        "{label:<16} limit={:?} completed={} computrons={} ms={:.1} computrons/ms={:.1} halt={:?}",
        limit, out.completed, out.computrons, ms, out.computrons as f64 / ms.max(0.001),
        if out.completed { None } else { Some(&out.halt) }
    );
}

#[test]
fn verify_nval() {
    run("ctrl-loop", "var x = 0; for (var i = 0; i < 3000000; i++) { x = (x + i) | 0; } x", None);
    run("setup-str", "var h = 'a'.repeat(40000); var n = 'a'.repeat(20000) + 'b'; 0", None);
    run("includes", "var h = 'a'.repeat(40000); var n = 'a'.repeat(20000) + 'b'; h.includes(n)", None);
    run("indexOf", "var h = 'a'.repeat(40000); var n = 'a'.repeat(20000) + 'b'; h.indexOf(n)", None);
    run("includes-armed", "var h = 'a'.repeat(40000); var n = 'a'.repeat(20000) + 'b'; h.includes(n)", Some(20_000));
    run("ctrl-armed", "var x = 0; for (var i = 0; i < 100000000; i++) { x = (x + i) | 0; } x", Some(20_000));
    run("setup-big", "var x = (1n << 65000n) - 1n; x = x * x * x * x; 0", None);
    run("big-sq", "var x = (1n << 65000n) - 1n; x = x * x * x * x; x = x * x; 0", None);
    run("big-sq-armed", "var x = (1n << 65000n) - 1n; x = x * x * x * x; x = x * x; 0", Some(12_000));
    run("String(big)", "var x = (1n << 65000n) - 1n; x = x * x * x * x; String(x).length", None);
    run("big.toString", "var x = (1n << 65000n) - 1n; x = x * x * x * x; x.toString().length", None);
    run("BigInt(str)", "var s = '7'.repeat(200000); BigInt(s) > 0n", None);
    run("empty-slice", "var s = 'a', n = 0; for (var i = 0; i < 1000000; i++) { if (s.slice(1).length === 0) n++; } n", None);
    run("nonempty-len", "var s = 'a', n = 0; for (var i = 0; i < 1000000; i++) { if (s.length === 1) n++; } n", None);
}
