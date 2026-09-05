//! Oracle-backed regressions for the deterministic UTC `Date` profile.

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
fn constructor_utc_and_time_clip_match_xs() {
    for source in [
        "new Date(0).getTime()",
        "new Date(-0).getTime() === 0 && 1 / new Date(-0).getTime() === Infinity",
        "new Date(8640000000000001).getTime() !== new Date(8640000000000001).getTime()",
        "Date.UTC(1970, 0, 1)",
        "Date.UTC(99, 11, 31, 23, 59, 59, 999)",
        "Date.UTC(2016, 12, 1) === Date.UTC(2017, 0, 1)",
        "Date.UTC()",
        "try{new Date(1n);false}catch(e){e instanceof TypeError}",
        "try{Date.UTC(1n);false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn date_intrinsic_reflection_matches_xs() {
    for source in [
        "Date.hasOwnProperty('parse')+':'+Date.hasOwnProperty('UTC')+':'+Date.hasOwnProperty('now')",
        "Date.prototype.hasOwnProperty('toDateString')+':'+Date.prototype.hasOwnProperty('setUTCFullYear')",
        "Object.keys(Object.getOwnPropertyDescriptor(globalThis,'Date')).join(',')",
        "var d=Object.getOwnPropertyDescriptor(globalThis,'Date');d.writable+':'+d.enumerable+':'+d.configurable",
        "var seen=false;for(var k in globalThis){if(k==='Date')seen=true}seen",
        "var n='Date';Object.getOwnPropertyDescriptor(globalThis,n);delete globalThis[n];Object.getOwnPropertyDescriptor(globalThis,n)===undefined",
    ] {
        agrees(source);
    }
}

#[test]
fn utc_getters_and_iso_rendering_match_xs() {
    for source in [
        "var d=new Date(Date.UTC(2000,1,29,23,58,57,123)); [d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),d.getUTCDay(),d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds(),d.getUTCMilliseconds()].join(',')",
        "new Date(0).toISOString()",
        "new Date(-62167219200000).toISOString()",
        "new Date(0).toUTCString()",
        "Object.prototype.toString.call(new Date(0))",
        "new Date(NaN).toString()",
        "try { new Date(NaN).toISOString(); false } catch (e) { e instanceof RangeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn parsing_and_set_time_match_xs() {
    for source in [
        "Date.parse('1970-01-01T00:00:00.000Z')",
        "Date.parse('2000-02-29')",
        "new Date('1970').toISOString()",
        "new Date('2000-02').toISOString()",
        "new Date('-000001-07-01T00:00Z').getUTCFullYear()",
        "var d=new Date('-000001-07-01T00:00Z');d.toDateString().split(' ')[3]+':'+d.toUTCString().split(' ')[3]",
        "var d=new Date(0);Date.parse(d.toString())+':'+Date.parse(d.toUTCString())",
        "new Date('2000-02-29T12:34:56.789Z').toISOString()",
        "Date.parse('2019-02-29')",
        "Date.parse('2019-13-01')",
        "Date.parse('2019-00-01')",
        "Date.parse('2019-01-01T24:01:00Z')",
        "Date.parse('2019-01-01T01:02:03.1234Z')",
        "Date.parse('2019-01-01T00:00:00+09')",
        "var d=new Date(1); d.setTime(null) === 0 && d.getTime() === 0",
        "new Date(0).toJSON()",
        "new Date(NaN).toJSON()",
        "var d=new Date(0);try{d.setTime(1n);false}catch(e){e instanceof TypeError&&d.getTime()===0}",
    ] {
        agrees(source);
    }
}

#[test]
fn to_json_is_generic_and_observable() {
    for source in [
        "var log=[];var o={valueOf:function(){log.push('valueOf');return 1},get toISOString(){log.push('get');return function(){log.push(this===o?'call':'bad');return 42}}};Date.prototype.toJSON.call(o)+':'+log.join(',')",
        "var touched=false;var o={valueOf:function(){return Infinity},get toISOString(){touched=true;throw 'bad'}};Date.prototype.toJSON.call(o)===null&&!touched",
        "var o={toString:function(){return 'x'},valueOf:function(){return {}},toISOString:function(){return this===o&&arguments.length===0}};Date.prototype.toJSON.call(o)",
        "var ok=false;try{Date.prototype.toJSON.call(null)}catch(e){ok=e instanceof TypeError}ok",
        "Number.prototype.toISOString=function(){return this.valueOf()+1};Date.prototype.toJSON.call(4)",
        "var o;var fn=new Proxy(function(){return 'base'},{apply:function(target,self,args){return self===o&&args.length===0?'ok':'bad'}});o={valueOf:function(){return 1},toISOString:fn};Date.prototype.toJSON.call(o)",
        "var resolve;new Promise(function(r){resolve=r});var o={valueOf:function(){return 1},toISOString:resolve};String(Date.prototype.toJSON.call(o))",
        "var d=new Date(0);var o={valueOf:function(){return 1},toISOString:d.toISOString.bind(d)};Date.prototype.toJSON.call(o)",
        "var called=false;var valueOf=new Proxy(function(){return 1},{apply:function(){called=true;return 1}});var o={valueOf:valueOf,toISOString:function(){return called}};Date.prototype.toJSON.call(o)",
    ] {
        agrees(source);
    }
}

#[test]
fn date_to_primitive_and_locale_surface_match_xs() {
    for source in [
        "var d=new Date(0);d[Symbol.toPrimitive]('default')===d.toString()",
        "var d=new Date(0);d[Symbol.toPrimitive]('number')===0",
        "var log='';var o={toString:function(){log+='s';return 'ok'},valueOf:function(){log+='n';return 1}};Date.prototype[Symbol.toPrimitive].call(o,'default')+':'+log",
        "var log='';var o={toString:function(){log+='s';return 'ok'},valueOf:function(){log+='n';return 1}};Date.prototype[Symbol.toPrimitive].call(o,'number')+':'+log",
        "try{Date.prototype[Symbol.toPrimitive].call({},'invalid');false}catch(e){e instanceof TypeError}",
        "try{Date.prototype[Symbol.toPrimitive].call(1,'number');false}catch(e){e instanceof TypeError}",
        "Date.prototype[Symbol.toPrimitive].name+':'+Date.prototype[Symbol.toPrimitive].length",
        "Object.getOwnPropertySymbols(Date.prototype).map(String).join(',')",
        "var k=Object.getOwnPropertySymbols(Date.prototype)[0];var d=Object.getOwnPropertyDescriptor(Date.prototype,k);d.value===Date.prototype[k]&&!d.writable&&!d.enumerable&&d.configurable",
        "typeof Date.prototype.toLocaleString+':'+Date.prototype.toLocaleString.name+':'+Date.prototype.toLocaleString.length",
        "typeof Date.prototype.toLocaleDateString+':'+Date.prototype.toLocaleDateString.name+':'+Date.prototype.toLocaleDateString.length",
        "typeof Date.prototype.toLocaleTimeString+':'+Date.prototype.toLocaleTimeString.name+':'+Date.prototype.toLocaleTimeString.length",
    ] {
        agrees(source);
    }
}

#[test]
fn reflect_construct_date_uses_new_target_prototype() {
    for source in [
        "var C=function(){};var d=Reflect.construct(Date,[64],C);Object.getPrototypeOf(d)===C.prototype&&Date.prototype.getTime.call(d)===64",
        "var C=function(){};C.prototype=null;var d=Reflect.construct(Date,[64],C);Object.getPrototypeOf(d)===Date.prototype&&d.getTime()===64",
        "var log=[],p={};var C=new Proxy(function(){},{get:function(t,k,r){log.push(String(k));return k==='prototype'?p:Reflect.get(t,k,r)}});var d=Reflect.construct(Date,[64],C);log.join(',')+':'+(Object.getPrototypeOf(d)===p)+':'+Date.prototype.getTime.call(d)",
        "var C=new Proxy(function(){},{get:function(t,k,r){if(k==='prototype')throw 17;return Reflect.get(t,k,r)}});try{Reflect.construct(Date,[],C);false}catch(e){e===17}",
        "var log=[],p={};var C=new Proxy(function(){},{get:function(t,k,r){log.push(String(k));return k==='prototype'?p:Reflect.get(t,k,r)}});var o=Reflect.construct(Object,[],C);log.join(',')+':'+(Object.getPrototypeOf(o)===p)",
        "var C=new Proxy(function(){},{get:function(t,k,r){if(k==='prototype')throw 17;return Reflect.get(t,k,r)}});try{Reflect.construct(Object,[],C);false}catch(e){e===17}",
    ] {
        agrees(source);
    }
}

#[test]
fn calendar_and_clock_setters_match_xs() {
    for source in [
        "var d=new Date(Date.UTC(2000,0,31,23,58,57,123));d.setUTCMonth(1);d.toISOString()",
        "var d=new Date(Date.UTC(2000,0,1));d.setUTCDate(0);d.toISOString()",
        "var d=new Date(Date.UTC(2000,0,1));d.setUTCHours(25,61,62,1001);d.toISOString()",
        "var d=new Date(Date.UTC(2000,0,1));d.setUTCMinutes(-1);d.toISOString()",
        "var d=new Date(Date.UTC(2000,0,1));d.setUTCSeconds(1,1500);d.toISOString()",
        "var d=new Date(Date.UTC(2000,0,1));d.setUTCMilliseconds(-1);d.toISOString()",
        "var d=new Date(NaN);d.setUTCFullYear(5,0,2);d.toISOString()",
        "var d=new Date(Date.UTC(2000,0,1));d.setUTCFullYear(5);d.getUTCFullYear()",
        "var d=new Date(0),t=d.getTime();d.setFullYear(d.getFullYear());d.getTime()===t",
        "var d=new Date(0),t=d.getTime();d.setMonth(d.getMonth(),d.getDate());d.getTime()===t",
        "var d=new Date(0),t=d.getTime();d.setDate(d.getDate());d.getTime()===t",
        "var d=new Date(0),t=d.getTime();d.setHours(d.getHours(),d.getMinutes(),d.getSeconds(),d.getMilliseconds());d.getTime()===t",
        "var d=new Date(0),t=d.getTime();d.setMinutes(d.getMinutes(),d.getSeconds(),d.getMilliseconds());d.getTime()===t",
        "var d=new Date(0),t=d.getTime();d.setSeconds(d.getSeconds(),d.getMilliseconds());d.getTime()===t",
        "var d=new Date(0),t=d.getTime();d.setMilliseconds(d.getMilliseconds());d.getTime()===t",
    ] {
        agrees(source);
    }
}

#[test]
fn date_setters_preserve_validation_and_coercion_order() {
    for source in [
        "var calls=0;try{Date.prototype.setUTCMonth.call({}, {valueOf:function(){calls++;return 1}})}catch(e){}calls",
        "var d=new Date(0),log=[];d.setUTCHours({valueOf:function(){log.push('h');return 1}},{valueOf:function(){log.push('m');return 2}},{valueOf:function(){log.push('s');return 3}},{valueOf:function(){log.push('x');return 4}});log.join('')+':'+d.toISOString()",
        "var d=new Date(0),calls=0;try{d.setUTCMonth({valueOf:function(){throw 'x'}},{valueOf:function(){calls++;return 1}})}catch(e){}calls+':'+d.getTime()",
        "var d=new Date(NaN),calls=0;var r=d.setUTCMonth(1,{valueOf:function(){calls++;return 2}});calls+':'+(r!==r)+':'+(d.getTime()!==d.getTime())",
        "var d=new Date(0);var r=d.setUTCDate();(r!==r)+':'+(d.getTime()!==d.getTime())",
        "var d=new Date(0);try{d.setUTCDate(1n);false}catch(e){e instanceof TypeError&&d.getTime()===0}",
        "var d=new Date(0);try{d.setDate({valueOf:function(){return 1n}});false}catch(e){e instanceof TypeError&&d.getTime()===0}",
        "var d=new Date(0);var r=d.setUTCDate(-1e300);(r!==r)+':'+(d.getTime()!==d.getTime())",
        "var d=new Date(0);var r=d.setUTCDate(1e300);(r!==r)+':'+(d.getTime()!==d.getTime())",
        "var d=new Date(0);var r=d.setUTCFullYear(-1e300);(r!==r)+':'+(d.getTime()!==d.getTime())",
        "var d=new Date(0);var r=d.setUTCFullYear(1e300);(r!==r)+':'+(d.getTime()!==d.getTime())",
    ] {
        agrees(source);
    }
}

#[test]
fn date_setter_metadata_matches_xs() {
    for (name, length) in [
        ("setMilliseconds", 1),
        ("setUTCMilliseconds", 1),
        ("setSeconds", 2),
        ("setUTCSeconds", 2),
        ("setMinutes", 3),
        ("setUTCMinutes", 3),
        ("setHours", 4),
        ("setUTCHours", 4),
        ("setDate", 1),
        ("setUTCDate", 1),
        ("setMonth", 2),
        ("setUTCMonth", 2),
        ("setFullYear", 3),
        ("setUTCFullYear", 3),
    ] {
        agrees(&format!(
            "var f=Date.prototype.{name};f.name+':'+f.length==='{}:{}'",
            name, length
        ));
    }
}
