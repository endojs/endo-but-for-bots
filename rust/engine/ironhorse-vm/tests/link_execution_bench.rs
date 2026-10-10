//! Serial release controls for intrinsic linking and crank relinking.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
#[ignore = "serial linking timing control"]
fn link_execution() {
    assert!(!cfg!(debug_assertions));
    for (name, setup, source, expected) in [
        (
            "full_link",
            None,
            "JSON.stringify([Math.floor(1.5),Array.of(2)[0],new Uint8Array(1).length])",
            "[1,2,1]",
        ),
        (
            "growing_relink",
            Some("delete DataView.prototype[Symbol.toStringTag]; 0"),
            "var freshName=1; DataView.prototype[Symbol.toStringTag] === undefined",
            "true",
        ),
        (
            "template_relink",
            Some("var tag=a=>a; var saved=tag`x`; 0"),
            "var freshName=1; tag`x` === saved",
            "false",
        ),
    ] {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let symbols = parse_symbols(&symbols);
        let setup = setup.map(|source| {
            let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
            (code, parse_symbols(&symbols))
        });
        let mut times = Vec::new();
        let mut raw = None;
        for round in 0..6 {
            let mut elapsed = 0.0;
            for _ in 0..64 {
                let mut vm = Interp::new();
                if let Some((setup_code, setup_symbols)) = &setup {
                    vm.link_intrinsics(setup_symbols);
                    let outcome = vm.run(setup_code);
                    assert!(outcome.completed, "{name} setup: {:?}", outcome.halt);
                    assert_eq!(outcome.result, "0");
                }
                let start = Instant::now();
                let relinked = if setup.is_some() {
                    Some(vm.relink_crank(&code, &symbols).unwrap())
                } else {
                    vm.link_intrinsics(&symbols);
                    None
                };
                elapsed += start.elapsed().as_secs_f64();
                let outcome = vm.run(relinked.as_deref().unwrap_or(&code));
                assert!(outcome.completed, "{name}: {:?}", outcome.halt);
                assert_eq!(outcome.result, expected, "{name}");
                let actual = vm.meter_index();
                if let Some(old) = raw {
                    assert_eq!(actual, old, "{name}");
                }
                raw = Some(actual);
            }
            if round > 0 {
                times.push(elapsed);
            }
        }
        times.sort_by(f64::total_cmp);
        println!(
            "LINK_MODULE_METRIC {name} seconds={:.9} raw={} result={expected}",
            times[2],
            raw.unwrap()
        );
    }
}
