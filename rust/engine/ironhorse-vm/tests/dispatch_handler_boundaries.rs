//! Oracle-free receipts and control-transfer regressions for extracted opcodes.
//! Raw receipts captured on 0bee5c0ea before extraction; guest results are
//! independent semantic expectations, not comparisons between two new paths.
use ironhorse_vm::{parse_symbols, Interp};

fn check(source: &str, expected: &str, raw: u64) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, expected);
    assert_eq!(vm.meter_index(), raw);
}

#[test]
fn sloppy_nonwritable_length_advances_once() {
    check("var a=[1,2]; Object.defineProperty(a,'length',{writable:false}); var x=(a.length=7); x+a.length;", "9", 5213376);
}

#[test]
fn accessor_definition_advances_once() {
    check(
        "var o={get x(){return 3},set x(v){this.y=v}}; o.x=7; o.x+o.y;",
        "10",
        4514744,
    );
}

#[test]
fn getter_unwind_reaches_outer_callback_handler() {
    check("var o={get x(){throw 7}}; var n=0; try {[1].map(function(){return o.x}); n=100;} catch(e){n=e;} n+1;", "8", 7644928);
}

#[test]
fn setter_unwind_stops_assignment_and_resumes_catch() {
    check(
        "var o={set x(v){throw v}}; var n=0; try {o.x=7; n=100;} catch(e){n=e;} n+1;",
        "8",
        5691544,
    );
}

#[test]
fn proxy_get_set_and_delete_preserve_thrown_values() {
    check("var p=new Proxy({}, {get(){throw 2},set(){throw 3},deleteProperty(){throw 5}}); var n=0; try{p.x;n=100}catch(e){n+=e} try{p.x=1;n=100}catch(e){n+=e} try{delete p.x;n=100}catch(e){n+=e} n;", "10", 12315864);
}

#[test]
fn strict_failed_write_reaches_handler() {
    check("'use strict'; var a=[1]; Object.defineProperty(a,'length',{writable:false}); var n=0; try{a.length=7;n=100}catch(e){n=e instanceof TypeError?3:4} n+a.length;", "4", 7868560);
}

#[test]
fn computed_definition_and_delete_continue_once() {
    check("var key='x'; var o={[key]:3}; var a=[1,2]; var n=delete o[key]; n+=(delete a[0]); n+o.hasOwnProperty(key)+a.hasOwnProperty(0);", "2", 7050304);
}
