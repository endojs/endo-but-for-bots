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

fn assert_exact(source: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
    assert!(
        run.computrons_agree,
        "{source}: oracle={} ({}) ironhorse={} ({})",
        run.oracle_computrons,
        run.oracle_meter_raw,
        run.ironhorse_computrons,
        run.ironhorse_meter_raw,
    );
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
fn object_value_of_applies_to_object() {
    for source in [
        "var o={};Object.prototype.valueOf.call(o)===o",
        "Object.prototype.valueOf.call(7) instanceof Number",
        "Object.prototype.valueOf.call(false) instanceof Boolean",
        "Object.prototype.valueOf.call('x') instanceof String",
        "Object.prototype.valueOf.call(Symbol()) instanceof Symbol",
        "Object.prototype.valueOf.call(1n) instanceof BigInt",
        "try{Object.prototype.valueOf.call(null);false}catch(e){e instanceof TypeError}",
        "try{Object.prototype.valueOf.call(undefined);false}catch(e){e instanceof TypeError}",
    ] {
        assert_result_agrees(source, "true");
    }
}

#[test]
fn object_value_of_coercion_is_computron_exact() {
    for source in [
        "try{Object.prototype.valueOf.call(undefined)}catch(e){};true",
        "try{Object.prototype.valueOf.call(null)}catch(e){};true",
        "Object.prototype.valueOf.call(true);true",
        "Object.prototype.valueOf.call(7);true",
        "Object.prototype.valueOf.call('x');true",
        "Object.prototype.valueOf.call(Symbol());true",
        "Object.prototype.valueOf.call(1n);true",
    ] {
        assert_exact(source);
    }
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
fn boxed_symbols_use_the_intrinsic_to_primitive_method() {
    assert_result_agrees(
        "typeof Symbol.prototype[Symbol.toPrimitive]+','+Symbol.prototype[Symbol.toPrimitive].name+','+Symbol.prototype[Symbol.toPrimitive].length",
        "function,[Symbol.toPrimitive],1",
    );
    assert_result_agrees(
        "var d=Object.getOwnPropertyDescriptor(Symbol.prototype,Symbol.toPrimitive);''+d.writable+','+d.enumerable+','+d.configurable",
        "false,false,true",
    );
    assert_result_agrees(
        "var s=Symbol('s');var boxed=Object(s);var target={};Reflect.set(target,boxed,1);''+(Reflect.get(target,s)===1)+','+Object.getOwnPropertySymbols(target).length",
        "true,1",
    );
    assert_result_agrees(
        "var a=false,b=false;try{Object(Symbol('s'))+''}catch(e){a=e instanceof TypeError}try{Symbol('s')+''}catch(e){b=e instanceof TypeError}''+a+','+b",
        "true,true",
    );
    assert_result_agrees(
        "var key=Symbol.toPrimitive;delete Symbol.prototype[key];typeof Symbol.prototype[key]",
        "undefined",
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

// ---------------------------------------------------------------------------
// A member access on a primitive boxes the base to its wrapper prototype and
// performs a FULL `[[Get]]` there (ECMA-262 GetValue → ToObject → OrdinaryGet),
// with the primitive itself as the receiver. Reading the raw property slot
// instead — as both boxing paths used to — makes an accessor invisible: an
// accessor's slot holds `undefined`, so a guest getter on
// `%Number/Boolean/String/BigInt/Symbol.prototype%` silently read as
// `undefined` on a primitive receiver while working on an ordinary object.
// ---------------------------------------------------------------------------

/// Every wrapper prototype, both access forms (`.k` → `GET_PROPERTY`,
/// `[k]` → `GET_PROPERTY_AT`).
const WRAPPER_RECEIVERS: &[(&str, &str)] = &[
    ("Number", "(42)"),
    ("Boolean", "true"),
    ("String", "'a'"),
    ("BigInt", "(1n)"),
    ("Symbol", "Symbol()"),
];

#[test]
fn a_wrapper_prototype_getter_runs_for_a_primitive_receiver() {
    for (wrapper, receiver) in WRAPPER_RECEIVERS {
        let define = format!("Object.defineProperty({wrapper}.prototype,'zz',{{get(){{return 9}}}}); ");
        assert_result_agrees(&format!("{define}'' + {receiver}.zz"), "9");
        assert_result_agrees(&format!("{define}'' + {receiver}['zz']"), "9");
    }
}

#[test]
fn a_wrapper_prototype_getter_receives_the_primitive_as_this() {
    // A strict getter observes the unboxed primitive; a sloppy one boxes it at
    // its own prologue (OrdinaryCallBindThis), so the receiver handed to the
    // accessor is the primitive in both cases.
    for (wrapper, receiver, expected) in [
        ("Number", "(42)", "number"),
        ("Boolean", "false", "boolean"),
        ("String", "'a'", "string"),
        ("BigInt", "(1n)", "bigint"),
        ("Symbol", "Symbol()", "symbol"),
    ] {
        let define = format!(
            "Object.defineProperty({wrapper}.prototype,'zz',{{get(){{'use strict';return typeof this}}}}); "
        );
        assert_result_agrees(&format!("{define}'' + {receiver}.zz"), expected);
        assert_result_agrees(&format!("{define}'' + {receiver}['zz']"), expected);
    }
    assert_result_agrees(
        "Object.defineProperty(Number.prototype,'zz',{get(){return typeof this}}); '' + (42).zz",
        "object",
    );
    assert_result_agrees(
        "Object.defineProperty(Number.prototype,'zz',{get(){return this.valueOf()}}); '' + (42).zz",
        "42",
    );
}

#[test]
fn a_throwing_wrapper_prototype_getter_reaches_the_enclosing_catch() {
    // The boxing arms sit in the dispatch loop, so a `Halt::Resume` escaping
    // them rather than routing through `dispatch_result!` would leave the
    // `try` handler behind.
    for (wrapper, receiver) in WRAPPER_RECEIVERS {
        let define =
            format!("Object.defineProperty({wrapper}.prototype,'zz',{{get(){{throw new TypeError('x')}}}}); ");
        assert_result_agrees(
            &format!("{define}try{{{receiver}.zz;'escaped'}}catch(e){{'caught:'+(e instanceof TypeError)}}"),
            "caught:true",
        );
        assert_result_agrees(
            &format!("{define}try{{{receiver}['zz'];'escaped'}}catch(e){{'caught:'+(e instanceof TypeError)}}"),
            "caught:true",
        );
    }
}

#[test]
fn a_setter_only_wrapper_prototype_property_reads_undefined() {
    for (wrapper, receiver) in WRAPPER_RECEIVERS {
        let define = format!("Object.defineProperty({wrapper}.prototype,'zz',{{set(v){{}}}}); ");
        assert_result_agrees(&format!("{define}'' + {receiver}.zz"), "undefined");
        assert_result_agrees(&format!("{define}'' + {receiver}['zz']"), "undefined");
    }
}

#[test]
fn a_wrapper_prototype_data_property_reads_on_both_access_forms() {
    for (wrapper, receiver) in WRAPPER_RECEIVERS {
        let define = format!("{wrapper}.prototype.dd = 5; ");
        assert_result_agrees(&format!("{define}'' + {receiver}.dd"), "5");
        assert_result_agrees(&format!("{define}'' + {receiver}['dd']"), "5");
        assert_result_agrees(&format!("'' + {receiver}.nosuchname"), "undefined");
        assert_result_agrees(&format!("'' + {receiver}['nosuchname']"), "undefined");
        // An index key on a wrapper prototype names the canonical numeric
        // string; none of them carries an integer-indexed exotic. (A primitive
        // string is the exception — its index read is the character, never a
        // prototype lookup — so it is pinned separately below.)
        if *wrapper != "String" {
            assert_result_agrees(&format!("'' + {receiver}[0]"), "undefined");
        }
        // The inherited `constructor` is the one every wrapper prototype
        // already carries — a boolean receiver used to miss it entirely.
        assert_result_agrees(
            &format!("'' + ({receiver}.constructor === {wrapper})"),
            "true",
        );
        assert_result_agrees(
            &format!("'' + ({receiver}['constructor'] === {wrapper})"),
            "true",
        );
    }
}

#[test]
fn a_primitive_strings_length_and_index_reads_are_unchanged() {
    // `.length` stays the unmetered UTF-16 code-unit count rather than a
    // prototype read, and an index key still reads the one-unit character
    // instead of boxing.
    assert_result_agrees("'' + 'abc'.length", "3");
    assert_result_agrees("'' + 'abc'['length']", "3");
    assert_result_agrees("'' + 'abc'[1] + ',' + 'abc'['1'] + ',' + 'abc'[9]", "b,b,undefined");
    assert_result_agrees("var o = Object('ab'); '' + o.length + ',' + o[0] + ',' + o[2]", "2,a,undefined");
}

#[test]
fn a_nullish_base_still_throws_before_any_lookup() {
    assert_result_agrees("try{null.x}catch(e){'' + (e instanceof TypeError)}", "true");
    assert_result_agrees(
        "try{undefined['x']}catch(e){'' + (e instanceof TypeError)}",
        "true",
    );
}
