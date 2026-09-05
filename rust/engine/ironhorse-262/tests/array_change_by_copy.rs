//! Oracle-backed coverage for the generic Array change-by-copy methods.
//! These methods always create ordinary Arrays, read through holes, and must
//! preserve the observable coercion and property-access order.

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
fn methods_accept_generic_and_primitive_receivers() {
    for source in [
        "Array.prototype.toReversed.call({length:3,0:'a',2:'c'}).join(':')",
        "Array.prototype.with.call({length:3,0:'a',2:'c'},1,'b').join(':')",
        "Array.prototype.toSpliced.call({length:3,0:'a',2:'c'},1,1,'b').join(':')",
        "Array.prototype.toReversed.call('abc').join('')",
        "Array.prototype.with.call('ab',0,'x').join('')",
        "Array.prototype.toSpliced.call('abc',1,1,'x').join('')",
    ] {
        agrees(source);
    }
}

#[test]
fn methods_read_through_holes_and_materialize_undefined() {
    for source in [
        "var r=[,].toReversed(); Object.prototype.hasOwnProperty.call(r,0)+':'+r[0]",
        "var p={1:'inherited'}; var o=Object.create(p); o.length=3; o[0]='a'; o[2]='c'; Array.prototype.toReversed.call(o).join(':')",
        "var p={1:'inherited'}; var o=Object.create(p); o.length=3; o[0]='a'; o[2]='c'; Array.prototype.with.call(o,0,'x').join(':')",
        "var p={1:'inherited'}; var o=Object.create(p); o.length=3; o[0]='a'; o[2]='c'; Array.prototype.toSpliced.call(o,0,0).join(':')",
    ] {
        agrees(source);
    }
}

#[test]
fn with_coerces_before_copying_and_skips_the_replaced_get() {
    for source in [
        "var log=[]; var o={length:3,get 0(){log.push('g0');return 'a'},get 1(){throw Error('replaced')},get 2(){log.push('g2');return 'c'}}; var index={valueOf:function(){log.push('index');return 1}}; var r=Array.prototype.with.call(o,index,'b'); r.join('')+':'+log.join(',')",
        "var log=[]; var p=new Proxy({length:3,0:'a',1:'b',2:'c'},{get:function(t,k){log.push(String(k));return t[k]}}); Array.prototype.with.call(p,1,'x'); log.join(',')",
        "try{[1].with(1,2);false}catch(e){e instanceof RangeError}",
        "try{[1].with(Infinity,2);false}catch(e){e instanceof RangeError}",
        "try{[1].with(-Infinity,2);false}catch(e){e instanceof RangeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn to_reversed_gets_indices_in_reverse_order() {
    agrees(
        "var log=[]; var p=new Proxy({length:3,0:'a',1:'b',2:'c'},{get:function(t,k){log.push(String(k));return t[k]}}); Array.prototype.toReversed.call(p); log.join(',')",
    );
}

#[test]
fn to_spliced_observes_coercion_then_source_gets() {
    for source in [
        "var log=[]; var o={get length(){log.push('length');return 4},get 0(){log.push('g0');return 'a'},get 3(){log.push('g3');return 'd'}}; var start={valueOf:function(){log.push('start');return 1}}; var count={valueOf:function(){log.push('count');return 2}}; var r=Array.prototype.toSpliced.call(o,start,count,'x'); r.join('')+':'+log.join(',')",
        "var log=[]; var p=new Proxy({length:4,0:'a',1:'b',2:'c',3:'d'},{get:function(t,k){log.push(String(k));return t[k]}}); Array.prototype.toSpliced.call(p,1,2,'x'); log.join(',')",
        "Array.prototype.toSpliced.call({length:3,0:'a',1:'b',2:'c'}).join('')",
        "Array.prototype.toSpliced.call({length:3,0:'a',1:'b',2:'c'},1).join('')",
        "Array.prototype.toSpliced.call({length:4294967296},0,4294967296).length",
    ] {
        agrees(source);
    }
}

#[test]
fn numeric_arguments_use_to_number_and_propagate_abrupt_completion() {
    for source in [
        "try{[1].with(0n,2);false}catch(e){e instanceof TypeError}",
        "try{[1].with(Symbol(),2);false}catch(e){e instanceof TypeError}",
        "try{[1].toSpliced(0,1n);false}catch(e){e instanceof TypeError}",
        "var marker={}; try{[1].with({valueOf:function(){throw marker}},2);false}catch(e){e===marker}",
        "var marker={}; try{[1].toSpliced({valueOf:function(){throw marker}},0);false}catch(e){e===marker}",
    ] {
        agrees(source);
    }
}

#[test]
fn methods_create_plain_arrays_without_consulting_species() {
    for source in [
        "var used=false; var a=[1,2]; a.constructor={get [Symbol.species](){used=true;return function(){}}}; var r=a.with(0,3); r.join(',')+':'+used+':'+(r instanceof Array)",
        "var used=false; var a=[1,2]; a.constructor={get [Symbol.species](){used=true;return function(){}}}; var r=a.toReversed(); r.join(',')+':'+used+':'+(r instanceof Array)",
        "var used=false; var a=[1,2]; a.constructor={get [Symbol.species](){used=true;return function(){}}}; var r=a.toSpliced(0,1); r.join(',')+':'+used+':'+(r instanceof Array)",
    ] {
        agrees(source);
    }
}

#[test]
fn receiver_validation_and_function_metadata_match() {
    for source in [
        "try{Array.prototype.with.call(null,0,1);false}catch(e){e instanceof TypeError}",
        "try{Array.prototype.toReversed.call(undefined);false}catch(e){e instanceof TypeError}",
        "try{Array.prototype.toSpliced.call(null);false}catch(e){e instanceof TypeError}",
        "Array.prototype.with.name+':'+Array.prototype.with.length",
        "Array.prototype.toReversed.name+':'+Array.prototype.toReversed.length",
        "Array.prototype.toSpliced.name+':'+Array.prototype.toSpliced.length",
    ] {
        agrees(source);
    }
}
