//! The order in which each intrinsic object's own keys are created.
//!
//! OrdinaryOwnPropertyKeys lists an object's string keys, then its symbol
//! keys, each in the order the keys were created. XS creates every intrinsic
//! when it builds the realm, so an intrinsic's keys come in the order XS's
//! sources create them: mostly its builder tables, with newer members
//! appended. Ironhorse installs members lazily, when a program names one or
//! something reflects on the object, so creation order alone would make the
//! answer depend on the program's text. Instead every member is placed at its
//! rank in the tables below as it is installed
//! ([`Interp::place_intrinsic_key`]), and the global object's standard
//! bindings are installed all at once, in [`GLOBAL_KEY_ORDER`], before any
//! guest code runs.
//!
//! Each order is copied from the pinned XS (8.3.1), per object: run
//! `Reflect.ownKeys` on it. Keys the specification leaves to the engine
//! (XS's own `Math.idiv` family, `String.prototype.compare`,
//! `BigInt.bitLength`, the oracle host's globals, ...) are left out, and so
//! is `Math.random`, which Ironhorse omits by design. A member XS has and
//! Ironhorse does not yet is listed at XS's place, so it lands there when it
//! is added. Objects XS lacks (Intl, Temporal, the Segmenter iterators and
//! the for-in iterator) list their members in Ironhorse's boot roster order.
//!
//! A holder is an intrinsic global's name, a dotted path from one through
//! `prototype` or a member, or the specification's `%Name%` for an intrinsic
//! reachable only through syntax. `@@name` is a well-known symbol key. A
//! function's `length` and `name`, and the `length` of `Array.prototype` and
//! `String.prototype`, are listed by the exotic own-keys rules instead, and
//! are not in the tables.
use super::*;

/// The standard bindings of a global object, in XS's order. Ironhorse's
/// `Intl` and `Temporal`, which XS lacks, follow XS's newest constructors;
/// a global XS has and Ironhorse does not yet (`ModuleSource`) keeps its
/// place, and the oracle host's (`trace`, `global`, ...) are left out.
pub(super) const GLOBAL_KEY_ORDER: &[&str] = &[
    "AggregateError",
    "Array",
    "ArrayBuffer",
    "Atomics",
    "BigInt",
    "BigInt64Array",
    "BigUint64Array",
    "Boolean",
    "DataView",
    "Date",
    "Error",
    "EvalError",
    "FinalizationRegistry",
    "Float32Array",
    "Float64Array",
    "Int16Array",
    "Int32Array",
    "Int8Array",
    "JSON",
    "Map",
    "Math",
    "ModuleSource",
    "Number",
    "Object",
    "Promise",
    "Proxy",
    "RangeError",
    "ReferenceError",
    "Reflect",
    "RegExp",
    "Set",
    "SharedArrayBuffer",
    "String",
    "Symbol",
    "SyntaxError",
    "TypeError",
    "URIError",
    "Uint16Array",
    "Uint32Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "WeakMap",
    "WeakRef",
    "WeakSet",
    "decodeURI",
    "decodeURIComponent",
    "encodeURI",
    "encodeURIComponent",
    "escape",
    "isFinite",
    "isNaN",
    "parseFloat",
    "parseInt",
    "unescape",
    "Iterator",
    "AsyncDisposableStack",
    "DisposableStack",
    "SuppressedError",
    "Float16Array",
    "Intl",
    "Temporal",
    "Infinity",
    "NaN",
    "undefined",
    "Compartment",
    "Function",
    "eval",
    "globalThis",
    "harden",
    "lockdown",
    "petrify",
    // The conformance harness's host object, when it installs one
    // (`Interp::install_test262_host`): last, as XS's `xst` binds it.
    "$262",
];

/// Each intrinsic object's own keys in creation order: `(holder, keys)`.
pub(super) const INTRINSIC_KEY_ORDER: &[(&str, &[&str])] = &[
    ("AggregateError", &["prototype"]),
    (
        "AggregateError.prototype",
        &["name", "message", "constructor"],
    ),
    (
        "Array",
        &[
            "prototype",
            "from",
            "fromAsync",
            "isArray",
            "of",
            "@@species",
        ],
    ),
    (
        "Array.prototype",
        &[
            "at",
            "concat",
            "copyWithin",
            "entries",
            "every",
            "fill",
            "filter",
            "find",
            "findIndex",
            "findLast",
            "findLastIndex",
            "flat",
            "flatMap",
            "forEach",
            "includes",
            "indexOf",
            "join",
            "keys",
            "lastIndexOf",
            "map",
            "pop",
            "push",
            "reduce",
            "reduceRight",
            "reverse",
            "shift",
            "slice",
            "some",
            "sort",
            "splice",
            "toLocaleString",
            "toString",
            "unshift",
            "values",
            "toReversed",
            "toSorted",
            "toSpliced",
            "with",
            "constructor",
            "@@iterator",
            "@@unscopables",
        ],
    ),
    ("ArrayBuffer", &["prototype", "isView", "@@species"]),
    (
        "ArrayBuffer.prototype",
        &[
            "byteLength",
            "detached",
            "maxByteLength",
            "resizable",
            "concat",
            "resize",
            "slice",
            "transfer",
            "transferToFixedLength",
            "constructor",
            "@@toStringTag",
        ],
    ),
    (
        "Atomics",
        &[
            "add",
            "and",
            "compareExchange",
            "exchange",
            "isLockFree",
            "load",
            "or",
            "notify",
            "store",
            "sub",
            "wait",
            "waitAsync",
            "xor",
            "@@toStringTag",
        ],
    ),
    ("BigInt", &["prototype", "asIntN", "asUintN"]),
    (
        "BigInt.prototype",
        &[
            "toLocaleString",
            "toString",
            "valueOf",
            "constructor",
            "@@toStringTag",
        ],
    ),
    ("BigInt64Array", &["prototype", "BYTES_PER_ELEMENT"]),
    (
        "BigInt64Array.prototype",
        &["BYTES_PER_ELEMENT", "constructor"],
    ),
    ("BigUint64Array", &["prototype", "BYTES_PER_ELEMENT"]),
    (
        "BigUint64Array.prototype",
        &["BYTES_PER_ELEMENT", "constructor"],
    ),
    ("Boolean", &["prototype"]),
    ("Boolean.prototype", &["toString", "valueOf", "constructor"]),
    ("DataView", &["prototype"]),
    (
        "DataView.prototype",
        &[
            "getBigInt64",
            "setBigInt64",
            "getBigUint64",
            "setBigUint64",
            "getFloat16",
            "setFloat16",
            "getFloat32",
            "setFloat32",
            "getFloat64",
            "setFloat64",
            "getInt8",
            "setInt8",
            "getInt16",
            "setInt16",
            "getInt32",
            "setInt32",
            "getUint8",
            "setUint8",
            "getUint16",
            "setUint16",
            "getUint32",
            "setUint32",
            "buffer",
            "byteLength",
            "byteOffset",
            "constructor",
            "@@toStringTag",
        ],
    ),
    ("Date", &["prototype", "now", "parse", "UTC"]),
    (
        "Date.prototype",
        &[
            "getMilliseconds",
            "getSeconds",
            "getMinutes",
            "getHours",
            "getDay",
            "getDate",
            "getMonth",
            "getYear",
            "getFullYear",
            "getUTCMilliseconds",
            "getUTCSeconds",
            "getUTCMinutes",
            "getUTCHours",
            "getUTCDay",
            "getUTCDate",
            "getUTCMonth",
            "getUTCFullYear",
            "getTime",
            "getTimezoneOffset",
            "setDate",
            "setFullYear",
            "setHours",
            "setMilliseconds",
            "setMinutes",
            "setMonth",
            "setSeconds",
            "setTime",
            "setYear",
            "setUTCDate",
            "setUTCFullYear",
            "setUTCHours",
            "setUTCMilliseconds",
            "setUTCMinutes",
            "setUTCMonth",
            "setUTCSeconds",
            "toDateString",
            "toISOString",
            "toJSON",
            "toLocaleDateString",
            "toLocaleString",
            "toLocaleTimeString",
            "toString",
            "toTimeString",
            "toUTCString",
            "toGMTString",
            "valueOf",
            "constructor",
            "@@toPrimitive",
        ],
    ),
    ("Error", &["prototype", "isError"]),
    (
        "Error.prototype",
        &["toString", "name", "message", "stack", "constructor"],
    ),
    ("EvalError", &["prototype"]),
    ("EvalError.prototype", &["name", "message", "constructor"]),
    ("FinalizationRegistry", &["prototype"]),
    (
        "FinalizationRegistry.prototype",
        &["register", "unregister", "constructor", "@@toStringTag"],
    ),
    ("Float16Array", &["prototype", "BYTES_PER_ELEMENT"]),
    (
        "Float16Array.prototype",
        &["BYTES_PER_ELEMENT", "constructor"],
    ),
    ("Float32Array", &["prototype", "BYTES_PER_ELEMENT"]),
    (
        "Float32Array.prototype",
        &["BYTES_PER_ELEMENT", "constructor"],
    ),
    ("Float64Array", &["prototype", "BYTES_PER_ELEMENT"]),
    (
        "Float64Array.prototype",
        &["BYTES_PER_ELEMENT", "constructor"],
    ),
    ("Int16Array", &["prototype", "BYTES_PER_ELEMENT"]),
    (
        "Int16Array.prototype",
        &["BYTES_PER_ELEMENT", "constructor"],
    ),
    ("Int32Array", &["prototype", "BYTES_PER_ELEMENT"]),
    (
        "Int32Array.prototype",
        &["BYTES_PER_ELEMENT", "constructor"],
    ),
    ("Int8Array", &["prototype", "BYTES_PER_ELEMENT"]),
    ("Int8Array.prototype", &["BYTES_PER_ELEMENT", "constructor"]),
    (
        "JSON",
        &[
            "parse",
            "stringify",
            "isRawJSON",
            "rawJSON",
            "@@toStringTag",
        ],
    ),
    ("Map", &["prototype", "groupBy", "@@species"]),
    (
        "Map.prototype",
        &[
            "size",
            "clear",
            "delete",
            "entries",
            "forEach",
            "get",
            "has",
            "keys",
            "set",
            "values",
            "getOrInsert",
            "getOrInsertComputed",
            "constructor",
            "@@iterator",
            "@@toStringTag",
        ],
    ),
    (
        "Math",
        &[
            "abs",
            "acos",
            "acosh",
            "asin",
            "asinh",
            "atan",
            "atanh",
            "atan2",
            "cbrt",
            "ceil",
            "clz32",
            "cos",
            "cosh",
            "exp",
            "expm1",
            "f16round",
            "floor",
            "fround",
            "hypot",
            "imul",
            "log",
            "log1p",
            "log10",
            "log2",
            "max",
            "min",
            "pow",
            "round",
            "sign",
            "sin",
            "sinh",
            "sqrt",
            "sumPrecise",
            "tan",
            "tanh",
            "trunc",
            "E",
            "LN10",
            "LN2",
            "LOG10E",
            "LOG2E",
            "PI",
            "SQRT1_2",
            "SQRT2",
            "@@toStringTag",
        ],
    ),
    (
        "Number",
        &[
            "prototype",
            "isFinite",
            "isInteger",
            "isNaN",
            "isSafeInteger",
            "parseFloat",
            "parseInt",
            "EPSILON",
            "MAX_SAFE_INTEGER",
            "MAX_VALUE",
            "MIN_SAFE_INTEGER",
            "MIN_VALUE",
            "NaN",
            "NEGATIVE_INFINITY",
            "POSITIVE_INFINITY",
        ],
    ),
    (
        "Number.prototype",
        &[
            "toExponential",
            "toFixed",
            "toLocaleString",
            "toPrecision",
            "toString",
            "valueOf",
            "constructor",
        ],
    ),
    (
        "Object",
        &[
            "prototype",
            "assign",
            "create",
            "defineProperties",
            "defineProperty",
            "entries",
            "freeze",
            "fromEntries",
            "getOwnPropertyDescriptor",
            "getOwnPropertyDescriptors",
            "getOwnPropertyNames",
            "getOwnPropertySymbols",
            "getPrototypeOf",
            "groupBy",
            "hasOwn",
            "is",
            "isExtensible",
            "isFrozen",
            "isSealed",
            "keys",
            "preventExtensions",
            "seal",
            "setPrototypeOf",
            "values",
        ],
    ),
    (
        "Object.prototype",
        &[
            "__proto__",
            "hasOwnProperty",
            "__defineGetter__",
            "__defineSetter__",
            "__lookupGetter__",
            "__lookupSetter__",
            "isPrototypeOf",
            "propertyIsEnumerable",
            "toLocaleString",
            "toString",
            "valueOf",
            "constructor",
        ],
    ),
    (
        "Promise",
        &[
            "prototype",
            "all",
            "allSettled",
            "any",
            "race",
            "reject",
            "resolve",
            "try",
            "withResolvers",
            "@@species",
        ],
    ),
    (
        "Promise.prototype",
        &["catch", "finally", "then", "constructor", "@@toStringTag"],
    ),
    ("Proxy", &["revocable"]),
    ("RangeError", &["prototype"]),
    ("RangeError.prototype", &["name", "message", "constructor"]),
    ("ReferenceError", &["prototype"]),
    (
        "ReferenceError.prototype",
        &["name", "message", "constructor"],
    ),
    (
        "Reflect",
        &[
            "apply",
            "construct",
            "defineProperty",
            "deleteProperty",
            "get",
            "getOwnPropertyDescriptor",
            "getPrototypeOf",
            "has",
            "isExtensible",
            "ownKeys",
            "preventExtensions",
            "set",
            "setPrototypeOf",
            "@@toStringTag",
        ],
    ),
    ("RegExp", &["prototype", "escape", "@@species"]),
    (
        "RegExp.prototype",
        &[
            "compile",
            "exec",
            "test",
            "toString",
            "dotAll",
            "flags",
            "global",
            "hasIndices",
            "ignoreCase",
            "multiline",
            "source",
            "sticky",
            "unicode",
            "unicodeSets",
            "constructor",
            "@@match",
            "@@matchAll",
            "@@replace",
            "@@search",
            "@@split",
        ],
    ),
    ("Set", &["prototype", "@@species"]),
    (
        "Set.prototype",
        &[
            "size",
            "add",
            "clear",
            "delete",
            "entries",
            "forEach",
            "has",
            "values",
            "keys",
            "difference",
            "intersection",
            "isDisjointFrom",
            "isSubsetOf",
            "isSupersetOf",
            "symmetricDifference",
            "union",
            "constructor",
            "@@iterator",
            "@@toStringTag",
        ],
    ),
    ("SharedArrayBuffer", &["prototype", "@@species"]),
    (
        "SharedArrayBuffer.prototype",
        &[
            "byteLength",
            "growable",
            "maxByteLength",
            "grow",
            "slice",
            "constructor",
            "@@toStringTag",
        ],
    ),
    (
        "String",
        &["prototype", "fromCharCode", "fromCodePoint", "raw"],
    ),
    (
        "String.prototype",
        &[
            "at",
            "charAt",
            "charCodeAt",
            "codePointAt",
            "concat",
            "endsWith",
            "includes",
            "indexOf",
            "lastIndexOf",
            "localeCompare",
            "normalize",
            "padEnd",
            "padStart",
            "repeat",
            "replace",
            "replaceAll",
            "slice",
            "split",
            "startsWith",
            "substr",
            "substring",
            "toLocaleLowerCase",
            "toLocaleUpperCase",
            "toLowerCase",
            "toString",
            "toUpperCase",
            "trim",
            "trimEnd",
            "trimRight",
            "trimStart",
            "trimLeft",
            "valueOf",
            "match",
            "matchAll",
            "search",
            "isWellFormed",
            "toWellFormed",
            "constructor",
            "@@iterator",
        ],
    ),
    (
        "Symbol",
        &[
            "prototype",
            "for",
            "keyFor",
            "asyncIterator",
            "hasInstance",
            "isConcatSpreadable",
            "iterator",
            "match",
            "matchAll",
            "replace",
            "search",
            "species",
            "split",
            "toPrimitive",
            "toStringTag",
            "unscopables",
            "asyncDispose",
            "dispose",
        ],
    ),
    (
        "Symbol.prototype",
        &[
            "description",
            "toString",
            "valueOf",
            "constructor",
            "@@toPrimitive",
            "@@toStringTag",
        ],
    ),
    ("SyntaxError", &["prototype"]),
    ("SyntaxError.prototype", &["name", "message", "constructor"]),
    ("TypeError", &["prototype"]),
    ("TypeError.prototype", &["name", "message", "constructor"]),
    ("URIError", &["prototype"]),
    ("URIError.prototype", &["name", "message", "constructor"]),
    ("Uint16Array", &["prototype", "BYTES_PER_ELEMENT"]),
    (
        "Uint16Array.prototype",
        &["BYTES_PER_ELEMENT", "constructor"],
    ),
    ("Uint32Array", &["prototype", "BYTES_PER_ELEMENT"]),
    (
        "Uint32Array.prototype",
        &["BYTES_PER_ELEMENT", "constructor"],
    ),
    (
        "Uint8Array",
        &["prototype", "BYTES_PER_ELEMENT", "fromBase64", "fromHex"],
    ),
    (
        "Uint8Array.prototype",
        &[
            "BYTES_PER_ELEMENT",
            "constructor",
            "setFromBase64",
            "setFromHex",
            "toBase64",
            "toHex",
        ],
    ),
    ("Uint8ClampedArray", &["prototype", "BYTES_PER_ELEMENT"]),
    (
        "Uint8ClampedArray.prototype",
        &["BYTES_PER_ELEMENT", "constructor"],
    ),
    ("WeakMap", &["prototype"]),
    (
        "WeakMap.prototype",
        &[
            "delete",
            "get",
            "has",
            "set",
            "getOrInsert",
            "getOrInsertComputed",
            "constructor",
            "@@toStringTag",
        ],
    ),
    ("WeakRef", &["prototype"]),
    (
        "WeakRef.prototype",
        &["deref", "constructor", "@@toStringTag"],
    ),
    ("WeakSet", &["prototype"]),
    (
        "WeakSet.prototype",
        &["add", "delete", "has", "constructor", "@@toStringTag"],
    ),
    ("Iterator", &["prototype", "concat", "from"]),
    (
        "Iterator.prototype",
        &[
            "drop",
            "every",
            "filter",
            "find",
            "flatMap",
            "forEach",
            "map",
            "reduce",
            "some",
            "take",
            "toArray",
            "constructor",
            "@@toStringTag",
            "@@dispose",
            "@@iterator",
        ],
    ),
    ("AsyncDisposableStack", &["prototype"]),
    (
        "AsyncDisposableStack.prototype",
        &[
            "disposed",
            "adopt",
            "defer",
            "disposeAsync",
            "move",
            "use",
            "constructor",
            "@@asyncDispose",
            "@@toStringTag",
        ],
    ),
    ("DisposableStack", &["prototype"]),
    (
        "DisposableStack.prototype",
        &[
            "disposed",
            "adopt",
            "defer",
            "dispose",
            "move",
            "use",
            "constructor",
            "@@dispose",
            "@@toStringTag",
        ],
    ),
    ("SuppressedError", &["prototype"]),
    (
        "SuppressedError.prototype",
        &["name", "message", "constructor"],
    ),
    ("Compartment", &["prototype"]),
    (
        "Compartment.prototype",
        &[
            "globalThis",
            "evaluate",
            "import",
            "importNow",
            "constructor",
            "@@toStringTag",
        ],
    ),
    ("Function", &["prototype"]),
    (
        "Function.prototype",
        &[
            "apply",
            "bind",
            "call",
            "toString",
            "arguments",
            "caller",
            "constructor",
            "@@hasInstance",
        ],
    ),
    ("%TypedArray%", &["prototype", "from", "of", "@@species"]),
    (
        "%TypedArray%.prototype",
        &[
            "at",
            "buffer",
            "byteLength",
            "byteOffset",
            "length",
            "copyWithin",
            "entries",
            "every",
            "fill",
            "filter",
            "find",
            "findIndex",
            "findLast",
            "findLastIndex",
            "forEach",
            "includes",
            "indexOf",
            "join",
            "keys",
            "lastIndexOf",
            "map",
            "reduce",
            "reduceRight",
            "reverse",
            "set",
            "slice",
            "some",
            "sort",
            "subarray",
            "toLocaleString",
            "toString",
            "values",
            "toReversed",
            "toSorted",
            "with",
            "constructor",
            "@@toStringTag",
            "@@iterator",
        ],
    ),
    ("%ArrayIteratorPrototype%", &["next", "@@toStringTag"]),
    ("%MapIteratorPrototype%", &["next", "@@toStringTag"]),
    ("%SetIteratorPrototype%", &["next", "@@toStringTag"]),
    (
        "%RegExpStringIteratorPrototype%",
        &["next", "@@toStringTag"],
    ),
    (
        "%IteratorHelperPrototype%",
        &["next", "return", "@@toStringTag"],
    ),
    ("%WrapForValidIteratorPrototype%", &["next", "return"]),
    (
        "%AsyncIteratorPrototype%",
        &["@@asyncDispose", "@@asyncIterator"],
    ),
    ("%GeneratorFunction%", &["prototype"]),
    (
        "%GeneratorFunction%.prototype",
        &["prototype", "constructor", "@@toStringTag"],
    ),
    (
        "%GeneratorPrototype%",
        &["next", "return", "throw", "constructor", "@@toStringTag"],
    ),
    ("%AsyncFunction%", &["prototype"]),
    (
        "%AsyncFunction%.prototype",
        &["constructor", "@@toStringTag"],
    ),
    ("%AsyncGeneratorFunction%", &["prototype"]),
    (
        "%AsyncGeneratorFunction%.prototype",
        &["prototype", "constructor", "@@toStringTag"],
    ),
    (
        "%AsyncGeneratorPrototype%",
        &["next", "return", "throw", "constructor", "@@toStringTag"],
    ),
    // Ironhorse's own, in boot roster order: XS has no counterpart.
    (
        "Intl",
        &[
            "Locale",
            "Collator",
            "getCanonicalLocales",
            "supportedValuesOf",
            "ListFormat",
            "PluralRules",
            "Segmenter",
            "DateTimeFormat",
            "NumberFormat",
            "__ironhorseDataVersion",
            "@@toStringTag",
        ],
    ),
    ("Intl.Locale", &["prototype", "supportedLocalesOf"]),
    (
        "Intl.Locale.prototype",
        &[
            "constructor",
            "toString",
            "maximize",
            "minimize",
            "@@toStringTag",
        ],
    ),
    ("Intl.Collator", &["prototype", "supportedLocalesOf"]),
    (
        "Intl.Collator.prototype",
        &["constructor", "resolvedOptions", "@@toStringTag"],
    ),
    ("Intl.ListFormat", &["prototype", "supportedLocalesOf"]),
    (
        "Intl.ListFormat.prototype",
        &[
            "constructor",
            "format",
            "formatToParts",
            "resolvedOptions",
            "@@toStringTag",
        ],
    ),
    ("Intl.PluralRules", &["prototype", "supportedLocalesOf"]),
    (
        "Intl.PluralRules.prototype",
        &[
            "constructor",
            "select",
            "selectRange",
            "resolvedOptions",
            "@@toStringTag",
        ],
    ),
    ("Intl.Segmenter", &["prototype", "supportedLocalesOf"]),
    (
        "Intl.Segmenter.prototype",
        &["constructor", "segment", "resolvedOptions", "@@toStringTag"],
    ),
    ("Intl.DateTimeFormat", &["prototype", "supportedLocalesOf"]),
    (
        "Intl.DateTimeFormat.prototype",
        &[
            "constructor",
            "format",
            "formatToParts",
            "formatRange",
            "formatRangeToParts",
            "resolvedOptions",
            "@@toStringTag",
        ],
    ),
    ("Intl.NumberFormat", &["prototype", "supportedLocalesOf"]),
    (
        "Intl.NumberFormat.prototype",
        &[
            "constructor",
            "formatToParts",
            "formatRange",
            "formatRangeToParts",
            "resolvedOptions",
            "format",
            "@@toStringTag",
        ],
    ),
    ("%SegmentsPrototype%", &["containing", "@@iterator"]),
    (
        "%SegmentIteratorPrototype%",
        &["next", "@@toStringTag", "@@iterator"],
    ),
    (
        "Temporal",
        &[
            "Instant",
            "Duration",
            "PlainDate",
            "PlainTime",
            "PlainDateTime",
            "PlainYearMonth",
            "PlainMonthDay",
            "Calendar",
            "ZonedDateTime",
            "Now",
            "@@toStringTag",
        ],
    ),
    (
        "Temporal.Instant",
        &[
            "prototype",
            "from",
            "fromEpochMilliseconds",
            "fromEpochNanoseconds",
            "compare",
        ],
    ),
    (
        "Temporal.Instant.prototype",
        &[
            "constructor",
            "add",
            "subtract",
            "until",
            "since",
            "round",
            "equals",
            "toString",
            "toJSON",
            "valueOf",
            "@@toStringTag",
        ],
    ),
    ("Temporal.Duration", &["prototype", "from", "compare"]),
    (
        "Temporal.Duration.prototype",
        &[
            "constructor",
            "with",
            "negated",
            "abs",
            "add",
            "subtract",
            "round",
            "total",
            "toString",
            "toJSON",
            "valueOf",
            "@@toStringTag",
        ],
    ),
    ("Temporal.PlainDate", &["prototype", "from", "compare"]),
    (
        "Temporal.PlainDate.prototype",
        &[
            "constructor",
            "with",
            "add",
            "subtract",
            "until",
            "since",
            "equals",
            "toString",
            "toJSON",
            "valueOf",
            "toPlainDateTime",
            "@@toStringTag",
        ],
    ),
    ("Temporal.PlainTime", &["prototype", "from", "compare"]),
    (
        "Temporal.PlainTime.prototype",
        &[
            "constructor",
            "with",
            "add",
            "subtract",
            "until",
            "since",
            "equals",
            "toString",
            "toJSON",
            "valueOf",
            "toPlainDateTime",
            "@@toStringTag",
        ],
    ),
    ("Temporal.PlainDateTime", &["prototype", "from", "compare"]),
    (
        "Temporal.PlainDateTime.prototype",
        &[
            "constructor",
            "with",
            "add",
            "subtract",
            "until",
            "since",
            "equals",
            "toString",
            "toJSON",
            "valueOf",
            "toPlainDate",
            "toPlainTime",
            "@@toStringTag",
        ],
    ),
    ("Temporal.PlainYearMonth", &["prototype", "from", "compare"]),
    (
        "Temporal.PlainYearMonth.prototype",
        &[
            "constructor",
            "with",
            "add",
            "subtract",
            "until",
            "since",
            "equals",
            "toString",
            "toJSON",
            "valueOf",
            "@@toStringTag",
        ],
    ),
    ("Temporal.PlainMonthDay", &["prototype", "from", "compare"]),
    (
        "Temporal.PlainMonthDay.prototype",
        &[
            "constructor",
            "with",
            "add",
            "subtract",
            "until",
            "since",
            "equals",
            "toString",
            "toJSON",
            "valueOf",
            "@@toStringTag",
        ],
    ),
    ("Temporal.Calendar", &["prototype", "from"]),
    ("Temporal.Calendar.prototype", &["constructor", "toString"]),
    ("Temporal.ZonedDateTime", &["prototype", "from", "compare"]),
    (
        "Temporal.ZonedDateTime.prototype",
        &[
            "constructor",
            "with",
            "add",
            "subtract",
            "until",
            "since",
            "round",
            "equals",
            "startOfDay",
            "getTimeZoneTransition",
            "toInstant",
            "toPlainDate",
            "toPlainTime",
            "toPlainDateTime",
            "withPlainTime",
            "withTimeZone",
            "withCalendar",
            "toString",
            "toJSON",
            "toLocaleString",
            "valueOf",
            "@@toStringTag",
        ],
    ),
    (
        "Temporal.Now",
        &[
            "instant",
            "timeZoneId",
            "zonedDateTimeISO",
            "plainDateISO",
            "plainDateTimeISO",
            "plainTimeISO",
            "@@toStringTag",
        ],
    ),
    ("%ForInIteratorPrototype%", &["next"]),
];

/// One intrinsic object's keys by rank: its string keys and its well-known
/// symbol keys, each by name.
#[derive(Debug, Default)]
pub(super) struct IntrinsicKeyRanks {
    strings: std::collections::HashMap<&'static str, u16>,
    symbols: std::collections::HashMap<&'static str, u16>,
}

impl Interp {
    /// The boot object an [`INTRINSIC_KEY_ORDER`] holder names, or `None` in
    /// a profile without it.
    pub(super) fn resolve_intrinsic_holder(&self, path: &str) -> Option<crate::value::SlotIndex> {
        let member = |owner: crate::value::SlotIndex, wanted: &str| {
            self.proto_methods
                .iter()
                .find(|(holder, name, _)| *holder == owner && *name == wanted)
                .map(|(_, _, member)| *member)
        };
        let mut parts = path.split('.');
        let mut holder = match parts.next()? {
            "%TypedArray%" => self.functions.iter().find_map(|(&function, info)| {
                (info.native == Some(Native::TypedArrayBase)).then_some(function)
            })?,
            "%ArrayIteratorPrototype%" => self.array_iterator_proto,
            "%MapIteratorPrototype%" => self.map_iterator_proto,
            "%SetIteratorPrototype%" => self.set_iterator_proto,
            "%RegExpStringIteratorPrototype%" => self.regexp_string_iterator_proto,
            "%IteratorHelperPrototype%" => self.iterator_helper_proto,
            "%WrapForValidIteratorPrototype%" => self.iterator_wrapper_proto,
            "%AsyncIteratorPrototype%" => self.instance_prototype(self.async_generator_proto),
            "%GeneratorPrototype%" => self.generator_proto,
            "%AsyncGeneratorPrototype%" => self.async_generator_proto,
            "%GeneratorFunction%" => member(self.generator_function_proto, "constructor")?,
            "%AsyncFunction%" => member(self.async_function_proto, "constructor")?,
            "%AsyncGeneratorFunction%" => {
                member(self.async_generator_function_proto, "constructor")?
            }
            "%SegmentsPrototype%" => self.segments_proto,
            "%SegmentIteratorPrototype%" => self.segment_iterator_proto,
            "%ForInIteratorPrototype%" => self.enumerator_proto,
            name => self.intrinsics.get(name).copied()?,
        };
        for part in parts {
            holder = match self.ctor_prototype.get(&holder) {
                Some(&prototype) if part == "prototype" => prototype,
                _ => member(holder, part)?,
            };
        }
        (!holder.is_null()).then_some(holder)
    }

    /// [`INTRINSIC_KEY_ORDER`] resolved against this boot: each holder's
    /// ranks. Every boot, a restore's included, needs them and none stores
    /// them. Every boot also lays out the same objects at the same indices,
    /// which the boot fingerprint and every restore rely on, so the first
    /// boot's resolution stands for every boot's and is made once per process
    /// (`every_boot_resolves_the_same_holders`).
    pub(super) fn intrinsic_key_ranks_at_boot(
        &self,
    ) -> std::collections::HashMap<crate::value::SlotIndex, &'static IntrinsicKeyRanks> {
        static HOLDERS: std::sync::OnceLock<
            std::collections::HashMap<crate::value::SlotIndex, &'static IntrinsicKeyRanks>,
        > = std::sync::OnceLock::new();
        HOLDERS
            .get_or_init(|| self.resolve_intrinsic_key_ranks())
            .clone()
    }

    /// [`Self::intrinsic_key_ranks_at_boot`], resolved afresh.
    fn resolve_intrinsic_key_ranks(
        &self,
    ) -> std::collections::HashMap<crate::value::SlotIndex, &'static IntrinsicKeyRanks> {
        static RANKS: std::sync::OnceLock<Vec<IntrinsicKeyRanks>> = std::sync::OnceLock::new();
        let tables = RANKS.get_or_init(|| {
            INTRINSIC_KEY_ORDER
                .iter()
                .map(|(_, keys)| {
                    let mut ranks = IntrinsicKeyRanks::default();
                    for (rank, key) in keys.iter().enumerate() {
                        let rank = rank as u16;
                        match key.strip_prefix("@@") {
                            Some(symbol) => ranks.symbols.insert(symbol, rank),
                            None => ranks.strings.insert(key, rank),
                        };
                    }
                    ranks
                })
                .collect()
        });
        INTRINSIC_KEY_ORDER
            .iter()
            .zip(tables)
            .filter_map(|((path, _), ranks)| Some((self.resolve_intrinsic_holder(path)?, ranks)))
            .collect()
    }

    /// The rank of own key `id` among `holder`'s intrinsic keys, or `None`
    /// for a key the tables do not list there.
    #[cfg(test)]
    fn intrinsic_key_rank(&self, holder: crate::value::SlotIndex, id: u16) -> Option<u16> {
        self.intrinsic_key_rank_in(self.intrinsic_key_ranks.get(&holder)?, id)
    }

    /// The rank of key `id` in `ranks`, one holder's.
    fn intrinsic_key_rank_in(&self, ranks: &IntrinsicKeyRanks, id: u16) -> Option<u16> {
        if let Some(descriptor) = self.symbol_key_ids.descriptor(id) {
            let name = self.well_known_symbols.iter().find_map(|(name, value)| {
                (value.value == Payload::Reference(descriptor)).then_some(*name)
            })?;
            return ranks.symbols.get(name).copied();
        }
        let name = self.symbol_names.get(usize::from(id).checked_sub(1)?)?;
        ranks.strings.get(name.as_str()?).copied()
    }

    /// Move `property`, which an intrinsic installer has just created as
    /// `holder`'s newest own property, to its rank among `holder`'s keys.
    ///
    /// The new key goes before the oldest key that is not a lower-ranked
    /// intrinsic key. Members are installed only while every key the object
    /// has is one of its own, because a guest's first new key on an intrinsic
    /// completes its surface first ([`Self::pending_surfaces`]), so this keeps
    /// the object's keys in the order of its table whatever order the members
    /// arrive in, and a key the guest adds later still follows them all.
    pub(super) fn place_intrinsic_key(
        &mut self,
        holder: crate::value::SlotIndex,
        property: crate::value::SlotIndex,
    ) {
        if self.slots.get(holder).next != property {
            return;
        }
        let Some(&ranks) = self.intrinsic_key_ranks.get(&holder) else {
            return;
        };
        let Some(rank) = self.intrinsic_key_rank_in(ranks, self.slots.get(property).id) else {
            return;
        };
        // Placing every key keeps `holder`'s chain, which runs newest first,
        // as keys unranked or the guest's, then intrinsic keys by falling
        // rank. So the oldest key that is not lower-ranked is the last before
        // the first lower-ranked one, and the walk stops there: installing
        // members in their table's order reads one older key each.
        let mut successor = None;
        let mut current = self.slots.get(property).next;
        while !current.is_null() {
            let slot = self.slots.get(current);
            if slot.flag & XS_INTERNAL_FLAG == 0 {
                match self.intrinsic_key_rank_in(ranks, slot.id) {
                    Some(other) if other < rank => break,
                    Some(other) if other == rank => {}
                    _ => successor = Some(current),
                }
            }
            current = slot.next;
        }
        let Some(successor) = successor else {
            return;
        };
        let newest = self.slots.get(property).next;
        self.slots.get_mut(holder).next = newest;
        let after = self.slots.get(successor).next;
        self.slots.get_mut(property).next = after;
        self.slots.get_mut(successor).next = property;
    }

    /// Install every standard global binding the current environment admits,
    /// in [`GLOBAL_KEY_ORDER`], interning the names unmetered. A global object
    /// has its standard bindings before any guest code runs, as XS's does, so
    /// a guest's global follows them and a compartment's global lists them
    /// all. A binding the environment already created, or created and then
    /// deleted, is left alone.
    pub(super) fn install_standard_globals(&mut self) {
        let was_installing = self.installing_intrinsics;
        self.installing_intrinsics = true;
        // A standard global the table does not list still binds, after the
        // rest; `every_intrinsic_has_a_key_order` keeps this empty.
        let mut unlisted: Vec<&'static str> = self
            .intrinsics
            .keys()
            .copied()
            .filter(|name| !GLOBAL_KEY_ORDER.contains(name))
            .collect();
        unlisted.sort_unstable();
        for name in GLOBAL_KEY_ORDER.iter().copied().chain(unlisted) {
            if !self.intrinsics.contains_key(name)
                && value_global(name).is_none()
                && name != "globalThis"
            {
                continue;
            }
            let id = self.intern_static_key_unmetered(name);
            self.install_global_intrinsic_binding(&SymbolName::from(name), id);
        }
        self.installing_intrinsics = was_installing;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_intrinsic_has_a_key_order() {
        let machine = Interp::new();
        let mut holders = std::collections::HashSet::new();
        for (path, keys) in INTRINSIC_KEY_ORDER {
            let holder = machine
                .resolve_intrinsic_holder(path)
                .unwrap_or_else(|| panic!("{path} names no intrinsic"));
            assert!(
                holders.insert(holder),
                "{path}: a second order for one object"
            );
            let mut listed = std::collections::HashSet::new();
            for key in *keys {
                assert!(listed.insert(key), "{path}: {key} is listed twice");
            }
        }
        for holder in machine.intrinsic_surface_holders() {
            assert!(
                machine.intrinsic_key_ranks.contains_key(&holder),
                "{holder:?} has lazily installed members and no key order"
            );
        }
        let mut globals = std::collections::HashSet::new();
        for name in GLOBAL_KEY_ORDER {
            assert!(globals.insert(name), "{name} is listed twice");
        }
        for name in machine.intrinsics.keys() {
            assert!(
                GLOBAL_KEY_ORDER.contains(name),
                "the standard global {name} has no place"
            );
        }
    }

    /// The holders resolved once per process are every boot's: a fresh boot,
    /// and a machine that has run, resolve the same objects to the same
    /// tables.
    #[test]
    fn every_boot_resolves_the_same_holders() {
        let first = Interp::new();
        let cached = first.intrinsic_key_ranks.clone();
        assert!(!cached.is_empty());
        let mut later = Interp::new();
        let (bytecode, symbols) =
            ironhorse_compile::compile_atoms("var q = { clear: 1 }; new Map().clear(); q").unwrap();
        later.link_intrinsics(&crate::parse_symbols(&symbols));
        assert!(later.run(&bytecode).completed);
        for machine in [&first, &later] {
            let fresh = machine.resolve_intrinsic_key_ranks();
            assert_eq!(fresh.len(), cached.len());
            for (holder, ranks) in &fresh {
                assert!(
                    cached
                        .get(holder)
                        .is_some_and(|cached| std::ptr::eq(*cached, *ranks)),
                    "{holder:?} resolves to another table"
                );
            }
        }
    }

    /// With every member installed, each object's keys are ranked and come in
    /// rank order, and the global object's standard bindings in theirs.
    #[test]
    fn a_complete_realm_is_in_key_order() {
        let mut machine = Interp::new_shared_realm_machine_configured(None, false);
        let pending: Vec<_> = machine.pending_surfaces.iter().copied().collect();
        for holder in pending {
            machine.materialize_intrinsic_own_surface(holder);
        }
        let holders: Vec<_> = machine.intrinsic_key_ranks.keys().copied().collect();
        for holder in holders {
            let mut previous = None;
            for property in machine.own_property_slots(holder) {
                let id = machine.slots.get(property).id;
                if machine.key_id_index(id).is_some() {
                    continue;
                }
                let name = machine.property_key_name(id);
                if machine.functions.contains_key(&holder)
                    && matches!(name.as_str(), "length" | "name")
                {
                    continue;
                }
                let rank = machine
                    .intrinsic_key_rank(holder, id)
                    .unwrap_or_else(|| panic!("{holder:?}: {name} has no place"));
                assert!(
                    previous.is_none_or(|previous| previous < rank),
                    "{holder:?}: {name} is out of order"
                );
                previous = Some(rank);
            }
        }
        let globals: Vec<String> = machine
            .own_property_slots(machine.environment.global_obj)
            .into_iter()
            .map(|property| machine.property_key_name(machine.slots.get(property).id))
            .collect();
        let expected: Vec<String> = GLOBAL_KEY_ORDER
            .iter()
            .filter(|name| globals.iter().any(|global| global == *name))
            .map(|name| name.to_string())
            .collect();
        assert_eq!(globals, expected);
    }

    impl Interp {
        fn property_key_name(&self, id: u16) -> String {
            if let Some(descriptor) = self.symbol_key_ids.descriptor(id) {
                let name = self.well_known_symbols.iter().find_map(|(name, value)| {
                    (value.value == Payload::Reference(descriptor)).then_some(*name)
                });
                return format!("@@{}", name.unwrap_or("?"));
            }
            self.symbol_names[usize::from(id) - 1]
                .as_str()
                .unwrap_or("?")
                .to_string()
        }
    }
}
