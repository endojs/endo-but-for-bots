//! TEMPORARY audit probe (NVAL). An armed meter with a tight limit: how long
//! does one native call run before the host's refusal can land?
use ironhorse_vm::Interp;
use std::time::Instant;

fn armed(label: &str, src: &str, limit: u64) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    let names = ironhorse_vm::parse_symbols(&s);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    m.arm_meter(100, Box::new(move |c| c <= limit));
    let t = Instant::now();
    let out = m.run(&b);
    println!(
        "{label:<10} limit={limit} completed={} computrons={} ms={:.1} halt={:?}",
        out.completed,
        out.computrons,
        t.elapsed().as_secs_f64() * 1e3,
        out.halt
    );
}

#[test]
fn nval_armed_meter_cannot_interrupt() {
    // Setup (two repeat() calls) costs a few thousand computrons; the
    // limit leaves room for setup but not for proportional search work.
    armed(
        "includes",
        "var h = 'a'.repeat(40000); var n = 'a'.repeat(20000) + 'b'; h.includes(n)",
        20_000,
    );
    armed(
        "bigint-mul",
        "var x = (1n << 65000n) - 1n; for (var i = 0; i < 5; i++) x = x * x; x > 0n",
        5_000,
    );
    armed(
        "control",
        "var x = 0; for (var i = 0; i < 100000000; i++) { x = (x + i) | 0; } x",
        20_000,
    );
}
