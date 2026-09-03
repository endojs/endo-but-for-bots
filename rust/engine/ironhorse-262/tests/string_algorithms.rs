//! Oracle-backed regressions for UTF-16 String construction and prototype
//! algorithms. These deliberately include lone surrogates and generic
//! receivers so a UTF-8/scalar-value shortcut cannot satisfy the gate.

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
fn constructors_preserve_utf16_and_code_points() {
    for source in [
        "String.fromCharCode(65, 0xD800).charCodeAt(1)",
        "String.fromCharCode(0x10041)",
        "String.fromCodePoint(0x1F600).length",
        "String.fromCodePoint(0x1F600).codePointAt(0)",
        "String.fromCodePoint()",
    ] {
        agrees(source);
    }
}

#[test]
fn constructor_statics_reject_invalid_calls_catchably() {
    for source in [
        "try { String.fromCodePoint(Symbol()); false } catch (e) { e instanceof TypeError }",
        "try { String.fromCharCode(0n); false } catch (e) { e instanceof TypeError }",
        "try { new String.fromCharCode(65); false } catch (e) { e instanceof TypeError }",
        "try { String.fromCodePoint(0x110000); false } catch (e) { e instanceof RangeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn string_builtins_expose_standard_name_and_length_metadata() {
    for source in [
        "String.fromCharCode.name+':'+String.fromCharCode.length+':'+String.fromCodePoint.name+':'+String.fromCodePoint.length",
        "var n=['charCodeAt','codePointAt','charAt','at','slice','substring','indexOf','lastIndexOf','includes','startsWith','endsWith','concat','toLowerCase','toUpperCase','normalize','repeat','trim','padStart','padEnd','isWellFormed','toWellFormed','match','search','replace','replaceAll','split'];n.map(function(k){return String.prototype[k].name+':'+String.prototype[k].length}).join('|')",
        "String.prototype[Symbol.iterator].name+':'+String.prototype[Symbol.iterator].length",
    ] {
        agrees(source);
    }
}

#[test]
fn padding_and_well_formedness_are_code_unit_exact() {
    for source in [
        "'x'.padStart(5, 'ab')",
        "'x'.padEnd(4)",
        "'abc'.padStart(2, 'z')",
        "'ok'.isWellFormed()",
        "String.fromCharCode(0xD800).isWellFormed()",
        "String.fromCharCode(0xD800).toWellFormed().charCodeAt(0)",
        "String.fromCodePoint(0x1F600).toWellFormed().length",
    ] {
        agrees(source);
    }
}

#[test]
fn methods_coerce_generic_receivers_and_trim_ecmascript_whitespace() {
    for source in [
        "String.prototype.trim.call(123)",
        "String.prototype.trim.call({ toString: function () { return '  ok  '; } })",
        "String.prototype.trim.call('\\u00A0\\uFEFFok\\u3000')",
        "String.prototype.padStart.call({ toString: function () { return 'x'; } }, 3, '0')",
        "''.repeat(2147483647).length",
    ] {
        agrees(source);
    }
}

#[test]
fn unicode_case_conversion_handles_special_contextual_and_astral_mappings() {
    for source in [
        "'\\u0130'.toLowerCase().split('').map(function(c){return c.charCodeAt(0).toString(16)}).join(',')",
        "'Straße \\uFB03'.toUpperCase()",
        "'A\\u03A3 A\\u03A3B'.toLowerCase()",
        "String.fromCodePoint(0x10400).toLowerCase().codePointAt(0).toString(16)",
        "String.fromCodePoint(0x10428).toUpperCase().codePointAt(0).toString(16)",
        "'\\u212A É'.toLowerCase()",
        "String.prototype.toUpperCase.call({toString:function(){return 'élan'}})",
    ] {
        agrees(source);
    }
}

#[test]
fn unicode_case_conversion_preserves_lone_surrogates() {
    for source in [
        "var s=String.fromCharCode(0xD800,65);var r=s.toLowerCase();r.charCodeAt(0)+':'+r.charCodeAt(1)",
        "var s=String.fromCharCode(97,0xDC00);var r=s.toUpperCase();r.charCodeAt(0)+':'+r.charCodeAt(1)",
    ] {
        agrees(source);
    }
}

#[test]
fn unicode_normalization_supports_all_forms_and_preserves_utf16() {
    for source in [
        "'e\\u0301'.normalize() === '\\u00E9'",
        "'\\u00E9'.normalize('NFD').split('').map(function(c){return c.charCodeAt(0).toString(16)}).join(',')",
        "'\\uFB03'.normalize('NFKC')",
        "'\\u2460'.normalize('NFKD')",
        "String.fromCodePoint(0x1D15E).normalize('NFD').split('').map(function(c){return c.charCodeAt(0).toString(16)}).join(',')",
        "var s=String.fromCharCode(0xD800,0x65,0x301,0xDC00);var r=s.normalize();r.charCodeAt(0)+':'+r.charCodeAt(1)+':'+r.charCodeAt(2)",
    ] {
        agrees(source);
    }
}

#[test]
fn unicode_normalization_observes_coercion_order_and_errors() {
    for source in [
        "String.prototype.normalize.call({toString:function(){return 'e\\u0301'}})",
        "var log=[];var r={toString:function(){log.push('this');return 'e\\u0301'}};var f={toString:function(){log.push('form');return 'NFC'}};String.prototype.normalize.call(r,f)+':'+log.join(',')",
        "try { 'x'.normalize('nfc'); false } catch (e) { e instanceof RangeError }",
        "try { 'x'.normalize(null); false } catch (e) { e instanceof RangeError }",
        "try { 'x'.normalize(Symbol()); false } catch (e) { e instanceof TypeError }",
        "var marker={};try{'x'.normalize({toString:function(){throw marker}});false}catch(e){e===marker}",
        "try { String.prototype.normalize.call(null); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn index_of_and_last_index_of_search_utf16_with_spec_coercions() {
    for source in [
        "'abcabc'.indexOf('bc')",
        "'abcabc'.indexOf('bc', 2)",
        "'abcabc'.indexOf('', 99)",
        "'abcabc'.lastIndexOf('bc')",
        "'abcabc'.lastIndexOf('bc', 3)",
        "'abcabc'.lastIndexOf('', -99)",
        "String.prototype.indexOf.call(12345, 34)",
        "String.prototype.lastIndexOf.call(true, 'r')",
        "var s=String.fromCodePoint(0x1F600)+'x'+String.fromCodePoint(0x1F600); s.indexOf(String.fromCodePoint(0x1F600), 1)",
        "var s=String.fromCharCode(0xD800,65,0xD800); s.lastIndexOf(String.fromCharCode(0xD800))",
        "'abc'.lastIndexOf('a', undefined)",
    ] {
        agrees(source);
    }
}

#[test]
fn index_of_missing_search_uses_undefined_despite_the_pinned_oracle_shortcut() {
    // ECMA-262 applies ToString(undefined), so this finds the word at zero.
    // The pinned XS oracle has an `argc < 1` shortcut returning -1; lock the
    // standards-correct IronHorse result without laundering that host bug into
    // the general oracle-agreement helper.
    let run = dual_run("'undefined value'.indexOf()")
        .expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete);
    assert_eq!(run.ironhorse_result, "0");
    assert_eq!(run.oracle_result, "-1");

    let run = dual_run("'undefined value'.lastIndexOf()")
        .expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete);
    assert_eq!(run.ironhorse_result, "0");
    assert_eq!(run.oracle_result, "-1");
}

#[test]
fn index_of_and_last_index_of_meter_representative_scans_exactly() {
    for source in [
        "'abc'.indexOf('b')",
        "'aaab'.indexOf('aab')",
        "'abcabc'.lastIndexOf('bc')",
        "var x=String.fromCodePoint(0x1F600); (x+'a'+x).lastIndexOf(x)",
    ] {
        let run = dual_run(source).expect("the XS oracle machine must start");
        assert!(
            run.is_bit_exact(),
            "`{source}` is not bit exact: oracle={:?}/{}/{} ironhorse={:?}/{}/{}",
            run.oracle_result,
            run.oracle_computrons,
            run.oracle_meter_raw,
            run.ironhorse_result,
            run.ironhorse_computrons,
            run.ironhorse_meter_raw,
        );
    }
}

#[test]
fn index_of_and_last_index_of_observe_coercion_order_and_errors() {
    for source in [
        "var log=[]; var r={toString:function(){log.push('this');return 'abc'}}; var s={toString:function(){log.push('search');return 'b'}}; var p={valueOf:function(){log.push('position');return 0}}; String.prototype.indexOf.call(r,s,p)+':'+log.join(',')",
        "var log=[]; var r={toString:function(){log.push('this');return 'abcabc'}}; var s={toString:function(){log.push('search');return 'b'}}; var p={valueOf:function(){log.push('position');return 4}}; String.prototype.lastIndexOf.call(r,s,p)+':'+log.join(',')",
        "try { String.prototype.indexOf.call(null, 'x'); false } catch (e) { e instanceof TypeError }",
        "try { 'abc'.indexOf(Symbol()); false } catch (e) { e instanceof TypeError }",
        "try { 'abc'.lastIndexOf('a', 0n); false } catch (e) { e instanceof TypeError }",
        "var marker={}; try { 'abc'.indexOf({toString:function(){throw marker}}); false } catch(e) { e===marker }",
    ] {
        agrees(source);
    }
}

#[test]
fn explicit_string_iterator_yields_unicode_code_points() {
    for source in [
        "var i='ab'[Symbol.iterator](); i.next().value+i.next().value+i.next().done",
        "var i=String.fromCodePoint(0x1F600)[Symbol.iterator](); i.next().value.length",
        "var i=String.fromCharCode(0xD800)[Symbol.iterator](); i.next().value.charCodeAt(0)",
    ] {
        agrees(source);
    }
}

#[test]
fn split_handles_string_separators_limits_and_utf16() {
    for source in [
        "JSON.stringify('one--two----four--'.split('--'))",
        "JSON.stringify('hello'.split('l', 2))",
        "JSON.stringify('hello'.split(undefined))",
        "JSON.stringify(''.split(''))",
        "JSON.stringify(''.split('x'))",
        "JSON.stringify('abc'.split('', 2))",
        "var s=String.fromCodePoint(0x1F600); var a=s.split(''); a.length+':'+a[0].charCodeAt(0)+':'+a[1].charCodeAt(0)",
        "String.prototype.split.call(123, '2').join('|')",
        "'thisnullisnull'.split(null).join('|')",
        "'aaaa'.split('a', -1).length",
        "'aaaa'.split('a', 4294967297).length",
        "JSON.stringify('hello'.split(/l/, 1))",
        "JSON.stringify('hello'.split(/l/, 2))",
        "JSON.stringify('hello'.split(new RegExp()))",
        "JSON.stringify('axb'.split(/x?/))",
    ] {
        agrees(source);
    }
}

#[test]
fn split_observes_custom_protocol_and_coercion_order() {
    for source in [
        "var log=[]; var recv={toString:function(){log.push('recv');return 'a--b'}}; var sep={get [Symbol.split](){log.push('get');return undefined},toString:function(){log.push('sep');return '--'}}; var lim={valueOf:function(){log.push('limit');return 9}}; String.prototype.split.call(recv,sep,lim).join(',')+'|'+log.join(',')",
        "var seen=''; var sep={ [Symbol.split]: function(s,l){seen=s+':'+l;return 7} }; var r='abc'.split(sep,2); seen+':'+r",
        "Number.prototype[Symbol.split]=function(s,l){return s+':'+l}; 'abc'.split(4,2)",
        "try { 'x'.split({[Symbol.split]: 1}); false } catch (e) { e instanceof TypeError }",
        "try { String.prototype.split.call(null, ','); false } catch (e) { e instanceof TypeError }",
        "var called=false; try { String.prototype.split.call(null,{[Symbol.split]:function(){called=true}}); false } catch(e) { e instanceof TypeError && !called }",
        "try { 'x'.split(Symbol()); false } catch (e) { e instanceof TypeError }",
        "var E=function(){}; var s={toString:function(){throw new E}}; try{'x'.split(s,0);false}catch(e){e instanceof E}",
        "String.prototype.split.name+':'+String.prototype.split.length",
        "'use strict'; var o=new Object(true); o.x=1; o.x",
        "'use strict'; var o=new Object(true); o.split=String.prototype.split; typeof o.split",
        "'use strict'; Boolean.prototype.toString; var o=new Object(true); o.split=String.prototype.split; o.split(true,false).length",
        "Object.prototype.toString; String.prototype.split.call(Math)[0]",
        "Object.defineProperty(Math,Symbol.toStringTag,{value:Symbol()}); Object.prototype.toString.call(Math)",
    ] {
        agrees(source);
    }
}

#[test]
fn search_constructs_regexp_from_ordinary_arguments() {
    for source in [
        "'ssABBABAB'.search({toString:function(){return 'AB'}})",
        "new String('test string').search('string')",
        "'a1b1c'.search(1)",
        "'atrueb'.search(true)",
        "'a42b'.search(42n)",
        "'abc'.search(undefined)",
        "String.prototype.search.call(12345, '34')",
        "try { 'abc'.search(Symbol()); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn search_observes_custom_symbol_protocol() {
    for source in [
        "var seen=[]; var p={ [Symbol.search]:function(v){seen.push(this===p,v);return 7} }; 'abc'.search(p)+':'+seen.join(',')",
        "var p={ [Symbol.search]:null,toString:function(){return '3'} }; 'ab3c'.search(p)",
        "var boom={}; var p={get [Symbol.search](){throw boom}}; try{'x'.search(p);false}catch(e){e===boom}",
        "try { 'x'.search({[Symbol.search]: 1}); false } catch (e) { e instanceof TypeError }",
        "var called=false; Number.prototype[Symbol.search]=function(){called=true}; 'a1'.search(1)+':'+called",
        "var recv={toString:function(){throw Error('must not coerce')}}; var p={[Symbol.search]:function(v){return v===recv}}; String.prototype.search.call(recv,p)",
        "try { String.prototype.search.call(null, { [Symbol.search]:function(){return 1} }); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn match_constructs_regexp_from_ordinary_arguments() {
    for source in [
        "'ssABBABAB'.match({toString:function(){return 'AB'}})[0]",
        "new String('test string').match('string')[0]",
        "'a1b1c'.match(1).index",
        "'atrueb'.match(true)[0]",
        "'a42b'.match(42n)[0]",
        "'abc'.match(undefined)[0]",
        "String.prototype.match.call(12345, '34')[0]",
        "try { 'abc'.match(Symbol()); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn match_observes_custom_symbol_protocol() {
    for source in [
        "var seen=[]; var p={ [Symbol.match]:function(v){seen.push(this===p,v);return 7} }; 'abc'.match(p)+':'+seen.join(',')",
        "var p={ [Symbol.match]:null,toString:function(){return '3'} }; 'ab3c'.match(p)[0]",
        "var boom={}; var p={get [Symbol.match](){throw boom}}; try{'x'.match(p);false}catch(e){e===boom}",
        "try { 'x'.match({[Symbol.match]: 1}); false } catch (e) { e instanceof TypeError }",
        "var called=false; Number.prototype[Symbol.match]=function(){called=true}; 'a1'.match(1)[0]+':'+called",
        "var recv={toString:function(){throw Error('must not coerce')}}; var p={[Symbol.match]:function(v){return v===recv}}; String.prototype.match.call(recv,p)",
        "try { String.prototype.match.call(null, { [Symbol.match]:function(){return 1} }); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn match_collects_global_results_and_advances_empty_matches() {
    for source in [
        "JSON.stringify('123456abcde7890'.match(/\\d{2}/g))",
        "'abc'.match(/z/g)",
        "var r=/a/g; r.lastIndex=2; JSON.stringify('aba'.match(r))+':'+r.lastIndex",
        "JSON.stringify('ab'.match(/(?:)/g))",
        "JSON.stringify('abb'.match(/b*/g))",
    ] {
        agrees(source);
    }
}

#[test]
fn replace_handles_ordinary_string_search_and_replacement() {
    for source in [
        "'xxx'.replace('x', 'a')",
        "'abc'.replace('', '-')",
        "'abc'.replace('b', \"[$&][$`][$'][$$][$1]\")",
        "String.prototype.replace.call(12345, '34', 'x')",
        "var log=[]; var s={toString:function(){log.push('search');return 'b'}}; var r={toString:function(){log.push('replacement');return 'x'}}; var o={toString:function(){log.push('receiver');return 'abc'}}; String.prototype.replace.call(o,s,r)+':'+log.join(',')",
        "var called=0; var r={toString:function(){called++;return 'x'}}; 'abc'.replace('z',r)+':'+called",
        "try { 'abc'.replace(Symbol(), 'x'); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn replace_invokes_function_and_custom_symbol_protocol() {
    for source in [
        "var a; var r='abc'.replace('b',function(){'use strict';a=[this,arguments[0],arguments[1],arguments[2],arguments.length];return 'X'});r+':'+a.join(',')",
        "var p={[Symbol.replace]:function(s,r){return (this===p)+':'+s+':'+r}}; 'abc'.replace(p,'x')",
        "var p={[Symbol.replace]:null,toString:function(){return 'b'}}; 'abc'.replace(p,'x')",
        "var boom={}; var p={get [Symbol.replace](){throw boom}}; try{'x'.replace(p,'y');false}catch(e){e===boom}",
        "try { 'x'.replace({[Symbol.replace]: 1}, 'y'); false } catch (e) { e instanceof TypeError }",
        "var called=false; Number.prototype[Symbol.replace]=function(){called=true}; 'a1'.replace(1,'x')+':'+called",
        "var recv={toString:function(){throw Error('must not coerce')}}; var p={[Symbol.replace]:function(v,r){return v===recv&&r===9}}; String.prototype.replace.call(recv,p,9)",
        "try { String.prototype.replace.call(null, { [Symbol.replace]:function(){return 1} }, 2); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn replace_handles_regexp_functions_and_global_collection() {
    for source in [
        "'abc12 def34'.replace(/([a-z]+)([0-9]+)/,function(){return arguments[2]+arguments[1]})",
        "var seen; 'éa'.replace(/a/,function(m,p){seen=p;return ''}); seen",
        "var seen; (String.fromCodePoint(0x1F600)+'a').replace(/a/,function(m,p){seen=p;return ''}); seen",
        "'a'.replace(/a/,function(){return String.fromCharCode(0xD800)}).charCodeAt(0)",
        "'123abc'.replace(/\\d/g, 'x')",
        "'abc'.replace(/(?:)/g, '-')",
        "'abc123def456'.replace(/([a-z]+)(\\d+)/g, '[$2:$1]')",
        "var seen=[]; 'a1b22'.replace(/(\\d+)/g,function(m,c,p,s){seen.push(m,c,p,s);return '#'});seen.join('|')",
        "var r=/a/g;r.lastIndex=2;var s='aba'.replace(r,'x');s+':'+r.lastIndex",
    ] {
        agrees(source);
    }
}

#[test]
fn replace_all_handles_plain_empty_and_functional_replacements() {
    for source in [
        "'aaab a a aac'.replaceAll('aa', 'z')",
        "'aaaaa'.replaceAll('aa', 'x')",
        "'abc'.replaceAll('', '-')",
        "''.replaceAll('', 'x')",
        "(String.fromCodePoint(0x1F600)).replaceAll('', '-').split('').map(function(c){return c.charCodeAt(0).toString(16)}).join(',')",
        "'ababa'.replaceAll('a', \"[$&][$`][$'][$$][$1]\")",
        "var seen=[];var r='aXa'.replaceAll('a',function(m,p,s){seen.push(m,p,s);return p});r+':'+seen.join('|')",
        "var called=0;var f=function(){called++;return 'x'};'abc'.replaceAll('z',f)+':'+called",
    ] {
        agrees(source);
    }
}

#[test]
fn replace_all_validates_regexp_and_observes_protocol_order() {
    for source in [
        "'a1a2'.replaceAll(/a/g, 'x')",
        "typeof RegExp.prototype[Symbol.replace]+':'+RegExp.prototype[Symbol.replace].name+':'+RegExp.prototype[Symbol.replace].length",
        "/a/g[Symbol.replace]('aa', 'x')",
        "var called=0;class RE extends RegExp {[Symbol.replace](...args){called++;return super[Symbol.replace](...args)}};var r=new RE('a','g');'aa'.replaceAll(r,'x')+':'+called+':'+(Object.getPrototypeOf(r)===RE.prototype)",
        "try { 'aa'.replaceAll(/a/, 'x'); false } catch (e) { e instanceof TypeError }",
        "var log=[];var recv={toString:function(){log.push('this');return 'aba'}};var search={toString:function(){log.push('search');return 'a'}};var repl={toString:function(){log.push('repl');return 'x'}};String.prototype.replaceAll.call(recv,search,repl)+':'+log.join(',')",
        "var search={flags:'g',[Symbol.match]:true,[Symbol.replace]:function(s,r){return this===search&&s==='x'&&r===7}};String.prototype.replaceAll.call('x',search,7)",
        "var r=/x/g;Object.defineProperty(r,Symbol.replace,{value:undefined});'x /x/g /x/g'.replaceAll(r,'z')",
        "var marker={};var search={[Symbol.match]:true,get flags(){throw marker}};try{'x'.replaceAll(search,'y');false}catch(e){e===marker}",
        "var marker={};var search={[Symbol.match]:false,get [Symbol.replace](){throw marker}};try{'x'.replaceAll(search,'y');false}catch(e){e===marker}",
        "try { String.prototype.replaceAll.call(null, 'x', 'y'); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn regexp_symbol_replace_observes_generic_exec_results() {
    for source in [
        "var n=0;var r={flags:'g',lastIndex:9,exec:function(){n++;return n===1?{length:3,0:'b',1:'x',2:undefined,index:1,groups:{name:'N'}}:null}};RegExp.prototype[Symbol.replace].call(r,'abc','$1-$2-$<name>')+':'+r.lastIndex+':'+n",
        "var n=0;var r=/./;r.exec=function(){return {get length(){n++;return 2},get 0(){n++;return 'a'},get index(){n++;return 0},get 1(){n++;return 7},get groups(){n++;return undefined}}};r[Symbol.replace]('ab','$1')+':'+n",
        "var args;var r=/./;r.exec=function(){return []};r[Symbol.replace]('foo',function(){args=[].slice.call(arguments)});args.map(String).join('|')",
        "var r=/./;r.exec=function(){return {length:1,0:'b',index:1,groups:'123'}};r[Symbol.replace]('ab','[$<length>]')",
        "var n=0;var r=/./g;r.exec=function(){n++;return n===1?{length:1,0:0,index:1}:n===2?{length:1,0:0,index:3}:null};r[Symbol.replace]('abcde','X')+':'+n",
        "var n=0;var r=/^|\\udf06/g;Object.defineProperty(r,'unicode',{value:true});var s=r[Symbol.replace]('\\ud834\\udf06',function(){n++;return 'X'});s.split('').map(function(c){return c.charCodeAt(0).toString(16)}).join(',')+':'+n",
        "var marker={};var r=/./;Object.defineProperty(r,'flags',{get:function(){throw marker}});try{r[Symbol.replace]('x','');false}catch(e){e===marker}",
        "var marker={};var r=/./;r.exec=function(){return {length:2,0:'x',index:0,get 1(){throw marker}}};try{r[Symbol.replace]('x','');false}catch(e){e===marker}",
    ] {
        agrees(source);
    }
}

#[test]
fn regexp_symbol_replace_uses_current_result_access_order() {
    // Current ECMA-262 reads result length, matched text, index, captures, and
    // groups in that order. Pinned XS reads index before length, so this is an
    // intentional standards-convergence assertion rather than an oracle gate.
    let source = "var log=[];var r=/./;r.exec=function(){return {get length(){log.push('length');return 2},get 0(){log.push('match');return 'a'},get index(){log.push('index');return 0},get 1(){log.push('capture');return 7},get groups(){log.push('groups');return undefined}}};r[Symbol.replace]('ab','$1')+':'+log.join(',')";
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete);
    assert_eq!(run.ironhorse_result, "7b:length,match,index,capture,groups");
}
