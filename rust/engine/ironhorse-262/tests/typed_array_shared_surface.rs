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
        "var P=Object.getPrototypeOf(Int8Array.prototype); var n=0; Object.defineProperty(P,Symbol.toStringTag,{get:function(){n++;return 'Custom'},configurable:true}); Object.prototype.toString.call(new Int8Array(1))+':'+n",
        "var P=Object.getPrototypeOf(Int8Array.prototype); var marker={}; Object.defineProperty(P,Symbol.toStringTag,{get:function(){throw marker},configurable:true}); try{Object.prototype.toString.call(new Int8Array(1));false}catch(e){e===marker}",
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
        "Array.from=function(){return []}; Int8Array.from([1,2]).length",
        "var log=[]; function C(n){log.push('C');return new Int8Array(n)} var o={length:1,get 0(){log.push('g');return 1}}; Int8Array.from.call(C,o); log.join('')",
        "function C(){return new Int8Array(0)} try{Int8Array.from.call(C,[1]);false}catch(e){e instanceof TypeError}",
        "function C(){return new Int8Array(0)} try{Int8Array.of.call(C,1);false}catch(e){e instanceof TypeError}",
        "var called=false,argument=-1; function C(length){called=true;argument=length;return new Uint8Array(0)} try{Int8Array.from.call(C,{length:4294967296})}catch(e){} called+':'+argument",
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
        "var a=new Uint8Array([1,2]); var i=a.values(); $262.detachArrayBuffer(a.buffer); try{i.next();false}catch(e){e instanceof TypeError}",
        "var a=new Uint8Array([1]); var i=a.values(); i.next(); i.next(); $262.detachArrayBuffer(a.buffer); i.next().done",
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

#[test]
fn shared_allocating_methods_honor_species_copy_and_view_semantics() {
    for source in [
        "var a=new Uint8Array([1,2,3]); var b=a.slice(1); a[1]=9; b.join(',')+':'+(b.buffer!==a.buffer)",
        "var a=new Uint8Array([1,2,3]); var b=a.subarray(1); a[1]=9; b.join(',')+':'+(b.buffer===a.buffer)",
        "var seen=''; function C(buffer,offset,length){seen=offset+':'+length;return new Uint8Array(0)} var a=new Uint8Array(new ArrayBuffer(8),2,4); a.constructor={[Symbol.species]:C}; $262.detachArrayBuffer(a.buffer); try{a.subarray(1,3)}catch(_error){} seen",
        "var a=new Uint8Array([1,255]); a.constructor={[Symbol.species]:Int16Array}; var b=a.slice(); (b instanceof Int16Array)+':'+b.join(',')",
        "var log=[]; function S(n){log.push('species:'+n);return new Uint8Array(n)} var a=new Uint8Array([1,2]); a.constructor={[Symbol.species]:S}; var b=a.map(function(v){log.push('map:'+v);return v+1}); log.join(',')+':'+b.join(',')",
        "var log=[]; function S(n){log.push('species:'+n);return new Uint8Array(n)} var a=new Uint8Array([1,2,3]); a.constructor={[Symbol.species]:S}; var b=a.filter(function(v){log.push('filter:'+v);return v>1}); log.join(',')+':'+b.join(',')",
        "var a=new BigInt64Array([1n,2n,3n]); a.map(function(v){return v*2n}).join(',')+':'+a.filter(function(v){return v>1n}).join(',')",
        "new BigInt64Array([3n,-1n,2n]).sort().join(',')",
        "var a=new Float64Array([NaN,3,-0,0,-2]).sort(); a[0]+':'+Object.is(a[1],-0)+':'+Object.is(a[2],0)+':'+a[3]+':'+String(a[4])",
        "new Uint8Array([7,6,5,4,3,2,1,0]).sort(function(a,b){return (a>>2)-(b>>2)}).join(',')",
        "try{new Uint8Array([2,1]).sort(function(){return 0n});false}catch(e){e instanceof TypeError}",
        "var P=Object.getPrototypeOf(Int8Array.prototype); P.toString===Array.prototype.toString",
        "var a=new Uint8Array([1,2]); a.toString()",
    ] {
        agrees(source);
    }
}

#[test]
fn shared_locale_string_validates_and_invokes_each_numeric_domain() {
    for source in [
        "var calls=[]; BigInt.prototype.toLocaleString=function(){calls.push(this);return 'b'+this}; var a=new BigInt64Array([1n,2n]); a.toLocaleString()+':'+calls.join('|')",
        "var a=new Uint8Array([1,2]); var calls=0; Number.prototype.toLocaleString=function(){calls++;if(calls===1)$262.detachArrayBuffer(a.buffer);return this}; a.toLocaleString()+':'+calls",
        "var a=new Uint8Array(1); $262.detachArrayBuffer(a.buffer); try{a.toLocaleString();false}catch(e){e instanceof TypeError}",
        "try{Uint8Array.prototype.toLocaleString.call({});false}catch(e){e instanceof TypeError}",
        "var P=Object.getPrototypeOf(Int8Array.prototype); P.toLocaleString.name+':'+P.toLocaleString.length",
    ] {
        agrees(source);
    }

    // XS has no ECMA-402 NumberFormat host and its Array locale-string path
    // does not forward locales/options. Pin the modern behavior directly on
    // IronHorse while retaining oracle coverage for invocation and errors.
    for (source, expected) in [
        ("new Uint8Array([1,2,255]).toLocaleString()", "1,2,255"),
        (
            "new BigInt64Array([1234567890123456789n,-2n]).toLocaleString()",
            "1,234,567,890,123,456,789,-2",
        ),
        (
            "new Uint8Array([1,2]).toLocaleString('en-US',{style:'currency',currency:'USD'})",
            "$1.00,$2.00",
        ),
        (
            "new BigInt64Array([1n,2n]).toLocaleString('en-US',{style:'currency',currency:'USD'})",
            "$1.00,$2.00",
        ),
        (
            "new Uint8Array([1,2]).toLocaleString('en-US',{style:'unit',unit:'meter'})",
            "1 m,2 m",
        ),
        (
            "new BigInt64Array([1n,2n]).toLocaleString('en-US',{style:'unit',unit:'meter'})",
            "1 m,2 m",
        ),
        (
            "var calls=[]; Number.prototype.toLocaleString=function(l,o){calls.push(this+':'+l+':'+o.x);return 'v'+this}; var a=new Uint8Array([1,2]); a.toLocaleString('zz',{x:4})+':'+calls.join('|')",
            "v1,v2:1:zz:4|2:zz:4",
        ),
    ] {
        let run = dual_run(source).expect("the pinned XS oracle must start");
        assert!(
            matches!(
                run.agreement,
                Agreement::BothComplete | Agreement::IronhorseOnlyComplete
            ),
            "{run:?}",
        );
        assert_eq!(run.ironhorse_result, expected, "for `{source}`");
    }
}
