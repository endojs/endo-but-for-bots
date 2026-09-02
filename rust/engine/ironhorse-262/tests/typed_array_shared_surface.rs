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

#[test]
fn shared_from_and_of_properties_are_writable_and_configurable() {
    for name in ["from", "of"] {
        agrees(&format!(
            "var T=Object.getPrototypeOf(Int8Array); var name='{name}'; var old=T[name]; var d=Object.getOwnPropertyDescriptor(T,name); var seen=false; for(var key in T){{if(key===name)seen=true}} var enumerable=seen&&Object.prototype.hasOwnProperty.call(T,name)&&Object.prototype.propertyIsEnumerable.call(T,name); T[name]='unlikelyValue'; var writable=T[name]==='unlikelyValue'; T[name]=old; var configurable=delete T[name]; d.writable+':'+d.enumerable+':'+d.configurable+':'+enumerable+':'+writable+':'+configurable+':'+Object.prototype.hasOwnProperty.call(T,name)"
        ));
    }
}

#[test]
fn bigint_view_byte_offset_tracks_buffer_geometry() {
    for constructor in ["BigInt64Array", "BigUint64Array"] {
        for source in [
            format!(
                "var T={constructor}; var offset=4*T.BYTES_PER_ELEMENT; var buffer=new ArrayBuffer(8*T.BYTES_PER_ELEMENT); new T(buffer,offset).byteOffset"
            ),
            format!(
                "var T={constructor}; var offset=4*T.BYTES_PER_ELEMENT; var buffer=new ArrayBuffer(8*T.BYTES_PER_ELEMENT); var view=new T(buffer,offset); new T(view).byteOffset"
            ),
        ] {
            agrees(&source);
        }
    }
}

#[test]
fn shared_join_handles_number_bigint_and_detachment() {
    for source in [
        "new Uint8Array([1,2,255]).join('-')",
        "new BigInt64Array([1n,-2n,3n]).join('|')",
        "var a=new Uint8Array([1,2,3]); var s={toString:function(){$262.detachArrayBuffer(a.buffer);return '-'}}; a.join(s)",
        "try { Uint8Array.prototype.join.call({}, ','); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn shared_iterators_validate_and_yield_each_element_domain() {
    for source in [
        "var a=new Uint8Array([4,5]); var i=a.values(); i.next().value+':'+i.next().value+':'+i.next().done",
        "var a=new Uint8Array([4,5]); var i=a.keys(); i.next().value+':'+i.next().value+':'+i.next().done",
        "var a=new BigInt64Array([4n,-5n]); var i=a.entries(); var x=i.next().value; var y=i.next().value; x[0]+':'+x[1]+':'+y[0]+':'+y[1]",
        "var P=Object.getPrototypeOf(Int8Array.prototype); P.values===P[Symbol.iterator]",
        "var a=new Uint8Array(1); $262.detachArrayBuffer(a.buffer); try { a.values(); false } catch (e) { e instanceof TypeError }",
        "try { Uint8Array.prototype.values.call({}); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn shared_readonly_methods_observe_live_elements_and_iteration_order() {
    for source in [
        "var a=new Uint8Array([42]); Reflect.set(a,0,7)+':'+a[0]",
        "var a=new Uint8Array([5]); [Reflect.get(a,0),Reflect.has(a,0),Reflect.getOwnPropertyDescriptor(a,0).value,Reflect.defineProperty(a,0,{value:9}),a[0],Reflect.deleteProperty(a,0)].join(':')",
        "var a=new Uint8Array([42,43,44]); var n=0; var r=a.every(function(v,i){Reflect.set(a,i,n++); return true}); r+':'+a.join(',')",
        "var a=new Uint8Array([1,2,3]); var seen=[]; a.forEach(function(v,i){seen.push(v+':'+i); if(i===0)a[1]=9}); seen.join(',')",
        "var a=new Uint8Array([1,2,3]); a.some(function(v){return v===2})+':'+a.find(function(v){return v>1})+':'+a.findIndex(function(v){return v>2})",
        "var a=new Float64Array([NaN,0,-0]); a.includes(NaN)+':'+a.indexOf(NaN)+':'+a.indexOf(0)+':'+a.lastIndexOf(0)",
        "var a=new Uint8Array(); var x={valueOf:function(){throw new Error('unreached')}}; a.includes(0,x)+':'+a.indexOf(0,x)",
        "var a=new BigInt64Array([1n,2n,3n]); a.reduce(function(x,y){return x+y},0n)+':'+a.reduceRight(function(x,y){return x-y})",
        "var a=new Uint8Array([1,2]); var seen=[]; a.forEach(function(v,i){seen.push(String(v));if(i===0)$262.detachArrayBuffer(a.buffer)});seen.join(',')",
    ] {
        agrees(source);
    }
}
