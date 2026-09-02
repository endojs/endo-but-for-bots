//! `Object(value)` and `new Object(value)` perform `ToObject` for primitive
//! values. Both forms must create a fresh wrapper with the corresponding realm
//! prototype and preserve the primitive through ordinary coercion.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn object_call_boxes_boolean_number_and_string() {
    assert_result_agrees(
        "var o = Object(true); '' + (typeof o) + ',' + (o.constructor === Boolean) + ',' + (o == true) + ',' + (o === true)",
        "object,true,true,false",
    );
    assert_result_agrees(
        "var o = Object(1.25); '' + (typeof o) + ',' + (o.constructor === Number) + ',' + (o == 1.25) + ',' + (o === 1.25)",
        "object,true,true,false",
    );
    assert_result_agrees(
        "var o = Object('ab'); '' + (typeof o) + ',' + (o.constructor === String) + ',' + (o == 'ab') + ',' + (o === 'ab')",
        "object,true,true,false",
    );
    assert_result_agrees(
        "var o = Object('ab'); '' + o.length + ',' + o[0] + ',' + o[1] + ',' + o[2]",
        "2,a,b,undefined",
    );
}

#[test]
fn object_construct_boxes_primitive_values() {
    assert_result_agrees(
        "var o = new Object(false); '' + (o instanceof Boolean) + ',' + o.valueOf()",
        "true,false",
    );
    assert_result_agrees(
        "var o = new Object(7); '' + (o instanceof Number) + ',' + o.valueOf()",
        "true,7",
    );
    assert_result_agrees(
        "var o = new Object('x'); '' + (o instanceof String) + ',' + o.valueOf()",
        "true,x",
    );
}

#[test]
fn object_to_string_reports_wrapper_builtin_tags() {
    assert_result_agrees(
        "[Object(true),Object(7),Object('x'),Object(Symbol('s')),Object(1n)].map(function(v){return Object.prototype.toString.call(v)}).join(',')",
        "[object Boolean],[object Number],[object String],[object Symbol],[object BigInt]",
    );
}

#[test]
fn object_boxes_symbols_to_fresh_objects() {
    assert_result_agrees(
        "var s = Symbol('s'); var a = Object(s); var b = Object(s); '' + (typeof a) + ',' + (a !== s) + ',' + (a !== b)",
        "object,true,true",
    );
}

#[test]
fn boxed_symbols_support_intrinsic_symbol_methods() {
    assert_result_agrees(
        "var s=Symbol('s'); var o=Object(s); o.toString()+','+(o.valueOf()===s)",
        "Symbol(s),true",
    );
    assert_result_agrees(
        "var r=Array.prototype.copyWithin.call(Symbol('s'),0,0); Object.prototype.toString.call(r)+':'+String(r.valueOf())+':'+r.toString()",
        "[object Symbol]:Symbol(s):Symbol(s)",
    );
}

#[test]
fn symbol_methods_reject_non_symbol_receivers() {
    assert_result_agrees(
        "var a=false,b=false; try{Symbol.prototype.valueOf.call({})}catch(e){a=e instanceof TypeError} try{Symbol.prototype.toString.call(1)}catch(e){b=e instanceof TypeError} ''+a+','+b",
        "true,true",
    );
}

#[test]
fn object_is_compares_wrappers_by_identity() {
    assert_result_agrees(
        "var a = Object(0); var b = new Object(''); '' + Object.is(a, a) + ',' + Object.is(b, b) + ',' + Object.is(a, Object(0))",
        "true,true,false",
    );
    assert_result_agrees(
        "'' + Object.is(NaN, NaN) + ',' + Object.is(0, -0) + ',' + Object.is('x', 'x')",
        "true,false,true",
    );
}

#[test]
fn object_from_entries_defines_dense_array_entries() {
    assert_result_agrees(
        "var o = Object.fromEntries([['z', 1], ['x', 2], ['z', 3]]); '' + o.z + ',' + o.x + ',' + Object.keys(o).join('|')",
        "3,2,z|x",
    );
    assert_result_agrees("Object.fromEntries([Object('ab')]).a", "b");
    assert_result_agrees("Object.fromEntries([new String('xy')]).x", "y");
}

#[test]
fn object_from_entries_consumes_general_iterables_in_order() {
    assert_result_agrees(
        "var effects=[]; var iterable={ [Symbol.iterator]: function(){ effects.push('iterator'); var n=0; return { next: function(){ effects.push('next'+n); if (n++ === 0) return {done:false,value:{get 0(){effects.push('key');return {toString:function(){effects.push('toString');return 'x'}}},get 1(){effects.push('value');return 7}}}; return {done:true} } } } }; var o=Object.fromEntries(iterable); effects.join('|')+','+o.x",
        "iterator|next0|key|value|toString|next1,7",
    );
    assert_result_agrees(
        "var entry={0:'x',1:3,get [Symbol.iterator](){throw Error('entry must not be iterated')}}; var iterable={ [Symbol.iterator]:function(){var done=false;return {next:function(){if(done)return {done:true};done=true;return {done:false,value:entry}}}}}; Object.fromEntries(iterable).x",
        "3",
    );
}

#[test]
fn object_from_entries_closes_after_entry_processing_errors() {
    assert_result_agrees(
        "var closed=0; var iterable={ [Symbol.iterator]: function(){ return {next:function(){return {done:false,value:null}},return:function(){closed++;return {}}} } }; var caught=false; try{Object.fromEntries(iterable)}catch(e){caught=e instanceof TypeError} ''+caught+','+closed",
        "true,1",
    );
    assert_result_agrees(
        "var closed=0; var boom={}; var entry={get 0(){throw boom}}; var iterable={ [Symbol.iterator]: function(){ return {next:function(){return {done:false,value:entry}},return:function(){closed++;return {}}} } }; var caught; try{Object.fromEntries(iterable)}catch(e){caught=e===boom} ''+caught+','+closed",
        "true,1",
    );
    assert_result_agrees(
        "var closed=0; var boom={}; var entry={0:{toString:function(){throw boom}},1:4}; var iterable={ [Symbol.iterator]: function(){ return {next:function(){return {done:false,value:entry}},return:function(){closed++;return {}}} } }; var caught; try{Object.fromEntries(iterable)}catch(e){caught=e===boom} ''+caught+','+closed",
        "true,1",
    );
}

#[test]
fn object_from_entries_does_not_close_iterator_step_errors() {
    assert_result_agrees(
        "var closed=0; var boom={}; var iterable={ [Symbol.iterator]: function(){ return {next:function(){throw boom},return:function(){closed++}} } }; var caught; try{Object.fromEntries(iterable)}catch(e){caught=e===boom} ''+caught+','+closed",
        "true,0",
    );
    assert_result_agrees(
        "var closed=0; var boom={}; var iterable={ [Symbol.iterator]: function(){ return {next:function(){return {get done(){throw boom}}},return:function(){closed++}} } }; var caught; try{Object.fromEntries(iterable)}catch(e){caught=e===boom} ''+caught+','+closed",
        "true,0",
    );
}

#[test]
fn object_from_entries_observes_next_and_primitive_iterator_lookup() {
    assert_result_agrees(
        "var gets=0,it=[['x',1]][Symbol.iterator](),src={}; Object.defineProperty(it,'next',{get:function(){gets++;return function(){return {done:true}}}}); src[Symbol.iterator]=function(){return it}; var o=Object.fromEntries(src); gets+','+Object.keys(o).length",
        "1,0",
    );
    assert_result_agrees(
        "var old=String.prototype[Symbol.iterator]; String.prototype[Symbol.iterator]=function(){var done=false;return {next:function(){if(done)return {done:true};done=true;return {value:['x',7],done:false}}}}; var value=Object.fromEntries('ab').x; String.prototype[Symbol.iterator]=old; value",
        "7",
    );
}
