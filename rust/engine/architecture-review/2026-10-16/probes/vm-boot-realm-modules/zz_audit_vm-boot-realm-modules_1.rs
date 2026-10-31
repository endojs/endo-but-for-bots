//! TEMPORARY audit probe (vm-boot-realm-modules). Deleted after the audit.
use ironhorse_vm::{parse_symbols, Interp, Machine};
use std::time::Instant;

fn rss_kb() -> u64 {
    let statm = std::fs::read_to_string("/proc/self/statm").unwrap();
    let pages: u64 = statm.split_whitespace().nth(1).unwrap().parse().unwrap();
    pages * 4
}

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap();
    (code, parse_symbols(&symbols))
}

fn run(src: &str) -> (f64, u64, String) {
    let (code, names) = compile(src);
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    let t = Instant::now();
    let out = vm.run(&code);
    let dt = t.elapsed().as_secs_f64();
    assert!(out.completed, "{src}: {:?}", out.halt);
    (dt, out.computrons, out.result)
}

#[test]
fn boot_and_key_costs() {
    let stack = std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(body)
        .unwrap();
    stack.join().unwrap();
}

fn body() {
    // Warm the process-wide OnceLocks (boot fingerprint, key ranks).
    drop(Interp::new());

    // 1. Interp::new(): time and live heap.
    let n = 40;
    let t = Instant::now();
    for _ in 0..n {
        drop(Interp::new());
    }
    let boot_us = t.elapsed().as_secs_f64() * 1e6 / n as f64;
    let mut vm = Interp::new();
    let stats = vm.collect_garbage().unwrap();
    println!(
        "AUDIT interp_new_us={boot_us:.0} live_slots={} chunk_bytes={}",
        stats.slots_live, stats.chunk_bytes_after
    );

    // 2. Interp::new() + link of a trivial program.
    let (code, names) = compile("0");
    let t = Instant::now();
    for _ in 0..n {
        let mut vm = Interp::new();
        vm.link_intrinsics(&names);
    }
    let link_us = t.elapsed().as_secs_f64() * 1e6 / n as f64;
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    assert!(vm.run(&code).completed);
    let stats = vm.collect_garbage().unwrap();
    println!(
        "AUDIT new_plus_link_us={link_us:.0} live_slots_after_trivial_link={}",
        stats.slots_live
    );

    // 3. Machine::new() (shared realm: full link + harden) and a Compartment.
    let m = 10;
    let t = Instant::now();
    for _ in 0..m {
        drop(Machine::new());
    }
    let machine_us = t.elapsed().as_secs_f64() * 1e6 / m as f64;
    let machine = Machine::new();
    let s0 = machine.collect().unwrap();
    println!(
        "AUDIT machine_new_us={machine_us:.0} machine_live_slots={} chunk_bytes={}",
        s0.slots_live, s0.chunk_bytes_after
    );
    let (ccode, csyms) = ironhorse_compile::compile_atoms("1").unwrap();
    let k = 50;
    let t = Instant::now();
    let mut keep = Vec::new();
    for _ in 0..k {
        let c = machine.new_compartment();
        let out = c.evaluate_with_symbols(&ccode, &csyms);
        assert!(out.completed, "{:?}", out.halt);
        keep.push(c);
    }
    let comp_us = t.elapsed().as_secs_f64() * 1e6 / k as f64;
    let s1 = machine.collect().unwrap();
    println!(
        "AUDIT compartment_create_eval_us={comp_us:.0} slots_per_compartment={:.1} chunk_bytes_per_compartment={:.0}",
        (s1.slots_live - s0.slots_live) as f64 / k as f64,
        (s1.chunk_bytes_after as f64 - s0.chunk_bytes_after as f64) / k as f64
    );
    drop(keep);

    // 4. RSS per retained Machine.
    let before = rss_kb();
    let held: Vec<Machine> = (0..20).map(|_| Machine::new()).collect();
    let after = rss_kb();
    println!(
        "AUDIT rss_per_machine_kb={:.0}",
        (after - before) as f64 / held.len() as f64
    );
    drop(held);
    let before = rss_kb();
    let held: Vec<Interp> = (0..20)
        .map(|_| {
            let mut vm = Interp::new();
            vm.link_intrinsics(&names);
            vm
        })
        .collect();
    let after = rss_kb();
    println!(
        "AUDIT rss_per_linked_interp_kb={:.0}",
        (after - before) as f64 / held.len() as f64
    );
    drop(held);

    // 5. Novel computed keys: wall time and computrons, with and without
    //    many live functions.
    for (label, src) in [
        (
            "index_keys_20k",
            "var o = {}; for (var j = 0; j < 20000; j++) o[j] = j; 0",
        ),
        (
            "novel_computed_keys_20k",
            "var o = {}; for (var j = 0; j < 20000; j++) o['k' + j] = j; 0",
        ),
        (
            "json_parse_keys_20k",
            "var p = []; for (var j = 0; j < 20000; j++) p.push('\"k' + j + '\":' + j); \
             var o = JSON.parse('{' + p.join(',') + '}'); 0",
        ),
        (
            "fns_50k_then_index_keys_20k",
            "var f = []; for (var i = 0; i < 50000; i++) f.push(function () {}); \
             var o = {}; for (var j = 0; j < 20000; j++) o[j] = j; 0",
        ),
        (
            "fns_50k_then_novel_keys_20k",
            "var f = []; for (var i = 0; i < 50000; i++) f.push(function () {}); \
             var o = {}; for (var j = 0; j < 20000; j++) o['k' + j] = j; 0",
        ),
        (
            "static_reads_200k",
            "var p = { k: 1 }; var s = 0; for (var i = 0; i < 200000; i++) s += p.k; s",
        ),
        (
            "computed_reads_200k",
            "var p = { k: 1 }; var k = 'k'; var s = 0; for (var i = 0; i < 200000; i++) s += p[k]; s",
        ),
    ] {
        let (dt, computrons, result) = run(src);
        println!("AUDIT {label} seconds={dt:.3} computrons={computrons} result={result}");
    }
}
