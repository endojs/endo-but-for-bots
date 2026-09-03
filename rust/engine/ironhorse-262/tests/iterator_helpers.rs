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
    agrees("function* g() { yield 1; yield 2; } g().toArray().join(',')");
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
fn iterator_constructor_supports_derived_construction() {
    for source in [
        "class I extends Iterator { next() { return { done: true }; } } var i = new I(); i instanceof I && i instanceof Iterator",
        "class I extends Iterator { constructor() { super(); this.n = 0; } next() { return this.n < 3 ? { value: ++this.n } : { done: true }; } } new I().reduce(function (a, v) { return a + v; }, 10)",
        "function C() {} C.prototype = null; var i = Reflect.construct(Iterator, [], C); Object.getPrototypeOf(i) === Iterator.prototype",
        "var ok = false; try { Reflect.construct(Iterator, []); } catch (e) { ok = e instanceof TypeError; } ok",
    ] {
        agrees(source);
    }
}

#[test]
fn to_array_consumes_intrinsic_iterators() {
    agrees("[1, 2, 3].values().toArray().join(',')");
    agrees("new Set([1, 2]).values().toArray().join(',')");
    agrees("new Map([[1, 'a'], [2, 'b']]).keys().toArray().join(',')");
    agrees("var i = [1, 2].values(); i.next(); i.toArray().join(',')");
    agrees("var ok = false; try { Iterator.prototype.toArray.call(1); } catch (e) { ok = e instanceof TypeError; } ok");
}

#[test]
fn eager_helpers_drive_generic_direct_iterators() {
    for source in [
        "var i=Object.create(Iterator.prototype);i.n=0;i.next=function(){return this.n<3?{value:++this.n,done:false}:{done:true}};var log=[];var r=i.reduce(function(a,v,k){log.push(k);return a+v},10);r+':'+log.join(',')",
        "var i=Object.create(Iterator.prototype);i.n=0;i.next=function(){return this.n<3?{value:++this.n,done:false}:{done:true}};var log=[];var r=i.reduce(function(a,v,k){log.push(k);return a+v});r+':'+log.join(',')",
        "var gets=0;var i=Object.create(Iterator.prototype);i.n=0;Object.defineProperty(i,'next',{get:function(){gets++;return function(){return this.n<2?{value:++this.n}:{done:true}}}});i.toArray().join(',')+':'+gets",
        "var i=Object.create(Iterator.prototype);i.n=0;i.next=function(){return this.n<3?{value:++this.n}:{done:true}};var log=[];var r=i.forEach(function(v,k){'use strict';log.push(v+':'+k+':'+(this===undefined))});String(r)+':'+log.join(',')",
        "var i=Object.create(Iterator.prototype);i.n=0;i.next=function(){return this.n<3?{value:++this.n}:{done:true}};i.some(function(v,k){return v+k===3})",
        "var i=Object.create(Iterator.prototype);i.n=0;i.next=function(){return this.n<3?{value:++this.n}:{done:true}};i.every(function(v,k){return v===k+1})",
        "var i=Object.create(Iterator.prototype);i.n=0;i.next=function(){return this.n<3?{value:++this.n}:{done:true}};i.find(function(v,k){return v===2&&k===1})",
        "var i=Object.create(Iterator.prototype);i.next=function(){return {done:true}};var ok=false;try{i.reduce(function(){})}catch(e){ok=e instanceof TypeError}ok",
        "var i=Object.create(Iterator.prototype);i.next=function(){return {done:true}};i.reduce(function(){throw 1},undefined)===undefined",
        "var i=[1,2].values();i.n=0;i.next=function(){return this.n++?{done:true}:{value:9}};i.toArray().join(',')",
        "var log=[];var i=Object.create(Iterator.prototype);i.n=0;i.next=function(){var r=Object.create({value:7,done:this.n++>0});return new Proxy(r,{get:function(t,k,q){log.push(String(k));return Reflect.get(t,k,q)}})};i.toArray().join(',')+':'+log.join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn eager_helpers_close_on_callbacks_and_short_circuits() {
    for source in [
        "var log=[];var i=Object.create(Iterator.prototype);i.n=0;i.next=function(){return this.n<3?{value:++this.n}:{done:true}};i.return=function(){log.push('return');return {done:true}};var r=i.some(function(v,k){log.push(v+':'+k);return v===2});r+':'+log.join(',')",
        "var log=[];var i=Object.create(Iterator.prototype);i.n=0;i.next=function(){return this.n<3?{value:++this.n}:{done:true}};i.return=function(){log.push('return');return {done:true}};var r=i.every(function(v,k){log.push(v+':'+k);return v<2});r+':'+log.join(',')",
        "var log=[];var i=Object.create(Iterator.prototype);i.n=0;i.next=function(){return this.n<3?{value:++this.n}:{done:true}};i.return=function(){log.push('return');return {done:true}};var r=i.find(function(v,k){log.push(v+':'+k);return v===2});r+':'+log.join(',')",
        "var closed=0;var marker={};var i=Object.create(Iterator.prototype);i.next=function(){return {value:1}};i.return=function(){closed++;throw 2};var same=false;try{i.forEach(function(){throw marker})}catch(e){same=e===marker}same+':'+closed",
        "var log=[];var i=Object.create(Iterator.prototype);Object.defineProperty(i,'next',{get:function(){log.push('next');return function(){return {done:true}}}});i.return=function(){log.push('return');throw 1};var typed=false;try{i.some(0)}catch(e){typed=e instanceof TypeError}log.join(',')+':'+typed",
        "var i=Object.create(Iterator.prototype);i.next=function(){return {value:1}};i.return=function(){return 1};var typed=false;try{i.some(function(){return true})}catch(e){typed=e instanceof TypeError}typed",
        "var marker={};var i=Object.create(Iterator.prototype);i.next=function(){return {value:1}};i.return=function(){throw marker};var same=false;try{i.find(function(){return true})}catch(e){same=e===marker}same",
        "var closed=0;var i=Object.create(Iterator.prototype);i.n=0;i.next=function(){return this.n++?{done:true}:{value:1}};i.return=function(){closed++;return {}};i.forEach(function(){});closed",
        "var closed=0;var i=Object.create(Iterator.prototype);i.n=0;i.next=function(){return this.n++?{done:true}:{value:1}};i.return=function(){closed++;return {}};i.reduce(function(a,v){return a+v},0)+':'+closed",
    ] {
        agrees(source);
    }
}

#[test]
fn iterator_step_failures_do_not_close_the_iterator() {
    // XS 9 closes after failures from IteratorStepValue, contrary to
    // IteratorNext/IteratorStep/IteratorStepValue setting the iterator
    // record's [[Done]] field before propagating the throw. Preserve the
    // ES2025 result and keep the pinned oracle differences explicit.
    for source in [
        "var closed=0;var marker={};var i=Object.create(Iterator.prototype);i.next=function(){throw marker};i.return=function(){closed++};var same=false;try{i.forEach(function(){})}catch(e){same=e===marker}same+':'+closed",
        "var closed=0;var marker={};var i=Object.create(Iterator.prototype);i.next=function(){return Object.defineProperty({},'done',{get:function(){throw marker}})};i.return=function(){closed++};var same=false;try{i.some(function(){})}catch(e){same=e===marker}same+':'+closed",
        "var closed=0;var marker={};var i=Object.create(Iterator.prototype);i.next=function(){return Object.defineProperty({},'value',{get:function(){throw marker}})};i.return=function(){closed++};var same=false;try{i.every(function(){})}catch(e){same=e===marker}same+':'+closed",
    ] {
        assert_ironhorse_result(source, "true:0");
        let oracle = dual_run(source).expect("the XS oracle machine must start");
        assert_eq!(oracle.oracle_result, "true:1", "update if XS is fixed");
    }
    let primitive = "var closed=0;var i=Object.create(Iterator.prototype);i.next=function(){return 1};i.return=function(){closed++};var typed=false;try{i.toArray()}catch(e){typed=e instanceof TypeError}typed+':'+closed";
    agrees(primitive);
}
