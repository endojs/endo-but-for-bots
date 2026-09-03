//! Behavioral gate for the fixed-length subset of
//! `ArrayBuffer.prototype.transfer` / `transferToFixedLength`: copying,
//! resizing, detachment, coercion order, receiver validation, and metadata.

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
fn transfer_preserves_bytes_and_detaches_the_source() {
    assert_result_agrees(
        "var b=new ArrayBuffer(4),v=new Uint8Array(b);v.set([10,20,30,40]);\
         var c=b.transfer();\
         [b.byteLength,v.byteLength,c.byteLength,new Uint8Array(c).join(',')].join(':')",
    );
}

#[test]
fn transfer_truncates_or_zero_extends_to_the_requested_length() {
    assert_result_agrees(
        "var a=new Uint8Array([1,2,3,4]).buffer;var x=a.transfer(2);\
         var b=new Uint8Array([5,6]).buffer;var y=b.transfer(4);\
         var c=new ArrayBuffer(1),z=c.transfer(0);\
         [new Uint8Array(x).join(','),new Uint8Array(y).join(','),z.byteLength].join(':')",
    );
}

#[test]
fn transfer_to_fixed_length_matches_fixed_buffer_transfer() {
    assert_result_agrees(
        "var b=new Uint8Array([7,8,9]).buffer;var c=b.transferToFixedLength(5);\
         [b.byteLength,c.resizable,c.byteLength,new Uint8Array(c).join(',')].join(':')",
    );
}

#[test]
fn new_length_coercion_precedes_the_detached_recheck() {
    assert_result_agrees(
        "var b=new ArrayBuffer(2),log=[];var n={valueOf:function(){\
           log.push('coerce');$262.detachArrayBuffer(b);return 1\
         }};var caught=false;try{b.transfer(n)}catch(e){caught=e instanceof TypeError}\
         caught+':'+log.join(',')",
    );
    assert_result_agrees(
        "var b=new ArrayBuffer(2),touched=false;$262.detachArrayBuffer(b);\
         try{b.transfer({valueOf:function(){touched=true;return 1}})}catch(_error){}touched",
    );
}

#[test]
fn invalid_receivers_and_lengths_throw_at_the_specification_boundary() {
    assert_result_agrees(
        "var touched=false,n={valueOf:function(){touched=true;return 1}};\
         var a=false,b=false;try{ArrayBuffer.prototype.transfer.call({},n)}catch(e){a=e instanceof TypeError}\
         try{ArrayBuffer.prototype.transfer.call(new SharedArrayBuffer(2),n)}catch(e){b=e instanceof TypeError}\
         a+':'+b+':'+touched",
    );
    assert_result_agrees(
        "var b=new ArrayBuffer(2),a=false,c=false;\
         try{b.transfer(-1)}catch(e){a=e instanceof RangeError}\
         try{b.transfer(1n)}catch(e){c=e instanceof TypeError}\
         a+':'+c+':'+b.byteLength",
    );
}

#[test]
fn transfer_does_not_consult_constructor_or_species() {
    assert_result_agrees(
        "var b=new Uint8Array([1,2]).buffer;Object.defineProperty(b,'constructor',{\
           get:function(){throw new Error('constructor must not be read')}\
         });var c=b.transfer();c instanceof ArrayBuffer",
    );
}

#[test]
fn transfer_and_detached_expose_standard_metadata() {
    assert_result_agrees("var b=new ArrayBuffer(3);b.maxByteLength+':'+b.resizable");
    assert_result_agrees(
        "var d=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'detached');\
         var b=new ArrayBuffer(0),g=d.get;\
         [ArrayBuffer.prototype.transfer.name,ArrayBuffer.prototype.transfer.length,\
          ArrayBuffer.prototype.transferToFixedLength.name,ArrayBuffer.prototype.transferToFixedLength.length,\
          g.name,g.length,d.set===undefined,d.enumerable,d.configurable,g.call(b),b.transfer().detached].join(':')",
    );
    assert_result_agrees(
        "var g=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'detached').get,a=false,b=false;\
         try{g.call({})}catch(e){a=e instanceof TypeError}\
         try{g.call(new SharedArrayBuffer(0))}catch(e){b=e instanceof TypeError}\
         a+':'+b",
    );
}
