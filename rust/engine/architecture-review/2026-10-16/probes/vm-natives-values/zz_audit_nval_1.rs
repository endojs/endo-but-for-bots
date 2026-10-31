//! TEMPORARY audit probe (NVAL). Measures computrons charged vs wall time for
//! value built-ins whose work may not be metered proportionally.
use ironhorse_vm::Interp;
use std::time::Instant;

fn run(label: &str, src: &str) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    let names = ironhorse_vm::parse_symbols(&s);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let t = Instant::now();
    let out = m.run(&b);
    let ms = t.elapsed().as_secs_f64() * 1e3;
    println!(
        "{label:<14} completed={} computrons={:>12} ms={:>9.1} computrons/ms={:>10.1} halt={:?}",
        out.completed,
        out.computrons,
        ms,
        out.computrons as f64 / ms.max(0.001),
        if out.completed { None } else { Some(&out.halt) }
    );
}

#[test]
fn nval_metering_ratios() {
    run(
        "baseline-loop",
        "var x = 0; for (var i = 0; i < 3000000; i++) { x = (x + i) | 0; } x",
    );
    run(
        "baseline-str",
        "var n = 0; for (var i = 0; i < 300000; i++) { n += ('ab' + i).length; } n",
    );
    run(
        "bigint-mul",
        "var x = (1n << 65000n) - 1n; for (var i = 0; i < 5; i++) x = x * x; x > 0n",
    );
    run(
        "bigint-div",
        "var x = (1n << 65000n) - 1n; x = x * x * x * x; var y = (1n << 64000n) + 12345n; (x / y) > 0n",
    );
    run(
        "String(big)",
        "var x = (1n << 65000n) - 1n; x = x * x * x * x; String(x).length",
    );
    run(
        "big.toString",
        "var x = (1n << 65000n) - 1n; x = x * x * x * x; x.toString().length",
    );
    run(
        "BigInt(str)",
        "var s = '7'.repeat(200000); BigInt(s) > 0n",
    );
    run(
        "1n<str",
        "var s = '7'.repeat(200000); 1n < s",
    );
    run(
        "includes",
        "var h = 'a'.repeat(40000); var n = 'a'.repeat(20000) + 'b'; h.includes(n)",
    );
    run(
        "indexOf",
        "var h = 'a'.repeat(40000); var n = 'a'.repeat(20000) + 'b'; h.indexOf(n)",
    );
    run(
        "json-replacer",
        "var k = []; for (var i = 0; i < 10000; i++) k.push('k' + i); JSON.stringify({}, k)",
    );
    run(
        "json-deep",
        "var v = 'x'.repeat(1 << 20); for (var i = 0; i < 2000; i++) v = [v]; JSON.stringify(v).length",
    );
    run(
        "json-shallow",
        "var v = 'x'.repeat(1 << 20); v = [v]; JSON.stringify(v).length",
    );
    run(
        "localeCompare",
        "var a = '\\u00e9'.repeat(1000000), b = '\\u00e9'.repeat(999999) + 'f'; var r = 0; for (var i = 0; i < 10; i++) r += a.localeCompare(b); r",
    );
    run(
        "concat-15000",
        "var s = ''; for (var i = 0; i < 15000; i++) { s += 'x'; } s.length",
    );
}
