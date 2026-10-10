//! The numeric operator and Math builtin use one release-selected provider.
use ironhorse_vm::{parse_symbols, Interp, MATH_PROVIDER};

#[test]
fn exponentiation_uses_the_same_provider_as_math_pow() {
    let (code, symbols) = ironhorse_compile::compile_atoms(
        "var x=0.7, y=1.3; var d=new DataView(new ArrayBuffer(8)); d.setFloat64(0,x**y); var hi=d.getUint32(0),lo=d.getUint32(4); d.setFloat64(0,Math.pow(x,y)); hi===d.getUint32(0)&&lo===d.getUint32(4)",
    ).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "true");
    assert_eq!(
        MATH_PROVIDER,
        if cfg!(feature = "deterministic-math") {
            "libm-0.2.16-soft"
        } else {
            "platform"
        }
    );
    if let Some(path) = std::env::var_os("IRONHORSE_BOOT_IDENTITY") {
        std::fs::write(path, Interp::boot_fingerprint()).unwrap();
    }
}
