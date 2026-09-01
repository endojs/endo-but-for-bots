//! Oracle-backed `Array.from` regressions covering its iterable and array-like
//! paths, mapping callback, constructor selection, and IteratorClose behavior.

use ironhorse_262::{dual_run, Agreement};

fn assert_oracle_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "agreement for {source}: oracle_error={:?}, ironhorse_halt={:?}",
        run.oracle_error,
        run.ironhorse_halt
    );
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
}

#[test]
fn array_iterable_materializes_holes_and_observes_growth() {
    assert_oracle_result("Array.from([1,,3]).join(':')", "1::3");
    assert_oracle_result(
        "var a=[1,2]; Array.from(a, function(v,i){ if(i===0)a.push(3); return v; }).join(',')",
        "1,2,3",
    );
}

#[test]
fn string_iterates_unicode_code_points() {
    // A supplementary code point is one iterator element containing two UTF-16
    // code units. Avoid rendering the glyph itself because the pinned XS
    // result renderer intentionally exposes its internal CESU-8 spelling.
    assert_oracle_result("var a=Array.from('A😀B'); a.length+':'+a[1].length", "3:2");
}

#[test]
fn mapping_receives_index_and_this_arg() {
    assert_oracle_result(
        "var t={n:10}; Array.from([1,2], function(v,i){return this.n+v+i}, t).join(',')",
        "11,13",
    );
}

#[test]
fn explicit_null_iterator_selects_array_like_path() {
    assert_oracle_result(
        "var o={0:'a',2:'c',length:3}; o[Symbol.iterator]=null; Array.from(o).join(':')",
        "a::c",
    );
}

#[test]
fn custom_iterator_protocol_is_consumed() {
    assert_oracle_result(
        "var iterable={}; iterable[Symbol.iterator]=function(){var i=0; return {next:function(){return i<3?{value:++i,done:false}:{done:true}}}}; Array.from(iterable).join(',')",
        "1,2,3",
    );
}

#[test]
fn array_symbol_iterator_is_materialized() {
    assert_oracle_result(
        "var a=[4,5]; var it=a[Symbol.iterator](); var x=it.next(),xv=x.value,xd=x.done,y=it.next(),yv=y.value,z=it.next(); xv+':'+xd+':'+yv+':'+z.done",
        "4:false:5:true",
    );
    assert_oracle_result(
        "Array.prototype[Symbol.iterator]===Array.prototype.values",
        "true",
    );
}

#[test]
fn custom_constructor_receives_iterable_shape() {
    assert_oracle_result(
        "function C(){this.calls=arguments.length} var r=Array.from.call(C,[4,5]); (r instanceof C)+':'+r.calls+':'+r.length+':'+r[0]+r[1]",
        "true:0:2:45",
    );
    assert_oracle_result(
        "function C(n){this.arg=n} var o={0:7,length:1}; o[Symbol.iterator]=null; var r=Array.from.call(C,o); r.arg+':'+r.length+':'+r[0]",
        "1:1:7",
    );
}

#[test]
fn constructor_runs_before_iterator_acquisition() {
    assert_oracle_result(
        "var order=[]; function C(){order.push('construct'); throw {tag:1}} var o={}; o[Symbol.iterator]=function(){order.push('iterate')}; var tag=0; try{Array.from.call(C,o)}catch(e){tag=e.tag} order.join(',')+':'+tag",
        "construct:1",
    );
}

#[test]
fn abrupt_mapping_closes_iterator_and_preserves_throw() {
    assert_oracle_result(
        "var closed=0, marker={tag:9}, iterable={}; iterable[Symbol.iterator]=function(){return {next:function(){return {value:1,done:false}},return:function(){closed++;return {}}}}; var same=false; try{Array.from(iterable,function(){throw marker})}catch(e){same=e===marker} same+':'+closed",
        "true:1",
    );
}

#[test]
fn invalid_inputs_throw_type_error() {
    assert_oracle_result(
        "var a=false,b=false; try{Array.from(null)}catch(e){a=e instanceof TypeError} try{Array.from([],42)}catch(e){b=e instanceof TypeError} a+':'+b",
        "true:true",
    );
    assert_oracle_result(
        "var o={}; o[Symbol.iterator]=function(){return {next:function(){return 1}}}; try{Array.from(o);false}catch(e){e instanceof TypeError}",
        "true",
    );
}
