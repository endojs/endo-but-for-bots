//! TEMPORARY audit probe 3 (vm-memory-gc-meter region): re-check, in release,
//! the meter-proportionality cases cited from the earlier reviewer's meter.out.
use std::time::Instant;

use ironhorse_vm::Interp;

fn timed(name: &str, src: &str) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    let names = ironhorse_vm::parse_symbols(&s);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let c0 = m.meter_index();
    let t = Instant::now();
    let o = m.run(&b);
    let dt = t.elapsed();
    let comp = (m.meter_index() - c0) >> 16;
    let outcome = if o.completed {
        o.result.chars().take(30).collect::<String>()
    } else {
        format!("{:?}", o.halt)
    };
    println!(
        "RECHECK {name}: wall={dt:?} computrons={comp} ns/computron={:.1} result={outcome}",
        dt.as_nanos() as f64 / comp.max(1) as f64
    );
}

#[test]
fn recheck() {
    timed("baseline_int_loop_1e6", "var x = 0; for (var i = 0; i < 1000000; i++) x = (x + i) | 0; x");
    timed("doubling_concat_25", "var s = 'x'; for (var k = 0; k < 25; k++) s += s; s.length");
    timed("json_stringify_33M_string", "var s = 'x'; for (var k = 0; k < 25; k++) s += s; JSON.stringify(s).length");
    timed("indexOf_1e5_by_1e3", "var h = 'a'.repeat(100000); var n = 'a'.repeat(1000) + 'b'; h.indexOf(n)");
    timed("indexOf_1e6_by_1e3", "var h = 'a'.repeat(1000000); var n = 'a'.repeat(1000) + 'b'; h.indexOf(n)");
    timed("sparse_join_1e7", "var a = []; a.length = 10000000; a.join().length");
    timed("array_includes_sparse_1e7", "var a = []; a.length = 10000000; a.includes(1)");
    timed("concat_loop_16000", "var s = ''; for (var i = 0; i < 16000; i++) s += 'x'; s.length");
}
