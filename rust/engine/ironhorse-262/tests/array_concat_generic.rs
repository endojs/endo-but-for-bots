//! Oracle-backed coverage for the generic `Array.prototype.concat` path.
//! Concat is intentionally generic, preserves holes, honors
//! `Symbol.isConcatSpreadable`, and uses `ArraySpeciesCreate` for Array
//! receivers.

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
fn accepts_generic_and_primitive_receivers() {
    for source in [
        "var o={0:'a',length:1}; var r=Array.prototype.concat.call(o,['b']); (r[0]===o)+':'+r[1]+':'+r.length",
        "var r=Array.prototype.concat.call('ab'); typeof r[0]+':'+String(r[0])+':'+r.length",
        "Array.prototype.concat.call(17,'x').length",
    ] {
        agrees(source);
    }
}

#[test]
fn preserves_holes_and_reads_inherited_elements() {
    for source in [
        "var a=[,,'c']; var r=a.concat([,'e']); r.length+':'+Object.prototype.hasOwnProperty.call(r,0)+':'+r[2]+':'+Object.prototype.hasOwnProperty.call(r,3)+':'+r[4]",
        "var p=[]; p[1]='inherited'; var a=[,,]; Object.setPrototypeOf(a,p); var r=a.concat(); r.length+':'+Object.prototype.hasOwnProperty.call(r,0)+':'+r[1]+':'+Object.prototype.hasOwnProperty.call(r,1)",
    ] {
        agrees(source);
    }
}

#[test]
fn honors_symbol_is_concat_spreadable() {
    for source in [
        "var a=[1,2]; a[Symbol.isConcatSpreadable]=false; var r=a.concat(); r.length+':'+(r[0]===a)",
        "var a=[1,2]; a[Symbol.isConcatSpreadable]=false; var r=[0].concat(a); r.length+':'+r[0]+':'+(r[1]===a)",
        "var o={0:'a',2:'c',length:3}; o[Symbol.isConcatSpreadable]=true; var r=[0].concat(o); r.length+':'+r[1]+':'+Object.prototype.hasOwnProperty.call(r,2)+':'+r[3]",
        "var log=[]; var o={get [Symbol.isConcatSpreadable](){log.push('spread');return true},get length(){log.push('length');return 1},get 0(){log.push('get:0');return 'x'}}; [0].concat(o)[1]+':'+log.join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn proxy_traps_are_observed_in_specification_order() {
    agrees(
        "var log=[]; var p=new Proxy({length:3,0:'a',2:'c'},{get:function(t,k){log.push('get:'+String(k));return t[k]},has:function(t,k){log.push('has:'+String(k));return k in t}}); p[Symbol.isConcatSpreadable]=true; var r=[].concat(p); r[0]+':'+Object.prototype.hasOwnProperty.call(r,1)+':'+r[2]+'|'+log.join(',')",
    );
}

#[test]
fn array_species_constructor_receives_zero() {
    agrees(
        "var seen=-1; function Species(n){seen=n;this.tag='species'} var a=[1,,3]; a.constructor={}; a.constructor[Symbol.species]=Species; var r=a.concat([4]); seen+':'+r.tag+':'+r.length+':'+r[0]+':'+Object.prototype.hasOwnProperty.call(r,1)+':'+r[2]+':'+r[3]+':'+(r instanceof Array)",
    );
}

#[test]
fn species_and_result_failures_are_observable() {
    for source in [
        "var touched=false; var o={get constructor(){touched=true}}; Array.prototype.concat.call(o); touched",
        "var log=[]; var c={}; Object.defineProperty(c,Symbol.species,{get:function(){log.push('species');return function S(n){log.push('construct:'+n)}}}); var a=[1]; Object.defineProperty(a,'constructor',{get:function(){log.push('constructor');return c}}); a.concat(); log.join(',')",
        "function S(){return Object.preventExtensions({})} var a=[1]; a.constructor={}; a.constructor[Symbol.species]=S; try{a.concat();false}catch(e){e instanceof TypeError}",
        "var marker={}; function S(){return {set length(v){throw marker}}} var a=[]; a.constructor={}; a.constructor[Symbol.species]=S; try{a.concat();false}catch(e){e===marker}",
    ] {
        agrees(source);
    }
}

#[test]
fn propagated_errors_match_the_oracle() {
    for source in [
        "var marker={}; var o={get [Symbol.isConcatSpreadable](){throw marker}}; try{[].concat(o);false}catch(e){e===marker}",
        "var marker={}; var o={[Symbol.isConcatSpreadable]:true,get length(){throw marker}}; try{[].concat(o);false}catch(e){e===marker}",
        "var p=Proxy.revocable([],{}); p.revoke(); try{[].concat(p.proxy);false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn function_metadata_matches_ecmascript() {
    agrees("Array.prototype.concat.name+':'+Array.prototype.concat.length");
}
