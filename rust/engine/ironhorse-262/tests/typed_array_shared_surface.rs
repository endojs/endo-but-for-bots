//! Oracle-backed coverage for the shared `%TypedArray%` constructor and
//! prototype exposed through the concrete TypedArray inheritance chain.

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
fn shared_view_accessors_have_spec_descriptors_and_brand_checks() {
    for source in [
        "var P=Object.getPrototypeOf(Int8Array.prototype); var d=Object.getOwnPropertyDescriptor(P,'length'); typeof d.get+':'+d.set+':'+d.enumerable+':'+d.configurable",
        "var a=new Uint16Array(new ArrayBuffer(12),2,3); a.length+':'+a.byteLength+':'+a.byteOffset+':'+(a.buffer instanceof ArrayBuffer)",
        "var P=Object.getPrototypeOf(Int8Array.prototype); var g=Object.getOwnPropertyDescriptor(P,'length').get; try { g.call({}); false } catch (e) { e instanceof TypeError }",
        "var P=Object.getPrototypeOf(Int8Array.prototype); var d=Object.getOwnPropertyDescriptor(P,Symbol.toStringTag); d.get.call(new Uint16Array(1))+':'+d.get.call({})+':'+d.enumerable+':'+d.configurable",
    ] {
        agrees(source);
    }
}

#[test]
fn shared_from_and_of_construct_concrete_typed_arrays() {
    for source in [
        "Int8Array.from===Object.getPrototypeOf(Int8Array).from",
        "var a=Uint8Array.of(1,258,-1); (a instanceof Uint8Array)+':'+a.length+':'+a[0]+':'+a[1]+':'+a[2]",
        "var a=Uint16Array.from([1,2,3],function(v,i){return v+i}); a.length+':'+a[0]+':'+a[1]+':'+a[2]",
        "var seen=[]; var src={[Symbol.iterator]:function(){var i=0;return {next:function(){seen.push(i);return i<2?{value:++i,done:false}:{done:true}}}}}; var a=Uint8Array.from(src); a[0]+','+a[1]+':'+seen.join(',')",
        "var log=[]; var src={[Symbol.iterator]:function(){var i=0;return {next:function(){log.push('n'+i);return i<2?{value:++i,done:false}:{done:true}}}}}; Uint8Array.from(src,function(v){log.push('m'+v);return v}); log.join(',')",
        "try { Uint8Array.from.call({}, [1]); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}
