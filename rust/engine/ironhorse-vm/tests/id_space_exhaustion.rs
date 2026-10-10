//! F075: novel guest keys stop at a catchable ceiling, before hard poisoning.
use ironhorse_vm::{parse_symbols, Interp};

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, parse_symbols(&s))
}

#[test]
fn json_key_exhaustion_preserves_existing_keys_and_engine_headroom() {
    let mut json = String::from("{");
    for i in 0..66_000u32 {
        if i > 0 {
            json.push(',');
        }
        json.push_str(&format!("\"k{i}\":0"));
    }
    json.push('}');
    let source = format!(
        r#"
        var existing={{known:7}}; var caught=0;
        try {{ JSON.parse('{json}'); }} catch(e) {{
            if (!(e instanceof RangeError)) throw e;
            caught++;
        }}
        for (var attempt=0; attempt<5; attempt++) {{
            try {{ existing['novel' + attempt]=1; }} catch(e) {{
                if (!(e instanceof RangeError)) throw e;
                caught++;
            }}
        }}
        try {{ existing[Symbol()]=1; }} catch(e) {{
            if (!(e instanceof RangeError)) throw e;
            caught++;
        }}
        try {{ Object.defineProperty([], '90000', {{get:function(){{return 1;}}}}); }} catch(e) {{
            if (!(e instanceof RangeError)) throw e;
            caught++;
        }}
        if (new Proxy(existing, {{}}).known !== 7) throw new Error('proxy');
        existing.known++;
        // Deferred intrinsic materialization and error construction retain ids.
        if (Object.getOwnPropertyNames(Array).length < 1) throw new Error('intrinsics');
        caught + ':' + existing.known
    "#
    );
    let (code, names) = compile(&source);
    let mut vm = Interp::new();
    vm.link_intrinsics(&names);
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "8:8");
    assert!(
        vm.is_quiescent(),
        "a caught soft refusal must remain persistable"
    );
    assert!(vm.program_symbol_names().len() < u16::MAX as usize - 512);
    let before = vm.program_symbol_names().len();
    let (code, names) = compile("existing.known++; existing.known");
    let code = vm.relink_crank(&code, &names).unwrap();
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "9");
    assert_eq!(vm.program_symbol_names().len(), before);
}
