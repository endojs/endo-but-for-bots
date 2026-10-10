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

#[test]
fn with_environment_reads_and_writes_advance_once() {
    check("var o={x:3},n=0; with(o){n=x;x=7} n+o.x;", "10", 4083296);
}

#[test]
fn global_accessor_throw_reaches_variable_handler() {
    check("Object.defineProperty(globalThis,'dispatchGlobal',{get(){throw 3},set(v){throw v},configurable:true}); var n=0; try{dispatchGlobal;n=100}catch(e){n+=e} try{dispatchGlobal=7;n=100}catch(e){n+=e} n;", "10", 9544088);
}

#[test]
fn iterator_method_throw_reaches_outer_handler() {
    check(
        "var o={[Symbol.iterator](){throw 7}},n=0; try{for(var x of o){n=100}}catch(e){n=e} n+1;",
        "8",
        6264416,
    );
}

#[test]
fn unbound_typeof_keeps_its_exception() {
    check("var n=typeof dispatchUnboundName; var caught=0; try{dispatchUnboundName}catch(e){caught=e instanceof ReferenceError?1:2} n+':'+caught;", "undefined:1", 5230008);
}

#[test]
fn private_accessors_preserve_receiver_and_throw_identity() {
    check("class C { #x=3; get #y(){throw this.#x} set #y(v){this.#x=v} run(){this.#y=7;try{return this.#y}catch(e){return e}} } new C().run();", "7", 11110376);
}

#[test]
fn super_accessors_keep_this_and_propagate_throws() {
    check("class A {get x(){throw this.y} set x(v){this.y=v}} class B extends A {run(){super.x=7;try{return super['x']}catch(e){return e}}} new B().run();", "7", 11717224);
}

#[test]
fn numeric_coercion_and_membership_preserve_throws() {
    check("var o={[Symbol.toPrimitive](){throw 3}},p=new Proxy({}, {has(){throw 7}}),n=0; try{o++;n=100}catch(e){n+=e} try{'x' in p;n=100}catch(e){n+=e} n;", "10", 10167464);
}

#[test]
fn getter_from_an_earlier_crank_unwinds_to_the_current_buffer() {
    let mut vm = Interp::new();
    let (code, symbols) =
        ironhorse_compile::compile_atoms("var dispatchObject={get x(){throw 9}};")
            .expect("compiles");
    vm.link_intrinsics(&parse_symbols(&symbols));
    assert!(vm.run(&code).completed);
    let (code, symbols) =
        ironhorse_compile::compile_atoms("var n=0;try{dispatchObject.x;n=100}catch(e){n=e}n+1;")
            .expect("compiles");
    let code = vm
        .relink_crank(&code, &parse_symbols(&symbols))
        .expect("relinks");
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "10");
}
