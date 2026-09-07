//! Intrinsic reflection and constructor probes exercised by the SES bootstrap.
use ironhorse_vm::{parse_symbols, Interp};

struct Compiler;
impl ironhorse_vm::SourceCompiler for Compiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        ironhorse_compile::compile_atoms_with(source, strict)
            .map(|(bytecode, symbols)| ironhorse_vm::CompiledSource { bytecode, symbols })
            .map_err(|e| ironhorse_vm::SourceCompileError::Syntax(e.to_string()))
    }
}

fn result(source: &str) -> String {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn({
            let source = source.to_string();
            move || {
                let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
                let mut machine = Interp::new();
                machine.set_source_compiler(std::rc::Rc::new(Compiler));
                machine.link_intrinsics(&parse_symbols(&symbols));
                let outcome = machine.run(&code);
                assert!(outcome.completed, "{:?}", outcome.halt);
                outcome.result
            }
        })
        .unwrap()
        .join()
        .unwrap()
}

#[test]
fn buffer_accessors_can_be_captured_and_brand_check_the_receiver() {
    assert_eq!(
        result(
            r#"
        var b = new ArrayBuffer(12), v = new DataView(b, 3, 5);
        var get = (p, n) => Object.getOwnPropertyDescriptor(p, n).get;
        var a = get(ArrayBuffer.prototype, 'byteLength');
        var d = get(DataView.prototype, 'byteLength');
        var o = get(DataView.prototype, 'byteOffset');
        var r = get(DataView.prototype, 'buffer');
        var caught = 0;
        for (var f of [a, d, o, r]) { try { f.call({}) } catch(e) { caught += e instanceof TypeError; } }
        [a.call(b), d.call(v), o.call(v), r.call(v) === b, caught].join(':')
    "#
        ),
        "12:5:3:true:4"
    );
}

#[test]
fn generator_function_prototype_exposes_the_shared_generator_prototype() {
    assert_eq!(
        result(
            r#"
        var f = function*() { yield 42; };
        var p = Object.getPrototypeOf(f);
        var d = Object.getOwnPropertyDescriptor(p, 'prototype');
        [d.value === Object.getPrototypeOf(f.prototype), d.writable, d.enumerable,
         d.configurable, p.prototype.next.call(f()).value].join(':')
    "#
        ),
        "true:false:false:true:42"
    );
}

#[test]
fn collection_constructor_detection_throws_catchable_type_errors() {
    assert_eq!(
        result(
            r#"
        var n = 0;
        for (var C of [Map, Set, WeakMap, WeakSet]) {
            try { C(); } catch(e) { n += e instanceof TypeError; }
            var c = new C();
            n += typeof c === 'object';
        }
        n
    "#
        ),
        "8"
    );
}

#[test]
fn in_links_computed_intrinsic_names_without_resurrecting_deleted_members() {
    assert_eq!(
        result(
            r#"
        var name = 'to' + 'String';
        var before = name in {};
        delete Object.prototype[name];
        var after = name in {};
        [before, after, 'ent' + 'ries' in new Map()].join(':')
    "#
        ),
        "true:false:true"
    );
}

#[test]
fn short_eval_does_not_lower_the_intrinsic_install_floor() {
    assert_eq!(
        result(
            r#"
        var p = Iterator.prototype;
        var old = Reflect.ownKeys(p);
        for (var key of old) { if(key !== Symbol.iterator) delete p[key]; }
        (0, eval)('1');
        Reflect.ownKeys(p).map(String).join(',')
    "#
        ),
        "Symbol(Symbol.iterator)"
    );
}

#[test]
fn async_generator_inherits_a_distinct_async_iterator_prototype() {
    assert_eq!(
        result(
            r#"
        var f = async function*() {};
        var g = Object.getPrototypeOf(f).prototype;
        var p = Object.getPrototypeOf(g);
        var o = {};
        [p !== Object.prototype, Object.getPrototypeOf(p) === Object.prototype,
         p[Symbol.asyncIterator].call(o) === o].join(':')
    "#
        ),
        "true:true:true"
    );
}

#[test]
fn computed_compound_assignment_preserves_reference_and_evaluates_key_once() {
    assert_eq!(
        result(
            r#"
        var o = {n: 3}, calls = 0;
        var key = () => { calls++; return 'n'; };
        var a = o[key()] += 4;
        var b = o[key()] ||= 99;
        var c = o[key()] &&= 11;
        [a, b, c, o.n, calls].join(':')
    "#
        ),
        "7:7:11:11:3"
    );
}

#[test]
fn intrinsic_reflection_materializes_symbol_keys_before_freeze() {
    assert_eq!(result(r#"
        const prototype = Array.prototype;
        const keys = Reflect.ownKeys(prototype);
        const symbol = Symbol.unscopables;
        const present = keys.includes(symbol);
        delete prototype[symbol];
        Object.freeze(prototype);
        const before = Reflect.ownKeys(prototype).length;
        eval("Array.prototype[Symbol.unscopables]; Array.prototype['to' + 'Sorted'];");
        [present, Object.isFrozen(prototype), prototype[symbol] === undefined,
         Reflect.ownKeys(prototype).length === before].join(':')
    "#), "true:true:true:true");
}

#[test]
fn later_intrinsic_linking_preserves_frozen_descriptors() {
    assert_eq!(result(r#"
        const protos = [Array.prototype, Error.prototype,
          Object.getPrototypeOf((async function* () {})()).constructor.prototype];
        protos.forEach(Object.freeze);
        const before = protos.map(p => Reflect.ownKeys(p).length);
        eval("new Intl.NumberFormat(); Object.getOwnPropertyDescriptor(Error.prototype, 'stack');");
        protos.map((p, i) => Object.isFrozen(p) && Reflect.ownKeys(p).length === before[i]).join(':')
    "#), "true:true:true");
}

#[test]
fn frozen_global_is_not_extended_by_computed_intrinsic_names() {
    assert_eq!(result(r#"
        (() => {
            const global = globalThis;
            Object.freeze(global);
            const count = Reflect.ownKeys(global).length;
            const name = ['Weak', 'Set'].join('');
            const constructor = global[name];
            return [typeof constructor, Object.isFrozen(global), Reflect.ownKeys(global).length === count].join(':');
        })()
    "#), "function:true:true");
}
