//! Native builtin identities, method tags, display names, and arities.
use super::*;

/// The `Math` static functions ironhorse models (`xsMath.c`). Each is a
/// property of the `Math` namespace object, dispatched through
/// [`NativeMethod::Math`] ignoring the receiver. The bodies carry **no**
/// `mxMeterSome` (verified against the pin: `grep -c mxMeter xsMath.c` is
/// 0), so a Math call's whole computron cost is the native host frame
/// ([`MATH_FRAME_METERING`]); the result NaN is the canonical `f64::NAN`
/// (`C_NAN`), which the design flags consensus-critical.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum MathId {
    Abs,
    Acos,
    Acosh,
    Asin,
    Asinh,
    Atan,
    Atanh,
    Atan2,
    Cbrt,
    Ceil,
    Clz32,
    Cos,
    Cosh,
    Exp,
    Expm1,
    Floor,
    Fround,
    Hypot,
    Imul,
    Log,
    Log1p,
    Log10,
    Log2,
    Max,
    Min,
    Pow,
    Round,
    Sign,
    Sin,
    Sinh,
    Sqrt,
    Tan,
    Tanh,
    Trunc,
}

/// A native prototype method ironhorse models (dispatched with the receiver as
/// `this`). Some methods invoke guest callbacks or accessors; their bodies
/// use the interpreter's re-entry and exception machinery.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum NativeMethod {
    /// `%Function.prototype%` itself is a callable, non-constructable built-in
    /// that accepts any arguments and returns `undefined`.
    FunctionPrototype,
    /// `Date` statics and prototype methods. The compact operation id keeps
    /// the calendar implementation centralized; see `date_method`.
    Date(u8),
    /// A method on one of the ISO Temporal plain families.  The first byte is
    /// the family (date, time, date-time, year-month, month-day, calendar),
    /// and the second is the operation.  Keeping this compact makes the
    /// shared ISO algorithms below genuinely shared instead of six copied
    /// native dispatch tables.
    TemporalPlain(u8, u8),
    /// A `Temporal.ZonedDateTime` static or prototype method.  The byte is the
    /// operation code dispatched in [`Interp::temporal_zoned_method`].
    TemporalZoned(u8),
    /// A `Temporal.Now` namespace function.  The byte selects the hook
    /// (`instant`, `timeZoneId`, `zonedDateTimeISO`, …) in
    /// [`Interp::temporal_now_method`].
    TemporalNow(u8),
    TemporalInstantFrom,
    TemporalInstantFromEpochMilliseconds,
    TemporalInstantFromEpochNanoseconds,
    TemporalInstantCompare,
    TemporalInstantAdd,
    TemporalInstantSubtract,
    TemporalInstantUntil,
    TemporalInstantSince,
    TemporalInstantRound,
    TemporalInstantEquals,
    TemporalInstantToString,
    TemporalInstantToJSON,
    TemporalInstantValueOf,
    TemporalDurationFrom,
    TemporalDurationCompare,
    TemporalDurationWith,
    TemporalDurationNegated,
    TemporalDurationAbs,
    TemporalDurationAdd,
    TemporalDurationSubtract,
    TemporalDurationRound,
    TemporalDurationTotal,
    TemporalDurationToString,
    TemporalDurationToJSON,
    TemporalDurationValueOf,
    IntlGetCanonicalLocales,
    IntlSupportedValuesOf,
    IntlSupportedLocalesOf,
    LocaleToString,
    LocaleMaximize,
    LocaleMinimize,
    CollatorResolvedOptions,
    CollatorCompare,
    ListFormatFormat,
    ListFormatFormatToParts,
    ListFormatResolvedOptions,
    PluralRulesSelect,
    PluralRulesSelectRange,
    PluralRulesResolvedOptions,
    SegmenterSegment,
    SegmenterResolvedOptions,
    SegmentsContaining,
    SegmentsIterator,
    SegmentIteratorNext,
    SegmentIteratorSymbolIterator,
    DateTimeFormatFormat,
    DateTimeFormatFormatToParts,
    DateTimeFormatFormatRange,
    DateTimeFormatFormatRangeToParts,
    DateTimeFormatResolvedOptions,
    NumberFormatFormat,
    /// `get Intl.NumberFormat.prototype.format` — the accessor **getter**
    /// (name `"get format"`, length 0). Returns the receiver's cached
    /// `[[BoundFormat]]` function, creating it on first read.
    NumberFormatFormatGetter,
    /// The cached `[[BoundFormat]]` function (an anonymous, length-1 built-in)
    /// the `format` getter returns: calling `boundFormat(value)` formats
    /// `value` with the NumberFormat the getter was read from.
    NumberFormatBoundFormat,
    NumberFormatFormatToParts,
    NumberFormatFormatRange,
    NumberFormatFormatRangeToParts,
    NumberFormatResolvedOptions,
    /// The internal `%CopyObject%` helper used by object spread and object
    /// rest. It copies the source's own enumerable properties to `this`.
    CopyObject,
    ObjectToString,
    /// `Object.prototype.toLocaleString()` invokes the receiver's live
    /// `toString` method.
    ObjectToLocaleString,
    ObjectHasOwnProperty,
    ObjectValueOf,
    ObjectIsPrototypeOf,
    /// `Object.is(x, y)` — ECMAScript SameValue (NaN equals NaN, signed
    /// zeros differ, and objects compare by identity).
    ObjectIs,
    /// `Object.hasOwn(object, key)` — `HasOwnProperty(? ToObject(object),
    /// ? ToPropertyKey(key))`.
    ObjectHasOwn,
    /// `Object.assign(target, ...sources)` — copy each source's live own
    /// enumerable string and symbol properties through the object MOP.
    ObjectAssign,
    /// `Object.fromEntries(iterable)` consumes entry objects through the
    /// iterator protocol. Each entry is read by keys `0` and `1`.
    ObjectFromEntries,
    /// `Object.keys(o)` — the own enumerable string-keyed property names, in
    /// property-creation order, as a fresh `Array` of interned key strings.
    ObjectKeys,
    /// `Object.create(proto[, properties])` for ordinary prototypes and the
    /// same descriptor machinery as `Object.defineProperties`.
    ObjectCreate,
    /// `Object.getOwnPropertyDescriptor(o, k)` returns the own data or accessor
    /// descriptor for `k`, or `undefined` when absent.
    ObjectGetOwnPropertyDescriptor,
    /// `Object.getOwnPropertyNames(o)` — all own string keys, including
    /// non-enumerable Error `message`/`cause` properties.
    ObjectGetOwnPropertyNames,
    /// `Object.defineProperty(o, k, descriptor)` converts the descriptor and
    /// defines the property through the modeled receiver's internal method.
    /// A rejected definition throws; a successful definition returns the object.
    ObjectDefineProperty,
    /// `Object.defineProperties(o, descriptors)`; descriptors are snapshotted
    /// before any definition and then applied through the ordinary MOP seam.
    ObjectDefineProperties,
    /// `Object.getOwnPropertyDescriptors(o)` — a fresh object mapping each own
    /// property key to its descriptor object (the plural of
    /// `getOwnPropertyDescriptor`).
    ObjectGetOwnPropertyDescriptors,
    /// `Object.getOwnPropertySymbols(o)` in symbol creation order.
    ObjectGetOwnPropertySymbols,
    /// `Object.values(o)` — a fresh `Array` of `o`'s own enumerable
    /// string-keyed property values, in creation order.
    ObjectValues,
    /// `Object.entries(o)` — a fresh `Array` of `[key, value]` two-element
    /// arrays for `o`'s own enumerable string-keyed properties, in creation
    /// order.
    ObjectEntries,
    /// `Object.preventExtensions(o)` — mark the instance non-extensible
    /// (`XS_DONT_PATCH_FLAG`), returning it.
    ObjectPreventExtensions,
    /// `Object.seal(o)` — prevent extensions and mark every own property
    /// non-configurable (`XS_DONT_DELETE_FLAG`), returning it.
    ObjectSeal,
    /// `Object.freeze(o)` — prevent extensions and mark every own data
    /// property non-configurable and non-writable
    /// (`XS_DONT_DELETE_FLAG|XS_DONT_SET_FLAG`), returning it.
    ObjectFreeze,
    /// `Object.isExtensible(o)` — whether the instance is still extensible.
    ObjectIsExtensible,
    /// `Object.isSealed(o)` — non-extensible and every own property
    /// non-configurable.
    ObjectIsSealed,
    /// `Object.isFrozen(o)` — non-extensible and every own data property
    /// non-configurable and non-writable.
    ObjectIsFrozen,
    /// `Object.prototype.propertyIsEnumerable(k)` — whether `k` is an own
    /// enumerable property of the receiver.
    ObjectPropertyIsEnumerable,
    /// `Reflect.getPrototypeOf(target)` calls `[[GetPrototypeOf]]` after
    /// requiring an object target.
    ReflectGetPrototypeOf,
    /// `Reflect.setPrototypeOf(target, proto)` calls `[[SetPrototypeOf]]`
    /// after validating the object target and object-or-null prototype.
    /// Returns whether the internal method accepts the change.
    ReflectSetPrototypeOf,
    ReflectIsExtensible,
    ReflectPreventExtensions,
    /// `Reflect.getOwnPropertyDescriptor(target, key)` returns an own data
    /// or accessor descriptor, or `undefined`, through `[[GetOwnProperty]]`.
    /// A non-object target throws TypeError.
    ReflectGetOwnPropertyDescriptor,
    /// `Reflect.defineProperty(target, key, descriptor)` converts the
    /// descriptor and calls `[[DefineOwnProperty]]`, returning its Boolean
    /// acceptance result. Invalid arguments and abrupt completions still throw.
    ReflectDefineProperty,
    /// `Reflect.ownKeys(target)` returns the string and symbol keys produced
    /// by the object target's `[[OwnPropertyKeys]]` internal method.
    ReflectOwnKeys,
    /// `Reflect.has(target, key)` calls `[[HasProperty]]` on the object target
    /// with the converted property key.
    ReflectHas,
    /// `Reflect.get(target, key[, receiver])` calls `[[Get]]` with the
    /// explicit receiver, or the target when it is omitted.
    ReflectGet,
    /// `Reflect.set(target, key, value[, receiver])` calls `[[Set]]` with the
    /// explicit receiver, or the target when omitted, and returns its Boolean
    /// acceptance result.
    ReflectSet,
    /// `Reflect.deleteProperty(target, key)` calls `[[Delete]]` on the
    /// object target and returns its Boolean acceptance result.
    ReflectDeleteProperty,
    /// `Reflect.apply(target, thisArgument, argumentsList)` expands the
    /// array-like arguments list and invokes the callable target through the
    /// shared abstract Call operation.
    ReflectApply,
    /// `Reflect.construct(target, argumentsList[, newTarget])` checks the
    /// constructors, expands the array-like arguments list, and delegates to
    /// the shared construction operation.
    ReflectConstruct,
    /// `Proxy.revocable(target, handler)` (`xsProxy.c` `fx_Proxy_revocable`):
    /// returns `{ proxy, revoke }` where `revoke` is a
    /// [`NativeMethod::ProxyRevoke`] function bound (via
    /// [`Interp::proxy_revokers`]) to the freshly-minted proxy.
    ProxyRevocable,
    /// The `revoke` function `Proxy.revocable` returns: trips its proxy's
    /// `[[ProxyTarget]]`/`[[ProxyHandler]]` to null and marks it revoked.
    ProxyRevoke,
    /// `Object.getPrototypeOf(O)` (`fx_Object_getPrototypeOf`): the object's
    /// `[[GetPrototypeOf]]` — routes through the proxy `getPrototypeOf` trap.
    ObjectGetPrototypeOf,
    /// `Object.setPrototypeOf(O, proto)` (`fx_Object_setPrototypeOf`): the
    /// object's `[[SetPrototypeOf]]` — routes through the proxy trap.
    ObjectSetPrototypeOf,
    FunctionToString,
    /// `Function.prototype.call` — a re-entrant trampoline: invoke the
    /// receiver function with the first argument as `this` and the rest as
    /// its arguments. Handled specially in the `run` dispatch (it re-enters
    /// the interpreter frame machinery rather than computing a value).
    FunctionCall,
    /// `Function.prototype.apply` invokes the receiver function with the
    /// given `this` and an array-like arguments list. A null or undefined list
    /// supplies no arguments.
    FunctionApply,
    /// `Function.prototype.bind(thisArg, ...boundArgs)`
    /// (`fx_Function_prototype_bind`): create a **bound function** — a fresh
    /// callable whose `.length` is the target's own `.length` minus the bound
    /// arg count (floored at 0), `.name` is `"bound "` + the target's name,
    /// and which, when called, invokes the target with the bound `this` and
    /// the bound args prepended to the call args (`fx_Function_prototype_
    /// bound`). Handled in `call_native_method` (creation); the bound
    /// function's later invocation is a separate trampoline in the `run`
    /// dispatch.
    FunctionBind,
    /// `Function.prototype[Symbol.hasInstance](value)`: the public
    /// `OrdinaryHasInstance(this, value)` entry point inherited by callable
    /// objects and consulted by the `instanceof` operator.
    FunctionHasInstance,
    ErrorToString,
    DisposableStackUse,
    DisposableStackAdopt,
    DisposableStackDefer,
    DisposableStackMove,
    DisposableStackDispose,
    AsyncDisposableStackUse,
    AsyncDisposableStackAdopt,
    AsyncDisposableStackDefer,
    AsyncDisposableStackMove,
    AsyncDisposableStackDisposeAsync,
    /// A primitive wrapper's `valueOf` (returns the wrapped primitive).
    WrapperValueOf,
    /// A primitive wrapper's `toString` (stringifies the wrapped primitive).
    WrapperToString,
    /// `Symbol.prototype.toString()` (`fx_Symbol_prototype_toString` →
    /// `fxSymbolToString`): the descriptive string `Symbol(<description>)`.
    SymbolToString,
    /// `Symbol.prototype.valueOf()` returns the symbol primitive, unwrapping
    /// a Symbol wrapper when necessary.
    SymbolValueOf,
    /// `Symbol.prototype[Symbol.toPrimitive](hint)`: the symbol primitive
    /// itself, unwrapping a Symbol wrapper object. The hint is ignored.
    SymbolToPrimitive,
    /// `get Symbol.prototype.description` (`fx_Symbol_prototype_get_
    /// description`): the accessor **getter** (name `"get description"`,
    /// length 0) over the receiver's `[[Description]]` — the description slot
    /// a `Symbol(desc)` call coerced to a String, or `undefined` when the
    /// symbol was created without one. Brand-checked like its `toString`/
    /// `valueOf` siblings, so a non-Symbol receiver is a `TypeError`.
    SymbolDescriptionGetter,
    /// `Date.prototype[Symbol.toPrimitive](hint)`: validate the string hint,
    /// then perform ordinary conversion in string order for `"string"` and
    /// `"default"`, or number order for `"number"`.
    DateToPrimitive,
    /// `BigInt.prototype.toString([radix])`: render the primitive/wrapper
    /// receiver in radix 2 through 36.
    BigIntToString,
    /// `BigInt.prototype.toLocaleString([locales[, options]])`.
    BigIntToLocaleString,
    /// `BigInt.prototype.valueOf()`: unwrap a BigInt wrapper or return a
    /// primitive BigInt receiver unchanged.
    BigIntValueOf,
    /// `BigInt.asIntN(bits, bigint)`: truncate to a signed `bits`-wide value.
    BigIntAsIntN,
    /// `BigInt.asUintN(bits, bigint)`: truncate to an unsigned `bits`-wide
    /// value.
    BigIntAsUintN,
    /// `Symbol.for(key)` (`fx_Symbol_for`): the shared registry symbol for
    /// `key` — the same symbol on repeat calls (registry-interned identity).
    SymbolFor,
    /// `Symbol.keyFor(sym)` (`fx_Symbol_keyFor`): the registry key a
    /// registered symbol was interned under, or `undefined`.
    SymbolKeyFor,
    /// `Array.prototype.push(...items)` appends the arguments and returns
    /// the new length, using the generic property path when required.
    ArrayPush,
    /// `Array.prototype.pop()`
    /// (`fx_Array_prototype_pop`): remove and return the last element (or
    /// `undefined` on an empty array), updating the length.
    ArrayPop,
    /// `Array.prototype.indexOf(value[, from])`
    /// (`fx_Array_prototype_indexOf`): the first index at which `value` is
    /// found by strict equality, or `-1`.
    ArrayIndexOf,
    /// `Array.prototype.join([sep])`
    /// (`fx_Array_prototype_join`): the elements stringified and joined by
    /// `sep` (default `","`), holes/`undefined`/`null` contributing empty.
    ArrayJoin,
    /// `Array.prototype.includes(value[, from])`
    /// (`fx_Array_prototype_includes`): whether `value` is an element (by
    /// SameValueZero), scanning from `from`.
    ArrayIncludes,
    /// `Array.prototype.lastIndexOf(value[, from])`: the last
    /// index at which `value` is found (strict equality) scanning backward, or
    /// `-1`.
    ArrayLastIndexOf,
    /// `Array.prototype.fill(value[, start[, end]])`
    /// (`fx_Array_prototype_fill`): set `[start, end)` to `value`, returning
    /// the array.
    ArrayFill,
    /// `Array.prototype.reverse()`
    /// (`fx_Array_prototype_reverse`): reverse the elements in place, returning
    /// the array.
    ArrayReverse,
    /// `Array.prototype.slice([start[, end]])`
    /// (`fx_Array_prototype_slice`): a new array with the elements of
    /// `[start, end)`.
    ArraySlice,
    /// `Array.prototype.concat(...args)`
    /// (`fx_Array_prototype_concat`): a new array of the receiver's elements
    /// followed by each argument (spreading array arguments).
    ArrayConcat,
    /// `Array.prototype.at(index)` (`fx_Array_prototype_at`):
    /// the element at `index` (negative counts from the end), or `undefined`.
    ArrayAt,
    /// `Array.prototype.shift()` (`fx_Array_prototype_shift`):
    /// remove and return the first element, shifting the rest down.
    ArrayShift,
    /// `Array.prototype.unshift(...items)`
    /// (`fx_Array_prototype_unshift`): prepend the arguments, returning the new
    /// length.
    ArrayUnshift,
    /// `Array.prototype.copyWithin(target[, start[, end]])`
    /// (`fx_Array_prototype_copyWithin`): copy the block `[start, end)` to
    /// `target` in place, returning the array.
    ArrayCopyWithin,
    /// `Array.prototype.with(index, value)` (`fx_Array_prototype_with`): a new
    /// array copying the receiver with `index` replaced by `value` (negative
    /// index counts from the end; out-of-range is a RangeError).
    ArrayWith,
    /// `Array.prototype.forEach(callback[, thisArg])`
    /// (`fx_Array_prototype_forEach`): call `callback(item, index, array)` for
    /// each present element; returns `undefined`. The first re-entrant method
    /// (drives a user callback per element via [`Interp::run_callback`]).
    ArrayForEach,
    /// `Array.prototype.map(callback[, thisArg])`: a new array of the callback
    /// results, one per element.
    ArrayMap,
    /// `Array.prototype.some(callback[, thisArg])`: `true` if the callback is
    /// truthy for any element (short-circuits).
    ArraySome,
    /// `Array.prototype.every(callback[, thisArg])`: `true` if the callback is
    /// truthy for every element (short-circuits on the first falsy).
    ArrayEvery,
    /// `Array.prototype.find(callback[, thisArg])`: the first element for which
    /// the callback is truthy, or `undefined`.
    ArrayFind,
    /// `Array.prototype.findIndex(callback[, thisArg])`: the index of the first
    /// element for which the callback is truthy, or `-1`.
    ArrayFindIndex,
    /// `Array.prototype.filter(callback[, thisArg])`: a new array of the
    /// elements for which the callback is truthy.
    ArrayFilter,
    /// `Array.prototype.reduce(callback[, initial])`: fold left with
    /// `callback(acc, item, index, array)`.
    ArrayReduce,
    /// `Array.prototype.reduceRight(callback[, initial])`: fold right.
    ArrayReduceRight,
    /// `Array.prototype.findLast(callback[, thisArg])`: the last element for
    /// which the callback is truthy, or `undefined`.
    ArrayFindLast,
    /// `Array.prototype.findLastIndex(callback[, thisArg])`: the index of the
    /// last element for which the callback is truthy, or `-1`.
    ArrayFindLastIndex,
    /// `Array.prototype.toReversed()` (`fx_Array_prototype_toReversed`): a new
    /// array with the receiver's elements reversed (non-mutating).
    ArrayToReversed,
    /// `Array.prototype.splice(start[, deleteCount, ...items])`
    /// (`fx_Array_prototype_splice`): remove `deleteCount` elements at `start`
    /// and insert `items`, returning a new array of the removed elements.
    ArraySplice,
    /// `Array.prototype.flat([depth])` (`fx_Array_prototype_flat`): a new array
    /// with sub-array elements flattened to `depth` (default 1).
    ArrayFlat,
    /// `Array.prototype.flatMap(callback[, thisArg])`
    /// (`fx_Array_prototype_flatMap`): map then flatten by one level.
    ArrayFlatMap,
    /// `Array.prototype.toSpliced(start, deleteCount, ...items)`
    /// (`fx_Array_prototype_toSpliced`): a non-mutating splice into a new array.
    ArrayToSpliced,
    /// `Array.prototype.toString()` (`fx_Array_prototype_toString`): delegates
    /// to `this.join()` with the default separator (spec 23.1.3.36).
    ArrayToString,
    /// `Array.prototype.sort([comparator])`.
    ArraySort,
    /// `Array.prototype.toSorted([comparator])`.
    ArrayToSorted,
    /// `Array.prototype.toLocaleString()` invokes non-nullish elements'
    /// locale-string methods, with empty fields for holes and nullish values.
    ArrayToLocaleString,
    /// `%TypedArray%.prototype.copyWithin(target, start, end)`.
    TypedArrayCopyWithin,
    /// `%TypedArray%.prototype.fill(value, start, end)`.
    TypedArrayFill,
    /// `%TypedArray%.prototype.set(source, offset)`.
    TypedArraySet,
    /// `%TypedArray%.prototype.reverse()`.
    TypedArrayReverse,
    /// `%TypedArray%.prototype.join(separator)`.
    TypedArrayJoin,
    /// `%TypedArray%.prototype.values()` / `keys()` / `entries()`.
    TypedArrayValues,
    TypedArrayKeys,
    TypedArrayEntries,
    /// `%TypedArray%.prototype.slice(start, end)` / `subarray(begin, end)`.
    TypedArraySlice,
    TypedArraySubarray,
    /// `%TypedArray%.prototype.map(callback, thisArg)` / `filter(...)`.
    TypedArrayMap,
    TypedArrayFilter,
    /// `%TypedArray%.prototype.sort(comparefn)`.
    TypedArraySort,
    /// `%TypedArray%.prototype.toLocaleString([locales[, options]])`.
    TypedArrayToLocaleString,
    /// Non-allocating shared TypedArray methods. Operation ids select
    /// `forEach`, `every`, `some`, `find`, `findIndex`, `includes`, `indexOf`,
    /// `lastIndexOf`, `reduce`, and `reduceRight`, in that order.
    TypedArrayReadonly(u8),
    /// Shared `%TypedArray%.prototype` view accessors.
    TypedArrayLengthGetter,
    TypedArrayByteLengthGetter,
    TypedArrayByteOffsetGetter,
    TypedArrayBufferGetter,
    TypedArrayToStringTagGetter,
    /// `%TypedArray%.from` / `%TypedArray%.of`, inherited by concrete
    /// TypedArray constructors.
    TypedArrayFrom,
    TypedArrayOf,
    /// `Array.from(iterable[, mapFn[, thisArg]])`, including guest iterator,
    /// mapper and constructor calls under a native exception boundary.
    ArrayFrom,
    /// `Array.fromAsync(...)` returns a promise and drives iterator adoption
    /// through the native `FromAsyncData` state machine.
    ArrayFromAsync,
    /// `Array.isArray(v)` — a static on the `Array` constructor: whether `v`
    /// is an array exotic object.
    ArrayIsArray,
    /// `Array.of(...items)` — a static: a new array whose elements are the
    /// arguments (always elements, never a length).
    ArrayOf,
    /// `Array.prototype.values()` / `keys()` / `entries()`
    /// (`fx_Array_prototype_values` &co.): construct an Array Iterator over the
    /// receiver with the given kind (0 values / 1 keys / 2 entries).
    ArrayValues,
    ArrayKeys,
    ArrayEntries,
    /// `%ArrayIteratorPrototype%.next()` (`fx_ArrayIterator_prototype_next`):
    /// yield the next `{value, done}` (mutating and returning the iterator's
    /// reused result object).
    ArrayIteratorNext,
    /// A `Math.*` static (`xsMath.c`), dispatched ignoring the receiver.
    Math(MathId),
    /// `String.prototype.charCodeAt(pos)` (`fx_String_prototype_charCodeAt`):
    /// the UTF-16 code unit at `pos`, or `NaN` when out of range. No
    /// `mxMeterSome`; the result is a number (no chunk).
    StringCharCodeAt,
    /// `String.prototype.codePointAt(pos)` (`fx_String_prototype_codePointAt`):
    /// the code point at `pos`, or `undefined` out of range.
    StringCodePointAt,
    /// `String.prototype.charAt(pos)` (`fx_String_prototype_charAt`): the
    /// one-character string at `pos` (empty string out of range). Allocates
    /// the result chunk.
    StringCharAt,
    /// `String.prototype.at(index)` (`fx_String_prototype_at`): the character
    /// at `index` (negative counts from the end), `undefined` out of range.
    StringAt,
    /// `String.prototype.slice([start[,end]])` (`fx_String_prototype_slice`):
    /// the substring `[start,end)` with negative offsets from the end.
    StringSlice,
    /// `String.prototype.substring([start[,end]])`
    /// (`fx_String_prototype_substring`): the substring between the clamped,
    /// swapped-if-needed offsets.
    StringSubstring,
    /// `String.prototype.indexOf(search[,from])`
    /// (`fx_String_prototype_indexOf`): the first index of `search` at or after
    /// `from`, or `-1`. Meters one `mxMeterSome` per non-continuation scanned
    /// byte.
    StringIndexOf,
    /// `String.prototype.lastIndexOf(search[,from])`
    /// (`fx_String_prototype_lastIndexOf`): the last index of `search`, or `-1`.
    StringLastIndexOf,
    /// `String.prototype.includes(search[,from])`
    /// (`fx_String_prototype_includes`): whether `search` occurs.
    StringIncludes,
    /// `String.prototype.startsWith(search[,from])`
    /// (`fx_String_prototype_startsWith`).
    StringStartsWith,
    /// `String.prototype.endsWith(search[,end])`
    /// (`fx_String_prototype_endsWith`).
    StringEndsWith,
    /// `String.prototype.concat(...args)` (`fx_String_prototype_concat`):
    /// the receiver followed by each stringified argument; `mxMeterSome(argc)`
    /// plus the result chunk.
    StringConcat,
    /// `String.prototype.toLowerCase()` / `toUpperCase()`
    /// (`fx_String_prototype_toCase`): locale-insensitive Unicode case mapping
    /// over scalar runs, preserving unpaired UTF-16 surrogates;
    /// `mxMeterSome(count)` plus the result chunk.
    StringToLowerCase,
    StringToUpperCase,
    /// Locale-aware string casing. The frozen Intl profile uses Unicode
    /// default casing plus Turkish/Azeri dotted-I specialization.
    StringToLocaleLowerCase,
    StringToLocaleUpperCase,
    /// `String.prototype.localeCompare(that[, locales[, options]])`.
    StringLocaleCompare,
    /// `String.prototype.normalize([form])`: Unicode NFC/NFD/NFKC/NFKD
    /// normalization over scalar runs, preserving unpaired UTF-16 surrogates.
    StringNormalize,
    /// `String.prototype.repeat(count)` (`fx_String_prototype_repeat`): the
    /// receiver repeated `count` times; `mxMeterSome(count)` plus the result
    /// chunk. A negative/`Infinity` count is a RangeError.
    StringRepeat,
    /// `String.prototype.trim()`/`trimStart()`/`trimEnd()`
    /// (`fx_String_prototype_trim*`): the receiver with ASCII/Unicode
    /// whitespace stripped. ASCII-whitespace fast path.
    StringTrim,
    StringTrimStart,
    StringTrimEnd,
    /// `String.prototype.padStart` / `padEnd`.
    StringPadStart,
    StringPadEnd,
    /// ES2024 well-formed Unicode string predicates/conversion.
    StringIsWellFormed,
    StringToWellFormed,
    /// `String.fromCharCode` / `String.fromCodePoint` constructor statics.
    StringFromCharCode,
    StringFromCodePoint,
    /// `String.raw(template, ...substitutions)`: concatenate the observable
    /// `template.raw` array-like segments with the corresponding substitutions.
    StringRaw,
    /// `String.prototype[Symbol.iterator]()`.
    StringIterator,
    /// `Number.isFinite`/`isInteger`/`isNaN`/`isSafeInteger` (`xsNumber.c`) —
    /// statics on the `Number` constructor that inspect the argument's slot
    /// **kind** directly (no coercion): an integer is always finite/integer/
    /// safe and never NaN; a number defers to its `fpclassify`.
    NumberIsFinite,
    NumberIsInteger,
    NumberIsNaN,
    NumberIsSafeInteger,
    /// `Number.prototype.toString([radix])` (`fx_Number_prototype_toString`):
    /// radix-10 renders through `fxNumberToString` (the `Number::toString`
    /// spelling); a radix in `[2,36]` runs XS's digit conversion. Allocates
    /// the result chunk.
    NumberToString,
    /// `Number.prototype.toLocaleString([locales[, options]])`.
    NumberToLocaleString,
    /// The global `parseInt(string[,radix])` (`fx_parseInt`): the integer
    /// prefix parse. No `mxMeterSome`, no chunk.
    GlobalParseInt,
    /// The global `parseFloat(string)` (`fx_parseFloat`): the float prefix
    /// parse (`fxStringToNumber` with `whole = 0`). No chunk.
    GlobalParseFloat,
    /// The global `isNaN(x)` / `isFinite(x)` (`fx_isNaN`/`fx_isFinite`):
    /// `fxToNumber` then the `fpclassify` test. No chunk.
    GlobalIsNaN,
    GlobalIsFinite,
    /// The global `harden(x)` (`fx_harden`, `xsLockdown.c`): the transitive
    /// freeze worklist over the slot arena — prevent extensions and stamp
    /// every own data property non-writable/non-configurable (accessors
    /// non-configurable), then queue the prototype and every reference-valued
    /// property, marking each reached instance `XS_DONT_MARSHALL_FLAG`. Returns
    /// `x`. `xsLockdown.c` calls no `mxMeter`, so the cost is allocation-driven
    /// (the worklist `fxNewSlot`s + the two `fxNewInstance` ownKeys holders per
    /// object). Ironhorse's intrinsics are modeled sparsely, so the transitive
    /// object count diverges from the pin — the freeze *result* is faithful,
    /// the computron count over an intrinsic-spilling walk is not (a structural
    /// divergence, the same sparse-intrinsics fact the module/compartment
    /// children record). Result-gated corpus.
    GlobalHarden,
    /// The global `petrify(x)` (`fx_petrify`, `xsLockdown.c`): a *single*-object
    /// freeze (non-transitive) — prevent extensions, stamp every own property
    /// non-writable/non-configurable, and additionally stamp the internal data
    /// slots (ArrayBuffer/Date/Map/Set/WeakMap/WeakSet) `XS_DONT_SET_FLAG`.
    /// Returns `x`. Allocation-driven metering (the one `fxNewInstance` ownKeys
    /// holder + its at-slots).
    GlobalPetrify,
    /// `$262.detachArrayBuffer(buffer)`, the test262 host hook.
    Test262DetachArrayBuffer,
    /// `JSON.stringify(value[, replacer[, space]])` serializes through
    /// observable property reads, `toJSON`, replacer callbacks or property
    /// lists, and wrapper unboxing. A remaining BigInt value throws TypeError.
    JsonStringify,
    /// `JSON.parse(text)` (`fx_JSON_parse`): parse `text` to a value.
    JsonParse,
    /// `Map.prototype.set(k, v)` / `WeakMap.prototype.set(k, v)`
    /// (`fx_Map_prototype_set` / `fx_WeakMap_prototype_set`): insert or update
    /// the entry, returning the receiver. A new key allocates the entry slots
    /// (`fxSetEntry`/`fxSetWeakEntry`) — the sole metering (xsMapSet.c calls no
    /// `mxMeter`); an existing key updates in place, allocation-free.
    MapSet,
    /// `Map.prototype.get(k)` / `WeakMap.prototype.get(k)`: the value for `k`,
    /// or `undefined`. Allocation-free (`fxGetEntry`/`fxGetWeakEntry`).
    MapGet,
    /// `Map.prototype.has(k)` / `WeakMap.prototype.has(k)`: membership.
    MapHas,
    /// `Map.prototype.delete(k)` / `WeakMap.prototype.delete(k)`: remove and
    /// report whether present. A Map shrink may reallocate the address chunk
    /// (`fxResizeEntries`); a WeakMap unlink is allocation-free.
    MapDelete,
    /// `Map.prototype.getOrInsert(key, value)` (upsert proposal): return the
    /// existing value for `key`, or insert `value` under the canonicalized key
    /// and return it. Requires a real `[[MapData]]` receiver.
    MapGetOrInsert,
    /// `Map.prototype.getOrInsertComputed(key, callbackfn)` (upsert proposal):
    /// return the existing value for `key`; on absence call `callbackfn(key)`
    /// exactly once (the canonicalized key, `this` undefined), then insert its
    /// result under the key (overwriting any entry the callback itself added)
    /// and return it. Re-entrant (drives a user callback).
    MapGetOrInsertComputed,
    /// `Map.groupBy(items, callbackfn)` (array-grouping proposal): a static on
    /// the `Map` constructor. Iterate `items`, call `callbackfn(value, index)`
    /// per element, bucket each value into an Array keyed by the callback result
    /// under SameValueZero (`-0`→`+0`), and return a fresh `Map`. Re-entrant.
    MapGroupBy,
    /// `Object.groupBy(items, callbackfn)` (array-grouping proposal): like
    /// `Map.groupBy` but buckets under `? ToPropertyKey(key)` into a fresh
    /// null-prototype ordinary object whose values are Arrays. Re-entrant.
    ObjectGroupBy,
    WeakMapSet,
    WeakMapGet,
    WeakMapHas,
    WeakMapDelete,
    /// `WeakMap.prototype.getOrInsert(key, value)` (upsert proposal): return the
    /// existing value for `key`, or insert `value` and return it. Requires a
    /// real `[[WeakMapData]]` receiver and a weakly-holdable `key` (a TypeError
    /// otherwise, checked before insertion). No key canonicalization — WeakMap
    /// keys are objects, so SameValue and SameValueZero coincide.
    WeakMapGetOrInsert,
    /// `WeakMap.prototype.getOrInsertComputed(key, callbackfn)` (upsert
    /// proposal): return the existing value for `key`; on absence call
    /// `callbackfn(key)` exactly once (`this` undefined), then insert its result
    /// under the key (overwriting any entry the callback itself added) and
    /// return it. The weak-key check precedes the callable check (spec order).
    /// Re-entrant (drives a user callback).
    WeakMapGetOrInsertComputed,
    /// `Set.prototype.add(v)` / `WeakSet.prototype.add(v)`: insert `v`,
    /// returning the receiver (`fxSetEntry` with no pair → two entry slots;
    /// the weak form allocates three).
    SetAdd,
    /// `Set.prototype.has(v)` / `WeakSet.prototype.has(v)`.
    SetHas,
    /// `Set.prototype.delete(v)` / `WeakSet.prototype.delete(v)`.
    SetDelete,
    /// The seven "new Set methods" (ES2025 set-methods proposal):
    /// `union`/`intersection`/`difference`/`symmetricDifference` return a fresh
    /// Set; `isSubsetOf`/`isSupersetOf`/`isDisjointFrom` return a Boolean. Each
    /// first coerces its argument through `GetSetRecord` (read `size`→ToNumber,
    /// `has`, `keys` — all observably, in that order) and drives the argument's
    /// `keys()` iterator or its `has` callback per the specification.
    SetUnion,
    SetIntersection,
    SetDifference,
    SetSymmetricDifference,
    SetIsSubsetOf,
    SetIsSupersetOf,
    SetIsDisjointFrom,
    WeakSetAdd,
    WeakSetHas,
    WeakSetDelete,
    /// `Map.prototype.forEach(cb[, thisArg])` / `Set.prototype.forEach(...)`
    /// (`fx_Map_prototype_forEach` / `fx_Set_prototype_forEach`): call
    /// `cb(value, key, coll)` for each live entry in insertion order (a Set
    /// passes `value` for both the value AND the key). The second re-entrant
    /// collection method; the handler branches on the receiver's kind. WeakMap/
    /// WeakSet have no `forEach`.
    CollForEach,
    /// `Map.prototype.entries()`/`keys()`/`values()` and
    /// `Set.prototype.entries()`/`values()`/`keys()` (Set's `keys` IS
    /// `values`): construct a Map/Set Iterator over the receiver with the given
    /// iteration kind (0 keys, 1 values, 2 entries). Set's kind-2 entry is
    /// `[value, value]`.
    CollEntries,
    CollKeys,
    CollValues,
    /// `Map.prototype.clear()` / `Set.prototype.clear()`
    /// (`fx_Map_prototype_clear` / the Set form → `fxClearEntries`): drop every
    /// entry and shrink the address table back toward `mxTableMinLength`,
    /// returning `undefined`. WeakMap/WeakSet have no `clear`.
    CollClear,
    /// `ArrayBuffer.prototype.slice(begin, end)`
    /// (`fx_ArrayBuffer_prototype_slice`): a fresh ArrayBuffer holding the
    /// `[begin, end)` byte range (relative-index clamped like
    /// `Array.prototype.slice`), copied out of the receiver's backing store.
    ArrayBufferSlice,
    /// `get ArrayBuffer[Symbol.species]`: the standard accessor returns its
    /// receiver.
    ArrayBufferSpeciesGetter,
    /// The fixed-buffer-compatible `ArrayBuffer.prototype` accessors.
    ArrayBufferDetachedGetter,
    ArrayBufferMaxByteLengthGetter,
    ArrayBufferResizableGetter,
    /// `ArrayBuffer.prototype.resize` is recognized but returns
    /// `Halt::NotImplemented`; only fixed-size buffers are modeled.
    ArrayBufferResize,
    /// `ArrayBuffer.prototype.transfer` / `transferToFixedLength`.
    ArrayBufferTransfer,
    ArrayBufferTransferToFixedLength,
    /// `ArrayBuffer.prototype.concat` (XS extension) —
    /// recognized-but-unimplemented.
    ArrayBufferConcat,
    /// `ArrayBuffer.isView(arg)` (`fx_ArrayBuffer_isView`): `true` iff the
    /// argument is a TypedArray or DataView view, else `false`.
    ArrayBufferIsView,
    /// An `Atomics.*` operation selected by the numeric payload.
    /// Single-agent read-modify-write operations support integer and BigInt
    /// views using ordinary backing-store byte operations. Wait, notify, and
    /// waitAsync are refused.
    Atomic(u8),
    /// `DataView.prototype.get<Type>(byteOffset[, littleEndian])`
    /// (`fx_DataView_prototype_get`): read an element of the type indexed by
    /// the payload (into [`TYPED_ARRAY_TYPES`]) at the byte offset, honoring
    /// the endianness (default big-endian). One `mxMeterOne` per read.
    DataViewGet(u8),
    /// `DataView.prototype.set<Type>(byteOffset, value[, littleEndian])`
    /// (`fx_DataView_prototype_set`): coerce and write an element of the type
    /// indexed by the payload. One `mxMeterOne` per write.
    DataViewSet(u8),
    /// Reflective DataView prototype accessors: buffer, byteLength, byteOffset.
    DataViewAccessor(u8),
    /// `Promise.prototype.then(onFulfilled, onRejected)`
    /// (`fx_Promise_prototype_then`): register the reaction pair on the
    /// receiver promise and return a fresh derived promise the reaction's
    /// outcome settles. Re-entrant when the promise is already settled (it
    /// queues a job, run at the pump-loop drain).
    PromiseThen,
    /// `Promise.prototype.catch(onRejected)` (`fx_Promise_prototype_catch`):
    /// `then(undefined, onRejected)`.
    PromiseCatch,
    /// `Promise.prototype.finally(onFinally)` registers finally handlers,
    /// awaits the callback result through the selected species constructor,
    /// and restores the original settlement unless the callback throws or rejects.
    PromiseFinally,
    /// The anonymous length-1 `thenFinally` / `catchFinally` closures created
    /// by `Promise.prototype.finally` for an observable custom `then`. Their
    /// hidden home and polarity live in `promise_functions`, alongside the
    /// other runtime-minted, persisted Promise callables.
    PromiseFinallyHandler,
    /// The anonymous length-0 value thunk returned by a callable finally
    /// handler. It restores the original fulfillment value or throws the
    /// original rejection reason after `PromiseResolve(C, onFinally())`.
    PromiseFinallyValue,
    /// `get Promise[@@species]`: the standard accessor returns its receiver.
    PromiseSpeciesGetter,
    /// `%GeneratorPrototype%.next(v)` (`fx_Generator_prototype_next`): resume
    /// the suspended body with `v` as the yield expression's value, running
    /// to the next `yield` or completion; returns `{value, done}`.
    GeneratorNext,
    /// `%GeneratorPrototype%.return(v)` resumes with a return completion
    /// through pending finally handlers.
    GeneratorReturn,
    /// `%GeneratorPrototype%.throw(e)` resumes by throwing `e` at the
    /// suspension point.
    GeneratorThrow,
    AsyncGeneratorNext,
    AsyncGeneratorReturn,
    AsyncGeneratorThrow,
    AsyncIteratorIdentity,
    /// `Promise.resolve(value)` (`fx_Promise_resolve`): a promise resolved
    /// with `value` (returned as-is when already a native promise).
    PromiseResolveStatic,
    /// `Promise.reject(reason)` (`fx_Promise_reject`): a promise rejected
    /// with `reason`.
    PromiseRejectStatic,
    /// `Promise.all(iterable)` (`fx_Promise_all`): live iterator consumption
    /// with ordered aggregate fulfillment and abrupt-completion rejection.
    PromiseAll,
    /// `Promise.race(iterable)` (`fx_Promise_race`): live iterator consumption
    /// and first-settlement forwarding.
    PromiseRace,
    /// `Promise.allSettled(iterable)` (`fx_Promise_allSettled`): live iterator
    /// consumption and ordered settlement records.
    PromiseAllSettled,
    /// `Promise.any(iterable)` (`fx_Promise_any`): live iterator consumption,
    /// first fulfillment, or an ordered `AggregateError`.
    PromiseAny,
    /// A promise's resolve/reject function (XS's `fxResolvePromise`/
    /// `fxRejectPromise` host functions handed to the executor). Recognized
    /// in the `RUN` dispatch by a `promise_functions` side-table lookup, not
    /// bound as a prototype method; this variant is the marker the
    /// `alloc_method` name/length machinery uses.
    PromiseResolveFunction,
    PromiseRejectFunction,
    /// The anonymous length-2 closure `NewPromiseCapability` passes to a
    /// constructor. Its hidden home object captures the first resolve/reject
    /// pair supplied by that constructor.
    PromiseCapabilityExecutor,
    /// `RegExp.prototype.exec(string)` (`fx_RegExp_prototype_exec`): compile-
    /// once, drive the matcher from `lastIndex` (for `g`/`y`), and build the
    /// match-result array (`[whole, ...captures]` + `index`/`input`/`groups`),
    /// updating `lastIndex`. Returns `null` on no match.
    RegExpExec,
    /// `RegExp.prototype.test(string)` (`fx_RegExp_prototype_test`): the same
    /// match drive as `exec`, returning a boolean and updating `lastIndex`.
    RegExpTest,
    /// `RegExp.prototype.toString()` (`fx_RegExp_prototype_toString`): the
    /// `/source/flags` literal string, read through the `source`/`flags`
    /// getters.
    RegExpToString,
    /// `RegExp.prototype.compile(...)` (`fx_RegExp_prototype_compile`): XS's
    /// annexB stub is literally `*mxResult = *mxThis` — no instance check, no
    /// recompilation, arguments ignored — so the mirror returns `this` as-is.
    RegExpCompile,
    /// `%RegExp.prototype%[Symbol.replace](string, replaceValue)`: coerce the
    /// subject and drive the shared RegExp replacement worker.
    RegExpReplace,
    /// `%RegExp.prototype%[Symbol.match](string)`: drive abstract `RegExpExec`
    /// once or collect every global match.
    RegExpMatch,
    /// `%RegExp.prototype%[Symbol.matchAll](string)`: clone through the
    /// observable species constructor and return a lazy RegExp String Iterator.
    RegExpMatchAll,
    /// `%RegExp.prototype%[Symbol.search](string)`: execute from zero and
    /// restore the receiver's observable `lastIndex`.
    RegExpSearch,
    /// `%RegExp.prototype%[Symbol.split](string, limit)`: construct the sticky
    /// species matcher and emit intervening substrings and captures.
    RegExpSplit,
    /// `%RegExpStringIteratorPrototype%.next()`: drive `RegExpExec` lazily,
    /// including global zero-length-match advancement.
    RegExpStringIteratorNext,
    /// `get RegExp[Symbol.species]`: the standard accessor returns its receiver.
    RegExpSpeciesGetter,
    /// `get Error.prototype.stack` (`fx_Error_prototype_get_stack`): for an
    /// error instance, `name[: message]` plus one `\n at <fn> ()` line per
    /// construction-time frame; `undefined` for a non-error object; a
    /// TypeError for a non-object `this`.
    ErrorStackGetter,
    /// `set Error.prototype.stack` (`fx_Error_prototype_set_stack`): defines
    /// an own `{value, writable, enumerable, configurable}` `stack` property
    /// on `this` unconditionally (no string check — `mxDefineID`), with a
    /// TypeError for a non-object `this`, a missing argument, or a refused
    /// define (a frozen receiver, a rejecting proxy trap).
    ErrorStackSetter,
    /// `String.prototype.match(regexp)` (`fx_String_prototype_match`): coerce
    /// the receiver to string, the argument to a RegExp, and dispatch to the
    /// matcher — the non-global path returns `exec`'s result; the global path
    /// collects every whole match.
    StringMatch,
    /// `String.prototype.matchAll(regexp)`: validate global RegExps, honor an
    /// observable `@@matchAll`, or create a global RegExp and invoke it.
    StringMatchAll,
    /// `String.prototype.search(regexp)` (`fx_String_prototype_search`): the
    /// index of the first match, or `-1`.
    StringSearch,
    /// `String.prototype.replace(pattern, replacement)`
    /// (`fx_String_prototype_replace`): string-or-RegExp pattern with a
    /// string replacement carrying the `$`-substitution grammar.
    StringReplace,
    /// `String.prototype.replaceAll(pattern, replacement)`: validates that a
    /// RegExp search is global, then replaces every non-overlapping string
    /// occurrence or delegates through `@@replace`.
    StringReplaceAll,
    /// `String.prototype.split(separator[, limit])`
    /// (`fx_String_prototype_split`): split on a string-or-RegExp separator.
    StringSplit,
    /// `%MapIteratorPrototype%.next()` and `%SetIteratorPrototype%.next()`.
    /// Distinct identities enforce the collection-specific internal-slot
    /// brand check even though both advance the shared `IterState` layout.
    MapIteratorNext,
    SetIteratorNext,
    IteratorFrom,
    /// `%WrapForValidIteratorPrototype%.next()`: call the `next` method
    /// captured by `Iterator.from` with the wrapped iterator as receiver.
    IteratorWrapperNext,
    /// `%WrapForValidIteratorPrototype%.return()`: look up and call the
    /// wrapped iterator's live `return` method, or synthesize a completed
    /// iterator result when it has none.
    IteratorWrapperReturn,
    /// `get Iterator.prototype.constructor`: returns the realm's `%Iterator%`
    /// constructor without inspecting the receiver.
    IteratorConstructorGetter,
    /// `set Iterator.prototype.constructor`: the string-keyed instance of
    /// `SetterThatIgnoresPrototypeProperties`.
    IteratorConstructorSetter,
    /// `get Iterator.prototype[Symbol.toStringTag]`: returns `"Iterator"`
    /// without inspecting the receiver.
    IteratorToStringTagGetter,
    /// `set Iterator.prototype[Symbol.toStringTag]`: the symbol-keyed instance
    /// of `SetterThatIgnoresPrototypeProperties`.
    IteratorToStringTagSetter,
    /// One of the Iterator Helper prototype methods, indexed in the order
    /// installed by `create_intrinsics`.
    IteratorHelper(u8),
}

/// One intrinsic (native) function ironhorse models. The variant is the
/// identity the `run`/`new` dispatch and the completion renderer key off;
/// [`Native::display_name`] is the name XS's `Function.prototype.toString`
/// prints for it (`function ["Object"] (){[native code]}`).
///
/// Builtin constructors and the Error hierarchy use this closed dispatch set.
/// Unsupported call or construct behavior returns [`Halt::NotImplemented`]
/// with the builtin's name.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Native {
    /// The realm's intrinsic `eval` function. Direct calls are dispatched by
    /// `XS_CODE_EVAL`; ordinary/indirect calls reach [`Interp::call_native`].
    Eval,
    Locale,
    Collator,
    ListFormat,
    PluralRules,
    Segmenter,
    DateTimeFormat,
    NumberFormat,
    TemporalInstant,
    TemporalDuration,
    /// PlainDate, PlainTime, PlainDateTime, PlainYearMonth, PlainMonthDay,
    /// and Calendar respectively.
    TemporalPlain(u8),
    /// The `Temporal.ZonedDateTime` constructor (`new` only; a bare call is a
    /// `TypeError`). Instances are branded by the `temporal_zoneds` side table.
    TemporalZonedDateTime,
    Object,
    Function,
    Boolean,
    Symbol,
    BigInt,
    Number,
    String,
    Date,
    Array,
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
    AggregateError,
    SuppressedError,
    DisposableStack,
    AsyncDisposableStack,
    Map,
    Set,
    WeakMap,
    WeakSet,
    /// The abstract `Iterator` constructor and its helper-method prototype.
    Iterator,
    /// `ArrayBuffer` — the raw byte-buffer constructor (`xsDataView.c`
    /// `fx_ArrayBuffer`). Its per-instance backing store lives in the
    /// [`Interp::array_buffers`] side table.
    ArrayBuffer,
    /// `SharedArrayBuffer` — a shared raw byte-buffer constructor
    /// (`xsAtomics.c` `fx_SharedArrayBuffer`). ironhorse is single-agent, so a
    /// SharedArrayBuffer is a plain byte buffer (its backing store lives in the
    /// same [`Interp::array_buffers`] side table, marked in
    /// [`Interp::shared_buffers`]); the "shared" distinction only gates
    /// `Atomics.wait`/`notify` and `ArrayBuffer.isView`-style brand checks.
    SharedArrayBuffer,
    /// The non-global abstract `%TypedArray%` constructor, reachable as the
    /// `[[Prototype]]` of every concrete TypedArray constructor. Direct call
    /// and direct construction both throw a `TypeError`.
    TypedArrayBase,
    /// A concrete TypedArray constructor (`Uint8Array`/`Int32Array`/… —
    /// `xsDataView.c` `fx_TypedArray`). The payload indexes
    /// [`TYPED_ARRAY_TYPES`] (the element type). Its per-instance view state
    /// lives in the [`Interp::typed_arrays`] side table.
    TypedArray(u8),
    /// `DataView` — the endian-aware buffer view constructor (`xsDataView.c`
    /// `fx_DataView`). Its per-instance view state lives in the
    /// [`Interp::data_views`] side table.
    DataView,
    /// `Promise` — the promise constructor (`xsPromise.c` `fx_Promise`). Its
    /// per-instance settlement state lives in the [`Interp::promises`] side
    /// table; the resolve/reject functions it hands the executor are host
    /// functions recorded in [`Interp::promise_functions`].
    Promise,
    /// `RegExp` — the regular-expression constructor (`xsRegExp.c`
    /// `fx_RegExp`). Its per-instance compiled program + source/flags live in
    /// the [`Interp::regexps`] side table; `lastIndex` is an ordinary own
    /// integer property. The matcher itself is the `ironhorse-regexp` crate.
    RegExp,
    /// `Proxy` — the proxy constructor (`xsProxy.c` `fx_Proxy`). A special
    /// constructor: it has **no** `.prototype` property and its instances have
    /// no identity prototype. Constructing it validates the target/handler are
    /// objects and records a [`ProxyData`] in the [`Interp::proxies`] side
    /// table; the exotic behavior is the trap dispatch keyed off that table.
    Proxy,
    /// `%GeneratorFunction%` — the (non-global) dynamic **generator** function
    /// constructor, reachable as `(function*(){}).constructor`. Call and
    /// construct both run CreateDynamicFunction with the `function*` grammar
    /// through the runtime source bridge ([`Interp::create_dynamic_function`]).
    GeneratorFunction,
    /// `%AsyncFunction%` — the (non-global) dynamic **async** function
    /// constructor, reachable as `(async function(){}).constructor`.
    AsyncFunction,
    /// `%AsyncGeneratorFunction%` — the (non-global) dynamic **async
    /// generator** function constructor, reachable as
    /// `(async function*(){}).constructor`.
    AsyncGeneratorFunction,
}

impl Native {
    /// The name XS prints for this built-in (its `name` property, shown by
    /// `Function.prototype.toString` and by the completion renderer).
    pub fn display_name(self) -> &'static str {
        match self {
            Native::Eval => "eval",
            Native::Locale => "Locale",
            Native::Collator => "Collator",
            Native::ListFormat => "ListFormat",
            Native::PluralRules => "PluralRules",
            Native::Segmenter => "Segmenter",
            Native::DateTimeFormat => "DateTimeFormat",
            Native::NumberFormat => "NumberFormat",
            Native::TemporalInstant => "Instant",
            Native::TemporalDuration => "Duration",
            Native::TemporalPlain(i) => TEMPORAL_PLAIN_NAMES[i as usize],
            Native::TemporalZonedDateTime => "ZonedDateTime",
            Native::Object => "Object",
            Native::Function => "Function",
            Native::Boolean => "Boolean",
            Native::Symbol => "Symbol",
            Native::BigInt => "BigInt",
            Native::Number => "Number",
            Native::String => "String",
            Native::Date => "Date",
            Native::Array => "Array",
            Native::Error => "Error",
            Native::EvalError => "EvalError",
            Native::RangeError => "RangeError",
            Native::ReferenceError => "ReferenceError",
            Native::SyntaxError => "SyntaxError",
            Native::TypeError => "TypeError",
            Native::URIError => "URIError",
            Native::AggregateError => "AggregateError",
            Native::SuppressedError => "SuppressedError",
            Native::DisposableStack => "DisposableStack",
            Native::AsyncDisposableStack => "AsyncDisposableStack",
            Native::Map => "Map",
            Native::Set => "Set",
            Native::WeakMap => "WeakMap",
            Native::WeakSet => "WeakSet",
            Native::Iterator => "Iterator",
            Native::ArrayBuffer => "ArrayBuffer",
            Native::SharedArrayBuffer => "SharedArrayBuffer",
            Native::TypedArrayBase => "TypedArray",
            Native::TypedArray(i) => TYPED_ARRAY_TYPES[i as usize].name,
            Native::DataView => "DataView",
            Native::Promise => "Promise",
            Native::RegExp => "RegExp",
            Native::Proxy => "Proxy",
            Native::GeneratorFunction => "GeneratorFunction",
            Native::AsyncFunction => "AsyncFunction",
            Native::AsyncGeneratorFunction => "AsyncGeneratorFunction",
        }
    }

    /// ECMAScript `length` of the intrinsic constructor.
    pub(super) fn arity(self) -> u32 {
        match self {
            Native::Eval => 1,
            Native::Locale => 1,
            Native::Collator => 0,
            Native::ListFormat => 0,
            Native::PluralRules => 0,
            Native::Segmenter => 0,
            Native::DateTimeFormat => 0,
            Native::NumberFormat => 0,
            Native::TemporalInstant => 1,
            Native::TemporalDuration => 0,
            Native::TemporalPlain(i) => [3, 0, 3, 2, 2, 1][i as usize],
            Native::TemporalZonedDateTime => 2,
            Native::AggregateError => 2,
            Native::SuppressedError => 3,
            Native::DisposableStack | Native::AsyncDisposableStack => 0,
            Native::RegExp => 2,
            Native::Proxy => 2,
            // `%GeneratorFunction%`/`%AsyncFunction%`/`%AsyncGeneratorFunction%`
            // each have `length` 1 (their sole formal is `...args`).
            Native::GeneratorFunction | Native::AsyncFunction | Native::AsyncGeneratorFunction => 1,
            Native::TypedArray(_) => 3,
            Native::DataView => 1,
            Native::Date => 7,
            Native::Symbol
            | Native::Map
            | Native::Set
            | Native::WeakMap
            | Native::WeakSet
            | Native::Iterator
            | Native::TypedArrayBase => 0,
            Native::Object
            | Native::Function
            | Native::Boolean
            | Native::BigInt
            | Native::Number
            | Native::String
            | Native::Array
            | Native::Error
            | Native::EvalError
            | Native::RangeError
            | Native::ReferenceError
            | Native::SyntaxError
            | Native::TypeError
            | Native::URIError
            | Native::ArrayBuffer
            | Native::SharedArrayBuffer
            | Native::Promise => 1,
        }
    }

    /// The intrinsic global constructors ironhorse binds, in `(name, variant)`
    /// pairs. The name is what the XS compiler records in the symbols
    /// atom; [`Interp::link_intrinsics`] binds each to the program-local id
    /// the compiler assigned it.
    pub fn intrinsics() -> Vec<(&'static str, Native)> {
        let mut v = vec![
            ("Object", Native::Object),
            ("Function", Native::Function),
            ("Boolean", Native::Boolean),
            ("Symbol", Native::Symbol),
            ("BigInt", Native::BigInt),
            ("Number", Native::Number),
            ("String", Native::String),
            ("Date", Native::Date),
            ("Array", Native::Array),
            ("Error", Native::Error),
            ("EvalError", Native::EvalError),
            ("RangeError", Native::RangeError),
            ("ReferenceError", Native::ReferenceError),
            ("SyntaxError", Native::SyntaxError),
            ("TypeError", Native::TypeError),
            ("URIError", Native::URIError),
            ("AggregateError", Native::AggregateError),
            ("SuppressedError", Native::SuppressedError),
            ("DisposableStack", Native::DisposableStack),
            ("AsyncDisposableStack", Native::AsyncDisposableStack),
            ("Map", Native::Map),
            ("Set", Native::Set),
            ("WeakMap", Native::WeakMap),
            ("WeakSet", Native::WeakSet),
            ("Iterator", Native::Iterator),
            ("ArrayBuffer", Native::ArrayBuffer),
            ("SharedArrayBuffer", Native::SharedArrayBuffer),
        ];
        // The concrete TypedArray constructors (`Uint8Array`/…), each a
        // `fx_TypedArray` callback distinguished by its element type index.
        for (i, t) in TYPED_ARRAY_TYPES.iter().enumerate() {
            v.push((t.name, Native::TypedArray(i as u8)));
        }
        v.push(("DataView", Native::DataView));
        v.push(("Promise", Native::Promise));
        v.push(("RegExp", Native::RegExp));
        v
    }
}
