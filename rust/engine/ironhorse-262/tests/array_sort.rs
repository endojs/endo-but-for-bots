//! Oracle-backed coverage for the generic, stable Array `sort` and `toSorted`
//! algorithms. Result agreement is the conformance gate; their comparison
//! counts and therefore computron totals are intentionally implementation-
//! dependent.

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
fn default_sort_is_utf16_lexical_and_stable() {
    for source in [
        "[10,2,1,undefined].sort().map(String).join(',')",
        "var a=[{k:1,n:'a'},{k:0,n:'b'},{k:1,n:'c'},{k:0,n:'d'}]; a.sort(function(x,y){return x.k-y.k}); a.map(function(x){return x.n}).join('')",
        "['\\uD855\\uDE51','\\uFF3A'].sort().map(function(s){return s.charCodeAt(0).toString(16)}).join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn sort_methods_have_spec_function_metadata() {
    for source in [
        "Array.prototype.sort.name+':'+Array.prototype.sort.length",
        "Array.prototype.toSorted.name+':'+Array.prototype.toSorted.length",
    ] {
        agrees(source);
    }
}

#[test]
fn sort_preserves_holes_and_observes_inherited_values() {
    for source in [
        "var a=[3,,1,undefined,,2]; a.sort(); ''+a[0]+a[1]+a[2]+':'+a[3]+':'+a.length+':'+(3 in a)+':'+(4 in a)+':'+(5 in a)",
        "var p={1:'a'}; var o=Object.create(p); o.length=3; o[0]='b'; o[2]='c'; Array.prototype.sort.call(o); o[0]+o[1]+o[2]+':'+Object.prototype.hasOwnProperty.call(o,'1')",
        "var o={length:3,0:'b',2:'a'}; Array.prototype.sort.call(o); o[0]+o[1]+':'+Object.prototype.hasOwnProperty.call(o,'2')",
    ] {
        agrees(source);
    }
}

#[test]
fn to_sorted_reads_through_holes_into_a_fresh_ordinary_array() {
    for source in [
        "var a=[3,,1]; var b=a.toSorted(); ''+b[0]+b[1]+':'+b[2]+':'+(2 in b)+':'+(1 in a)+':'+a[0]",
        "var p={1:'a'}; var o=Object.create(p); o.length=3; o[0]='b'; o[2]='c'; var r=Array.prototype.toSorted.call(o); r.join('')+':'+(r instanceof Array)",
        "var used=false; var a=[2,1]; a.constructor={get [Symbol.species](){used=true;return function(){}}}; var r=a.toSorted(); r.join(',')+':'+used+':'+(r instanceof Array)",
        "Array.prototype.toSorted.call('ba').join('')",
    ] {
        agrees(source);
    }
}

#[test]
fn comparator_results_cross_the_to_number_boundary() {
    for source in [
        "[3,1,2].sort(function(a,b){return {valueOf:function(){return a-b}}}).join(',')",
        "[3,1,2].toSorted(function(){return NaN}).join(',')",
        "try{[2,1].sort(function(){return 0n});false}catch(e){e instanceof TypeError}",
        "try{[2,1].toSorted(function(){return Symbol()});false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn validation_and_abrupt_completion_follow_spec_order() {
    for source in [
        "var touched=false; var o={get length(){touched=true;return 0}}; try{Array.prototype.sort.call(o,1)}catch(e){} touched",
        "var marker={}; try{[2,1].sort(function(){throw marker});false}catch(e){e===marker}",
        "var marker={}; var x={toString:function(){throw marker}}; try{[x,1].sort();false}catch(e){e===marker}",
        "try{Array.prototype.sort.call({length:1n,0:'x'});false}catch(e){e instanceof TypeError}",
        "try{Array.prototype.toSorted.call({length:{valueOf:function(){return 1n}},0:'x'});false}catch(e){e instanceof TypeError}",
        "var touched=false; var o={length:4294967296,get 0(){touched=true}}; try{Array.prototype.toSorted.call(o)}catch(e){} touched",
    ] {
        agrees(source);
    }
}

#[test]
fn sort_uses_throwing_set_and_delete_operations() {
    for source in [
        "var a=[2,1]; Object.defineProperty(a,'0',{writable:false}); try{a.sort(function(x,y){return x-y});false}catch(e){e instanceof TypeError}",
        "var o={length:2}; Object.defineProperty(o,'1',{value:'a',writable:true,configurable:false}); try{Array.prototype.sort.call(o);false}catch(e){e instanceof TypeError&&o[0]==='a'}",
        "try{Array.prototype.sort.call('ba');false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn proxy_traps_observe_collection_then_writeback() {
    agrees(
        "var log=[]; var target={length:3,0:'b',2:'a'}; var p=new Proxy(target,{has:function(t,k){log.push('h'+k);return k in t},get:function(t,k){log.push('g'+k);return t[k]},set:function(t,k,v){log.push('s'+k);t[k]=v;return true},deleteProperty:function(t,k){log.push('d'+k);return delete t[k]}}); Array.prototype.sort.call(p); target[0]+target[1]+':'+('2' in target)+':'+(log.indexOf('h1')>=0)+':'+(log.indexOf('g2')>=0)+':'+(log.indexOf('s0')>=0)+':'+(log.indexOf('d2')>=0)",
    );
}
