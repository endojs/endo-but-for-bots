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
