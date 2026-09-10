//! F135/F188: forward and reverse property identities agree across GC and reuse.
use ironhorse_vm::{parse_symbols, Interp};

fn run(vm: &mut Interp, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let code = vm.relink_crank(&code, &parse_symbols(&symbols)).unwrap();
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    out.result
}

#[test]
fn reflection_keeps_symbol_identity_and_utf16_names_after_collection() {
    let mut vm = Interp::new();
    assert_eq!(
        run(
            &mut vm,
            r#"
        var keep = {}, symbols = [];
        for (var i=0;i<300;i++) {
            var s = Symbol('same');
            keep[s] = i;
            symbols.push(s);
            var dead = {}; dead[Symbol('dead')] = i;
        }
        dead = null; s = null;
        keep['\ud800'] = 1; keep['plain'] = 2; keep[3] = 3;
        Reflect.ownKeys(keep).length
    "#
        ),
        "303"
    );
    for _ in 0..2 {
        vm.collect_garbage().expect("quiescent collection succeeds");
        assert_eq!(
            run(
                &mut vm,
                r#"
            var fresh = {};
            for(var j=0;j<300;j++) fresh[Symbol('fresh')] = j;
            var keys = Reflect.ownKeys(keep);
            var ok = keys[0] === '3' && keys[1] === '\ud800' && keys[2] === 'plain';
            for(var k=0;k<300;k++) ok = ok && keys[k+3] === symbols[k] && keep[keys[k+3]] === k;
            ok && Object.keys(keep).length === 3 && Object.getOwnPropertySymbols(keep).length === 300
        "#
            ),
            "true"
        );
    }
}
