//! Index-property attributes across a checkpoint and a resume (Thixotrope
//! harness C-16).
//!
//! The defect itself was in the VM (a `const` binding's flag reached the
//! element `Array.prototype.push` created), but it showed in a vat whose
//! array was pushed in one crank and spliced in a later one, possibly after
//! the vat slept and woke. So each element shape is built in the first crank
//! from `const` bindings and observed after eager and lazy resume, which the
//! twin helper also requires to agree with an uninterrupted machine on value
//! and metering.

#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank, sig, twin};

use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_vm::Interp;

const FIRST: &str = "var a = 0; var o = 0; var r = 0; var s = 0; var t = 0; \
     (function () { 'use strict'; \
       const x = {x: 1}; const y = {y: 1}; \
       a = []; a.push(x, y, 3); a[3] = x; a.unshift(y); \
       o = {}; o[0] = x; o[1] = y; \
       r = [x, y, 3]; Object.defineProperty(r, 1, {writable: false}); \
       Object.defineProperty(r, 2, {enumerable: false}); \
       s = [x, y]; Object.seal(s); \
       const holder = {a, o, x}; Object.freeze(holder); Object.freeze(x); \
     })(); t = 7; t";

const ATTRS: &str = "var attrs = function (v) { \
       return Reflect.ownKeys(v).map(function (k) { \
         var d = Object.getOwnPropertyDescriptor(v, k); \
         return String(k) + ':' + (d.writable ? 'w' : '-') + (d.enumerable ? 'e' : '-') + \
           (d.configurable ? 'c' : '-'); }).join(' '); };";

fn observe(body: &str) -> String {
    format!("var a; var o; var r; var s; var t; {ATTRS} t = (function () {{ 'use strict'; {body} }})(); t")
}

#[test]
fn elements_from_const_bindings_stay_plain_across_resume() {
    let observations = [
        observe("return attrs(a);"),
        observe("return attrs(o);"),
        observe("return attrs(r);"),
        observe("return attrs(s);"),
        // The queue's failing operation, in a crank after the resume.
        observe("a.splice(1, 1); a.shift(); a[0] = 0; return a.length + ' ' + attrs(a);"),
        observe("o[0] = 0; delete o[1]; return attrs(o);"),
        // Explicit attributes still refuse after the resume.
        observe("var w = 'ok'; try { r[1] = 0; } catch (e) { w = 'threw'; } return w + ' ' + attrs(r);"),
        observe("var w = 'ok'; try { s.splice(0, 1); } catch (e) { w = 'threw'; } return w + ' ' + attrs(s);"),
        observe("s[0] = 9; return String(s[0]) + ' ' + attrs(s);"),
    ];
    let observations: Vec<&str> = observations.iter().map(String::as_str).collect();
    let mut store = MemoryStore::new();
    let seen = twin(FIRST, &observations, &mut store);
    let results: Vec<&str> = seen.iter().map(|row| row.2.as_str()).collect();
    assert_eq!(
        results,
        [
            "0:wec 1:wec 2:wec 3:wec 4:wec length:w--",
            "0:wec 1:wec",
            "0:wec 1:-ec 2:w-c length:w--",
            "0:we- 1:we- length:w--",
            "3 0:wec 1:wec 2:wec length:w--",
            "0:wec",
            "threw 0:wec 1:-ec 2:w-c length:w--",
            "threw 0:we- 1:we- length:w--",
            "9 0:we- 1:we- length:w--",
        ]
    );
}

#[test]
fn element_attributes_survive_a_blob_round_trip() {
    let (bytecode, names) = compile(FIRST);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut blob = from_snapshot_bytes(&bytes, &sig()).expect("blob restore");
    for (body, expected) in [
        (
            "return attrs(a);",
            "0:wec 1:wec 2:wec 3:wec 4:wec length:w--",
        ),
        ("return attrs(r);", "0:wec 1:-ec 2:w-c length:w--"),
        ("return attrs(s);", "0:we- 1:we- length:w--"),
        (
            "a.splice(0, 2); return attrs(a);",
            "0:wec 1:wec 2:wec length:w--",
        ),
    ] {
        let (completed, halt, result, _) = crank(&mut blob, &observe(body));
        assert!(completed, "{body}: {halt}");
        assert_eq!(result, expected, "{body}");
    }
}
