//! Oracle-backed coverage for the generic `Array.prototype.slice` path.
//! Slice is intentionally generic, preserves holes, and uses
//! `ArraySpeciesCreate` for Array receivers.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (halt: {:?}; oracle error: {:?}; ironhorse error: {:?})",
        run.ironhorse_halt,
        run.oracle_error,
        run.ironhorse_error,
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn accepts_array_like_string_and_typed_array_receivers() {
    for source in [
        "var r=Array.prototype.slice.call({length:4,0:'a',2:'c'},1,4); r.length+':'+Object.prototype.hasOwnProperty.call(r,0)+':'+r[1]+':'+Object.prototype.hasOwnProperty.call(r,2)",
        "Array.prototype.slice.call('abcd',1,-1).join('')",
        "Array.prototype.slice.call(new Uint8Array([3,1,2]),1).join(',')",
        "Array.prototype.slice.call(17).length",
    ] {
        agrees(source);
    }
}

#[test]
fn preserves_holes_and_reads_inherited_elements() {
    for source in [
        "var a=[,,'c']; var r=a.slice(0,3); r.length+':'+Object.prototype.hasOwnProperty.call(r,0)+':'+Object.prototype.hasOwnProperty.call(r,1)+':'+r[2]",
        "var p={1:'inherited'}; var o=Object.create(p); o.length=3; o[0]='a'; var r=Array.prototype.slice.call(o); r[0]+':'+r[1]+':'+Object.prototype.hasOwnProperty.call(r,1)+':'+Object.prototype.hasOwnProperty.call(r,2)",
    ] {
        agrees(source);
    }
}

#[test]
fn proxy_has_and_get_traps_are_observed_in_index_order() {
    agrees(
        "var log=[]; var p=new Proxy({length:3,0:'a',2:'c'},{get:function(t,k){log.push('get:'+String(k));return t[k]},has:function(t,k){log.push('has:'+String(k));return k in t}}); var r=Array.prototype.slice.call(p,0,3); r[0]+':'+Object.prototype.hasOwnProperty.call(r,1)+':'+r[2]+'|'+log.join(',')",
    );
}

#[test]
fn bounds_use_to_integer_or_infinity_in_specification_order() {
    for source in [
        "var log=[]; var o={get length(){log.push('length');return 4},0:'a',1:'b',2:'c',3:'d'}; var start={valueOf:function(){log.push('start');return 1}}; var end={valueOf:function(){log.push('end');return 3}}; Array.prototype.slice.call(o,start,end).join('')+':'+log.join(',')",
        "[0,1,2,3].slice(-Infinity,Infinity).join(',')",
        "[0,1,2,3].slice(NaN,-1).join(',')",
        "[0,1,2,3].slice(1,undefined).join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn invalid_bounds_and_receivers_throw_the_right_errors() {
    for source in [
        "try{Array.prototype.slice.call(null);false}catch(e){e instanceof TypeError}",
        "try{[1].slice(0n);false}catch(e){e instanceof TypeError}",
        "try{[1].slice(Symbol());false}catch(e){e instanceof TypeError}",
        "var marker={}; try{[1].slice({valueOf:function(){throw marker}});false}catch(e){e===marker}",
    ] {
        agrees(source);
    }
}

#[test]
fn array_species_constructor_receives_the_result_length() {
    agrees(
        "var seen=-1; function Species(n){seen=n; this.tag='species'} var a=[1,,3]; a.constructor={}; a.constructor[Symbol.species]=Species; var r=a.slice(0,3); seen+':'+r.tag+':'+r.length+':'+r[0]+':'+Object.prototype.hasOwnProperty.call(r,1)+':'+r[2]+':'+(r instanceof Array)",
    );
}

#[test]
fn species_lookup_and_result_failures_are_observable() {
    for source in [
        "var log=[]; var c={}; Object.defineProperty(c,Symbol.species,{get:function(){log.push('species');return function S(n){log.push('construct:'+n)}}}); var a=[1,2]; Object.defineProperty(a,'constructor',{get:function(){log.push('constructor');return c}}); a.slice(0,1); log.join(',')",
        "var marker={}; function S(){return Object.preventExtensions({})} var a=[1]; a.constructor={}; a.constructor[Symbol.species]=S; try{a.slice();false}catch(e){e instanceof TypeError}",
        "var marker={}; function S(){return {set length(v){throw marker}}} var a=[]; a.constructor={}; a.constructor[Symbol.species]=S; try{a.slice();false}catch(e){e===marker}",
    ] {
        agrees(source);
    }
}

#[test]
fn function_metadata_matches_ecmascript() {
    agrees("Array.prototype.slice.name+':'+Array.prototype.slice.length");
}
