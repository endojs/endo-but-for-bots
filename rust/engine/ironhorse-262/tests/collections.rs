//! XS-differential regressions for collection receiver validation and live
//! Map/Set traversal.

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

#[test]
fn collection_methods_validate_their_internal_slot() {
    agrees(
        "var ok = false; try { Map.prototype.get.call({}); } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "var ok = false; try { Set.prototype.add.call(new Map(), 1); } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "var ok = false; try { WeakMap.prototype.set.call(new Map(), {}, 1); } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "var ok = false; try { WeakSet.prototype.add.call(new Set(), {}); } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
}

#[test]
fn weak_collection_mutators_reject_primitive_keys() {
    agrees(
        "var ok = false; try { new WeakMap().set(1, 2); } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "var ok = false; try { new WeakSet().add('x'); } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
}

#[test]
fn dense_array_iterables_populate_all_collection_kinds() {
    agrees("var m = new Map([['a', 1], ['b', 2], ['a', 3]]); m.size + ':' + m.get('a')");
    agrees("var s = new Set([1, 2, 1, -0]); s.size + ':' + s.has(0)");
    agrees(
        "var a = {}, b = {}; var w = new WeakMap([[a, 1], [b, 2]]); \
         w.get(a) + w.get(b)",
    );
    agrees("var a = {}, b = {}; var w = new WeakSet([a, b, a]); w.has(a) && w.has(b)");
}

#[test]
fn collection_constructors_consume_general_and_sparse_iterables() {
    agrees("var s=new Set(function*(){yield 1;yield 2;yield 1}());s.size+':'+s.has(2)");
    agrees(
        "var m=new Map(function*(){yield ['a',1];yield ['b',2]}()); \
         m.size+':'+m.get('b')",
    );
    agrees("var s=new Set([,1]);s.size+':'+s.has(undefined)");
    agrees("new Map([[,2]]).get(undefined)");
    agrees("var s=new Set('a\\u{1F600}a');s.size+':'+s.has('\\u{1F600}')");
    agrees(
        "var a={},b={};var w=new WeakMap(function*(){yield [a,1];yield [b,2]}()); \
         w.get(a)+w.get(b)",
    );
}

#[test]
fn collection_constructor_observes_protocol_order_and_closing() {
    agrees(
        "var log=[];var old=Set.prototype.add;Set.prototype.add=function(v){log.push('add'+v);return old.call(this,v)}; \
         var a=[1,2];a[Symbol.iterator]=function(){log.push('iter');return [3][Symbol.iterator]()}; \
         var s=new Set(a);Set.prototype.add=old;log.join(',')+':'+s.has(3)",
    );
    agrees(
        "var closed=0,i=0;var it={ [Symbol.iterator]:function(){return { \
           next:function(){return i++?{done:true}:{value:1,done:false}}, \
           return:function(){closed++;return {}}}}}; \
         var ok=false;try{new Map(it)}catch(e){ok=e instanceof TypeError}ok+':'+closed",
    );
    agrees(
        "var closed=0;var it={ [Symbol.iterator]:function(){return { \
           next:function(){throw 7},return:function(){closed++;return {}}}}}; \
         var caught;try{new Set(it)}catch(e){caught=e}caught+':'+closed",
    );
    agrees(
        "var closed=0,i=0;var it={ [Symbol.iterator]:function(){return { \
           next:function(){return i++?{done:true}:{value:1,done:false}}, \
           return:function(){closed++;return {}}}}}; \
         var old=Set.prototype.add;Set.prototype.add=function(){throw 8};var caught; \
         try{new Set(it)}catch(e){caught=e}Set.prototype.add=old;caught+':'+closed",
    );
    agrees(
        "var p=Object.getPrototypeOf([][Symbol.iterator]()),old=p.next,calls=0; \
         p.next=function(){calls++;return old.call(this)};var s=new Set([1,2]); \
         p.next=old;calls+':'+s.size",
    );
    agrees(
        "var log=[],entry=[];Object.defineProperty(entry,'0',{get:function(){log.push('k');return 'a'}}); \
         Object.defineProperty(entry,'1',{get:function(){log.push('v');return 3}}); \
         var m=new Map([entry]);log.join(',')+':'+m.get('a')",
    );
    agrees(
        "var old=Set.prototype.add,ok=false;Set.prototype.add=Map.prototype.set; \
         try{new Set([1])}catch(e){ok=e instanceof TypeError}Set.prototype.add=old;ok",
    );
    agrees(
        "var a=[1,2],old=Set.prototype.add;Object.defineProperty(Set.prototype,'add',{ \
         configurable:true,get:function(){delete a[1];return old}});var s=new Set(a); \
         delete Set.prototype.add;Set.prototype.add=old;s.size+':'+s.has(undefined)",
    );
}

#[test]
fn iterable_constructor_observes_overridden_adder() {
    agrees(
        "var calls = 0; var old = Map.prototype.set; \
         Map.prototype.set = function (k, v) { calls++; return old.call(this, k, v); }; \
         new Map([['a', 1], ['b', 2]]); Map.prototype.set = old; calls",
    );
    agrees(
        "var calls = 0; var old = Set.prototype.add; \
         Set.prototype.add = function (v) { calls++; return old.call(this, v); }; \
         new Set([1, 2]); Set.prototype.add = old; calls",
    );
}

#[test]
fn iteration_is_live_across_deletion_and_append() {
    agrees(
        "var m = new Map(); m.set('a', 1); m.set('b', 2); m.set('c', 3); \
         var it = m.keys(); var out = [it.next().value]; m.delete('a'); \
         m.delete('b'); m.set('d', 4); out.push(it.next().value, it.next().value); \
         out.join(',')",
    );
    agrees(
        "var s = new Set(); s.add(1); s.add(2); var out = []; \
         s.forEach(function (v) { out.push(v); if (v === 1) { s.delete(2); s.add(3); } }); \
         out.join(',')",
    );
    agrees(
        "var m = new Map(); m.set('a', 1); m.set('b', 2); var out = []; \
         m.forEach(function (v, k) { out.push(k); if (k === 'a') { m.clear(); m.set('c', 3); } }); \
         out.join(',')",
    );
}

#[test]
fn collection_builtin_function_metadata_is_reflective() {
    for source in [
        "var f = Map.prototype.set; f.name + ':' + f.length",
        "var f = Set.prototype.add; f.name + ':' + f.length",
        "var f = Map.prototype.entries; f.name + ':' + f.length",
        "var f = Set.prototype.forEach; f.name + ':' + f.length",
        "var f = Map.prototype.get; delete f.name; Object.defineProperty(f, 'name', { value: 'again' }); f.name",
        "var f = Set.prototype.delete; delete f.length; Object.defineProperty(f, 'length', { value: 7 }); f.length",
    ] {
        agrees(source);
    }
}

#[test]
fn map_and_set_iterator_prototypes_are_distinct_and_branded() {
    for source in [
        "var p = Object.getPrototypeOf(new Map().entries()); p.next.name + ':' + p.next.length",
        "var p = Object.getPrototypeOf(new Set().values()); p.next.name + ':' + p.next.length",
        "Object.getPrototypeOf(new Map().entries())[Symbol.toStringTag]",
        "Object.getPrototypeOf(new Set().values())[Symbol.toStringTag]",
        "Object.getPrototypeOf(new Map().entries()).propertyIsEnumerable(Symbol.toStringTag)",
        "Object.getPrototypeOf(new Set().values()).propertyIsEnumerable(Symbol.toStringTag)",
        "Object.getPrototypeOf(new Map().entries()) === Object.getPrototypeOf(new Set().values())",
        "var m = new Map([[1, 2]]).entries(); var s = new Set([1]).values(); var ok = false; try { m.next.call(s); } catch (e) { ok = e instanceof TypeError; } ok",
        "var m = new Map([[1, 2]]).entries(); var s = new Set([1]).values(); var ok = false; try { s.next.call(m); } catch (e) { ok = e instanceof TypeError; } ok",
    ] {
        agrees(source);
    }
}
