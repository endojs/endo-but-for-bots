//! Oracle-backed coverage for `%TypedArray%.prototype.toReversed`, `toSorted`
//! and `with`, the change-array-by-copy family: each leaves the receiver
//! untouched and returns a fresh view of the receiver's own element type,
//! never consulting `constructor` or `@@species`.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn methods_have_spec_shape() {
    for source in [
        "var P=Object.getPrototypeOf(Int8Array.prototype); ['toReversed','toSorted','with'].map(function(k){var d=Object.getOwnPropertyDescriptor(P,k); return k+':'+typeof d.value+':'+d.value.length+':'+d.value.name+':'+d.writable+':'+d.enumerable+':'+d.configurable}).join(',')",
        "var P=Object.getPrototypeOf(Int8Array.prototype); Reflect.ownKeys(P).filter(function(k){return typeof k==='string'}).join(',')",
        "var P=Object.getPrototypeOf(Int8Array.prototype); try{new P.toReversed();false}catch(e){e instanceof TypeError}",
        "var P=Object.getPrototypeOf(Int8Array.prototype); ['toReversed','toSorted','with'].map(function(k){try{P[k].call([1,2]);return 'ok'}catch(e){return e.constructor.name}}).join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn to_reversed_copies_in_reverse_and_ignores_species() {
    for source in [
        "var a=new Float64Array([1,-0,NaN,3]); var r=a.toReversed(); (r!==a)+':'+(r instanceof Float64Array)+':'+Array.prototype.join.call(r)+':'+Object.is(r[2],-0)+':'+a.join()",
        "var a=new BigInt64Array([1n,2n,3n]); a.toReversed().join()",
        "var a=new Uint8Array([1,2,3]); a.constructor=function(){throw 1}; a.toReversed().constructor===Uint8Array",
        "new Int16Array(0).toReversed().length",
    ] {
        agrees(source);
    }
}

#[test]
fn to_sorted_sorts_a_copy() {
    for source in [
        "var a=new Float64Array([3,NaN,-0,0,-1]); var s=a.toSorted(); Array.prototype.map.call(s,function(v){return Object.is(v,-0)?'-0':String(v)}).join()+':'+a.join()",
        "var a=new Int32Array([1,3,2]); a.toSorted(function(x,y){return y-x}).join()+':'+a.join()",
        "var a=new BigUint64Array([3n,1n,2n]); a.toSorted().join()",
        "try{new Int8Array(1).toSorted({});false}catch(e){e instanceof TypeError}",
        "var P=Object.getPrototypeOf(Int8Array.prototype); try{P.toSorted.call({}, 1);false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn with_replaces_one_element() {
    for source in [
        "var a=new Uint8Array([1,2,3]); var w=a.with(-1,300); w.join()+':'+a.join()+':'+(w instanceof Uint8Array)",
        "var a=new BigInt64Array([1n,2n]); a.with(0,5n).join()",
        "[3,-4,Infinity].map(function(i){try{new Int8Array(3).with(i,0);return 'ok'}catch(e){return e.constructor.name}}).join()",
        "var log=[]; var a=new Int8Array(2); try{a.with({valueOf:function(){log.push('i');return 9}},{valueOf:function(){log.push('v');return 1}})}catch(e){log.push(e.constructor.name)} log.join()",
        "var rab=new ArrayBuffer(4,{maxByteLength:4}); var a=new Uint8Array(rab); var r=a.with(0,{valueOf:function(){rab.resize(2);return 7}}); r.length+':'+r.join()",
        "var rab=new ArrayBuffer(0,{maxByteLength:1}); var a=new Uint8Array(rab); var r=a.with(0,{valueOf:function(){rab.resize(1);return 7}}); r.length",
        "var rab=new ArrayBuffer(16,{maxByteLength:16}); var a=new BigInt64Array(rab); try{a.with(0,{valueOf:function(){rab.resize(8);return 1n}});false}catch(e){e.constructor.name}",
    ] {
        agrees(source);
    }
}
