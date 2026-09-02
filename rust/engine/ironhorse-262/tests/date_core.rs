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
        "new Date('2000-02-29T12:34:56.789Z').toISOString()",
        "var d=new Date(1); d.setTime(null) === 0 && d.getTime() === 0",
        "new Date(0).toJSON()",
        "new Date(NaN).toJSON()",
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
