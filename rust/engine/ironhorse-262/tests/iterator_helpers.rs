//! XS-differential regressions for the Iterator global's reflective surface
//! and the shared `%IteratorPrototype%` inherited by built-in iterators.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

fn assert_ironhorse_result(source: &str, expected: &str) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    let run = ironhorse_vm::run_program_with_symbols(&bytecode, &symbols);
    assert!(
        run.completed,
        "IronHorse must complete {source:?}: {:?}",
        run.halt
    );
    assert_eq!(run.result, expected, "IronHorse result for {source:?}");
}

#[test]
fn iterator_constructor_and_helpers_have_specified_metadata() {
    for source in [
        "Iterator.name + ':' + Iterator.length",
        "Iterator.from.name + ':' + Iterator.from.length",
        "Iterator.prototype.map.name + ':' + Iterator.prototype.map.length",
        "Iterator.prototype.filter.name + ':' + Iterator.prototype.filter.length",
        "Iterator.prototype.take.name + ':' + Iterator.prototype.take.length",
        "Iterator.prototype.drop.name + ':' + Iterator.prototype.drop.length",
        "Iterator.prototype.flatMap.name + ':' + Iterator.prototype.flatMap.length",
        "Iterator.prototype.reduce.name + ':' + Iterator.prototype.reduce.length",
        "Iterator.prototype.toArray.name + ':' + Iterator.prototype.toArray.length",
        "Iterator.prototype.forEach.name + ':' + Iterator.prototype.forEach.length",
        "Iterator.prototype.some.name + ':' + Iterator.prototype.some.length",
        "Iterator.prototype.every.name + ':' + Iterator.prototype.every.length",
        "Iterator.prototype.find.name + ':' + Iterator.prototype.find.length",
    ] {
        agrees(source);
    }
}

#[test]
fn iterator_prototype_accessors_have_es2025_metadata_and_behavior() {
    for source in [
        "var d = Object.getOwnPropertyDescriptor(Iterator.prototype, 'constructor'); \
         [d.get.name, d.get.length, d.set.name, d.set.length, d.enumerable, \
          d.configurable, d.get.call(null) === Iterator].join(':')",
        "var d = Object.getOwnPropertyDescriptor(Iterator.prototype, Symbol.toStringTag); \
         [d.get.name, d.get.length, d.set.name, d.set.length, d.enumerable, \
          d.configurable, d.get.call(null)].join(':')",
        "var q = Object.getPrototypeOf([][Symbol.iterator]()); \
         delete q[Symbol.toStringTag]; Object.prototype.toString.call([][Symbol.iterator]())",
        "var p = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); \
         p.constructor.name",
        "var d = Object.getOwnPropertyDescriptor(Iterator.prototype, 'constructor'); \
         var ok = false; try { d.set.call(1, 2); } \
         catch (e) { ok = e instanceof TypeError; } ok",
        "var ok = false; try { Iterator.prototype.constructor = 1; } \
         catch (e) { ok = e instanceof TypeError; } ok",
        "var ok = false; try { Iterator.prototype[Symbol.toStringTag] = 'X'; } \
         catch (e) { ok = e instanceof TypeError; } ok",
        "var seen = 0; var o = Object.create(Iterator.prototype); \
         Object.defineProperty(o, 'constructor', { set: function (v) { seen = v; } }); \
         var d = Object.getOwnPropertyDescriptor(Iterator.prototype, 'constructor'); \
         d.set.call(o, 9); seen",
        "var target = { constructor: 1 }; var p = new Proxy(target, {}); \
         var d = Object.getOwnPropertyDescriptor(Iterator.prototype, 'constructor'); \
         d.set.call(p, 9); target.constructor",
        "var p = new Proxy({}, { \
           getOwnPropertyDescriptor: function () { return undefined; }, \
           defineProperty: function () { return false; } \
         }); var d = Object.getOwnPropertyDescriptor(Iterator.prototype, 'constructor'); \
         var ok = false; try { d.set.call(p, 9); } \
         catch (e) { ok = e instanceof TypeError; } ok",
    ] {
        agrees(source);
    }
}

#[test]
fn inherited_iterator_setters_create_ordinary_data_properties() {
    // XS 9.0 currently creates these properties with all attributes false,
    // contrary to ES2025's CreateDataPropertyOrThrow step. Keep the direct
    // engine regression on the standard result rather than baking that oracle
    // bug into IronHorse.
    assert_ironhorse_result(
        "var o = Object.create(Iterator.prototype); o.constructor = 42; \
         var d = Object.getOwnPropertyDescriptor(o, 'constructor'); \
         [d.value, d.writable, d.enumerable, d.configurable].join(':')",
        "42:true:true:true",
    );
    assert_ironhorse_result(
        "var o = Object.create(Iterator.prototype); o[Symbol.toStringTag] = 'Custom'; \
         var d = Object.getOwnPropertyDescriptor(o, Symbol.toStringTag); \
         [Object.prototype.toString.call(o), d.writable, d.enumerable, \
          d.configurable].join(':')",
        "[object Custom]:true:true:true",
    );
    assert_ironhorse_result(
        "var o = Object.create(Iterator.prototype); \
         Object.defineProperty(o, 'constructor', { value: 1, writable: false }); \
         var d = Object.getOwnPropertyDescriptor(Iterator.prototype, 'constructor'); \
         var ok = false; try { d.set.call(o, 2); } \
         catch (e) { ok = e instanceof TypeError; } ok + ':' + o.constructor",
        "true:1",
    );
}

#[test]
fn built_in_iterators_inherit_iterator_prototype() {
    agrees("[].values().map === Iterator.prototype.map");
    agrees("new Map().entries().map === Iterator.prototype.map");
    agrees("new Set().values().map === Iterator.prototype.map");
    agrees("var i = [1].values(); Iterator.from(i) === i");
    agrees("var i = new Map().entries(); Iterator.from(i) === i");
    agrees("var i = new Set().values(); Iterator.from(i) === i");
}

#[test]
fn iterator_constructor_is_abstract() {
    agrees("var ok = false; try { Iterator(); } catch (e) { ok = e instanceof TypeError; } ok");
    agrees("var ok = false; try { new Iterator(); } catch (e) { ok = e instanceof TypeError; } ok");
}

#[test]
fn to_array_consumes_intrinsic_iterators() {
    agrees("[1, 2, 3].values().toArray().join(',')");
    agrees("new Set([1, 2]).values().toArray().join(',')");
    agrees("new Map([[1, 'a'], [2, 'b']]).keys().toArray().join(',')");
    agrees("var i = [1, 2].values(); i.next(); i.toArray().join(',')");
    agrees("var ok = false; try { Iterator.prototype.toArray.call(1); } catch (e) { ok = e instanceof TypeError; } ok");
}
