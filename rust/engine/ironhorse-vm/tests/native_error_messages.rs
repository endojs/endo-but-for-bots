//! F029: remaining native validation errors carry actionable messages.
use ironhorse_vm::{parse_symbols, Interp};

#[test]
fn native_validation_errors_explain_the_failed_requirement() {
    for (expression, name, message) in [
        (
            "Temporal.Instant(0n)",
            "TypeError",
            "Temporal.Instant: constructor requires new",
        ),
        (
            "new Temporal.Instant(0)",
            "TypeError",
            "Temporal.Instant: epochNanoseconds must be a supported BigInt",
        ),
        (
            "new Temporal.Instant(8640000000000000000001n)",
            "RangeError",
            "Temporal: epoch nanoseconds out of range",
        ),
        (
            "Temporal.Instant.from('invalid')",
            "RangeError",
            "Temporal.Instant: invalid instant string",
        ),
        (
            "Temporal.Instant.prototype.add.call({}, {})",
            "TypeError",
            "Temporal.Instant: incompatible receiver",
        ),
        (
            "new Temporal.Instant(0n).round('bad')",
            "RangeError",
            "Temporal: invalid time unit",
        ),
        (
            "Temporal.Duration.from({})",
            "TypeError",
            "Temporal.Duration: at least one duration field is required",
        ),
        (
            "new Temporal.Duration(1,-1)",
            "RangeError",
            "Temporal.Duration: fields must have a consistent sign",
        ),
        (
            "new Temporal.Duration().with(1)",
            "TypeError",
            "Temporal.with: fields must be an object",
        ),
        (
            "new Temporal.Duration().total({})",
            "RangeError",
            "Temporal.Duration.total: unit is required",
        ),
        (
            "new Temporal.Duration(1).total('days')",
            "RangeError",
            "Temporal: relativeTo is required for calendar units",
        ),
        (
            "new Temporal.PlainDate(2026,-1,1)",
            "RangeError",
            "Temporal: month out of range",
        ),
        (
            "new Temporal.PlainTime(-1)",
            "RangeError",
            "Temporal: time component out of range",
        ),
        (
            "new Temporal.PlainDate(2026,9,10).with({})",
            "TypeError",
            "Temporal.with: at least one date/time field is required",
        ),
        (
            "new Temporal.PlainDate(2026,9,10).valueOf()",
            "TypeError",
            "Temporal: valueOf cannot convert to a primitive",
        ),
        (
            "Temporal.ZonedDateTime.from({year:2026,month:9,day:10})",
            "TypeError",
            "Temporal.ZonedDateTime: timeZone is required",
        ),
        (
            "new Temporal.ZonedDateTime(0n,{})",
            "TypeError",
            "Temporal.ZonedDateTime: timeZone must be a string",
        ),
        (
            "new Temporal.ZonedDateTime(0n,'invalid')",
            "RangeError",
            "Temporal: invalid or unsupported time zone",
        ),
        (
            "new Intl.Locale(1)",
            "TypeError",
            "Intl: locale must be a string or string-convertible object",
        ),
        (
            "new Intl.Locale('invalid_tag')",
            "RangeError",
            "Intl: invalid language tag",
        ),
        (
            "new Intl.Locale('en',{region:'INVALID'})",
            "RangeError",
            "Intl.Locale: invalid region option",
        ),
        (
            "Intl.ListFormat()",
            "TypeError",
            "Intl.ListFormat: constructor requires new",
        ),
        (
            "new Intl.ListFormat('en').format([1])",
            "TypeError",
            "Intl.ListFormat: list elements must be strings",
        ),
        (
            "Intl.ListFormat.prototype.format.call({},[])",
            "TypeError",
            "Intl.ListFormat: incompatible receiver",
        ),
        (
            "new Intl.NumberFormat('en',{style:'currency'})",
            "TypeError",
            "Intl.NumberFormat: currency is required for currency style",
        ),
        (
            "new Intl.NumberFormat('en',{currency:'BADCODE'})",
            "RangeError",
            "Intl.NumberFormat: invalid currency code",
        ),
        (
            "new Intl.NumberFormat('en',{style:'bad'})",
            "RangeError",
            "Intl: invalid style option",
        ),
        (
            "new Intl.NumberFormat('en',{minimumIntegerDigits:0})",
            "RangeError",
            "Intl: minimumIntegerDigits must be between 1 and 21",
        ),
        (
            "new Intl.NumberFormat('en',{roundingIncrement:3})",
            "RangeError",
            "Intl.NumberFormat: invalid roundingIncrement",
        ),
        (
            "new Intl.PluralRules('en').selectRange(NaN,1)",
            "RangeError",
            "Intl.PluralRules.selectRange: endpoints must not be NaN",
        ),
        (
            "new Intl.DateTimeFormat('en',{dateStyle:'short',year:'numeric'})",
            "TypeError",
            "Intl.DateTimeFormat: dateStyle/timeStyle cannot be combined with components",
        ),
        (
            "new Intl.DateTimeFormat('en').format(NaN)",
            "RangeError",
            "Intl.DateTimeFormat: time value out of range",
        ),
        (
            "Intl.supportedValuesOf('bad')",
            "RangeError",
            "Intl.supportedValuesOf: invalid key",
        ),
        (
            "new Uint8Array(1).set(new BigInt64Array(1))",
            "TypeError",
            "TypedArray.set: Number and BigInt element domains cannot be mixed",
        ),
        (
            "RegExp.prototype.toString.call(1)",
            "TypeError",
            "RegExp.toString: receiver must be an object",
        ),
        (
            "var a=[1,2];Object.defineProperty(a,'1',{configurable:false});(function(){'use strict';a.length=0})()",
            "TypeError",
            "set length: array length update rejected",
        ),
        (
            "var a=[1,2];(function(){'use strict';a.length={valueOf(){Object.defineProperty(a,'length',{writable:false});return 1}}})()",
            "TypeError",
            "set length: array length update rejected",
        ),
        (
            "var p=new Proxy({},{set(){return false}});(function(){'use strict';p.x=1})()",
            "TypeError",
            "set: proxy trap returned false",
        ),
    ] {
        let source = format!("var result='no error';try{{{expression}}}catch(e){{var d=Object.getOwnPropertyDescriptor(e,'message');result=[e.name,e.message,e instanceof {name},d&&d.enumerable,d&&d.writable,d&&d.configurable].join('|')}}result");
        let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
        let mut vm = Interp::new();
        vm.link_intrinsics(&parse_symbols(&symbols));
        let out = vm.run(&code);
        assert!(out.completed, "{expression}: {:?}", out.halt);
        assert_eq!(
            out.result,
            format!("{name}|{message}|true|false|true|true"),
            "{expression}"
        );
    }
}
