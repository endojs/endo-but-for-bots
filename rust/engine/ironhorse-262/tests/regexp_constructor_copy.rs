//! Coverage for `RegExp` called or constructed with a RegExp argument.

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
fn bare_call_returns_only_the_same_constructor_regexp() {
    for source in [
        "var r=/ab/gi;r.lastIndex=3;(RegExp(r)===r)+':'+r.lastIndex",
        "var r=/ab/g;r.constructor=Object;var c=RegExp(r);(c!==r)+':'+c.source+':'+c.flags+':'+c.lastIndex",
        "var n=0;var r=/x/;Object.defineProperty(r,'constructor',{get:function(){n++;return RegExp}});(RegExp(r)===r)+':'+n",
        "var r=/ab/g;r[Symbol.match]=false;var c=RegExp(r);(c!==r)+':'+c.test('/ab/g')",
        "var o={source:'x',flags:'i',constructor:RegExp};o[Symbol.match]=true;RegExp(o)===o",
        "var n=0;var r=/x/;var p=new Proxy(RegExp.prototype,{get:function(){n++;return RegExp}});Object.setPrototypeOf(r,p);(RegExp(r)===r)+':'+n",
    ] {
        agrees(source);
    }
}

#[test]
fn construction_and_flag_overrides_create_a_fresh_regexp() {
    for source in [
        "var r=/ab/gi;r.lastIndex=4;var c=new RegExp(r);(c!==r)+':'+c.source+':'+c.flags+':'+c.lastIndex",
        "var r=/ab/gi;var c=new RegExp(r,'my');c.source+':'+c.flags",
        "var r=/ab/g;var c=RegExp(r,'i');(c!==r)+':'+c.source+':'+c.flags",
        "var r=/ab/g;try{new RegExp(r,'gg');false}catch(e){e instanceof SyntaxError}",
        "var log=[];var o={get source(){log.push('s');return 'ab'},get flags(){log.push('f');return 'i'}};o[Symbol.match]=true;var c=new RegExp(o);c.test('AB')+':'+log.join('')",
        "var o={};o[Symbol.match]=true;var c=new RegExp(o);c.source+':'+c.flags+':'+c.test('undefined')",
        "var o={source:undefined,flags:undefined};o[Symbol.match]=true;var c=new RegExp(o);c.source+':'+c.flags+':'+c.test('undefined')",
        "var n=0;var r=/x/;var p=new Proxy(RegExp.prototype,{get:function(){n++;return n===1?'ab':'i'}});Object.setPrototypeOf(r,p);var c=new RegExp(r);c.test('AB')+':'+n",
        "var r=/x/g;var p=Object.create(RegExp.prototype);Object.defineProperty(p,'source',{get:function(){return 'ab'}});Object.defineProperty(p,'flags',{get:function(){return 'i'}});Object.setPrototypeOf(r,p);var c=new RegExp(r);c.test('AB')+':'+c.flags",
        "var r=/x/g;Object.defineProperty(r,'source',{value:'ab'});Object.defineProperty(r,'flags',{value:'i'});var c=new RegExp(r);c.test('AB')+':'+c.flags",
    ] {
        agrees(source);
    }
}
