//! Behavioral gate for `ArrayBuffer.prototype.slice`: relative-index
//! coercion, observable species construction, result validation, detachment,
//! byte copying, and built-in metadata.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let dr = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        dr.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        dr.ironhorse_halt,
        dr.oracle_result,
        dr.ironhorse_result,
    );
    assert!(
        dr.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        dr.oracle_result, dr.ironhorse_result,
    );
}

#[test]
fn copies_the_clamped_byte_range_into_an_independent_buffer() {
    assert_result_agrees(
        "var b=new ArrayBuffer(5);var v=new Uint8Array(b);v.set([10,20,30,40,50]);\
         var c=b.slice(1,4);v[2]=99;\
         c.byteLength+':'+new Uint8Array(c).join(',')",
    );
    assert_result_agrees(
        "var b=new ArrayBuffer(5);var v=new Uint8Array(b);v.set([1,2,3,4,5]);\
         new Uint8Array(b.slice(-4,-1)).join(',')",
    );
    assert_result_agrees(
        "var b=new ArrayBuffer(2);\
         b.slice(-Infinity,Infinity).byteLength+':'+b.slice(9,-9).byteLength",
    );
}

#[test]
fn coercion_and_species_construction_follow_specification_order() {
    assert_result_agrees(
        "var log=[];var b=new ArrayBuffer(4);\
         var start={valueOf:function(){log.push('start');return 1}};\
         var end={valueOf:function(){log.push('end');return 3}};\
         var c={};Object.defineProperty(c,Symbol.species,{get:function(){\
           log.push('species');return function S(n){log.push('construct:'+n);return new ArrayBuffer(n+1)}\
         }});Object.defineProperty(b,'constructor',{get:function(){log.push('constructor');return c}});\
         var r=b.slice(start,end);log.join(',')+':'+r.byteLength",
    );
    assert_result_agrees(
        "var b=new ArrayBuffer(3);b.constructor={[Symbol.species]:null};\
         b.slice(1) instanceof ArrayBuffer",
    );
}

#[test]
fn rejects_invalid_species_results_with_catchable_type_errors() {
    assert_result_agrees(
        "var b=new ArrayBuffer(2);b.constructor={[Symbol.species]:1};\
         try{b.slice();false}catch(e){e instanceof TypeError}",
    );
    assert_result_agrees(
        "var b=new ArrayBuffer(2);b.constructor={[Symbol.species]:function(){return {}}};\
         try{b.slice();false}catch(e){e instanceof TypeError}",
    );
    assert_result_agrees(
        "var b=new ArrayBuffer(2);b.constructor={[Symbol.species]:function(){return b}};\
         try{b.slice();false}catch(e){e instanceof TypeError}",
    );
    assert_result_agrees(
        "var b=new ArrayBuffer(3);b.constructor={[Symbol.species]:function(){return new ArrayBuffer(1)}};\
         try{b.slice();false}catch(e){e instanceof TypeError}",
    );
    assert_result_agrees(
        "var b=new ArrayBuffer(2);b.constructor={[Symbol.species]:function(){return new SharedArrayBuffer(2)}};\
         try{b.slice();false}catch(e){e instanceof TypeError}",
    );
}

#[test]
fn validates_source_and_result_detachment_at_the_required_points() {
    assert_result_agrees(
        "var b=new ArrayBuffer(2);$262.detachArrayBuffer(b);\
         try{b.slice();false}catch(e){e instanceof TypeError}",
    );
    assert_result_agrees(
        "var b=new ArrayBuffer(2),seen=false;\
         Object.defineProperty(b,'constructor',{get:function(){seen=true;return ArrayBuffer}});\
         var start={valueOf:function(){$262.detachArrayBuffer(b);return 0}};\
         var caught=false;try{b.slice(start)}catch(e){caught=e instanceof TypeError}\
         caught+':'+seen",
    );
    assert_result_agrees(
        "var b=new ArrayBuffer(2);b.constructor={[Symbol.species]:function(n){\
           var r=new ArrayBuffer(n);$262.detachArrayBuffer(r);return r\
         }};try{b.slice();false}catch(e){e instanceof TypeError}",
    );
    assert_result_agrees(
        "var b=new ArrayBuffer(2);b.constructor={[Symbol.species]:function(n){\
           $262.detachArrayBuffer(b);return new ArrayBuffer(n)\
         }};try{b.slice();false}catch(e){e instanceof TypeError}",
    );
}

#[test]
fn rejects_non_array_buffer_and_shared_receivers_before_coercion() {
    assert_result_agrees(
        "try{ArrayBuffer.prototype.slice.call({});false}catch(e){e instanceof TypeError}",
    );
    assert_result_agrees(
        "var touched=false;var x={valueOf:function(){touched=true;return 0}};\
         try{ArrayBuffer.prototype.slice.call(new SharedArrayBuffer(2),x)}catch(_error){}touched",
    );
}

#[test]
fn slice_and_species_expose_standard_metadata() {
    assert_result_agrees(
        "ArrayBuffer.prototype.slice.name+':'+ArrayBuffer.prototype.slice.length",
    );
    assert_result_agrees(
        "ArrayBuffer.prototype[Symbol.toStringTag]+':'+Object.prototype.toString.call(new ArrayBuffer(0))",
    );
    assert_result_agrees(
        "var d=Object.getOwnPropertyDescriptor(ArrayBuffer,Symbol.species),x={};\
         [d.get.name,d.get.length,d.set===undefined,d.enumerable,d.configurable,d.get.call(x)===x].join(':')",
    );
}
