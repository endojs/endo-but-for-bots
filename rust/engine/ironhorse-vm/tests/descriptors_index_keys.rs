//! `Object.getOwnPropertyDescriptors` keeps canonical array indices as
//! indices: copying the descriptors of a TypedArray or an Array mints no name
//! per element in the machine's 16-bit key table.
//!
//! SES `harden` calls it on every TypedArray it freezes, and Thixotrope
//! hardens every inbound frame's bytes, so a vat used to intern one name per
//! byte it ever received and halt near 58 KB ("property key space
//! exhausted"); see the Thixotrope harness journal, J-0140 and J-0190. The
//! last test runs the real SES boot (`packages/thixotrope/dist-ironhorse`),
//! when it has been built.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Halt, Interp};

struct Cranks {
    machine: Interp,
}

impl Cranks {
    fn new() -> Self {
        let mut machine = Interp::new();
        machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
        Cranks { machine }
    }

    fn run(&mut self, source: &str) -> Result<String, Halt> {
        let machine = &mut self.machine;
        let (code, symbols) =
            ironhorse_compile::compile_atoms_goal(source, ironhorse_compile::Goal::Script, false)
                .expect("compiles");
        let names = parse_symbols(&symbols);
        let code = if machine.program_symbol_names().is_empty() {
            machine.link_intrinsics(&names);
            code
        } else {
            machine.relink_crank(&code, &names).expect("relinks")
        };
        let outcome = machine.run(&code);
        if outcome.completed {
            Ok(outcome.result)
        } else {
            Err(outcome.halt)
        }
    }

    fn eval(&mut self, source: &str) -> String {
        match self.run(source) {
            Ok(result) => result,
            Err(halt) => panic!("{source:.80}: {halt:?}"),
        }
    }
}

fn on_big_stack<F: FnOnce() + Send + 'static>(f: F) {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap();
}

/// How many fresh names the key table still takes, interned one crank.
const CAPACITY: &str = "{ let o = {}, i = 0; \
  try { for (;;i++) o['zq' + i] = 1; } catch (e) { i = i + ' ' + e.message; } String(i) }";

fn capacity(m: &mut Cranks) -> usize {
    let out = m.eval(CAPACITY);
    let (count, rest) = out.split_once(' ').expect("the table filled up");
    assert_eq!(rest, "property key space exhausted");
    count.parse().unwrap()
}

#[test]
fn descriptors_of_typed_arrays_and_arrays_mint_no_index_names() {
    on_big_stack(|| {
        let mut fresh = Cranks::new();
        fresh.eval("0");
        let room = capacity(&mut fresh);

        let mut m = Cranks::new();
        assert_eq!(
            m.eval(
                "{ const t = new Uint8Array(70000); t[69999] = 7; \
                 const d = Object.getOwnPropertyDescriptors(t); \
                 [Reflect.ownKeys(d).length, Reflect.ownKeys(d).slice(0, 3).join(), \
                  JSON.stringify(d[69999])].join('|') }"
            ),
            "70000|0,1,2|{\"value\":7,\"writable\":true,\"enumerable\":true,\"configurable\":true}"
        );
        assert_eq!(
            m.eval(
                "{ const a = Array.from({ length: 40000 }, (_, i) => i); \
                 const e = Object.getOwnPropertyDescriptors(a); \
                 [Reflect.ownKeys(e).length, JSON.stringify(e[42]), e.length.writable].join('|') }"
            ),
            "40001|{\"value\":42,\"writable\":true,\"enumerable\":true,\"configurable\":true}|true"
        );
        assert_eq!(
            m.eval(
                "{ const t = new Uint8Array(40000); t[39999] = 9; \
                 const p = Object.getOwnPropertyDescriptors(new Proxy(t, {})); \
                 [Reflect.ownKeys(p).length, p['39999'].value].join('|') }"
            ),
            "40000|9"
        );
        // 150,000 index descriptors later, the table has the room it had
        // (less the few names this program spelled).
        let left = capacity(&mut m);
        assert!(left + 64 >= room, "fresh {room}, after {left}");
    });
}

#[test]
fn descriptors_keep_ordinary_key_order_and_named_indices() {
    on_big_stack(|| {
        let mut m = Cranks::new();
        assert_eq!(
            m.eval(
                "const o = { b: 1, 2: 'x', a: 2, 1: 'y', [Symbol.for('s')]: 3 }; \
                 o['5'] = 'named'; \
                 const d = Object.getOwnPropertyDescriptors(o); \
                 [Reflect.ownKeys(d).map(String).join(), d[5].value, d['1'].value, \
                  d.b.value, d[Symbol.for('s')].value, Object.keys(d).join()].join('|')"
            ),
            "1,2,5,b,a,Symbol(s)|named|y|1|3|1,2,5,b,a"
        );
    });
}

#[test]
fn hardening_a_typed_array_after_the_ses_boot_mints_no_index_names() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/thixotrope/dist-ironhorse/boot.js"
    );
    let Ok(boot) = std::fs::read_to_string(path) else {
        eprintln!("descriptors: {path} absent; build the Thixotrope bundles to run this");
        return;
    };
    on_big_stack(move || {
        let mut m = Cranks::new();
        assert_eq!(
            m.eval(&format!(
                "var __e; try {{ {boot} }} catch (e) {{ __e = e; }} __e ? 'ERROR ' + __e : 'ok'"
            )),
            "ok"
        );
        assert_eq!(
            m.eval("harden(new Uint8Array(24576)); harden(new Uint8Array(60000)); 'ok'"),
            "ok"
        );
        // Before the fix the second harden alone filled the table.
        assert!(capacity(&mut m) > 40_000);
    });
}
