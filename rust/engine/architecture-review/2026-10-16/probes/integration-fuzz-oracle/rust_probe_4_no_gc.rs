// AUDIT PROBE (temporary): the thixotrope worker's crank loop
// (rust/thixotrope-ironhorse-worker/src/main.rs:118-180) never calls a
// collector. Drive the same Interp calls with a crank whose garbage is
// unreachable after it completes, and count cranks until a halt.
use ironhorse_vm::{parse_symbols, Interp};

#[test]
fn probe() {
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(|| {
            let src = "var keep = 0; for (var i = 0; i < 50000; i++) { var o = { a: i, b: [i] }; keep = keep + 1; } keep";
            let mut m = Interp::new();
            for crank in 1..=40 {
                let (code, symbols) = ironhorse_compile::compile_atoms_goal(
                    src,
                    ironhorse_compile::Goal::Script,
                    false,
                )
                .unwrap();
                let names = parse_symbols(&symbols);
                let code = if m.program_symbol_names().is_empty() {
                    m.link_intrinsics(&names);
                    code
                } else {
                    m.relink_crank(&code, &names).unwrap()
                };
                let o = m.run(&code);
                println!(
                    "crank {crank:2}: completed={} result={:?} halt={:?} live_slots={}",
                    o.completed,
                    o.result,
                    o.halt,
                    m.slots().live_count()
                );
                if !o.completed {
                    // What a collection would have done at the last boundary:
                    break;
                }
            }
            let mut c = Interp::new();
            let (code, symbols) =
                ironhorse_compile::compile_atoms_goal(src, ironhorse_compile::Goal::Script, false)
                    .unwrap();
            c.link_intrinsics(&parse_symbols(&symbols));
            for crank in 1..=40 {
                let code = if crank == 1 { code.clone() } else { c.relink_crank(&code, &parse_symbols(&symbols)).unwrap() };
                let o = c.run(&code);
                let freed = c.collect_garbage().map(|s| s.slots_reclaimed).unwrap_or(0);
                if crank % 10 == 0 || !o.completed {
                    println!("with collect_garbage, crank {crank:2}: completed={} halt={:?} live_slots={} (freed {freed})", o.completed, o.halt, c.slots().live_count());
                }
                if !o.completed { break; }
            }
        })
        .unwrap()
        .join()
        .unwrap();
}
