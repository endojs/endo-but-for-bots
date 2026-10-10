use ironhorse_vm::{parse_symbols, Interp};
use std::fmt::Write;

pub const FUNCTIONS: &[&str] = &[
    "acos", "acosh", "asin", "asinh", "atan", "atanh", "cbrt", "cos", "cosh", "exp", "expm1",
    "log", "log1p", "log10", "log2", "sin", "sinh", "tan", "tanh", "atan2", "pow", "hypot", "abs",
    "ceil", "floor", "sqrt",
];

pub fn guest_bits(function: &str, arguments: &[u64]) -> u64 {
    // Construct arguments from bytes too: do not let decimal parsing become a
    // second variable in the provider comparison. Explicit big endian on both ends.
    let mut source = String::from("var d = new DataView(new ArrayBuffer(8));\n");
    for (i, bits) in arguments.iter().enumerate() {
        writeln!(
            source,
            "d.setUint32(0, {}); d.setUint32(4, {}); var a{i} = d.getFloat64(0);",
            bits >> 32,
            bits & 0xffff_ffff
        )
        .unwrap();
    }
    let args = (0..arguments.len())
        .map(|i| format!("a{i}"))
        .collect::<Vec<_>>()
        .join(",");
    writeln!(
        source,
        "d.setFloat64(0, Math.{function}({args})); d.getUint32(0) + ':' + d.getUint32(4)"
    )
    .unwrap();
    let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(
        outcome.completed,
        "{function}({arguments:x?}): {:?}",
        outcome.halt
    );
    let (high, low) = outcome.result.split_once(':').unwrap();
    (high.parse::<u64>().unwrap() << 32) | low.parse::<u64>().unwrap()
}

pub fn vector() -> Vec<(&'static str, Vec<u64>)> {
    let inputs = [
        f64::NAN,
        0.0,
        -0.0,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::from_bits(1),
        f64::MAX,
        -1.0,
        1.0,
        -2.0,
        2.0,
        0.7,
        1.7,
        -0.7,
        1.0e-20,
        1.0e20,
        std::f64::consts::PI,
        f64::from_bits(1.0f64.to_bits() - 1),
        f64::from_bits(1.0f64.to_bits() + 1),
    ];
    let mut cases = Vec::new();
    for &function in FUNCTIONS {
        for input in inputs {
            let mut args = vec![input.to_bits()];
            if matches!(function, "atan2" | "pow" | "hypot") {
                args.push(1.3f64.to_bits());
            }
            cases.push((function, args));
        }
        if matches!(function, "atan2" | "pow" | "hypot") {
            for x in inputs[..11].iter() {
                for y in inputs[..11].iter() {
                    cases.push((function, vec![x.to_bits(), y.to_bits()]));
                }
            }
        }
    }
    cases.push(("hypot", vec![]));
    cases.push((
        "hypot",
        vec![3.0f64.to_bits(), 4.0f64.to_bits(), 12.0f64.to_bits()],
    ));
    cases
}
