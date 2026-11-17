//! An anonymous function, arrow or class defined as a property, a class
//! element or a private element takes its name from the key (SetFunctionName),
//! `get `/`set ` prefixed for an accessor: the compiler flags the definition
//! with `XS_NAME_FLAG`, and the VM renames the value as XS's
//! `fxRenameFunction` does, only while its own `name` is still empty.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("the pinned XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
}

#[test]
fn object_literal_members_take_their_keys() {
    assert_result_agrees(
        "var s = Symbol('d'); var o = { a() {}, get b() { return 1; }, set b(v) {}, async c() {}, *d() {}, async *e() {}, ['f' + 1]() {}, [s]() {}, g: function () {}, h: () => {}, i: class {} }; var gd = Object.getOwnPropertyDescriptor(o, 'b'); [o.a.name, gd.get.name, gd.set.name, o.c.name, o.d.name, o.e.name, o.f1.name, o[s].name, o.g.name, o.h.name, o.i.name].join()",
        "a,get b,set b,c,d,e,f1,[d],g,h,i",
    );
    assert_result_agrees(
        "var o = { 'str key': function () {}, 1: () => {} }; [o['str key'].name, o[1].name].join()",
        "str key,1",
    );
    assert_result_agrees(
        "var o = { 0.5: function () {}, 1e21: () => {}, [-0]: () => {}, [2**32]: () => {}, [4294967294]: () => {} }; Object.keys(o).map(function (k) { return o[k].name; }).join('|')",
        "0|4294967294|0.5|1e+21|4294967296",
    );
    assert_result_agrees(
        "var s = Symbol(), t = Symbol(''), u = Symbol('x\\ud800'); var o = { [s]() {}, [t]: () => {}, [u]: function () {}, [Symbol.iterator]() {} }; [o[s].name, o[t].name, o[u].name.length, o[Symbol.iterator].name].join('|')",
        "|[]|4|[Symbol.iterator]",
    );
    assert_result_agrees(
        "var o = { m() {} }; [String(o.m), Object.getOwnPropertyNames(o.m).join()].join('|')",
        "function [\"m\"] (){[native code]}|length,name",
    );
}

#[test]
fn class_elements_take_their_keys() {
    assert_result_agrees(
        "class A { m() {} get g() { return 1; } static s() {} #p() {} t() { return [this.#p.name]; } } [A.prototype.m.name, Object.getOwnPropertyDescriptor(A.prototype, 'g').get.name, A.s.name, new A().t()].join()",
        "m,get g,s,#p",
    );
    assert_result_agrees(
        "class X { f = function () {}; static g = () => {}; #h = function () {}; ['k' + 1] = () => {}; hn() { return this.#h.name; } } var x = new X(); [x.f.name, X.g.name, x.hn(), x.k1.name].join()",
        "f,g,#h,k1",
    );
    assert_result_agrees(
        "class A { static #p() {} static get #q() { return 1; } static set #q(v) {} static t() { return [A.#p.name, Object.getOwnPropertyNames(A).join()].join(); } } A.t()",
        "#p,length,name,prototype,t",
    );
}

#[test]
fn a_value_that_is_not_an_anonymous_definition_keeps_its_name() {
    // Neither a parenthesized comma expression nor a variable is an anonymous
    // function definition, so neither is renamed, and no rename reaches a
    // function through another reference to it.
    assert_result_agrees(
        "[({ g: (0, function* () {}) }).g.name, (function () { var f = [function* () {}][0]; ({ g: f }); return f.name; })()].join('|')",
        "|",
    );
    assert_result_agrees(
        "var a = { a: function b() {} }, c = { c: class { static name() {} } }, e = { e: class { static name = 'z' } }, d = { d: (0, function () {}) }; [a.a.name, typeof c.c.name, e.e.name, d.d.name].join('|')",
        "b|function|z|",
    );
    assert_result_agrees(
        "[({ e: class { static name = '' } }).e.name, ({ g: class { static { Object.defineProperty(this, 'name', { value: 'q' }); } } }).g.name].join('|')",
        "|q",
    );
}

#[test]
fn binding_names_are_unchanged() {
    assert_result_agrees(
        "var x = function () {}; var y; y = () => {}; var z; z ??= function () {}; var { w = class {} } = {}; function f(p = function () {}) { return p.name; } [x.name, y.name, z.name, w.name, f()].join()",
        "x,y,z,w,p",
    );
}
