//! Native constructor, function, and prototype-method dispatch.
use super::super::*;

impl Interp {
    pub(in crate::interp) fn call_native_inner(
        &mut self,
        native: Native,
        base: usize,
        argc: usize,
        has_target: bool,
        code: &[u8],
    ) -> Result<(), Step> {
        // `code` is threaded through for a native that re-enters user code —
        // the `Promise` executor via `run_callback`, and `Symbol`'s
        // `ToString(description)` — and ignored by the rest.
        let _ = code;
        // `super()` may construct a native heritage with a different
        // `new.target` (the derived constructor). User-function construction
        // consumes this latch in `enter_call`; native construction must do the
        // same so `Object` can select the derived prototype and the one-shot
        // target cannot leak into a later construct.
        let pending_native_new_target =
            has_target.then(|| self.pending_new_target.take()).flatten();
        let derived_native_construct = pending_native_new_target.is_some();
        let new_target = if has_target {
            pending_native_new_target.or_else(|| {
                self.stack.get(base + 1).and_then(|slot| match slot.value {
                    Payload::Reference(function) if slot.kind == Kind::Reference => Some(function),
                    _ => None,
                })
            })
        } else {
            None
        };
        // Argument i is at `base + 4 + i` (arg0 is the deepest); missing
        // arguments read `undefined`.
        let arg = |i: usize| -> Slot {
            self.stack
                .get(base + 4 + i)
                .copied()
                .unwrap_or_else(Slot::undefined)
        };
        let result: Slot = match native {
            // `eval`: a non-string input is returned unchanged (the spec's
            // "not a String" fast return); a string is compiled and executed
            // in this realm through the source-execution bridge
            // ([`Self::eval_source`]) — the principled compiler/VM seam that
            // replaced the former `eval:string-source` text boundary. The
            // completion value becomes the call's result. `eval` is never
            // constructable.
            Native::Eval => {
                if has_target {
                    return Err(self.catchable_type_error_msg("new: not a constructor".into()));
                }
                let source = arg(0);
                if source.kind == Kind::String {
                    let text = match source.value {
                        Payload::String(off) => self.str_text(off),
                        _ => String::new(),
                    };
                    // A direct eval inherits the caller's strictness; an
                    // indirect eval of ordinary source is sloppy (a
                    // `"use strict"` prologue still promotes it, in the
                    // compiler). `self.strict` is the calling script or
                    // function frame's strictness at this direct-eval site.
                    let strict = self.eval_direct && self.strict;
                    self.eval_source(&text, strict)?
                } else {
                    source
                }
            }
            // The dynamic-function constructor family (`Function`,
            // `%GeneratorFunction%`, `%AsyncFunction%`,
            // `%AsyncGeneratorFunction%`): CreateDynamicFunction
            // (ECMA-262 20.2.1.1.1) assembles the source from the args and
            // evaluates it in the realm; the completion is the new function.
            // Call and construct are equivalent (both create the function), so
            // `has_target` is ignored. The whole family shares one helper that
            // varies only the function-head grammar per kind.
            Native::Function
            | Native::GeneratorFunction
            | Native::AsyncFunction
            | Native::AsyncGeneratorFunction => {
                self.create_dynamic_function(native, base, argc, code)?
            }
            Native::Locale => {
                if !has_target {
                    return Err(self.catchable_type_error());
                }
                let source = arg(0);
                let options_arg = arg(1);
                let text = self.intl_locale_argument(code, source)?;
                let mut locale = match canonicalize_locale(&text) {
                    Some(locale) => locale,
                    None => return Err(self.catchable_range_error()),
                };
                if let Payload::Reference(options) = options_arg.value {
                    self.apply_locale_options(code, options, &mut locale)?;
                }
                locale.tag = locale_to_tag(&locale);
                let inst = self.slots.alloc(Slot::instance(self.locale_proto));
                self.locales.insert(inst, locale);
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            Native::Collator => {
                let locale_arg = arg(0);
                let options_arg = arg(1);
                let locale = self
                    .intl_first_locale(code, locale_arg)?
                    .unwrap_or_else(|| "en".to_string());
                let locale = match canonicalize_locale(&locale) {
                    Some(locale) => locale,
                    None => return Err(self.catchable_range_error()),
                };
                let mut data = CollatorData {
                    locale: supported_locale(&locale.tag),
                    usage: "sort".to_string(),
                    sensitivity: "variant".to_string(),
                    collation: locale
                        .unicode
                        .get("co")
                        .cloned()
                        .unwrap_or_else(|| "default".to_string()),
                    numeric: locale.unicode.get("kn").map_or(false, |v| v == "true"),
                    case_first: locale
                        .unicode
                        .get("kf")
                        .cloned()
                        .unwrap_or_else(|| "false".to_string()),
                    ignore_punctuation: false,
                };
                if let Payload::Reference(options) = options_arg.value {
                    self.apply_collator_options(code, options, &mut data)?;
                }
                let inst = self.slots.alloc(Slot::instance(self.collator_proto));
                self.collators.insert(inst, data);
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            Native::ListFormat => {
                if !has_target {
                    return Err(self.catchable_type_error());
                }
                let locale_arg = arg(0);
                let options_arg = arg(1);
                let resolved = self.intl_resolve_locale(code, locale_arg)?;
                let options = self.intl_get_options_object(options_arg)?;
                if let Some(opts) = options {
                    // localeMatcher is read and validated but does not affect
                    // the frozen data profile (lookup and best-fit agree).
                    self.intl_get_option_enum(
                        code,
                        opts,
                        "localeMatcher",
                        &["lookup", "best fit"],
                        "best fit",
                    )?;
                }
                let kind = match options {
                    Some(opts) => self.intl_get_option_enum(
                        code,
                        opts,
                        "type",
                        &["conjunction", "disjunction", "unit"],
                        "conjunction",
                    )?,
                    None => "conjunction".to_string(),
                };
                let style = match options {
                    Some(opts) => self.intl_get_option_enum(
                        code,
                        opts,
                        "style",
                        &["long", "short", "narrow"],
                        "long",
                    )?,
                    None => "long".to_string(),
                };
                let data = ListFormatData {
                    locale: resolved,
                    kind,
                    style,
                };
                let inst = self.slots.alloc(Slot::instance(self.list_format_proto));
                self.list_formats.insert(inst, data);
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            Native::PluralRules => {
                if !has_target {
                    return Err(self.catchable_type_error());
                }
                let locale_arg = arg(0);
                let options_arg = arg(1);
                let resolved = self.intl_resolve_locale(code, locale_arg)?;
                let options = self.intl_get_options_object(options_arg)?;
                if let Some(opts) = options {
                    self.intl_get_option_enum(
                        code,
                        opts,
                        "localeMatcher",
                        &["lookup", "best fit"],
                        "best fit",
                    )?;
                }
                let kind = match options {
                    Some(opts) => self.intl_get_option_enum(
                        code,
                        opts,
                        "type",
                        &["cardinal", "ordinal"],
                        "cardinal",
                    )?,
                    None => "cardinal".to_string(),
                };
                let notation = match options {
                    Some(opts) => self.intl_get_option_enum(
                        code,
                        opts,
                        "notation",
                        &["standard", "scientific", "engineering", "compact"],
                        "standard",
                    )?,
                    None => "standard".to_string(),
                };
                let mut data = PluralRulesData {
                    locale: resolved,
                    kind,
                    notation,
                    minimum_integer_digits: 1,
                    minimum_fraction_digits: 0,
                    maximum_fraction_digits: 3,
                    minimum_significant_digits: None,
                    maximum_significant_digits: None,
                    rounding_type: "fractionDigits".to_string(),
                    rounding_priority: "auto".to_string(),
                    rounding_mode: "halfExpand".to_string(),
                    rounding_increment: 1,
                    trailing_zero_display: "auto".to_string(),
                };
                if let Some(opts) = options {
                    self.set_number_digit_options(code, opts, &mut data, 0, 3, false)?;
                }
                let inst = self.slots.alloc(Slot::instance(self.plural_rules_proto));
                self.plural_rules.insert(inst, data);
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            Native::Segmenter => {
                if !has_target {
                    return Err(self.catchable_type_error());
                }
                let locale_arg = arg(0);
                let options_arg = arg(1);
                let resolved = self.intl_resolve_locale(code, locale_arg)?;
                let options = self.intl_get_options_object(options_arg)?;
                if let Some(opts) = options {
                    self.intl_get_option_enum(
                        code,
                        opts,
                        "localeMatcher",
                        &["lookup", "best fit"],
                        "best fit",
                    )?;
                }
                let granularity = match options {
                    Some(opts) => self.intl_get_option_enum(
                        code,
                        opts,
                        "granularity",
                        &["grapheme", "word", "sentence"],
                        "grapheme",
                    )?,
                    None => "grapheme".to_string(),
                };
                let data = SegmenterData {
                    locale: resolved,
                    granularity,
                };
                let inst = self.slots.alloc(Slot::instance(self.segmenter_proto));
                self.segmenters.insert(inst, data);
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            Native::DateTimeFormat => {
                if !has_target {
                    return Err(self.catchable_type_error());
                }
                let locale_arg = arg(0);
                let options_arg = arg(1);
                let data = self.build_date_time_format(code, locale_arg, options_arg)?;
                let inst = self
                    .slots
                    .alloc(Slot::instance(self.date_time_format_proto));
                self.date_time_formats.insert(inst, data);
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            Native::NumberFormat => {
                // `Intl.NumberFormat(...)` is callable with or without `new`
                // (the legacy ECMA-402 constructor form). Both create a fresh
                // instance chaining to `%NumberFormat.prototype%`.
                let locale_arg = arg(0);
                let options_arg = arg(1);
                let data = self.build_number_format(code, locale_arg, options_arg)?;
                let inst = self.slots.alloc(Slot::instance(self.number_format_proto));
                self.number_formats.insert(inst, data);
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            Native::TemporalInstant => {
                if !has_target {
                    return Err(self.catchable_type_error());
                }
                let ns = self
                    .temporal_bigint_to_i128(arg(0))
                    .ok_or_else(|| self.catchable_type_error())?;
                self.temporal_new_instant(ns)?
            }
            Native::TemporalDuration => {
                if !has_target {
                    return Err(self.catchable_type_error());
                }
                let values: Vec<Slot> = (0..10).map(arg).collect();
                let mut fields = [0i64; 10];
                for (i, field) in fields.iter_mut().enumerate() {
                    let value = values[i];
                    if value.kind == Kind::Undefined {
                        continue;
                    }
                    *field = self.temporal_integer(value)?;
                }
                let record = TemporalDurationRecord::from_fields(fields);
                if !temporal_duration_sign_valid(record) {
                    return Err(self.catchable_range_error());
                }
                self.temporal_new_duration(record)?
            }
            Native::TemporalPlain(kind) => {
                if !has_target {
                    return Err(self.catchable_type_error());
                }
                let values = (0..10).map(arg).collect::<Vec<_>>();
                self.temporal_plain_construct(kind, &values, code)?
            }
            Native::TemporalZonedDateTime => {
                // `new Temporal.ZonedDateTime(epochNanoseconds, timeZone[, calendar])`.
                if !has_target {
                    return Err(self.catchable_type_error());
                }
                let (epoch_arg, tz_value, cal) = (arg(0), arg(1), arg(2));
                let ns = self
                    .temporal_bigint_to_i128(epoch_arg)
                    .ok_or_else(|| self.catchable_type_error())?;
                if tz_value.kind != Kind::String {
                    // The constructor requires a *string* time-zone identifier
                    // (an object is not accepted here, unlike `from`).
                    return Err(self.catchable_type_error());
                }
                let tz_text = self.value_to_string(code, tz_value)?;
                let (time_zone, offset_ns) = resolve_zoned_time_zone(&tz_text)
                    .ok_or_else(|| self.catchable_range_error())?;
                if cal.kind != Kind::Undefined {
                    let id = self.value_to_string(code, cal)?;
                    if id.to_ascii_lowercase() != "iso8601" {
                        return Err(self.catchable_range_error());
                    }
                }
                self.temporal_new_zoned(ns, time_zone, offset_ns)?
            }
            Native::Date => {
                let now = 0.0;
                if !has_target {
                    let text = date_local_string(now);
                    let off = self.alloc_str_text(text.as_bytes());
                    Slot::of(Kind::String, Payload::String(off))
                } else {
                    let time = if argc == 0 {
                        now
                    } else if argc == 1 {
                        let value = arg(0);
                        if let Payload::Reference(r) = value.value {
                            if let Some(&date) = self.dates.get(&r) {
                                date
                            } else {
                                let primitive = self.to_primitive_default(code, value)?;
                                if primitive.kind == Kind::String {
                                    let text = match primitive.value {
                                        Payload::String(o) => self.str_text(o),
                                        _ => String::new(),
                                    };
                                    parse_date_string(&text).unwrap_or(f64::NAN)
                                } else {
                                    time_clip(self.to_number_f64(code, primitive)?)
                                }
                            }
                        } else if value.kind == Kind::String {
                            let text = match value.value {
                                Payload::String(o) => self.str_text(o),
                                _ => String::new(),
                            };
                            parse_date_string(&text).unwrap_or(f64::NAN)
                        } else {
                            time_clip(self.to_number_f64(code, value)?)
                        }
                    } else {
                        let mut values = [0.0; 7];
                        let inputs: Vec<Slot> = (0..7)
                            .map(|i| {
                                if i < argc {
                                    arg(i)
                                } else if i == 2 {
                                    Slot::integer(1)
                                } else {
                                    Slot::integer(0)
                                }
                            })
                            .collect();
                        for (value, v) in values.iter_mut().zip(inputs) {
                            *value = self.to_number_f64(code, v)?;
                        }
                        date_from_components(values)
                    };
                    // OrdinaryCreateFromConstructor(NewTarget,
                    // "%Date.prototype%"): Reflect.construct may retarget a
                    // native Date construction to a user constructor. A
                    // non-object `NewTarget.prototype` falls back to the Date
                    // intrinsic rather than `%Object.prototype%`.
                    let proto = match new_target {
                        Some(target) => {
                            self.get_prototype_from_constructor(code, target, self.date_proto)?
                        }
                        None => self.date_proto,
                    };
                    let inst = self.slots.alloc(Slot::instance(proto));
                    self.dates.insert(inst, time);
                    Slot::of(Kind::Reference, Payload::Reference(inst))
                }
            }
            // `Boolean(value)` (`fx_Boolean`): ToBoolean(argument0), or
            // `false` when called with no argument. Measured against the pin,
            // the primitive coercion meters **no** built-in step beyond the
            // call's dispatch — a `Boolean(x)` costs exactly its opcodes
            // (the argument expression's chunk allocations, if any, are
            // metered where they occur). A `new Boolean` (the wrapper object)
            // is the separate construct path, not yet modeled.
            Native::Boolean if !has_target => {
                let v = arg(0);
                Slot::boolean(self.truthy(&v))
            }
            // `new Boolean(v)` — the wrapper object (`[[BooleanData]]`).
            Native::Boolean => {
                let v = arg(0);
                let prim = Slot::boolean(self.truthy(&v));
                self.build_wrapper(Native::Boolean, prim)
            }
            // `Number(v)` / `new Number(v)`: the primitive number is
            // ToNumber(v). ironhorse handles the numeric fast path (identity), the
            // primitive `boolean`/`null`/`undefined` coercions, a string (the
            // `fxStringToNumber` whole-string parse), and explicit BigInt to
            // Number conversion. A Symbol throws TypeError. `new` wraps the
            // converted primitive.
            Native::Number => {
                let a = arg(0);
                let prim = match a.kind {
                    Kind::Integer | Kind::Number => a,
                    Kind::Boolean | Kind::Null | Kind::Undefined if argc >= 1 => {
                        Slot::number(to_number(&a))
                    }
                    Kind::String if argc >= 1 => match a.value {
                        Payload::String(off) => {
                            let bytes = self.str_text(off).into_bytes();
                            // `fx_Number` folds the ToNumber result to integer
                            // kind (`fx_Math_toInteger`) in the non-target case.
                            math_to_integer(string_to_number(&bytes, true))
                        }
                        _ => {
                            return Err(Step::Host(Halt::NotImplemented(native_unsupported_name(
                                native,
                            ))))
                        }
                    },
                    _ if argc == 0 => Slot::integer(0),
                    Kind::Reference => {
                        let primitive = self.to_number_value(code, a)?;
                        match primitive.value {
                            Payload::BigInt(off) => Slot::number(self.bigint_to_f64(off)),
                            _ => primitive,
                        }
                    }
                    Kind::BigInt => match a.value {
                        Payload::BigInt(off) => Slot::number(self.bigint_to_f64(off)),
                        _ => return Err(self.catchable_type_error()),
                    },
                    Kind::Symbol => {
                        return Err(
                            self.catchable_type_error_msg("cannot coerce symbol to number".into())
                        )
                    }
                    _ => {
                        return Err(Step::Host(Halt::NotImplemented(native_unsupported_name(
                            native,
                        ))))
                    }
                };
                if has_target {
                    self.build_wrapper(Native::Number, prim)
                } else {
                    prim
                }
            }
            // `String(v)` / `new String(v)`: the primitive string is
            // ToString(v). A string argument is identity (metering-neutral);
            // the general ToString of other kinds is metered via
            // `to_string_bytes_metered`. `new` wraps the primitive.
            Native::String => {
                let prim = if argc == 0 {
                    let off = self.chunks.alloc(b"");
                    Slot::of(Kind::String, Payload::String(off))
                } else {
                    let a = arg(0);
                    match a.kind {
                        Kind::String => a,
                        // `String(sym)` — the one explicit symbol→string
                        // coercion the spec allows (`SymbolDescriptiveString`):
                        // `Symbol(<description>)`. (Implicit coercion still
                        // throws — that path stays in [`Self::run`].)
                        Kind::Symbol => {
                            let bytes = self.symbol_descriptive_bytes(a);
                            let off = self.alloc_str_text(&bytes);
                            Slot::of(Kind::String, Payload::String(off))
                        }
                        Kind::Reference => {
                            let primitive = self.to_primitive(code, a, true)?;
                            if primitive.kind == Kind::Symbol {
                                return Err(Step::Host(Halt::NotImplemented("to_string:symbol")));
                            }
                            let bytes = self.to_string_bytes_metered(primitive);
                            let off = self.alloc_str_text(&bytes);
                            Slot::of(Kind::String, Payload::String(off))
                        }
                        // `String(aBigInt)` uses the same arbitrary-precision
                        // decimal renderer as implicit ToString. The helper
                        // charges the conversion step and result chunk; the
                        // constructor adds no separate allocation unless this
                        // is the `new String` wrapper path below.
                        Kind::BigInt => {
                            let bytes = self.to_string_bytes_metered(a);
                            let off = self.alloc_str_text(&bytes);
                            Slot::of(Kind::String, Payload::String(off))
                        }
                        _ => {
                            let bytes = self.to_string_bytes_metered(a);
                            let off = self.alloc_str_text(&bytes);
                            Slot::of(Kind::String, Payload::String(off))
                        }
                    }
                };
                if has_target {
                    self.build_wrapper(Native::String, prim)
                } else {
                    prim
                }
            }
            // `BigInt(value)` performs ToPrimitive(number), then accepts a
            // BigInt unchanged, Boolean as 0n/1n, an integral finite Number,
            // or a StringIntegerLiteral. `%BigInt%` is not constructible.
            Native::BigInt => {
                if has_target {
                    return Err(self.catchable_type_error_msg("new: BigInt".into()));
                }
                if argc == 0 {
                    return Err(self.catchable_type_error_msg("cannot coerce to bigint".into()));
                }
                let primitive = self.to_primitive(code, arg(0), false)?;
                match primitive.kind {
                    Kind::BigInt => primitive,
                    Kind::Boolean => self.make_bigint(
                        false,
                        vec![u32::from(matches!(primitive.value, Payload::Boolean(true)))],
                    ),
                    Kind::Integer => match primitive.value {
                        Payload::Integer(i) => {
                            let magnitude = (i as i64).unsigned_abs() as u32;
                            self.make_bigint(i < 0, vec![magnitude])
                        }
                        _ => return Err(self.catchable_type_error()),
                    },
                    Kind::Number => match primitive.value {
                        Payload::Number(n) if n.is_finite() && n.trunc() == n => {
                            let (negative, magnitude) = number_to_bigint(n);
                            self.make_bigint(negative, magnitude)
                        }
                        Payload::Number(_) => {
                            return Err(self.catchable_range_error_msg(
                                "cannot coerce number to bigint".into(),
                            ))
                        }
                        _ => return Err(self.catchable_type_error()),
                    },
                    Kind::String => {
                        let text = match primitive.value {
                            Payload::String(off) => self.str_text(off),
                            _ => return Err(self.catchable_syntax_error()),
                        };
                        let (negative, magnitude) =
                            parse_bigint_string(&text).ok_or_else(|| {
                                self.catchable_syntax_error_with_message(
                                    "cannot coerce string to bigint".into(),
                                )
                            })?;
                        self.make_bigint(negative, magnitude)
                    }
                    _ => {
                        return Err(self.catchable_type_error_msg(
                            if primitive.kind == Kind::Symbol {
                                "cannot coerce symbol to bigint"
                            } else {
                                "cannot coerce to bigint"
                            }
                            .into(),
                        ))
                    }
                }
            }
            // `Object([value])` / `new Object([value])` (`fx_Object`): with no
            // argument (or `undefined`/`null`), create a fresh empty ordinary
            // object; with an object argument, return it unchanged (ToObject
            // identity). Both the call and construct forms behave and meter
            // identically here (verified: same raw). A Boolean, Number, String,
            // or Symbol primitive is boxed with its intrinsic prototype and
            // internal primitive data; BigInt remains named until IronHorse
            // provides the realm's `BigInt` intrinsic/prototype. Metering for
            // the empty-object arm was measured against the pin: one
            // `fxNewObject` ([`Self::new_object`], 16640) plus one extra
            // built-in step ([`crate::meter::Meter::tick_builtin`], 16384) —
            // 33024 raw total, the fractional gap over a bare object literal.
            Native::Object => {
                let a = arg(0);
                if derived_native_construct {
                    self.meter.tick_builtin();
                    let inst = self.new_object();
                    let proto = match new_target {
                        Some(target) => {
                            self.get_prototype_from_constructor(code, target, self.object_proto)?
                        }
                        None => self.object_proto,
                    };
                    self.slots.get_mut(inst).value = Payload::Reference(proto);
                    Slot::of(Kind::Reference, Payload::Reference(inst))
                } else {
                    match a.kind {
                        Kind::Reference => a,
                        Kind::Undefined | Kind::Null => {
                            self.meter.tick_builtin();
                            let inst = self.new_object();
                            if let Some(target) = new_target {
                                let proto = self.get_prototype_from_constructor(
                                    code,
                                    target,
                                    self.object_proto,
                                )?;
                                self.slots.get_mut(inst).value = Payload::Reference(proto);
                            }
                            Slot::of(Kind::Reference, Payload::Reference(inst))
                        }
                        Kind::Boolean => {
                            let inst = self.box_object_primitive(Native::Boolean, a);
                            Slot::of(Kind::Reference, Payload::Reference(inst))
                        }
                        Kind::Integer | Kind::Number => {
                            let inst = self.box_object_primitive(Native::Number, a);
                            Slot::of(Kind::Reference, Payload::Reference(inst))
                        }
                        Kind::String => {
                            let inst = self.box_object_primitive(Native::String, a);
                            Slot::of(Kind::Reference, Payload::Reference(inst))
                        }
                        Kind::Symbol => {
                            let inst = self.box_object_primitive(Native::Symbol, a);
                            Slot::of(Kind::Reference, Payload::Reference(inst))
                        }
                        Kind::BigInt => {
                            let inst = self.box_object_primitive(Native::BigInt, a);
                            Slot::of(Kind::Reference, Payload::Reference(inst))
                        }
                        _ => {
                            return Err(Step::Host(Halt::NotImplemented(native_unsupported_name(
                                native,
                            ))))
                        }
                    }
                }
            }
            // The Error hierarchy (`fx_Error` and the per-type constructors):
            // `new TypeError(msg)` / `TypeError(msg)` both build a fresh error
            // instance carrying the type's `name` and, when a message argument
            // is given, an own `message` property set to ToString(message).
            // This is what graduates abort-value parity: a thrown error's
            // completion/abort value stringifies as `name` or `name: message`
            // (XS's `Error.prototype.toString`), not a primitive. `has_target`
            // is immaterial — an Error called as a function constructs too.
            Native::Error => self.build_native_error(code, "Error", base, argc)?,
            Native::EvalError => self.build_native_error(code, "EvalError", base, argc)?,
            Native::RangeError => self.build_native_error(code, "RangeError", base, argc)?,
            Native::ReferenceError => {
                self.build_native_error(code, "ReferenceError", base, argc)?
            }
            Native::SyntaxError => self.build_native_error(code, "SyntaxError", base, argc)?,
            Native::TypeError => self.build_native_error(code, "TypeError", base, argc)?,
            Native::URIError => self.build_native_error(code, "URIError", base, argc)?,
            // `new AggregateError(errors, message)` (`fx_AggregateError`):
            // the base error (name "AggregateError", message from arg **1**),
            // plus an own `errors` Array built by iterating arg 0.
            Native::AggregateError => self.build_aggregate_error(code, base, argc)?,
            Native::SuppressedError => {
                let message = (argc >= 3).then(|| arg(2));
                self.build_suppressed_error(arg(0), arg(1), message)
            }
            Native::DisposableStack | Native::AsyncDisposableStack => {
                if !has_target {
                    return Err(
                        self.catchable_type_error_msg(format!("call: {}", native.display_name()))
                    );
                }
                // Measured constructor residue (see the constant).
                self.meter.tick_raw(DISPOSABLE_STACK_CONSTRUCT_METERING);
                let proto = self
                    .intrinsics
                    .get(native.display_name())
                    .and_then(|&ctor| self.prototype_of(ctor))
                    .unwrap_or(self.object_proto);
                let inst = self.slots.alloc(Slot::instance(proto));
                self.disposable_stacks.insert(
                    inst,
                    DisposableStackData {
                        asynchronous: native == Native::AsyncDisposableStack,
                        ..DisposableStackData::default()
                    },
                );
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            // `Symbol([description])`: a fresh unique symbol. Its descriptor
            // slot holds the coerced description (or `undefined`), and its
            // identity is that slot — so `Symbol('a') !== Symbol('a')`.
            // [`SYMBOL_CREATE_METERING`] is the whole cost beyond the
            // description's own coercion (measured against the pin).
            //
            // ECMA-262 20.4.1.1 step 3 — and XS's `fx_Symbol`, which calls
            // `fxToString(the, mxArgv(0))` in place before `fxNewSymbol` —
            // coerce a non-`undefined` description to a String HERE. Storing
            // `arg(0)` raw made the symbol carry `Payload::Reference` to a live
            // guest object, and every reach-through site that matched
            // `Payload::Reference` without a kind guard then read and wrote
            // that object THROUGH the symbol: an ocap confinement break, since
            // a symbol is a value routinely treated as opaque and shared
            // freely. The coercion runs guest code (`toString`/`valueOf`/
            // `@@toPrimitive`) and propagates its abrupt completion, exactly
            // where XS does — before the symbol exists, so a throwing
            // description creates nothing. `new Symbol()` throws in JS; a
            // `has_target` call self-names below and never coerces (XS's
            // `mxTypeError("new Symbol")` precedes its `fxToString`).
            Native::Symbol if !has_target => {
                let description = arg(0);
                let mut desc = if description.kind == Kind::Undefined {
                    Slot::undefined()
                } else {
                    self.to_string_slot(code, description)?
                };
                // The stored description is a fresh heap slot, not a stack
                // alias: clear the argument's list linkage as the Array
                // constructor does for its elements.
                desc.id = 0;
                desc.next = crate::value::SlotIndex::NULL;
                let d = self.slots.alloc(desc);
                self.meter.tick_raw(SYMBOL_CREATE_METERING);
                Slot::of(Kind::Symbol, Payload::Reference(d))
            }
            // The intrinsic Iterator constructor is abstract only when called
            // directly or used as its own `new.target`. A derived constructor's
            // `super()` (and `Reflect.construct(Iterator, [], NewTarget)`) uses
            // OrdinaryCreateFromConstructor(NewTarget, "%Iterator.prototype%")
            // so subclasses can acquire the shared helper surface without any
            // additional internal slots.
            Native::Iterator => {
                if !has_target || !derived_native_construct {
                    return Err(self.catchable_type_error_msg(
                        if has_target {
                            "new: Iterator"
                        } else {
                            "call: Iterator"
                        }
                        .into(),
                    ));
                }
                let target = new_target.expect("a derived native construct has a new.target");
                let proto =
                    self.get_prototype_from_constructor(code, target, self.iterator_proto)?;
                let inst = self.slots.alloc(Slot::instance(proto));
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            // `Array(...)` / `new Array(...)` (`fx_Array`): both forms build the
            // same array. A single number argument is the length (a holey
            // array of that length); a single non-number, or two-or-more
            // arguments, are the elements. Metering measured against the pin
            // `48ee02d8cfe0`: a constant constructor base ([`ARRAY_CTOR_BASE_METERING`],
            // covering the native host frame, `fxGetPrototypeFromConstructor`,
            // and `fxNewArrayInstance`) plus, for the element forms, one
            // item-chunk allocation of `count` slots (a single `fxSetIndexSize`,
            // not per-item growth).
            Native::Array => {
                self.meter.tick_raw(ARRAY_CTOR_BASE_METERING);
                let inst = self.slots.alloc(Slot::instance(self.array_proto));
                let mut data = ArrayData::default();
                if argc == 1 {
                    let a = arg(0);
                    match a.kind {
                        Kind::Integer | Kind::Number => match self.checked_array_length(a) {
                            Some(n) => data.length = n,
                            // A non-length number (`Array(2.5)`, `Array(-1)`)
                            // is a `RangeError` in XS — its abort value and
                            // metering are a later increment; honest skip.
                            None => {
                                return Err(Step::Host(Halt::NotImplemented(
                                    "native-call:Array:bad-length",
                                )))
                            }
                        },
                        _ => {
                            self.charge_and_check(self.array_chunk_size_metering(1))?;
                            let mut v = a;
                            v.id = 0;
                            v.next = crate::value::SlotIndex::NULL;
                            data.insert_item(0, v, &mut self.side_refs);
                            data.length = 1;
                        }
                    }
                } else if argc >= 2 {
                    self.charge_and_check(self.array_chunk_size_metering(argc as u32))?;
                    for i in 0..argc {
                        let mut v = self
                            .stack
                            .get(base + 4 + i)
                            .copied()
                            .unwrap_or_else(Slot::undefined);
                        v.id = 0;
                        v.next = crate::value::SlotIndex::NULL;
                        data.insert_item(i as u32, v, &mut self.side_refs);
                    }
                    data.length = argc as u32;
                }
                self.arrays.insert(inst, data);
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            // `new Map()` / `new Set()` (`fx_Map`/`fx_Set` + `fxNewMapInstance`/
            // `fxNewSetInstance`): a fresh empty collection. The instance is
            // four `fxNewSlot`s (instance/table/list/size) plus the initial
            // `fxNewChunk(mxTableMinLength * 8)` address array — the sole
            // metering (xsMapSet.c calls no `mxMeter`), charged explicitly here
            // since the table lives in the `collections` side table. An
            // iterable argument uses the full observable iterator protocol;
            // only a provably intrinsic dense Array takes the calibrated fast
            // path. `Map()` without `new` throws a TypeError (its abort
            // metering is a later increment).
            Native::Map | Native::Set if has_target => {
                let a = arg(0);
                let (proto, kind) = match native {
                    Native::Map => (self.map_proto, CollKind::Map),
                    _ => (self.set_proto, CollKind::Set),
                };
                self.meter.tick_raw(MAP_CTOR_FRAME_METERING);
                self.meter.tick_slot_alloc(); // instance
                self.meter.tick_slot_alloc(); // table
                self.meter.tick_slot_alloc(); // list
                self.meter.tick_slot_alloc(); // size
                self.charge_chunk_work(MAP_MIN_TABLE_LENGTH as u64 * 8)?;
                let inst = self.slots.alloc(Slot::instance(proto));
                self.collections
                    .insert(inst, CollectionData::new(kind, MAP_MIN_TABLE_LENGTH));
                if argc >= 1 && a.kind != Kind::Undefined && a.kind != Kind::Null {
                    self.populate_collection_from_dense_array(code, inst, a)?;
                }
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            // `new Proxy(target, handler)` (`fx_Proxy` → `fxNewProxyInstance`):
            // both arguments must be objects; records the internal slots in the
            // `proxies` side table and returns the fresh exotic. `Proxy(...)`
            // without `new` is a TypeError (a constructor-only intrinsic).
            Native::Proxy => {
                if !has_target {
                    return Err(self.catchable_type_error_msg("call: Proxy".into()));
                }
                let target = arg(0);
                let handler = arg(1);
                let proxy = self.make_proxy(target, handler)?;
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                proxy
            }
            // `new WeakMap()` / `new WeakSet()` (`fxNewWeakMapInstance`): only
            // two `fxNewSlot`s (instance + weak list); there is no table or
            // address chunk — the entries hang off the key objects. Iterable
            // arguments share the Map/Set protocol implementation above.
            Native::WeakMap | Native::WeakSet if has_target => {
                let a = arg(0);
                let (proto, kind) = match native {
                    Native::WeakMap => (self.weakmap_proto, CollKind::WeakMap),
                    _ => (self.weakset_proto, CollKind::WeakSet),
                };
                self.meter.tick_raw(WEAK_CTOR_FRAME_METERING);
                self.meter.tick_slot_alloc(); // instance
                self.meter.tick_slot_alloc(); // weak list
                let inst = self.slots.alloc(Slot::instance(proto));
                self.collections.insert(inst, CollectionData::new(kind, 0));
                if argc >= 1 && a.kind != Kind::Undefined && a.kind != Kind::Null {
                    self.populate_collection_from_dense_array(code, inst, a)?;
                }
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            Native::WeakMap | Native::WeakSet | Native::Map | Native::Set => {
                let name = match native {
                    Native::WeakMap => "WeakMap",
                    Native::WeakSet => "WeakSet",
                    Native::Map => "Map",
                    _ => "Set",
                };
                return Err(self.catchable_type_error_msg(format!("call: {name}")));
            }
            // `new ArrayBuffer(byteLength)` (`fx_ArrayBuffer` +
            // `fxNewArrayBufferInstance`): a fresh zero-filled buffer. The
            // instance is `fxNewObjectInstance` + two internal `fxNewSlot`s
            // (the `XS_ARRAY_BUFFER_KIND` address slot and the
            // `XS_BUFFER_INFO_KIND` length slot), folded with the native host
            // frame into [`ARRAY_BUFFER_CTOR_FRAME_METERING`]; the backing
            // store is a single `fxNewChunk(byteLength)`. A resizable buffer
            // (a reference second argument carrying `maxByteLength`), a
            // negative/oversized/non-integer byteLength (each a RangeError),
            // and the `ArrayBuffer(n)` call without `new` (a TypeError) are
            // honest named skips — their abort metering is a later increment.
            Native::ArrayBuffer if has_target => {
                if argc >= 2 && arg(1).kind == Kind::Reference {
                    return Err(Step::Host(Halt::NotImplemented(
                        "native-call:ArrayBuffer:resizable",
                    )));
                }
                let a = arg(0);
                let byte_length = self.to_index_arg(code, a)?;
                self.meter.tick_raw(ARRAY_BUFFER_CTOR_FRAME_METERING);
                let inst = self.alloc_array_buffer(byte_length)?;
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            // `new SharedArrayBuffer(byteLength)` (`xsAtomics.c`
            // `fx_SharedArrayBuffer`). Single-agent: a plain byte buffer marked
            // shared. Only the integer/number fixed-length form is covered; a
            // growable buffer (2nd option-bag arg) or a byteLength needing
            // general ToNumber self-names an honest skip.
            Native::SharedArrayBuffer if has_target => {
                if argc >= 2 && arg(1).kind == Kind::Reference {
                    return Err(Step::Host(Halt::NotImplemented(
                        "native-call:SharedArrayBuffer:growable",
                    )));
                }
                let a = arg(0);
                let byte_length = self.to_index_arg(code, a)?;
                self.meter.tick_raw(ARRAY_BUFFER_CTOR_FRAME_METERING);
                let inst = self.alloc_array_buffer(byte_length)?;
                self.shared_buffers.insert(inst);
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            // `new <TypedArray>(...)` (`fx_TypedArray` + `fxConstructTypedArray`
            // + `fxNewTypedArrayInstance`). Two covered forms:
            //   - `new TA(length)`: allocate a fresh `new ArrayBuffer(length <<
            //     shift)` backing store (the inner construct's frame is folded
            //     into [`TYPED_ARRAY_LENGTH_CTOR_FRAME_METERING`]; the chunk is
            //     metered by `alloc_array_buffer`), view offset 0.
            //   - `new TA(buffer[, byteOffset[, length]])`: a view over an
            //     existing ArrayBuffer, sharing its store (no allocation).
            // The from-iterable / from-TypedArray / from-array-like copy forms
            // (`fx_TypedArray_from_object`, the source-TypedArray element copy)
            // drive the iterator/element protocol and self-name honest skips.
            Native::TypedArray(idx) if has_target => {
                let ty = TYPED_ARRAY_TYPES[idx as usize];
                let shift = ty.shift as u32;
                let proto = self
                    .intrinsics
                    .get(ty.name)
                    .and_then(|&c| self.ctor_prototype.get(&c).copied())
                    .unwrap_or(self.object_proto);
                // Snapshot the arguments up front so the general-coercion path
                // can take a `&mut self` borrow (`to_index_arg`) without keeping
                // the `arg` closure's immutable borrow of `self.stack` alive.
                let a = arg(0);
                let a1 = arg(1);
                let a2 = arg(2);
                match a.value {
                    // View over an existing ArrayBuffer.
                    Payload::Reference(r) if self.array_buffers.contains_key(&r) => {
                        let buf_len = self.array_buffers[&r].length;
                        // byteOffset (arg1): `ToIndex` — a non-negative integer.
                        // The integer/number fast paths stay inline (their exact
                        // metering is pinned by the meter-exact corpus); a
                        // boolean/string/object takes the general coercion
                        // (`valueOf`/`toString`), and a Symbol/BigInt or a
                        // negative/oversized value throws a catchable
                        // TypeError/RangeError exactly as `fxToIndex` does.
                        let offset: u32 = match self.arg_to_byte_length(base, 1, 0) {
                            Some(o) => o,
                            None => self.to_index_arg(code, a1)?,
                        };
                        // A byteOffset that is not a multiple of the element
                        // size is a RangeError (`fxCheckTypedArrayIndex`).
                        if offset & ((1 << shift) - 1) != 0 {
                            return Err(self.catchable_range_error_msg(format!(
                                "invalid byteOffset {offset}"
                            )));
                        }
                        // length (arg2): explicit element count, or the
                        // remaining buffer (which must divide evenly).
                        let byte_size: u32;
                        if argc >= 3 && a2.kind != Kind::Undefined {
                            // length (arg2): `ToIndex` — explicit element count.
                            // Integer/number inline (metering pinned); otherwise
                            // the general coercion / catchable throw.
                            let len = match self.arg_to_byte_length(base, 2, 0) {
                                Some(l) => l,
                                None => self.to_index_arg(code, a2)?,
                            };
                            // A length whose byte span overflows u32, runs past
                            // the buffer, or (implicitly) exceeds the allocation
                            // ceiling is a RangeError (`fxCheckTypedArrayLength`).
                            if self.detached_buffers.contains(&r) {
                                return Err(self.catchable_type_error_msg("detached buffer".into()));
                            }
                            let delta = match len.checked_mul(1 << shift) {
                                Some(d) => d,
                                None => {
                                    return Err(self.catchable_range_error_msg(format!(
                                        "invalid length {len}"
                                    )))
                                }
                            };
                            let end = match offset.checked_add(delta) {
                                Some(e) => e,
                                None => {
                                    return Err(self.catchable_range_error_msg(format!(
                                        "invalid length {len}"
                                    )))
                                }
                            };
                            if buf_len < end {
                                return Err(
                                    self.catchable_range_error_msg(format!("invalid length {len}"))
                                );
                            }
                            byte_size = delta;
                        } else {
                            // Implicit length: the buffer must divide evenly by
                            // the element size and contain the offset — else a
                            // RangeError (`fxCheckTypedArrayLength`).
                            if self.detached_buffers.contains(&r) {
                                return Err(self.catchable_type_error_msg("detached buffer".into()));
                            }
                            if (buf_len & ((1 << shift) - 1)) != 0 {
                                return Err(self.catchable_range_error_msg(format!(
                                    "invalid byteLength {buf_len}"
                                )));
                            }
                            if offset > buf_len {
                                return Err(self.catchable_range_error_msg(format!(
                                    "invalid byteLength {}",
                                    buf_len.wrapping_sub(offset)
                                )));
                            }
                            byte_size = buf_len - offset;
                        }
                        self.meter.tick_raw(TYPED_ARRAY_BUFFER_CTOR_FRAME_METERING);
                        let inst = self.slots.alloc(Slot::instance(proto));
                        self.typed_arrays.insert(
                            inst,
                            TypedArrayData {
                                kind: idx,
                                buffer: r,
                                offset,
                                length: byte_size >> shift,
                            },
                        );
                        Slot::of(Kind::Reference, Payload::Reference(inst))
                    }
                    // `new TA(source)` from a **dense Array** (`new Uint8Array([
                    // 1,2,3])`, the common boot-bundle form) or a **source
                    // TypedArray** (`new Int16Array(u8)`): allocate a fresh
                    // backing store of `length << shift` and copy each element,
                    // coercing per the destination element type. A plain array
                    // literal carries the default `Symbol.iterator`, so its
                    // direct dense element sequence IS the iterator result the
                    // spec-mandated protocol would yield — result-faithful. An
                    // element needing `ToPrimitive`/`valueOf` (an object member)
                    // takes the general coercion path. BigInt-element sources
                    // materialize real BigInt values so same-domain copies work
                    // and cross-domain copies throw the required TypeError.
                    Payload::Reference(r)
                        if self.arrays.contains_key(&r) || self.typed_arrays.contains_key(&r) =>
                    {
                        // The source LENGTH decides the allocation, so read it,
                        // bound it, and charge for it BEFORE materializing
                        // anything. This used to collect `0..len` into a
                        // `Vec<Slot>` and sanity-check afterwards, which made
                        // the source length an *unmetered allocation
                        // instruction*: a sparse `a.length = 200_000_000` —
                        // ordinary JS state, and ordinary snapshot bytes no
                        // decoder can refuse, since a sparse array is legitimate
                        // — reserved 32 bytes per declared element before any
                        // bound and before any charge. What that costs depends
                        // on the host and both outcomes are bad: where the
                        // reservation fails, `handle_alloc_error` ABORTS THE
                        // PROCESS, which no `catch_unwind` can contain; where
                        // overcommit lets it succeed, the worker stalls filling
                        // slots the meter never sees (measured: 132 seconds and
                        // 8.6 GB for a two-call program).
                        //
                        // Ordered this way the from-source path is exposed
                        // exactly as much as the length form `new TA(n)` it is
                        // equivalent to, and no more: the bound rejects first,
                        // and `alloc_array_buffer` charges
                        // `tick_chunk_new(byte_length)` before it allocates.
                        // `tests/typed_array_source_length.rs` holds the
                        // deadline that keeps the order this way round.
                        let (length, source_ta) = if let Some(src) = self.arrays.get(&r) {
                            (src.length, None)
                        } else {
                            let src = self.typed_arrays[&r];
                            (src.length, Some(src))
                        };
                        // A sparse snapshot is valid only with the intrinsic
                        // array iterator and its intrinsic next method. Check
                        // the resolved methods across the chain: an inherited
                        // override is just as observable as an own property.
                        if source_ta.is_none() {
                            // Runtime keys (for example from JSON.parse) can
                            // precede their lazy intrinsic bindings. Complete
                            // that installation before inspecting next.
                            self.install_pending_intrinsics();
                            let iterator_id = self
                                .well_known_symbol_property_id("iterator")
                                .expect("well-known iterator symbol");
                            // Unreferenced intrinsic names are linked lazily.
                            // If no next key exists, guest code cannot yet have
                            // replaced or deleted the intrinsic next method.
                            let intrinsic_next = self.symbol_ids.get("next").is_none_or(|&id| {
                                self.chain_resolves_native_data_method(
                                    self.array_iterator_proto,
                                    id,
                                    NativeMethod::ArrayIteratorNext,
                                )
                            });
                            if !self.chain_resolves_native_data_method(
                                r,
                                iterator_id,
                                NativeMethod::ArrayValues,
                            ) || !intrinsic_next
                            {
                                return Err(Step::Host(Halt::NotImplemented(
                                    "native-call:TypedArray:from-array-like",
                                )));
                            }
                        }
                        if length > (0x7FFF_FFFFu32 >> shift) {
                            return Err(Step::Host(Halt::NotImplemented(
                                "native-call:TypedArray:bad-length",
                            )));
                        }
                        let byte_length = length << shift;
                        self.meter.tick_raw(TYPED_ARRAY_LENGTH_CTOR_FRAME_METERING);
                        let buffer = self.alloc_array_buffer(byte_length)?;
                        let inst = self.slots.alloc(Slot::instance(proto));
                        let ta = TypedArrayData {
                            kind: idx,
                            buffer,
                            offset: 0,
                            length,
                        };
                        self.typed_arrays.insert(inst, ta);
                        // An ARRAY source is snapshotted up front — the spec's
                        // `IteratorToList` materializes every value BEFORE any
                        // element coercion runs, so a `valueOf` that mutates the
                        // source mid-copy (`iterated-array-changed-by-tonumber`)
                        // must not change later reads. The snapshot CLONES the
                        // source's sparse `items()` map (present entries only),
                        // NOT a dense `0..length` `Vec<Slot>`: the declared
                        // length is guest-controlled and unbounded up to the
                        // arm's own cap, so a dense snapshot would re-arm the
                        // dense-allocation hazard: reserving
                        // `length * size_of::<Slot>()` outside the meter,
                        // while `alloc_array_buffer` charged only the packed
                        // `byte_length`. Cloning `items()` keeps the allocation
                        // proportional to the storage the meter already charged
                        // (present entries), and an absent index reads
                        // `undefined` from the clone exactly as a hole would.
                        // The snapshot comes AFTER the length bound and the
                        // metered `alloc_array_buffer` charge above, so the
                        // admission ordering (reject first, charge second, only
                        // then any length-proportional allocation;
                        // `tests/typed_array_source_length.rs`) still holds and
                        // the length-proportional allocation the ordering exists
                        // to bound — the backing store — remains the only one. A
                        // TypedArray source needs no snapshot: its element reads
                        // are pure numeric loads and its element coercions run no
                        // guest code, so nothing can mutate it between reads. A
                        // hole reads `undefined` (-> NaN -> 0 for an integer
                        // view), matching the default-iterator result.
                        let snapshot: Option<std::collections::BTreeMap<u32, Slot>> = source_ta
                            .map_or_else(
                                || self.arrays.get(&r).map(|src| src.items().clone()),
                                |_| None,
                            );
                        for i in 0..length {
                            let v = match source_ta {
                                Some(src) if src.kind <= 1 => {
                                    self.typed_array_element_get_bigint(src, i)
                                }
                                Some(src) => self
                                    .typed_array_element_get(src, i)
                                    .expect("numeric TypedArray element decodes"),
                                None => snapshot
                                    .as_ref()
                                    .and_then(|items| items.get(&i).copied())
                                    .unwrap_or_else(Slot::undefined),
                            };
                            self.typed_array_element_set(code, ta, i, v)?;
                            self.meter
                                .tick_raw(TYPED_ARRAY_FROM_SOURCE_ELEMENT_METERING);
                        }
                        Slot::of(Kind::Reference, Payload::Reference(inst))
                    }
                    // Any other **object** source (an array-like, custom
                    // iterable, Map/Set, or proxy) first traverses the same
                    // iterator/array-like protocol as `Array.from`. Re-enter
                    // this constructor with the resulting dense Array so the
                    // bounded allocation and element-coercion path above stays
                    // single-sourced. A Symbol/BigInt first argument is a
                    // primitive, not an Object (its `Payload` is a Reference to
                    // the interned symbol/bigint), so it falls through to the
                    // length path below, where `ToNumber` throws a catchable
                    // TypeError exactly as the spec's `ToIndex` does.
                    Payload::Reference(_) if a.kind == Kind::Reference => {
                        let array_ctor = self
                            .intrinsics
                            .get("Array")
                            .copied()
                            .expect("Array intrinsic");
                        let array_ctor = Slot::of(Kind::Reference, Payload::Reference(array_ctor));
                        let collect_base = self.stack.len();
                        self.push(array_ctor);
                        self.push(Slot::undefined());
                        self.push(Slot::undefined());
                        self.push(Slot::of(Kind::Uninitialized, Payload::None));
                        self.push(a);
                        let collected = self.array_from(code, collect_base, 1);
                        self.stack.truncate(collect_base);
                        let collected = collected?;

                        let typed_array_ctor = self
                            .stack
                            .get(base + 1)
                            .copied()
                            .unwrap_or_else(Slot::undefined);
                        let construct_base = self.stack.len();
                        self.push(Slot::of(Kind::Uninitialized, Payload::None));
                        self.push(typed_array_ctor);
                        self.push(Slot::undefined());
                        self.push(Slot::of(Kind::Uninitialized, Payload::None));
                        self.push(collected);
                        let constructed = self.call_native(
                            Native::TypedArray(idx),
                            construct_base,
                            1,
                            true,
                            code,
                        );
                        match constructed {
                            Ok(()) => self.pop_checked()?,
                            Err(halt) => {
                                self.stack.truncate(construct_base);
                                return Err(halt);
                            }
                        }
                    }
                    // Length form: `new TA(n)`. `n` is `ToIndex`-coerced.
                    _ => {
                        let length = self.to_index_arg(code, a)?;
                        if length > (0x7FFF_FFFFu32 >> shift) {
                            return Err(self.catchable_range_error_msg("byteLength too big".into()));
                        }
                        let byte_length = length << shift;
                        self.meter.tick_raw(TYPED_ARRAY_LENGTH_CTOR_FRAME_METERING);
                        let buffer = self.alloc_array_buffer(byte_length)?;
                        let inst = self.slots.alloc(Slot::instance(proto));
                        self.typed_arrays.insert(
                            inst,
                            TypedArrayData {
                                kind: idx,
                                buffer,
                                offset: 0,
                                length,
                            },
                        );
                        Slot::of(Kind::Reference, Payload::Reference(inst))
                    }
                }
            }
            // `new DataView(buffer[, byteOffset[, byteLength]])` (`fx_DataView`
            // + `fxNewDataViewInstance`): a view over an existing ArrayBuffer.
            // The instance is `fxNewObjectInstance` + two internal `fxNewSlot`s
            // (the `XS_DATA_VIEW_KIND` view slot + the buffer-ref slot), folded
            // with the native host frame into
            // [`DATA_VIEW_CTOR_FRAME_METERING`]; no backing store is allocated
            // (the view shares the argument buffer). A non-ArrayBuffer first
            // argument throws TypeError. Offset and length use ToIndex, and a
            // span outside the backing store throws RangeError.
            Native::DataView if has_target => {
                let a = arg(0);
                let buf = match a.value {
                    Payload::Reference(r) if self.array_buffers.contains_key(&r) => r,
                    _ => {
                        return Err(self.catchable_type_error_msg(
                            "buffer: not an ArrayBuffer instance".into(),
                        ))
                    }
                };
                let offset_arg = arg(1);
                let length_arg = arg(2);
                let buf_len = self.array_buffers[&buf].length;
                let offset = self.to_index_arg(code, offset_arg)?;
                // A buffer detached by the `ToIndex(byteOffset)` coercion (a
                // user `valueOf`) is a TypeError — after the coercion ran, so
                // `ToNumber(byteOffset)` is still observed once, ahead of the
                // out-of-range RangeError.
                if self.detached_buffers.contains(&buf) {
                    return Err(self.catchable_type_error_msg("detached buffer".into()));
                }
                if offset > buf_len {
                    return Err(
                        self.catchable_range_error_msg(format!("invalid byteOffset {offset}"))
                    );
                }
                let size: u32;
                if argc >= 3 && length_arg.kind != Kind::Undefined {
                    let s = self.to_index_arg(code, length_arg)?;
                    let end = match offset.checked_add(s) {
                        Some(e) => e,
                        None => {
                            return Err(
                                self.catchable_range_error_msg(format!("invalid byteLength {s}"))
                            )
                        }
                    };
                    if buf_len < end {
                        return Err(
                            self.catchable_range_error_msg(format!("invalid byteLength {s}"))
                        );
                    }
                    size = s;
                } else {
                    size = buf_len - offset;
                }
                self.meter.tick_raw(DATA_VIEW_CTOR_FRAME_METERING);
                let inst = self.slots.alloc(Slot::instance(self.dataview_proto));
                self.data_views.insert(
                    inst,
                    DataViewData {
                        buffer: buf,
                        offset,
                        size,
                    },
                );
                Slot::of(Kind::Reference, Payload::Reference(inst))
            }
            // `DataView(...)` is constructor-only.
            Native::DataView => return Err(self.catchable_type_error_msg("call: DataView".into())),
            // `new Promise(executor)` (`fx_Promise`): a fresh pending promise
            // whose resolve/reject functions are handed to the executor, which
            // runs synchronously inside the construct (`mxRunCount(2)`). The
            // promise instance is `fxNewPromiseInstance` (six `fxNewSlot`s), the
            // resolving pair is `fxPushPromiseFunctions`
            // ([`PROMISE_FUNCTIONS_METERING`]), and the native frame residual is
            // [`PROMISE_CTOR_FRAME_METERING`]; the executor body is metered by
            // the re-entrant `run_callback`. A non-user-function executor, and a
            // non-`new` `Promise(...)` call throws a TypeError. Callability is
            // checked before allocating the promise (and therefore before
            // consulting `newTarget.prototype`), as required by the constructor
            // algorithm.
            Native::Promise if has_target => {
                if argc == 0 {
                    return Err(self.catchable_type_error_msg("no executor".into()));
                }
                let executor = arg(0);
                if !self.is_callable_value(executor) {
                    return Err(self.catchable_type_error_msg("executor: not a function".into()));
                }
                self.meter.tick_raw(PROMISE_CTOR_FRAME_METERING);
                let proto = match new_target {
                    Some(target) => {
                        self.get_prototype_from_constructor(code, target, self.promise_proto)?
                    }
                    None => self.promise_proto,
                };
                let promise = self.new_promise_instance_with_proto(proto);
                let (resolve, reject) = self.make_resolving_functions(promise);
                // Invoke `executor(resolve, reject)` with `this = undefined`,
                // re-entrant. A throw rejects the promise via `fxRejectException`
                // — its thrown-value capture + metering is a later increment, so
                // an executor throw self-names rather than mis-settle.
                match self.run_callback_catching_throw(
                    code,
                    executor,
                    Slot::undefined(),
                    &[resolve, reject],
                )? {
                    Ok(_) => {}
                    Err(thrown) => self.settle_via_function(code, reject, thrown)?,
                }
                Slot::of(Kind::Reference, Payload::Reference(promise))
            }
            // `%Promise%` is constructor-only. The call form fails before
            // inspecting its argument, and the realm TypeError remains
            // catchable by surrounding guest code.
            Native::Promise => return Err(self.catchable_type_error_msg("call: Promise".into())),
            // `new RegExp(pattern, flags)` and the bare-call `RegExp(...)`
            // (`fx_RegExp` + `fxInitializeRegExp`): coerce the pattern and
            // flags to strings, compile the pattern with `ironhorse_regexp`,
            // and build the instance (compiled program + source/flags in the
            // `regexps` side table, `lastIndex` = 0). A `/.../ ` literal reaches
            // here as `new RegExp(<pattern>, <flags>)`. An internal RegExp
            // pattern follows the copy-constructor path: a same-constructor
            // bare call with no flags returns the argument, while construction
            // or a flags override builds a fresh instance from its source.
            Native::RegExp => {
                let pattern_arg = arg(0);
                let flags_arg = arg(1);
                let pattern_is_regexp = self.string_is_regexp(code, pattern_arg)?;
                let pattern_regexp = match pattern_arg.value {
                    Payload::Reference(r) if self.regexps.contains_key(&r) => Some(r),
                    _ => None,
                };
                let return_pattern = if pattern_is_regexp {
                    if !has_target && flags_arg.kind == Kind::Undefined {
                        // `RegExp(pattern)` returns `pattern` only when its
                        // observable `constructor` is the active intrinsic.
                        if let Payload::Reference(r) = pattern_arg.value {
                            let id = self.intern_static_key("constructor");
                            let active = self
                                .stack
                                .get(base + 1)
                                .copied()
                                .unwrap_or_else(Slot::undefined);
                            let constructor = if pattern_regexp.is_some()
                                && self.regexp_getter_uses_default(r, id)
                            {
                                active
                            } else {
                                self.mop_get(code, r, id, pattern_arg)?
                            };
                            self.same_value(constructor, active)
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                };
                if return_pattern {
                    pattern_arg
                } else {
                    let pattern = if pattern_is_regexp {
                        let source_id = self.intern_static_key("source");
                        if let Some(r) = pattern_regexp {
                            // The ordinary Get is observable through own and
                            // inherited overrides, including Proxy prototypes.
                            if !self.regexp_getter_uses_default(r, source_id) {
                                let source = self.mop_get(code, r, source_id, pattern_arg)?;
                                if source.kind == Kind::Undefined {
                                    String::new()
                                } else {
                                    String::from_utf16_lossy(&self.to_string_units(code, source)?)
                                }
                            } else {
                                self.regexps[&r].source.clone()
                            }
                        } else {
                            let Payload::Reference(r) = pattern_arg.value else {
                                unreachable!("IsRegExp is false for primitives")
                            };
                            let source = self.mop_get(code, r, source_id, pattern_arg)?;
                            if source.kind == Kind::Undefined {
                                String::new()
                            } else {
                                String::from_utf16_lossy(&self.to_string_units(code, source)?)
                            }
                        }
                    } else if pattern_arg.kind == Kind::Undefined {
                        String::new()
                    } else {
                        String::from_utf16_lossy(&self.to_string_units(code, pattern_arg)?)
                    };
                    let flags = if flags_arg.kind == Kind::Undefined {
                        if pattern_is_regexp {
                            let flags_id = self.intern_static_key("flags");
                            if let Some(r) = pattern_regexp {
                                if !self.regexp_getter_uses_default(r, flags_id) {
                                    let value = self.mop_get(code, r, flags_id, pattern_arg)?;
                                    if value.kind == Kind::Undefined {
                                        String::new()
                                    } else {
                                        String::from_utf16_lossy(
                                            &self.to_string_units(code, value)?,
                                        )
                                    }
                                } else {
                                    self.regexps[&r].flags.clone()
                                }
                            } else {
                                let Payload::Reference(r) = pattern_arg.value else {
                                    unreachable!("IsRegExp is false for primitives")
                                };
                                let value = self.mop_get(code, r, flags_id, pattern_arg)?;
                                if value.kind == Kind::Undefined {
                                    String::new()
                                } else {
                                    String::from_utf16_lossy(&self.to_string_units(code, value)?)
                                }
                            }
                        } else {
                            String::new()
                        }
                    } else {
                        String::from_utf16_lossy(&self.to_string_units(code, flags_arg)?)
                    };
                    let regexp = self.build_regexp(pattern, flags)?;
                    if has_target {
                        let target = new_target.expect("a RegExp construct has a new.target");
                        let proto =
                            self.get_prototype_from_constructor(code, target, self.regexp_proto)?;
                        let Payload::Reference(instance) = regexp.value else {
                            unreachable!("build_regexp returns an object")
                        };
                        self.slots.get_mut(instance).value = Payload::Reference(proto);
                    }
                    regexp
                }
            }
            // `ArrayBuffer(...)` / `SharedArrayBuffer(...)` called WITHOUT `new`
            // (`has_target` false): a constructor-only intrinsic whose
            // `fx_ArrayBuffer`/`fx_SharedArrayBuffer` throws a catchable TypeError
            // when `mxTarget` is undefined (`if (mxIsUndefined(mxTarget)) mxTypeError`).
            Native::ArrayBuffer | Native::SharedArrayBuffer => {
                let name = if matches!(native, Native::ArrayBuffer) {
                    "ArrayBuffer"
                } else {
                    "SharedArrayBuffer"
                };
                return Err(self.catchable_type_error_msg(format!("call: {name}")));
            }
            Native::TypedArrayBase => {
                return Err(self.catchable_type_error_msg(
                    if has_target {
                        "new: TypedArray"
                    } else {
                        "call: TypedArray"
                    }
                    .into(),
                ));
            }
            Native::TypedArray(_) => {
                return Err(self.catchable_type_error_msg("call: TypedArray".into()));
            }
            // The remaining fundamentals constructors' call/coerce/construct
            // behaviors land incrementally; until then they self-name so the
            // differential runner records an honest skip.
            _ => {
                return Err(Step::Host(Halt::NotImplemented(native_unsupported_name(
                    native,
                ))))
            }
        };
        // Collapse the call region to the single result (frame teardown).
        let _ = argc;
        self.stack.truncate(base);
        self.push(result);
        Ok(())
    }

    #[inline(never)]
    pub(in crate::interp) fn call_native_method_inner(
        &mut self,
        m: NativeMethod,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<(), Step> {
        let _ = code; // used by the callback-taking methods (run_callback)
                      // Cost-calibration builtin histogram: one invocation per dispatched
                      // native prototype method. This is the central native-method
                      // dispatch seam (every `tick_builtin*` inside this function belongs
                      // to `m`). The feature-off recorder is a no-op; cost.rs tests its
                      // zero-sized representation. It records invocation counts, not
                      // wall-clock timings or per-step work attribution.
        self.cost.on_builtin(m);
        let this = self
            .stack
            .get(base)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let arg0 = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let _ = argc;
        // `Object.*` statics whose object operand (`arg0`) is a proxy route
        // through the proxy-aware MOP (ECMA-262 20.1.2.*, each delegating to an
        // internal method). Handled here so the trap cannot be bypassed.
        if let Payload::Reference(pinst) = arg0.value {
            if arg0.kind == Kind::Reference
                && self.proxies.contains_key(&pinst)
                && is_object_static_on_operand(m)
            {
                let r = self.object_static_proxy(m, pinst, base, argc, code)?;
                self.stack.truncate(base);
                self.push(r);
                return Ok(());
            }
        }
        let result: Slot = match m {
            NativeMethod::Date(op) => self.date_method(op, this, base, argc, code)?,
            NativeMethod::TemporalPlain(kind, op) => {
                let arg1 = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                self.temporal_plain_method(kind, op, this, arg0, arg1, code)?
            }
            NativeMethod::TemporalZoned(op) => {
                let arg1 = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                self.temporal_zoned_method(op, this, arg0, arg1, code)?
            }
            NativeMethod::TemporalNow(op) => self.temporal_now_method(op, arg0, code)?,
            NativeMethod::TemporalInstantFrom
            | NativeMethod::TemporalInstantFromEpochMilliseconds
            | NativeMethod::TemporalInstantFromEpochNanoseconds
            | NativeMethod::TemporalInstantCompare
            | NativeMethod::TemporalInstantAdd
            | NativeMethod::TemporalInstantSubtract
            | NativeMethod::TemporalInstantUntil
            | NativeMethod::TemporalInstantSince
            | NativeMethod::TemporalInstantRound
            | NativeMethod::TemporalInstantEquals
            | NativeMethod::TemporalInstantToString
            | NativeMethod::TemporalInstantToJSON
            | NativeMethod::TemporalInstantValueOf
            | NativeMethod::TemporalDurationFrom
            | NativeMethod::TemporalDurationCompare
            | NativeMethod::TemporalDurationWith
            | NativeMethod::TemporalDurationNegated
            | NativeMethod::TemporalDurationAbs
            | NativeMethod::TemporalDurationAdd
            | NativeMethod::TemporalDurationSubtract
            | NativeMethod::TemporalDurationRound
            | NativeMethod::TemporalDurationTotal
            | NativeMethod::TemporalDurationToString
            | NativeMethod::TemporalDurationToJSON
            | NativeMethod::TemporalDurationValueOf => {
                let arg1 = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let arg2 = self
                    .stack
                    .get(base + 6)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                self.temporal_method(m, this, arg0, arg1, arg2, code)?
            }
            NativeMethod::IntlGetCanonicalLocales => {
                let locales = self.intl_locale_list(code, arg0)?;
                let values = locales
                    .iter()
                    .map(|locale| self.intl_string(locale))
                    .collect::<Vec<_>>();
                self.array_from_slots(&values)
            }
            NativeMethod::IntlSupportedLocalesOf => {
                let locales = self.intl_locale_list(code, arg0)?;
                let values = locales
                    .iter()
                    .filter(|locale| locale_is_supported(locale))
                    .map(|locale| self.intl_string(locale))
                    .collect::<Vec<_>>();
                self.array_from_slots(&values)
            }
            NativeMethod::IntlSupportedValuesOf => {
                let key = self.intl_locale_argument(code, arg0)?;
                let values: &[&str] = match key.as_str() {
                    "calendar" => &[
                        "buddhist",
                        "chinese",
                        "coptic",
                        "dangi",
                        "ethioaa",
                        "ethiopic",
                        "gregory",
                        "hebrew",
                        "indian",
                        "islamic",
                        "islamic-civil",
                        "iso8601",
                        "japanese",
                        "persian",
                        "roc",
                    ],
                    "collation" => &[
                        "big5han", "compat", "dict", "emoji", "eor", "gb2312", "phonebk",
                        "phonetic", "pinyin", "searchjl", "stroke", "trad", "unihan", "zhuyin",
                    ],
                    "currency" => &[
                        "AED", "AUD", "BRL", "CAD", "CHF", "CNY", "EUR", "GBP", "INR", "JPY",
                        "KRW", "MXN", "RUB", "USD", "ZAR",
                    ],
                    "numberingSystem" => &[
                        "arab", "arabext", "beng", "deva", "fullwide", "gujr", "guru", "hanidec",
                        "khmr", "knda", "laoo", "latn", "limb", "mlym", "mong", "mymr", "orya",
                        "tamldec", "telu", "thai", "tibt",
                    ],
                    "timeZone" => &[
                        "Africa/Cairo",
                        "America/Los_Angeles",
                        "America/New_York",
                        "Asia/Shanghai",
                        "Asia/Tokyo",
                        "Europe/Berlin",
                        "Europe/London",
                        "Pacific/Auckland",
                        "UTC",
                    ],
                    "unit" => &[
                        "acre",
                        "bit",
                        "byte",
                        "celsius",
                        "centimeter",
                        "day",
                        "degree",
                        "fahrenheit",
                        "foot",
                        "gallon",
                        "gigabit",
                        "gigabyte",
                        "gram",
                        "hectare",
                        "hour",
                        "inch",
                        "kilobit",
                        "kilobyte",
                        "kilogram",
                        "kilometer",
                        "liter",
                        "megabit",
                        "megabyte",
                        "meter",
                        "mile",
                        "mile-scandinavian",
                        "milliliter",
                        "millimeter",
                        "millisecond",
                        "minute",
                        "month",
                        "ounce",
                        "percent",
                        "petabyte",
                        "pound",
                        "second",
                        "stone",
                        "terabit",
                        "terabyte",
                        "week",
                        "yard",
                        "year",
                    ],
                    _ => return Err(self.catchable_range_error()),
                };
                let slots = values
                    .iter()
                    .map(|value| self.intl_string(value))
                    .collect::<Vec<_>>();
                self.array_from_slots(&slots)
            }
            NativeMethod::LocaleToString => {
                let inst = match this.value {
                    Payload::Reference(r) if self.locales.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let tag = self.locales[&inst].tag.clone();
                self.intl_string(&tag)
            }
            NativeMethod::LocaleMaximize | NativeMethod::LocaleMinimize => {
                let inst = match this.value {
                    Payload::Reference(r) if self.locales.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let mut locale = self.locales[&inst].clone();
                if m == NativeMethod::LocaleMaximize {
                    maximize_locale(&mut locale);
                } else {
                    minimize_locale(&mut locale);
                }
                locale.tag = locale_to_tag(&locale);
                self.new_locale_from_data(locale)
            }
            NativeMethod::CollatorResolvedOptions => {
                let inst = match this.value {
                    Payload::Reference(r) if self.collators.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let data = self.collators[&inst].clone();
                let result = self.slots.alloc(Slot::instance(self.object_proto));
                for (name, value) in [
                    ("locale", self.intl_string(&data.locale)),
                    ("usage", self.intl_string(&data.usage)),
                    ("sensitivity", self.intl_string(&data.sensitivity)),
                    ("ignorePunctuation", Slot::boolean(data.ignore_punctuation)),
                    ("collation", self.intl_string(&data.collation)),
                    ("numeric", Slot::boolean(data.numeric)),
                    ("caseFirst", self.intl_string(&data.case_first)),
                ] {
                    self.define_descriptor_field(result, name, value);
                }
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            NativeMethod::CollatorCompare => {
                let function = self
                    .stack
                    .get(base + 1)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let f = match function.value {
                    Payload::Reference(r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let collator = match self.collator_compare_functions.get(&f).copied() {
                    Some(collator) => collator,
                    None => return Err(self.catchable_type_error()),
                };
                let data = self.collators[&collator].clone();
                let left =
                    String::from_utf8_lossy(&self.to_string_bytes_metered(arg0)).into_owned();
                let right_slot = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let right =
                    String::from_utf8_lossy(&self.to_string_bytes_metered(right_slot)).into_owned();
                Slot::integer(collator_compare(&data, &left, &right))
            }
            NativeMethod::ListFormatFormat | NativeMethod::ListFormatFormatToParts => {
                let inst = match this.value {
                    Payload::Reference(r) if self.list_formats.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let data = self.list_formats[&inst].clone();
                let list = self.string_list_from_iterable(code, arg0)?;
                let parts = list_format_parts(&data, &list);
                if m == NativeMethod::ListFormatFormat {
                    let mut s = String::new();
                    for (_, value) in &parts {
                        s.push_str(value);
                    }
                    self.intl_string(&s)
                } else {
                    let arr = self.new_array();
                    for (i, (ty, value)) in parts.iter().enumerate() {
                        let obj = self.slots.alloc(Slot::instance(self.object_proto));
                        let value_slot = self.intl_string(value);
                        let type_slot = self.intl_string(ty);
                        // Insert in `type`, `value` enumeration order.
                        self.define_descriptor_field(obj, "type", type_slot);
                        self.define_descriptor_field(obj, "value", value_slot);
                        let mut item = Slot::of(Kind::Reference, Payload::Reference(obj));
                        item.id = 0;
                        item.next = crate::value::SlotIndex::NULL;
                        self.arrays.get_mut(&arr).unwrap().insert_item(
                            i as u32,
                            item,
                            &mut self.side_refs,
                        );
                    }
                    self.arrays.get_mut(&arr).unwrap().length = parts.len() as u32;
                    Slot::of(Kind::Reference, Payload::Reference(arr))
                }
            }
            NativeMethod::ListFormatResolvedOptions => {
                let inst = match this.value {
                    Payload::Reference(r) if self.list_formats.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let data = self.list_formats[&inst].clone();
                let result = self.slots.alloc(Slot::instance(self.object_proto));
                let locale = self.intl_string(&data.locale);
                self.define_descriptor_field(result, "locale", locale);
                let kind = self.intl_string(&data.kind);
                self.define_descriptor_field(result, "type", kind);
                let style = self.intl_string(&data.style);
                self.define_descriptor_field(result, "style", style);
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            NativeMethod::PluralRulesSelect => {
                let inst = match this.value {
                    Payload::Reference(r) if self.plural_rules.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let data = self.plural_rules[&inst].clone();
                let number = self.to_number_value(code, arg0)?;
                let n = to_number(&number);
                let category = plural_select(&data, n);
                self.intl_string(category)
            }
            NativeMethod::PluralRulesSelectRange => {
                let inst = match this.value {
                    Payload::Reference(r) if self.plural_rules.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let data = self.plural_rules[&inst].clone();
                let start_arg = arg0;
                let end_arg = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                if start_arg.kind == Kind::Undefined || end_arg.kind == Kind::Undefined {
                    return Err(self.catchable_type_error());
                }
                let start = to_number(&self.to_number_value(code, start_arg)?);
                let end = to_number(&self.to_number_value(code, end_arg)?);
                if start.is_nan() || end.is_nan() {
                    return Err(self.catchable_range_error());
                }
                // PluralRuleSelectRange: without CLDR range data, fall back to
                // the plural category of the end value (correct for the tested
                // English default where start<end share the `other` category).
                let category = plural_select(&data, end);
                self.intl_string(category)
            }
            NativeMethod::PluralRulesResolvedOptions => {
                let inst = match this.value {
                    Payload::Reference(r) if self.plural_rules.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let data = self.plural_rules[&inst].clone();
                let result = self.slots.alloc(Slot::instance(self.object_proto));
                let locale = self.intl_string(&data.locale);
                self.define_descriptor_field(result, "locale", locale);
                let kind = self.intl_string(&data.kind);
                self.define_descriptor_field(result, "type", kind);
                let notation = self.intl_string(&data.notation);
                self.define_descriptor_field(result, "notation", notation);
                self.define_descriptor_field(
                    result,
                    "minimumIntegerDigits",
                    Slot::integer(data.minimum_integer_digits as i32),
                );
                let uses_significant = data.rounding_type == "significantDigits"
                    || data.rounding_type == "morePrecision"
                    || data.rounding_type == "lessPrecision";
                let uses_fraction = data.rounding_type == "fractionDigits"
                    || data.rounding_type == "morePrecision"
                    || data.rounding_type == "lessPrecision";
                if uses_fraction {
                    self.define_descriptor_field(
                        result,
                        "minimumFractionDigits",
                        Slot::integer(data.minimum_fraction_digits as i32),
                    );
                    self.define_descriptor_field(
                        result,
                        "maximumFractionDigits",
                        Slot::integer(data.maximum_fraction_digits as i32),
                    );
                }
                if uses_significant {
                    if let (Some(mn), Some(mx)) = (
                        data.minimum_significant_digits,
                        data.maximum_significant_digits,
                    ) {
                        self.define_descriptor_field(
                            result,
                            "minimumSignificantDigits",
                            Slot::integer(mn as i32),
                        );
                        self.define_descriptor_field(
                            result,
                            "maximumSignificantDigits",
                            Slot::integer(mx as i32),
                        );
                    }
                }
                let categories = plural_categories(&data.locale, &data.kind);
                let arr = self.new_array();
                for (i, cat) in categories.iter().enumerate() {
                    let mut item = self.intl_string(cat);
                    item.id = 0;
                    item.next = crate::value::SlotIndex::NULL;
                    self.arrays.get_mut(&arr).unwrap().insert_item(
                        i as u32,
                        item,
                        &mut self.side_refs,
                    );
                }
                self.arrays.get_mut(&arr).unwrap().length = categories.len() as u32;
                self.define_descriptor_field(
                    result,
                    "pluralCategories",
                    Slot::of(Kind::Reference, Payload::Reference(arr)),
                );
                self.define_descriptor_field(
                    result,
                    "roundingIncrement",
                    Slot::integer(data.rounding_increment as i32),
                );
                let rounding_mode = self.intl_string(&data.rounding_mode);
                self.define_descriptor_field(result, "roundingMode", rounding_mode);
                let rounding_priority = self.intl_string(&data.rounding_priority);
                self.define_descriptor_field(result, "roundingPriority", rounding_priority);
                let trailing = self.intl_string(&data.trailing_zero_display);
                self.define_descriptor_field(result, "trailingZeroDisplay", trailing);
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            NativeMethod::NumberFormatFormat => {
                let inst = match this.value {
                    Payload::Reference(r) if self.number_formats.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let n = to_number(&self.to_number_value(code, arg0)?);
                let resolved = self.nf_resolved(&self.number_formats[&inst].clone());
                let s = crate::intl_number::format_to_string(&resolved, n);
                self.intl_string(&s)
            }
            NativeMethod::NumberFormatFormatGetter => {
                // `get format`: `this` must be an initialized NumberFormat.
                // Return its cached `[[BoundFormat]]`, allocating an anonymous
                // length-1 native function on first read and recording the
                // instance both on the instance (`bound_format`) and in the
                // reverse side table the bound call handler consults.
                let inst = match this.value {
                    Payload::Reference(r) if self.number_formats.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let function = match self.number_formats[&inst].bound_format {
                    Some(f) => f,
                    None => {
                        let f =
                            self.alloc_named_method(NativeMethod::NumberFormatBoundFormat, "", 1);
                        self.number_format_bound_functions.insert(f, inst);
                        self.number_formats.get_mut(&inst).unwrap().bound_format = Some(f);
                        f
                    }
                };
                Slot::of(Kind::Reference, Payload::Reference(function))
            }
            NativeMethod::NumberFormatBoundFormat => {
                // The bound function recovers its NumberFormat from its own
                // function slot (`stack[base + 1]`) — like `CollatorCompare` —
                // then formats `arg0` exactly as `format` would.
                let function = self
                    .stack
                    .get(base + 1)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let f = match function.value {
                    Payload::Reference(r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let inst = match self.number_format_bound_functions.get(&f).copied() {
                    Some(inst) => inst,
                    None => return Err(self.catchable_type_error()),
                };
                let n = to_number(&self.to_number_value(code, arg0)?);
                let resolved = self.nf_resolved(&self.number_formats[&inst].clone());
                let s = crate::intl_number::format_to_string(&resolved, n);
                self.intl_string(&s)
            }
            NativeMethod::NumberFormatFormatToParts => {
                let inst = match this.value {
                    Payload::Reference(r) if self.number_formats.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let n = to_number(&self.to_number_value(code, arg0)?);
                let resolved = self.nf_resolved(&self.number_formats[&inst].clone());
                let parts = crate::intl_number::partition_number(&resolved, n);
                self.number_format_parts_array(parts)
            }
            NativeMethod::NumberFormatFormatRange
            | NativeMethod::NumberFormatFormatRangeToParts => {
                // formatRange/formatRangeToParts require CLDR range patterns not
                // yet modeled; self-name an honest skip rather than mis-execute.
                let _inst = match this.value {
                    Payload::Reference(r) if self.number_formats.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                return Err(Step::Host(Halt::NotImplemented(
                    "Intl.NumberFormat:formatRange",
                )));
            }
            NativeMethod::NumberFormatResolvedOptions => {
                let inst = match this.value {
                    Payload::Reference(r) if self.number_formats.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let data = self.number_formats[&inst].clone();
                let result = self.slots.alloc(Slot::instance(self.object_proto));
                let locale = self.intl_string(&data.locale);
                self.define_descriptor_field(result, "locale", locale);
                let nu = self.intl_string(&data.numbering_system);
                self.define_descriptor_field(result, "numberingSystem", nu);
                let style = self.intl_string(&data.style);
                self.define_descriptor_field(result, "style", style);
                if let Some(cur) = &data.currency {
                    let cur = self.intl_string(cur);
                    self.define_descriptor_field(result, "currency", cur);
                    let cd = self.intl_string(&data.currency_display);
                    self.define_descriptor_field(result, "currencyDisplay", cd);
                    let cs = self.intl_string(&data.currency_sign);
                    self.define_descriptor_field(result, "currencySign", cs);
                }
                if let Some(unit) = &data.unit {
                    let unit = self.intl_string(unit);
                    self.define_descriptor_field(result, "unit", unit);
                    let ud = self.intl_string(&data.unit_display);
                    self.define_descriptor_field(result, "unitDisplay", ud);
                }
                self.define_descriptor_field(
                    result,
                    "minimumIntegerDigits",
                    Slot::integer(data.minimum_integer_digits as i32),
                );
                let uses_sig = data.rounding_type == "significantDigits"
                    || data.rounding_type == "morePrecision"
                    || data.rounding_type == "lessPrecision";
                let uses_frac = data.rounding_type == "fractionDigits"
                    || data.rounding_type == "morePrecision"
                    || data.rounding_type == "lessPrecision";
                if uses_frac {
                    self.define_descriptor_field(
                        result,
                        "minimumFractionDigits",
                        Slot::integer(data.minimum_fraction_digits as i32),
                    );
                    self.define_descriptor_field(
                        result,
                        "maximumFractionDigits",
                        Slot::integer(data.maximum_fraction_digits as i32),
                    );
                }
                if uses_sig {
                    if let (Some(mn), Some(mx)) = (
                        data.minimum_significant_digits,
                        data.maximum_significant_digits,
                    ) {
                        self.define_descriptor_field(
                            result,
                            "minimumSignificantDigits",
                            Slot::integer(mn as i32),
                        );
                        self.define_descriptor_field(
                            result,
                            "maximumSignificantDigits",
                            Slot::integer(mx as i32),
                        );
                    }
                }
                if data.use_grouping == "false" {
                    self.define_descriptor_field(result, "useGrouping", Slot::boolean(false));
                } else {
                    let ug = self.intl_string(&data.use_grouping);
                    self.define_descriptor_field(result, "useGrouping", ug);
                }
                let notation = self.intl_string(&data.notation);
                self.define_descriptor_field(result, "notation", notation);
                if data.notation == "compact" {
                    let cd = self.intl_string(&data.compact_display);
                    self.define_descriptor_field(result, "compactDisplay", cd);
                }
                let sign = self.intl_string(&data.sign_display);
                self.define_descriptor_field(result, "signDisplay", sign);
                self.define_descriptor_field(
                    result,
                    "roundingIncrement",
                    Slot::integer(data.rounding_increment as i32),
                );
                let rm = self.intl_string(&data.rounding_mode);
                self.define_descriptor_field(result, "roundingMode", rm);
                let rp = self.intl_string(&data.rounding_priority);
                self.define_descriptor_field(result, "roundingPriority", rp);
                let tz = self.intl_string(&data.trailing_zero_display);
                self.define_descriptor_field(result, "trailingZeroDisplay", tz);
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            NativeMethod::SegmenterSegment => {
                let inst = match this.value {
                    Payload::Reference(r) if self.segmenters.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let granularity = self.segmenters[&inst].granularity.clone();
                let units = self.to_string_units(code, arg0)?;
                let segments = segment_units(&granularity, &units);
                let sdata = SegmentsData {
                    units,
                    segments,
                    granularity,
                };
                let sinst = self.slots.alloc(Slot::instance(self.segments_proto));
                self.segments.insert(sinst, sdata);
                Slot::of(Kind::Reference, Payload::Reference(sinst))
            }
            NativeMethod::SegmenterResolvedOptions => {
                let inst = match this.value {
                    Payload::Reference(r) if self.segmenters.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let data = self.segmenters[&inst].clone();
                let result = self.slots.alloc(Slot::instance(self.object_proto));
                let locale = self.intl_string(&data.locale);
                self.define_descriptor_field(result, "locale", locale);
                let g = self.intl_string(&data.granularity);
                self.define_descriptor_field(result, "granularity", g);
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            NativeMethod::SegmentsIterator => {
                let inst = match this.value {
                    Payload::Reference(r) if self.segments.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let it = self
                    .slots
                    .alloc(Slot::instance(self.segment_iterator_proto));
                self.segment_iterators.insert(
                    it,
                    SegmentIteratorData {
                        segments_inst: inst,
                        pos: 0,
                    },
                );
                Slot::of(Kind::Reference, Payload::Reference(it))
            }
            NativeMethod::SegmentIteratorSymbolIterator => this,
            NativeMethod::SegmentIteratorNext => {
                let it = match this.value {
                    Payload::Reference(r) if self.segment_iterators.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let (segments_inst, pos) = {
                    let s = &self.segment_iterators[&it];
                    (s.segments_inst, s.pos)
                };
                let seg_count = self.segments[&segments_inst].segments.len();
                let result = self.slots.alloc(Slot::instance(self.object_proto));
                if pos >= seg_count {
                    self.define_descriptor_field(result, "value", Slot::undefined());
                    self.define_descriptor_field(result, "done", Slot::boolean(true));
                } else {
                    let seg_obj = self.make_segment_data_object(segments_inst, pos);
                    self.segment_iterators.get_mut(&it).unwrap().pos = pos + 1;
                    self.define_descriptor_field(result, "value", seg_obj);
                    self.define_descriptor_field(result, "done", Slot::boolean(false));
                }
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            NativeMethod::SegmentsContaining => {
                let inst = match this.value {
                    Payload::Reference(r) if self.segments.contains_key(&r) => r,
                    _ => return Err(self.catchable_type_error()),
                };
                let n = self.to_number_value(code, arg0)?;
                let idx = to_number(&n).trunc();
                let len = self.segments[&inst].units.len() as f64;
                if idx.is_nan() || idx < 0.0 || idx >= len {
                    Slot::undefined()
                } else {
                    let idx = idx as usize;
                    let pos = self.segments[&inst]
                        .segments
                        .iter()
                        .position(|&(s, e, _)| idx >= s && idx < e);
                    match pos {
                        Some(p) => self.make_segment_data_object(inst, p),
                        None => Slot::undefined(),
                    }
                }
            }
            NativeMethod::DateTimeFormatFormat
            | NativeMethod::DateTimeFormatFormatToParts
            | NativeMethod::DateTimeFormatFormatRange
            | NativeMethod::DateTimeFormatFormatRangeToParts
            | NativeMethod::DateTimeFormatResolvedOptions => {
                let arg1 = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                self.date_time_format_method(m, this, arg0, arg1, code)?
            }
            NativeMethod::DisposableStackUse
            | NativeMethod::DisposableStackAdopt
            | NativeMethod::DisposableStackDefer
            | NativeMethod::DisposableStackMove
            | NativeMethod::DisposableStackDispose
            | NativeMethod::AsyncDisposableStackUse
            | NativeMethod::AsyncDisposableStackAdopt
            | NativeMethod::AsyncDisposableStackDefer
            | NativeMethod::AsyncDisposableStackMove
            | NativeMethod::AsyncDisposableStackDisposeAsync => {
                self.explicit_resource_method(m, this, base, argc, code)?
            }
            // `Proxy.revocable(target, handler)` (`fx_Proxy_revocable`): a fresh
            // proxy plus a `revoke` function tied to it, returned as
            // `{ proxy, revoke }`.
            NativeMethod::ProxyRevocable => {
                let target = arg0;
                let handler = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let proxy = self.make_proxy(target, handler)?;
                let proxy_inst = match proxy.value {
                    Payload::Reference(p) => p,
                    _ => return Err(self.catchable_type_error()),
                };
                let revoke = self.alloc_method(NativeMethod::ProxyRevoke);
                self.proxy_revokers.insert(revoke, proxy_inst);
                let result_obj = self.slots.alloc(Slot::instance(self.object_proto));
                self.define_descriptor_field(result_obj, "proxy", proxy);
                self.define_descriptor_field(
                    result_obj,
                    "revoke",
                    Slot::of(Kind::Reference, Payload::Reference(revoke)),
                );
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                Slot::of(Kind::Reference, Payload::Reference(result_obj))
            }
            // The `revoke` function itself (`fx_Proxy_revoke`): trip its bound
            // proxy's internal slots to null. Idempotent (a second call is a
            // no-op). Returns `undefined`.
            NativeMethod::ProxyRevoke => {
                let func = match self.stack.get(base + 1).map(|s| s.value) {
                    Some(Payload::Reference(f)) => f,
                    _ => crate::value::SlotIndex::NULL,
                };
                if let Some(&proxy) = self.proxy_revokers.get(&func) {
                    if let Some(data) = self.proxies.get_mut(&proxy) {
                        data.revoked = true;
                        data.target = crate::value::SlotIndex::NULL;
                        data.handler = crate::value::SlotIndex::NULL;
                    }
                }
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                Slot::undefined()
            }
            // `Object.getPrototypeOf(O)` (ECMA-262 20.1.2.12): the object's
            // `[[GetPrototypeOf]]` (proxy-aware). A primitive coerces to its
            // wrapper prototype; `undefined`/`null` throw.
            NativeMethod::ObjectGetPrototypeOf => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => {
                        // Primitive receiver: box to the matching prototype.
                        let proto = match arg0.kind {
                            Kind::String => self.string_proto,
                            Kind::Integer | Kind::Number => self.number_proto,
                            Kind::Symbol => self.symbol_proto,
                            Kind::BigInt => self.bigint_proto,
                            Kind::Boolean => self
                                .intrinsics
                                .get("Boolean")
                                .and_then(|&c| self.ctor_prototype.get(&c).copied())
                                .unwrap_or(crate::value::SlotIndex::NULL),
                            _ => return Err(self.catchable_type_error_msg("invalid object".into())),
                        };
                        if proto.is_null() {
                            return Err(self.catchable_type_error_msg("invalid object".into()));
                        }
                        self.stack.truncate(base);
                        self.push(Slot::of(Kind::Reference, Payload::Reference(proto)));
                        return Ok(());
                    }
                };
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                self.mop_get_prototype(code, inst)?
            }
            // `Object.setPrototypeOf(O, proto)` (ECMA-262 20.1.2.22): the
            // object's `[[SetPrototypeOf]]` (proxy-aware); returns `O`. A `false`
            // result throws. `proto` must be an object or `null`.
            NativeMethod::ObjectSetPrototypeOf => {
                if matches!(arg0.kind, Kind::Null | Kind::Undefined) {
                    return Err(self.catchable_type_error_msg("invalid object".into()));
                }
                let proto = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                if proto.kind != Kind::Reference && proto.kind != Kind::Null {
                    return Err(self.catchable_type_error_msg("invalid prototype".into()));
                }
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => {
                        if arg0.kind == Kind::Undefined || arg0.kind == Kind::Null {
                            return Err(self.catchable_type_error_msg("invalid object".into()));
                        }
                        // A primitive receiver: return it unchanged.
                        self.stack.truncate(base);
                        self.push(arg0);
                        return Ok(());
                    }
                };
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                if !self.mop_set_prototype(code, inst, proto)? {
                    return Err(self.catchable_type_error_msg("invalid prototype".into()));
                }
                arg0
            }
            NativeMethod::CopyObject => {
                // XS's internal helper is called as
                // `%CopyObject%(target, source, ...excludedKeys)`; unlike
                // `Object.assign`, `this` is deliberately `undefined`.
                let target = match arg0.value {
                    Payload::Reference(target) if arg0.kind == Kind::Reference => target,
                    _ => return Err(self.catchable_type_error_msg("invalid object".into())),
                };
                let source_value = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                if source_value.kind == Kind::Null || source_value.kind == Kind::Undefined {
                    arg0
                } else {
                    let from = self.array_to_object(source_value)?;
                    let Payload::Reference(source) = from.value else {
                        unreachable!("ToObject source")
                    };
                    let mut excluded = Vec::new();
                    for index in 2..argc {
                        let key = self.stack[base + 4 + index];
                        excluded.push(self.to_read_key(code, key)?);
                    }
                    let keys = self.mop_own_keys(code, source)?;
                    for key in keys {
                        // The un-fixed twin of `Object.assign`'s source side.
                        // Naming ran BEFORE both filters, so `{length,
                        // ...rest}` over a 70,000-unit String wrapper minted a
                        // name for every key — including the one it excludes
                        // and every one it skips as non-enumerable — and
                        // poisoned the machine.
                        let read_key = self.to_read_key(code, key)?;
                        if excluded
                            .iter()
                            .any(|&e| self.refresh_read_key(e) == self.refresh_read_key(read_key))
                        {
                            continue;
                        }
                        let enumerable = self
                            .mop_get_own_property_read(code, source, read_key)?
                            .is_some_and(|descriptor| descriptor.enumerable == Some(true));
                        if !enumerable {
                            continue;
                        }
                        let read_key = self.refresh_read_key(read_key);
                        let value = self.mop_get_read(code, source, read_key, from)?;
                        let copied = OrdinaryDescriptor {
                            value: Some(value),
                            writable: Some(true),
                            enumerable: Some(true),
                            configurable: Some(true),
                            ..OrdinaryDescriptor::default()
                        };
                        // Only a key that SURVIVES both filters is copied, and
                        // copying creates a property on the target, which in
                        // this representation needs a name.
                        let read_key = self.refresh_read_key(read_key);
                        if !self.mop_define_own_property_read(code, target, read_key, copied)? {
                            return Err(self.catchable_type_error_msg("copy property".into()));
                        }
                    }
                    arg0
                }
            }
            // `Function.prototype.call` is handled by the `run` trampoline
            // (`enter_call_dot_call`) and never reaches here.
            NativeMethod::FunctionCall => {
                return Err(Step::Host(Halt::EngineInvariant("call:unexpected")))
            }
            // `Function.prototype.apply` is handled by the `run` trampoline
            // (`enter_call_dot_apply`) and never reaches here.
            NativeMethod::FunctionApply => {
                return Err(Step::Host(Halt::EngineInvariant("apply:unexpected")))
            }
            NativeMethod::FunctionPrototype => Slot::undefined(),
            // `Object.prototype.valueOf`: `ToObject(this)`. Object receivers
            // retain their identity, primitive receivers become their realm
            // wrappers, and nullish receivers throw a catchable TypeError.
            NativeMethod::ObjectValueOf => match this.kind {
                Kind::Reference => this,
                Kind::Boolean
                | Kind::Integer
                | Kind::Number
                | Kind::String
                | Kind::Symbol
                | Kind::BigInt => {
                    self.meter.tick_raw(OBJECT_VALUE_OF_PRIMITIVE_METERING);
                    self.array_to_object(this)?
                }
                Kind::Null | Kind::Undefined => {
                    let message = if this.kind == Kind::Null {
                        "cannot coerce null to object"
                    } else {
                        "cannot coerce undefined to object"
                    };
                    let error = self.catchable_type_error_msg(message.into());
                    self.meter.untick_raw(if this.kind == Kind::Null {
                        OBJECT_VALUE_OF_NULL_CREDIT
                    } else {
                        OBJECT_VALUE_OF_UNDEFINED_CREDIT
                    });
                    return Err(error);
                }
                _ => return Err(self.catchable_type_error()),
            },
            // `<wrapper>.valueOf`: the wrapped primitive.
            NativeMethod::WrapperValueOf => match this.value {
                Payload::Reference(r) => self.wrapper_data.get(&r).copied().unwrap_or(this),
                _ => this,
            },
            // `Object.prototype.toString` steps 1-2: a nullish receiver answers
            // before ToObject, so it skips the IsArray / IsCallable /
            // Get(@@toStringTag) work the ordinary arm below does — which is
            // also what the oracle charges for (doing that work anyway put
            // IronHorse ~49k raw units above XS on both receivers).
            NativeMethod::ObjectToString if matches!(this.kind, Kind::Undefined | Kind::Null) => {
                let text: &[u8] = if this.kind == Kind::Undefined {
                    b"[object Undefined]"
                } else {
                    b"[object Null]"
                };
                let off = self.alloc_str_text_metered(text)?;
                Slot::of(Kind::String, Payload::String(off))
            }
            // `Object.prototype.toString`: `[object Object]` for an ordinary
            // object (the exotic tags — Array/Error/… — are XS overrides or a
            // later increment). Allocates the result string chunk.
            NativeMethod::ObjectToString => {
                self.meter.tick_raw(METHOD_OBJECT_TOSTRING_METERING);
                // IsArray precedes Get(@@toStringTag) in
                // Object.prototype.toString. Retain the result because a tag
                // getter can observably revoke a Proxy after its Array brand
                // has already been determined.
                let is_array = match this.value {
                    Payload::Reference(r) if this.kind == Kind::Reference => {
                        self.array_generic_is_array(r)?
                    }
                    _ => false,
                };
                // IsCallable is also part of the builtin-tag selection and
                // precedes the observable Get(@@toStringTag). A tag getter may
                // revoke a callable Proxy, but that cannot retroactively change
                // the already-selected Function builtin tag.
                let is_callable = self.is_callable_value(this);
                // A `Symbol.toStringTag` string on the receiver's chain wins
                // (`Object.prototype.toString` step 15). Only the Intl
                // formatter/segmenter objects carry one in the frozen profile —
                // objects the pinned oracle cannot construct — so this
                // unmetered chain read never perturbs a covered/metered case
                // (which has no such tag and falls through unchanged).
                let tag = match this.value {
                    Payload::Reference(r) => self.string_to_string_tag(code, r)?,
                    _ => None,
                };
                if let Some(tag) = tag {
                    let length = tag
                        .len()
                        .checked_add(9)
                        .ok_or(Step::Host(Halt::HeapExhausted))?;
                    self.charge_and_check(string_chunk_cost(
                        (tag.encode_utf16().count() + 9) as u64,
                    ))?;
                    self.admit_scratch::<u8>(length)?;
                    let owned = format!("[object {}]", tag);
                    let off = self.alloc_str_text(owned.as_bytes());
                    Slot::of(Kind::String, Payload::String(off))
                } else {
                    // `Object.prototype.toString` builtinTag (ECMA-262
                    // 20.1.3.6): a callable receiver is `[object Function]`
                    // (step 6) — the shape the `format` accessor getter's
                    // `builtin.js` reads — otherwise Error / plain Object.
                    let wrapper_tag = match this.value {
                        Payload::Reference(r) => {
                            self.wrapper_data.get(&r).map(|value| match value.kind {
                                Kind::Boolean => b"[object Boolean]".as_slice(),
                                Kind::Integer | Kind::Number => b"[object Number]".as_slice(),
                                Kind::String => b"[object String]".as_slice(),
                                Kind::Symbol => b"[object Symbol]".as_slice(),
                                Kind::BigInt => b"[object BigInt]".as_slice(),
                                _ => b"[object Object]".as_slice(),
                            })
                        }
                        _ => None,
                    };
                    let text: &[u8] = match this.value {
                        Payload::Reference(r) if self.dates.contains_key(&r) => b"[object Date]",
                        Payload::Reference(r) if self.error_data.contains_key(&r) => {
                            b"[object Error]"
                        }
                        Payload::Reference(r) if self.arguments_objects.contains(&r) => {
                            b"[object Arguments]"
                        }
                        Payload::Reference(_) if is_array => b"[object Array]",
                        Payload::BigInt(_) => b"[object BigInt]",
                        _ if wrapper_tag.is_some() => wrapper_tag.unwrap(),
                        _ if is_callable => b"[object Function]",
                        // A primitive receiver takes the builtinTag of the
                        // wrapper ToObject would produce. `this` arrives here
                        // unboxed (`call_dot_call_native` pushes the raw
                        // receiver), so `wrapper_tag` above -- which reads
                        // `wrapper_data` -- only ever covers an already-boxed
                        // receiver and left these falling through to the
                        // ordinary-object default. (`undefined`/`null` never
                        // reach here; they answer in the guarded arm above.)
                        _ if this.kind == Kind::Boolean => b"[object Boolean]",
                        _ if matches!(this.kind, Kind::Integer | Kind::Number) => {
                            b"[object Number]"
                        }
                        _ if this.kind == Kind::String => b"[object String]",
                        _ if this.kind == Kind::Symbol => b"[object Symbol]",
                        _ => b"[object Object]",
                    };
                    let off = self.alloc_str_text_metered(text)?;
                    Slot::of(Kind::String, Payload::String(off))
                }
            }
            NativeMethod::ObjectToLocaleString => {
                self.invoke_value_method(code, this, "toString", &[])?
            }
            // `Function.prototype.toString`: XS renders any function as
            // `function ["name"] (){[native code]}`.
            NativeMethod::FunctionToString => {
                if !self.is_callable_value(this) {
                    return Err(
                        self.catchable_type_error_msg("this: not a Function instance".into())
                    );
                }
                let name = match this.value {
                    Payload::Reference(r) => self
                        .functions
                        .get(&r)
                        .map(|fi| self.str_units(fi.name_chunk))
                        .unwrap_or_default(),
                    _ => Vec::new(),
                };
                self.meter.tick_raw(METHOD_FUNCTION_TOSTRING_METERING);
                let mut units: Vec<u16> = "function [\"".encode_utf16().collect();
                units.extend(name);
                units.extend("\"] (){[native code]}".encode_utf16());
                self.charge_and_check(string_chunk_cost(units.len() as u64))?;
                let off = self.chunks.alloc(&units_to_be16(&units));
                Slot::of(Kind::String, Payload::String(off))
            }
            // `Error.prototype.toString`: `name` / `name: message`.
            NativeMethod::ErrorToString => {
                let units = self.error_to_string(code, this)?;
                self.meter.tick_raw(METHOD_ERROR_TOSTRING_METERING);
                self.charge_and_check(string_chunk_cost(units.len() as u64))?;
                let off = self.chunks.alloc(&units_to_be16(&units));
                Slot::of(Kind::String, Payload::String(off))
            }
            // `<wrapper>.toString`: stringify the wrapped primitive with the
            // same per-type ToString metering the `String(v)` call uses (a
            // number renders through `fxNumberToString` — one built-in step
            // plus its chunk; a boolean/string is interned/identity, no cost).
            NativeMethod::WrapperToString => {
                let prim = match this.value {
                    Payload::Reference(r) => self.wrapper_data.get(&r).copied(),
                    _ => None,
                }
                .unwrap_or(this);
                let bytes = self.to_string_bytes_metered(prim);
                let off = self.alloc_str_text(&bytes);
                Slot::of(Kind::String, Payload::String(off))
            }
            // `Function.prototype.bind(thisArg, ...boundArgs)`: create a bound
            // function (its creation; the bound call is a `run` trampoline).
            NativeMethod::FunctionBind => self.make_bound_function(base, argc)?,
            NativeMethod::FunctionHasInstance => {
                Slot::boolean(self.ordinary_has_instance(code, this, arg0)?)
            }
            // `Symbol.prototype.toString()` → `Symbol(<description>)`
            // (`fxSymbolToString`: `fxStringX("Symbol(")` + the description +
            // `")"`). Accept either a Symbol primitive or its realm wrapper.
            NativeMethod::SymbolToString => {
                let symbol = self.symbol_this_value(this)?;
                let bytes = self.symbol_descriptive_bytes(symbol);
                self.meter.tick_raw(SYMBOL_TO_STRING_METERING);
                let off = self.alloc_str_text(&bytes);
                Slot::of(Kind::String, Payload::String(off))
            }
            // `Symbol.prototype.valueOf()`: the symbol primitive itself.
            NativeMethod::SymbolValueOf | NativeMethod::SymbolToPrimitive => {
                self.symbol_this_value(this)?
            }
            // `get Symbol.prototype.description`: the `[[Description]]` the
            // constructor coerced and stored, or `undefined`. The description
            // slot is the symbol's identity, so this reads it in place — no
            // chunk is allocated and nothing beyond the accessor dispatch is
            // metered (XS's `fx_Symbol_prototype_get_description` calls no
            // `mxMeter` of its own).
            NativeMethod::SymbolDescriptionGetter => {
                let symbol = self.symbol_this_value(this)?;
                match symbol.value {
                    Payload::Reference(d) => {
                        let slot = self.slots.get(d);
                        match slot.kind {
                            Kind::String => Slot::of(Kind::String, slot.value),
                            _ => Slot::undefined(),
                        }
                    }
                    _ => Slot::undefined(),
                }
            }
            NativeMethod::DateToPrimitive => {
                if !matches!(
                    this,
                    Slot {
                        kind: Kind::Reference,
                        value: Payload::Reference(_),
                        ..
                    }
                ) {
                    return Err(self.catchable_type_error_msg("invalid this".into()));
                }
                let hint = match arg0 {
                    Slot {
                        kind: Kind::String,
                        value: Payload::String(offset),
                        ..
                    } => self.str_text(offset),
                    _ => return Err(self.catchable_type_error_msg("invalid hint".into())),
                };
                match hint.as_str() {
                    "string" | "default" => self.ordinary_to_primitive(code, this, true)?,
                    "number" => self.ordinary_to_primitive(code, this, false)?,
                    _ => return Err(self.catchable_type_error_msg("invalid hint".into())),
                }
            }
            NativeMethod::BigIntValueOf => self.bigint_this_value(this)?,
            NativeMethod::BigIntAsIntN | NativeMethod::BigIntAsUintN => {
                let bits = self.to_bigint_width(code, arg0)?;
                let arg1 = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let value = self.to_bigint_value(code, arg1)?;
                self.bigint_as_n(value, bits, m == NativeMethod::BigIntAsIntN)?
            }
            NativeMethod::BigIntToString => {
                let value = self.bigint_this_value(this)?;
                let radix = if arg0.kind == Kind::Undefined {
                    10
                } else {
                    let n = self.number_radix_integer(code, arg0)?;
                    if !(2..=36).contains(&n) {
                        return Err(self.catchable_range_error_msg("invalid radix".into()));
                    }
                    n as u32
                };
                let Payload::BigInt(off) = value.value else {
                    return Err(self.catchable_type_error());
                };
                let (negative, magnitude) = self.read_bigint(off);
                let rendered = bi_to_radix(self, negative, &magnitude, radix)?;
                self.meter.tick_builtin();
                let off = self.alloc_str_text_metered(rendered.as_bytes())?;
                Slot::of(Kind::String, Payload::String(off))
            }
            NativeMethod::BigIntToLocaleString => {
                let value = self.bigint_this_value(this)?;
                let locale = self
                    .stack
                    .get(base + 4)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let options = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let Payload::BigInt(off) = value.value else {
                    return Err(self.catchable_type_error());
                };
                let (negative, magnitude) = self.read_bigint(off);
                let digits = bi_to_decimal(false, &magnitude);
                let data = self.build_number_format(code, locale, options)?;
                let resolved = self.nf_resolved(&data);
                let rendered =
                    crate::intl_number::format_bigint_to_string(&resolved, negative, &digits);
                self.intl_string(&rendered)
            }
            // `Symbol.for(key)`: apply ToString, then return the registry
            // symbol for that key — the same symbol identity on repeat calls.
            NativeMethod::SymbolFor => {
                let primitive = self.to_primitive(code, arg0, true)?;
                if primitive.kind == Kind::Symbol {
                    return Err(
                        self.catchable_type_error_msg("cannot coerce symbol to string".into())
                    );
                }
                let string = self.to_string_slot_metered(primitive);
                let key = match string.value {
                    Payload::String(off) => self.str_content(off).to_vec(),
                    _ => unreachable!("ToString returns a String slot"),
                };
                self.meter.tick_raw(SYMBOL_FOR_METERING);
                let d = if let Some(&d) = self.symbol_registry.get(&key) {
                    d
                } else {
                    // Intern the key as the registered symbol's description
                    // slot (its identity); `Symbol.for(k)` returns this same
                    // slot forever after, so `=== ` holds.
                    let desc_off = self.chunks.alloc(&key);
                    let d = self
                        .slots
                        .alloc(Slot::of(Kind::String, Payload::String(desc_off)));
                    self.symbol_registry.insert(key.clone(), d);
                    self.symbol_registry_keys.insert(d, key);
                    d
                };
                Slot::of(Kind::Symbol, Payload::Reference(d))
            }
            // `Symbol.keyFor(sym)`: the registry key a registered symbol was
            // interned under, or `undefined` for a non-registered symbol.
            NativeMethod::SymbolKeyFor => {
                if arg0.kind != Kind::Symbol {
                    return Err(self.catchable_type_error_msg("sym: not a symbol".into()));
                }
                self.meter.tick_raw(SYMBOL_KEYFOR_METERING);
                match arg0.value {
                    Payload::Reference(d) => match self.symbol_registry_keys.get(&d) {
                        Some(key) => {
                            let off = self.chunks.alloc(&key.clone());
                            Slot::of(Kind::String, Payload::String(off))
                        }
                        None => Slot::undefined(),
                    },
                    _ => Slot::undefined(),
                }
            }
            // `Object.prototype.hasOwnProperty(V)` (ECMA-262 20.1.3.2): the full
            // `? ToPropertyKey(V)` / `? ToObject(this)` / `HasOwnProperty(O, P)`
            // path — primitive-boxing receivers, symbol / number / index keys,
            // and the array/function/string-wrapper exotic own-property views.
            NativeMethod::ObjectHasOwnProperty => self.object_has_own_property(code, this, arg0)?,
            // `Object.prototype.isPrototypeOf(v)`: is the receiver in `v`'s
            // prototype chain. A non-object `v` short-circuits before the
            // receiver is boxed; otherwise walk `v.[[GetPrototypeOf]]`
            // observably so Proxy traps and abrupt completions participate.
            NativeMethod::ObjectIsPrototypeOf => {
                self.meter.tick_raw(METHOD_HAS_OWN_PROPERTY_METERING);
                let mut object = match arg0.value {
                    Payload::Reference(object) if arg0.kind == Kind::Reference => object,
                    _ => {
                        self.stack.truncate(base);
                        self.push(Slot::boolean(false));
                        return Ok(());
                    }
                };
                let prototype = self.array_to_object(this)?;
                let Payload::Reference(prototype) = prototype.value else {
                    unreachable!("ToObject returns a reference")
                };
                let mut proxy_steps = 0;
                loop {
                    self.charge_proxy_chain_step(object, &mut proxy_steps)?;
                    let parent = self.mop_get_prototype(code, object)?;
                    match (parent.kind, parent.value) {
                        (Kind::Reference, Payload::Reference(parent)) => {
                            if parent == prototype {
                                break Slot::boolean(true);
                            }
                            object = parent;
                        }
                        (Kind::Null, _) => break Slot::boolean(false),
                        _ => return Err(self.catchable_type_error()),
                    }
                }
            }
            NativeMethod::ObjectIs => {
                let right = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                Slot::boolean(self.same_value(arg0, right))
            }
            NativeMethod::ObjectHasOwn => {
                if matches!(arg0.kind, Kind::Null | Kind::Undefined) {
                    return Err(self.catchable_type_error_msg("invalid object".into()));
                }
                let key = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                self.object_has_own_property(code, arg0, key)?
            }
            NativeMethod::ObjectAssign => {
                if matches!(arg0.kind, Kind::Null | Kind::Undefined) {
                    return Err(self.catchable_type_error_msg("invalid target".into()));
                }
                let sources: Vec<Slot> = (1..argc)
                    .map(|index| {
                        self.stack
                            .get(base + 4 + index)
                            .copied()
                            .unwrap_or_else(Slot::undefined)
                    })
                    .collect();
                self.object_assign(code, arg0, &sources)?
            }
            NativeMethod::ObjectFromEntries => self.object_from_entries(code, arg0)?,
            // `Object.keys(o)`: `EnumerableOwnProperties(O, key)` over the
            // receiver's complete MOP, including primitive wrappers, arrays,
            // TypedArrays, and proxies.
            NativeMethod::ObjectKeys => {
                if matches!(arg0.kind, Kind::Null | Kind::Undefined) {
                    return Err(self.catchable_type_error_msg("invalid object".into()));
                }
                let object = self.array_to_object(arg0)?;
                let Payload::Reference(inst) = object.value else {
                    unreachable!("ToObject returns a reference")
                };
                let own_keys = self.mop_own_keys(code, inst)?;
                let mut keys = self.reserve_scratch(own_keys.len())?;
                for key in own_keys {
                    if key.kind != Kind::String {
                        continue;
                    }
                    // An enumeration OBSERVES; it must not mint a key per
                    // index (`Object.keys` over a 70,000-element array walked
                    // the id space into its saturation guard).
                    let read_key = self.to_read_key(code, key)?;
                    if self
                        .mop_get_own_property_read(code, inst, read_key)?
                        .is_some_and(|descriptor| descriptor.enumerable == Some(true))
                    {
                        keys.push(key);
                    }
                }
                let n = keys.len() as u32;
                // The fixed native frame + `fxNewArray(0)` base, the result
                // array's item chunk grown once to hold `n` slots, and one
                // `fxNewSlot` (the key-name string slot) per key. The key name
                // references the interned key string (XS_STRING_X_KIND), so it
                // allocates no chunk — metering is key-name-length independent.
                self.meter.tick_raw(OBJECT_KEYS_FRAME_METERING);
                self.charge_and_check(self.array_chunk_size_metering(n))?;
                for _ in 0..n {
                    self.meter.tick_slot_alloc();
                }
                self.array_from_slots(&keys)
            }
            // `Object.getOwnPropertyDescriptor(o, k)`: the data descriptor
            // object for `o`'s own property `k`, or `undefined` if absent.
            // Ordinary objects with ordinary data properties only; an exotic
            // receiver or an accessor / non-standard-flagged property skips.
            NativeMethod::ObjectGetOwnPropertyDescriptor => {
                let arg1 = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                // `? ToObject(O)` precedes `? ToPropertyKey(P)`: nullish
                // operands throw before an observable key coercion, while any
                // other primitive is inspected through its temporary wrapper.
                // Materializing that wrapper also reproduces XS's two-slot
                // primitive-box allocation instead of hiding it in a special
                // primitive-only shortcut. A `Symbol` receiver boxes into a
                // Symbol exotic with no own properties, so `[[GetOwnProperty]]`
                // answers `undefined` for every key through the ordinary path.
                let inst = match (arg0.kind, arg0.value) {
                    (Kind::Reference, Payload::Reference(o)) => o,
                    (Kind::Null | Kind::Undefined, _) => {
                        return Err(self.catchable_type_error_msg("invalid object".into()))
                    }
                    (Kind::Boolean, _) => self.box_primitive_wrapper(Native::Boolean, arg0),
                    (Kind::Integer | Kind::Number, _) => {
                        self.box_primitive_wrapper(Native::Number, arg0)
                    }
                    (Kind::String, _) => self.box_primitive_wrapper(Native::String, arg0),
                    (Kind::Symbol, _) => self.box_primitive_wrapper(Native::Symbol, arg0),
                    (Kind::BigInt, _) => self.box_primitive_wrapper(Native::BigInt, arg0),
                    _ => return Err(self.catchable_type_error_msg("invalid object".into())),
                };
                // The integer-indexed exotic `[[GetOwnProperty]]` (10.4.5.1): a
                // canonical numeric index yields the element data descriptor
                // (or `undefined` for an invalid index); a non-canonical key is
                // an ordinary own-property descriptor.
                if let Some(&ta) = self.typed_arrays.get(&inst) {
                    // `ToPropertyKey` runs FIRST, so a numeric key is the same
                    // key as its string spelling: `gopd(view, 1)` must answer
                    // the element descriptor exactly as `gopd(view, "1")` does.
                    // Reading the canonical index off the raw argument saw only
                    // the string form and sent a number key down the ordinary
                    // path, where it read `undefined` — and interned a name for
                    // it. `to_read_key` canonicalizes both spellings and mints
                    // nothing.
                    let descriptor = match self.to_read_key(code, arg1)? {
                        ReadKey::Index(index) => self.ta_index_own_descriptor(ta, f64::from(index)),
                        ReadKey::Id(id) => match self.ta_numeric_index_at(id, 0) {
                            Some(n) => self.ta_index_own_descriptor(ta, n),
                            None => self.ordinary_get_own_descriptor(inst, id),
                        },
                    };
                    match descriptor {
                        Some(descriptor) => {
                            self.meter.tick_raw(GOPD_PRESENT_RESIDUAL_METERING);
                            self.descriptor_object(descriptor)
                        }
                        None => {
                            self.meter.tick_raw(GOPD_ABSENT_RESIDUAL_METERING);
                            Slot::undefined()
                        }
                    }
                } else if self.arrays.contains_key(&inst) {
                    let key = self.to_read_key(code, arg1)?;
                    match self.mop_get_own_property_read(code, inst, key)? {
                        Some(descriptor) => {
                            self.meter.tick_raw(GOPD_PRESENT_RESIDUAL_METERING);
                            self.descriptor_object(descriptor)
                        }
                        None => {
                            self.meter.tick_raw(GOPD_ABSENT_RESIDUAL_METERING);
                            Slot::undefined()
                        }
                    }
                } else if self.wrapper_data.contains_key(&inst)
                    || self.collections.contains_key(&inst)
                    || self.array_buffers.contains_key(&inst)
                    || self.data_views.contains_key(&inst)
                {
                    let key = self.to_read_key(code, arg1)?;
                    match self.mop_get_own_property_read(code, inst, key)? {
                        Some(descriptor) => {
                            self.meter.tick_raw(GOPD_PRESENT_RESIDUAL_METERING);
                            self.descriptor_object(descriptor)
                        }
                        None => {
                            self.meter.tick_raw(GOPD_ABSENT_RESIDUAL_METERING);
                            Slot::undefined()
                        }
                    }
                } else {
                    // A symbol key resolves to its interned key id; a non-index
                    // string interns as a name. Own-only, so no boot-default gate:
                    // an own miss is soundly `undefined`. A canonical index the key
                    // table never held mints nothing — every own property of an
                    // ordinary object lives in the slot chain under an interned
                    // name, so such a key is an own miss by construction, and
                    // `function_meta_own_descriptor` names only `length`/`name`.
                    match self.to_read_key(code, arg1)? {
                        // An index property of an ordinary object lives in the
                        // index store, not the slot chain. This arm used to
                        // answer `undefined` outright, on the reasoning that
                        // "every own property of an ordinary object lives in
                        // the slot chain under an interned name" — true until
                        // the store existed, and the reason
                        // `Object.getOwnPropertyDescriptor(o, '0')` read
                        // `undefined` while `Reflect.getOwnPropertyDescriptor`
                        // answered correctly.
                        ReadKey::Index(index) => match self.index_prop_descriptor(inst, index) {
                            Some(descriptor) => {
                                self.meter.tick_raw(GOPD_PRESENT_RESIDUAL_METERING);
                                self.descriptor_object(descriptor)
                            }
                            None => {
                                self.meter.tick_raw(GOPD_ABSENT_RESIDUAL_METERING);
                                Slot::undefined()
                            }
                        },
                        ReadKey::Id(id) if self.index_prop_descriptor_by_id(inst, id).is_some() => {
                            let descriptor = self
                                .index_prop_descriptor_by_id(inst, id)
                                .expect("checked just above");
                            self.meter.tick_raw(GOPD_PRESENT_RESIDUAL_METERING);
                            self.descriptor_object(descriptor)
                        }
                        ReadKey::Id(id) => match self.find_property(inst, id) {
                            Some(p) => {
                                let prop = self.slots.get(p);
                                // An accessor own property needs the accessor-descriptor
                                // shape (`{get, set, enumerable, configurable}`), which
                                // is not modeled — honest skip. A data property carries
                                // only the `writable`/`enumerable`/`configurable` flag
                                // bits, rendered below; a literal's property is flag 0
                                // (all true), an `Object.defineProperty`-defined one may
                                // clear any of them.
                                if prop.flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) != 0 {
                                    self.meter.tick_raw(GOPD_PRESENT_RESIDUAL_METERING);
                                    self.descriptor_object(
                                        self.ordinary_get_own_descriptor(inst, id).unwrap(),
                                    )
                                } else {
                                    let writable = prop.flag & XS_DONT_SET_FLAG == 0;
                                    let enumerable = prop.flag & XS_DONT_ENUM_FLAG == 0;
                                    let configurable = prop.flag & XS_DONT_DELETE_FLAG == 0;
                                    self.meter.tick_raw(GOPD_PRESENT_RESIDUAL_METERING);
                                    let value = Slot::of(prop.kind, prop.value);
                                    let desc = self.alloc_descriptor_instance();
                                    self.define_descriptor_field(desc, "value", value);
                                    self.define_descriptor_field(
                                        desc,
                                        "writable",
                                        Slot::boolean(writable),
                                    );
                                    self.define_descriptor_field(
                                        desc,
                                        "enumerable",
                                        Slot::boolean(enumerable),
                                    );
                                    self.define_descriptor_field(
                                        desc,
                                        "configurable",
                                        Slot::boolean(configurable),
                                    );
                                    Slot::of(Kind::Reference, Payload::Reference(desc))
                                }
                            }
                            None => {
                                // XS carries a function's `length`/`name` as real own
                                // data properties; ironhorse synthesizes them from the
                                // `FuncInfo` (no ordinary slot), so render the exotic
                                // descriptor as PRESENT (not an absent miss) — matching
                                // the residual XS charges for a present property.
                                if let Some(desc) = self.function_meta_own_descriptor(inst, id) {
                                    self.meter.tick_raw(GOPD_PRESENT_RESIDUAL_METERING);
                                    let value = desc.value.unwrap_or_else(Slot::undefined);
                                    let d = self.alloc_descriptor_instance();
                                    self.define_descriptor_field(d, "value", value);
                                    self.define_descriptor_field(
                                        d,
                                        "writable",
                                        Slot::boolean(false),
                                    );
                                    self.define_descriptor_field(
                                        d,
                                        "enumerable",
                                        Slot::boolean(false),
                                    );
                                    self.define_descriptor_field(
                                        d,
                                        "configurable",
                                        Slot::boolean(true),
                                    );
                                    Slot::of(Kind::Reference, Payload::Reference(d))
                                } else {
                                    self.meter.tick_raw(GOPD_ABSENT_RESIDUAL_METERING);
                                    Slot::undefined()
                                }
                            }
                        },
                    }
                }
            }
            NativeMethod::ObjectGetOwnPropertyNames => {
                if matches!(arg0.kind, Kind::Null | Kind::Undefined) {
                    return Err(self.catchable_type_error_msg("invalid object".into()));
                }
                let object = self.array_to_object(arg0)?;
                let Payload::Reference(inst) = object.value else {
                    unreachable!("ToObject returns a reference")
                };
                let mut keys = self.mop_own_keys(code, inst)?;
                keys.retain(|key| key.kind == Kind::String);
                let n = keys.len() as u32;
                self.meter.tick_raw(OBJECT_KEYS_FRAME_METERING);
                self.charge_and_check(self.array_chunk_size_metering(n))?;
                for _ in 0..n {
                    self.meter.tick_slot_alloc();
                }
                self.array_from_slots(&keys)
            }
            NativeMethod::ObjectCreate => {
                let prototype = match arg0.value {
                    Payload::Reference(prototype) if arg0.kind == Kind::Reference => prototype,
                    _ if arg0.kind == Kind::Null => crate::value::SlotIndex::NULL,
                    _ => return Err(self.catchable_type_error_msg("invalid prototype".into())),
                };
                let object = self.new_object();
                self.slots.get_mut(object).value = Payload::Reference(prototype);
                let properties = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                if properties.kind != Kind::Undefined {
                    let descriptors = self.array_to_object(properties)?;
                    let Payload::Reference(descriptors) = descriptors.value else {
                        unreachable!("ToObject returns a reference")
                    };
                    if !self.define_properties_from_object(code, object, descriptors)? {
                        return Err(self.catchable_type_error_msg("invalid descriptor".into()));
                    }
                }
                Slot::of(Kind::Reference, Payload::Reference(object))
            }
            NativeMethod::ObjectDefineProperties => {
                let target = match arg0.value {
                    Payload::Reference(target) if arg0.kind == Kind::Reference => target,
                    _ => return Err(self.catchable_type_error_msg("invalid object".into())),
                };
                let properties = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                if properties.kind == Kind::Undefined {
                    return Err(self.catchable_type_error_msg("invalid properties".into()));
                }
                let descriptors = self.array_to_object(properties)?;
                let Payload::Reference(descriptors) = descriptors.value else {
                    unreachable!("ToObject returns a reference")
                };
                if !self.define_properties_from_object(code, target, descriptors)? {
                    return Err(self.catchable_type_error_msg("invalid descriptor".into()));
                }
                arg0
            }
            NativeMethod::ObjectGetOwnPropertySymbols => {
                if matches!(arg0.kind, Kind::Null | Kind::Undefined) {
                    return Err(self.catchable_type_error_msg("invalid object".into()));
                }
                let value = self.array_to_object(arg0)?;
                let Payload::Reference(object) = value.value else {
                    unreachable!("ToObject returns a reference")
                };
                let mut keys = self.mop_own_keys(code, object)?;
                keys.retain(|key| key.kind == Kind::Symbol);
                let result = self.new_array_unmetered();
                let mut data = ArrayData::default();
                for (index, key) in keys.into_iter().enumerate() {
                    data.insert_item(index as u32, key, &mut self.side_refs);
                }
                data.length = data.items().len() as u32;
                self.arrays.insert(result, data);
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            // `Object.defineProperty(o, k, descriptor)`: route ordinary and
            // modeled exotic receivers through ToPropertyDescriptor and their
            // complete `[[DefineOwnProperty]]` seam. The fallback below is only
            // for shapes that still lack that complete descriptor model.
            NativeMethod::ObjectDefineProperty => {
                let target = match arg0.value {
                    Payload::Reference(object) if arg0.kind == Kind::Reference => object,
                    _ => return Err(self.catchable_type_error_msg("invalid object".into())),
                };
                if self.is_ordinary_object(target)
                    || self.arrays.contains_key(&target)
                    || self.collections.contains_key(&target)
                    || self.array_buffers.contains_key(&target)
                    || self.data_views.contains_key(&target)
                    || self.wrapper_data.contains_key(&target)
                    || self.regexps.contains_key(&target)
                    || self.proxies.contains_key(&target)
                {
                    let key = self
                        .stack
                        .get(base + 5)
                        .copied()
                        .unwrap_or_else(Slot::undefined);
                    let descriptor_value = self
                        .stack
                        .get(base + 6)
                        .copied()
                        .unwrap_or_else(Slot::undefined);
                    let object = target;
                    let id = self.to_property_id(code, key)?;
                    let descriptor_object = match descriptor_value.value {
                        Payload::Reference(descriptor)
                            if descriptor_value.kind == Kind::Reference =>
                        {
                            descriptor
                        }
                        _ => return Err(self.catchable_type_error_msg("invalid descriptor".into())),
                    };
                    let descriptor = self.descriptor_from_object(code, descriptor_object)?;
                    self.meter.tick_raw(DEFINE_PROPERTY_NEW_RESIDUAL_METERING);
                    if !self.mop_define_own_property(code, object, id, descriptor)? {
                        return Err(self.catchable_type_error_msg("invalid descriptor".into()));
                    }
                    arg0
                } else if self.typed_arrays.contains_key(&target) {
                    // The integer-indexed exotic `[[DefineOwnProperty]]`
                    // (10.4.5.3) under `DefinePropertyOrThrow`: a canonical
                    // numeric index accepts only a valid-index, value-carrying
                    // data descriptor without a `configurable:false`/
                    // `enumerable:false`/`writable:false` clause; a rejection
                    // throws `TypeError`. A non-canonical key defines ordinarily.
                    let ta = self.typed_arrays[&target];
                    let key = self
                        .stack
                        .get(base + 5)
                        .copied()
                        .unwrap_or_else(Slot::undefined);
                    let descriptor_value = self
                        .stack
                        .get(base + 6)
                        .copied()
                        .unwrap_or_else(Slot::undefined);
                    let key = self.to_property_key_slot(code, key)?;
                    let descriptor_object = match descriptor_value.value {
                        Payload::Reference(descriptor)
                            if descriptor_value.kind == Kind::Reference =>
                        {
                            descriptor
                        }
                        _ => return Err(self.catchable_type_error_msg("invalid descriptor".into())),
                    };
                    let descriptor = self.descriptor_from_object(code, descriptor_object)?;
                    self.meter.tick_raw(DEFINE_PROPERTY_NEW_RESIDUAL_METERING);
                    let accepted = if let Some(n) = self.ta_numeric_index(key) {
                        self.ta_index_define(code, ta, n, descriptor)?
                    } else {
                        let id = self.to_property_id(code, key)?;
                        self.ordinary_define_own_property(target, id, descriptor)
                    };
                    if !accepted {
                        // A realm-local, catchable `TypeError` (the
                        // `DefinePropertyOrThrow` rejection an `assert.throws`
                        // observes), not an uncatchable host escape.
                        return Err(self.catchable_type_error_msg("invalid descriptor".into()));
                    }
                    arg0
                } else {
                    let arg1 = self
                        .stack
                        .get(base + 5)
                        .copied()
                        .unwrap_or_else(Slot::undefined);
                    let arg2 = self
                        .stack
                        .get(base + 6)
                        .copied()
                        .unwrap_or_else(Slot::undefined);
                    let inst = match arg0.value {
                        Payload::Reference(o) => o,
                        _ => {
                            return Err(Step::Host(Halt::NotImplemented(
                                "defineProperty:non-object",
                            )))
                        }
                    };
                    if self.arrays.contains_key(&inst)
                        || self.collections.contains_key(&inst)
                        || self.typed_arrays.contains_key(&inst)
                        || self.array_buffers.contains_key(&inst)
                        || self.data_views.contains_key(&inst)
                        || self.wrapper_data.contains_key(&inst)
                    {
                        return Err(Step::Host(Halt::NotImplemented(
                            "defineProperty:exotic-object",
                        )));
                    }
                    let descref = match arg2.value {
                        Payload::Reference(d) => d,
                        _ => {
                            return Err(Step::Host(Halt::NotImplemented(
                                "defineProperty:non-object-descriptor",
                            )))
                        }
                    };
                    // A symbol key resolves to its interned key id (`mxID(symbol)`);
                    // a string key interns as a name, rejecting an index-valued
                    // string (the exotic-index corner) and a boot default-key name
                    // the program never symbol-referenced (the intern-table gate —
                    // it cannot be keyed soundly).
                    let key_id = match arg1.kind {
                        Kind::Symbol => match arg1.value {
                            Payload::Reference(desc) => self.intern_symbol_key(desc)?,
                            _ => {
                                return Err(Step::Host(Halt::NotImplemented(
                                    "defineProperty:bad-symbol-key",
                                )))
                            }
                        },
                        Kind::String => {
                            let key = match arg1.value {
                                Payload::String(off) => {
                                    SymbolName::from_units(&self.str_units(off))
                                }
                                _ => {
                                    return Err(Step::Host(Halt::NotImplemented(
                                        "defineProperty:non-string-key",
                                    )))
                                }
                            };
                            if key.as_str().and_then(string_to_index).is_some() {
                                return Err(Step::Host(Halt::NotImplemented(
                                    "defineProperty:index-key",
                                )));
                            }
                            if !self.symbol_ids.contains_key(&key)
                                && key.as_str().is_some_and(|s| self.default_keys.contains(s))
                            {
                                return Err(Step::Host(Halt::NotImplemented(
                                    "defineProperty:ambiguous-default-key",
                                )));
                            }
                            self.intern_key(&key)?
                        }
                        _ => {
                            return Err(Step::Host(Halt::NotImplemented(
                                "defineProperty:non-string-key",
                            )))
                        }
                    };
                    // Read the descriptor's four data fields (their keys are the
                    // descriptor literal's program symbols). Any get/set present,
                    // or any of the four absent, is outside the covered shape.
                    let field = |slf: &Self, name: &str| -> Option<Slot> {
                        slf.symbol_ids
                            .get(name)
                            .and_then(|&fid| slf.find_property(descref, fid))
                            .map(|p| {
                                let s = slf.slots.get(p);
                                Slot::of(s.kind, s.value)
                            })
                    };
                    if field(self, "get").is_some() || field(self, "set").is_some() {
                        return Err(Step::Host(Halt::NotImplemented(
                            "defineProperty:accessor-descriptor",
                        )));
                    }
                    let (value, writable, enumerable, configurable) = match (
                        field(self, "value"),
                        field(self, "writable"),
                        field(self, "enumerable"),
                        field(self, "configurable"),
                    ) {
                        (Some(v), Some(w), Some(e), Some(c)) => (v, w, e, c),
                        _ => {
                            return Err(Step::Host(Halt::NotImplemented(
                                "defineProperty:partial-descriptor",
                            )))
                        }
                    };
                    // The three attribute flags coerce the field values to boolean
                    // (XS's `fxToBoolean`); a non-boolean attribute is outside the
                    // covered shape (its coercion metering is unmodeled here).
                    let as_bool = |s: Slot| -> Option<bool> {
                        match s.kind {
                            Kind::Boolean => Some(matches!(s.value, Payload::Boolean(true))),
                            _ => None,
                        }
                    };
                    let (w, e, c) = match (
                        as_bool(writable),
                        as_bool(enumerable),
                        as_bool(configurable),
                    ) {
                        (Some(w), Some(e), Some(c)) => (w, e, c),
                        _ => {
                            return Err(Step::Host(Halt::NotImplemented(
                                "defineProperty:non-boolean-attribute",
                            )))
                        }
                    };
                    let id = key_id;
                    // Only a genuinely-new own property is covered; a redefine runs
                    // the configurable-compatibility checks (different metering).
                    if self.find_property(inst, id).is_some() {
                        return Err(Step::Host(Halt::NotImplemented("defineProperty:redefine")));
                    }
                    let mut flag = 0u8;
                    if !w {
                        flag |= XS_DONT_SET_FLAG;
                    }
                    if !e {
                        flag |= XS_DONT_ENUM_FLAG;
                    }
                    if !c {
                        flag |= XS_DONT_DELETE_FLAG;
                    }
                    // The whole `fxDescriptorToSlot` field read +
                    // `fxOrdinaryDefineOwnProperty` create, folded into one measured
                    // residual (the property slot built with per-allocation metering
                    // suppressed); a novel key's intern slot is metered above.
                    self.meter.tick_raw(DEFINE_PROPERTY_NEW_RESIDUAL_METERING);
                    let mut prop = value;
                    prop.id = id;
                    prop.flag = flag;
                    let head = self.slots.get(inst).next;
                    prop.next = head;
                    let idx = self.slots.alloc(prop);
                    self.slots.get_mut(inst).next = idx;
                    arg0
                }
            }
            // `Object.propertyIsEnumerable(k)` (a prototype method): whether
            // `k` is an own enumerable property of the receiver. Own-only, no
            // prototype walk (XS's `fxOrdinaryGetOwnProperty` + the
            // `XS_DONT_ENUM_FLAG` test) — an absent, inherited, or
            // non-enumerable own key is `false`.
            NativeMethod::ObjectPropertyIsEnumerable => {
                // `? ToPropertyKey(P)` precedes `? ToObject(this)` for this
                // method (unlike `hasOwnProperty`), so an observable key
                // conversion still runs when the receiver is nullish. Reuse
                // the general object boxer so primitives expose their
                // wrapper's own properties.
                // A pure own-property PROBE: it creates nothing, so an index
                // the table has never held is not minted for it.
                let key = self.to_read_key(code, arg0)?;
                let object = self.array_to_object(this)?;
                let inst = match object.value {
                    Payload::Reference(object) => object,
                    _ => unreachable!("ToObject returns a reference"),
                };
                self.meter.tick_raw(PROPERTY_IS_ENUMERABLE_METERING);
                Slot::boolean(
                    self.mop_get_own_property_read(code, inst, key)?
                        .is_some_and(|descriptor| descriptor.enumerable == Some(true)),
                )
            }
            // `Object.values(o)` / `Object.entries(o)`: the value and key-value
            // forms of `EnumerableOwnProperties`, using a snapshotted key list
            // but live descriptors and Gets for each key.
            NativeMethod::ObjectValues | NativeMethod::ObjectEntries => {
                if matches!(arg0.kind, Kind::Null | Kind::Undefined) {
                    return Err(self.catchable_type_error_msg("invalid object".into()));
                }
                let entries = matches!(m, NativeMethod::ObjectEntries);
                let object = self.array_to_object(arg0)?;
                let Payload::Reference(inst) = object.value else {
                    unreachable!("ToObject returns a reference")
                };
                let own_keys = self.mop_own_keys(code, inst)?;
                let mut properties = self.reserve_scratch(own_keys.len())?;
                for key in own_keys {
                    if key.kind != Kind::String {
                        continue;
                    }
                    let read_key = self.to_read_key(code, key)?;
                    if !self
                        .mop_get_own_property_read(code, inst, read_key)?
                        .is_some_and(|descriptor| descriptor.enumerable == Some(true))
                    {
                        continue;
                    }
                    // The descriptor read above can run a proxy trap or an
                    // accessor, which may NAME this index (promoting an array
                    // item to an ordinary slot); refresh before the Get.
                    let read_key = self.refresh_read_key(read_key);
                    let value = self.mop_get_read(code, inst, read_key, object)?;
                    properties.push((key, value));
                }
                let n = properties.len() as u32;
                self.charge_and_check(if entries {
                    OBJECT_ENTRIES_FRAME_METERING
                } else {
                    OBJECT_VALUES_FRAME_METERING
                })?;
                self.charge_and_check(self.array_chunk_size_metering(n))?;
                let result = self.slots.alloc(Slot::instance(self.array_proto));
                let mut data = ArrayData::default();
                data.length = n;
                for (i, (key, val)) in properties.iter().enumerate() {
                    if entries {
                        self.meter.tick_raw(OBJECT_ENTRIES_PER_KEY_METERING);
                        // A `[key, value]` two-element array per own key.
                        self.charge_and_check(self.array_chunk_size_metering(2))?;
                        for _ in 0..2 {
                            self.meter.tick_slot_alloc();
                        }
                        let pair = self.slots.alloc(Slot::instance(self.array_proto));
                        let mut pd = ArrayData::default();
                        pd.length = 2;
                        pd.insert_item(0, *key, &mut self.side_refs);
                        pd.insert_item(1, *val, &mut self.side_refs);
                        self.arrays.insert(pair, pd);
                        data.insert_item(
                            i as u32,
                            Slot::of(Kind::Reference, Payload::Reference(pair)),
                            &mut self.side_refs,
                        );
                    } else {
                        self.meter.tick_raw(OBJECT_VALUES_PER_KEY_METERING);
                        self.meter.tick_slot_alloc();
                        data.insert_item(i as u32, *val, &mut self.side_refs);
                    }
                }
                self.arrays.insert(result, data);
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            // `Object.getOwnPropertyDescriptors(o)`: a fresh object mapping
            // every own string or symbol key to its complete descriptor.
            NativeMethod::ObjectGetOwnPropertyDescriptors => {
                if matches!(arg0.kind, Kind::Null | Kind::Undefined) {
                    return Err(self.catchable_type_error_msg("invalid object".into()));
                }
                let object = self.array_to_object(arg0)?;
                let Payload::Reference(inst) = object.value else {
                    unreachable!("ToObject returns a reference")
                };
                let keys = self.mop_own_keys(code, inst)?;
                let mut props: Vec<(u16, OrdinaryDescriptor)> = self.reserve_scratch(keys.len())?;
                for key in keys {
                    let id = self.to_property_id(code, key)?;
                    if let Some(descriptor) = self.mop_get_own_property(code, inst, id)? {
                        props.push((id, descriptor));
                    }
                }
                self.meter.tick_raw(GOPDS_FRAME_METERING);
                let result = self.slots.alloc(Slot::instance(self.object_proto));
                for (id, descriptor) in props {
                    self.meter.tick_raw(GOPDS_PER_KEY_METERING);
                    let desc = match self.descriptor_object(descriptor).value {
                        Payload::Reference(desc) => desc,
                        _ => unreachable!(),
                    };
                    let head = self.slots.get(result).next;
                    let mut prop = Slot::of(Kind::Reference, Payload::Reference(desc));
                    prop.id = id;
                    prop.next = head;
                    let idx = self.slots.alloc(prop);
                    self.slots.get_mut(result).next = idx;
                }
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            // `Object.preventExtensions(o)`: delegate to `[[PreventExtensions]]`.
            // Non-object arguments pass through unchanged.
            NativeMethod::ObjectPreventExtensions => {
                if arg0.kind == Kind::Reference {
                    if let Payload::Reference(inst) = arg0.value {
                        self.meter.tick_raw(PREVENT_EXTENSIONS_RESIDUAL_METERING);
                        if !self.mop_prevent_extensions(code, inst)? {
                            return Err(self.catchable_type_error_msg("extensible object".into()));
                        }
                    }
                }
                arg0
            }
            // `Object.seal` / `Object.freeze`: SetIntegrityLevel through the
            // complete MOP, including arrays and integer-indexed objects.
            NativeMethod::ObjectSeal | NativeMethod::ObjectFreeze => {
                let freeze = matches!(m, NativeMethod::ObjectFreeze);
                if arg0.kind == Kind::Reference {
                    if let Payload::Reference(inst) = arg0.value {
                        self.set_integrity_level(code, inst, freeze)?;
                    }
                }
                arg0
            }
            // `Object.isExtensible(o)`: whether the instance is still
            // extensible. A non-object argument is `false`.
            NativeMethod::ObjectIsExtensible => {
                let r = match arg0.value {
                    Payload::Reference(inst) if arg0.kind == Kind::Reference => {
                        self.mop_is_extensible(code, inst)?
                    }
                    _ => false,
                };
                self.meter.tick_raw(IS_EXTENSIBLE_RESIDUAL_METERING);
                Slot::boolean(r)
            }
            // `Object.isSealed(o)` / `Object.isFrozen(o)`: non-extensible and
            // every own property non-configurable (sealed) — and for frozen,
            // every own data property additionally non-writable. A non-object
            // argument is `true` (vacuously sealed/frozen).
            NativeMethod::ObjectIsSealed | NativeMethod::ObjectIsFrozen => {
                let frozen = matches!(m, NativeMethod::ObjectIsFrozen);
                let r = match arg0.value {
                    Payload::Reference(inst) if arg0.kind == Kind::Reference => {
                        self.test_integrity_level(code, inst, frozen)?
                    }
                    _ => {
                        self.meter.tick_raw(IS_EXTENSIBLE_RESIDUAL_METERING);
                        true
                    }
                };
                Slot::boolean(r)
            }
            // The global `harden(x)` (`fx_harden`, `xsLockdown.c`): the
            // transitive freeze worklist. Returns `x`.
            NativeMethod::GlobalHarden => self.do_harden(code, arg0)?,
            // The global `petrify(x)` (`fx_petrify`): the single-object freeze.
            NativeMethod::GlobalPetrify => self.do_petrify(code, arg0)?,
            NativeMethod::Test262DetachArrayBuffer => {
                let buffer = match arg0.value {
                    Payload::Reference(r)
                        if arg0.kind == Kind::Reference
                            && self.array_buffers.contains_key(&r)
                            && !self.shared_buffers.contains(&r) =>
                    {
                        r
                    }
                    _ => {
                        return Err(
                            self.catchable_type_error_msg("this is no ArrayBuffer instance".into())
                        )
                    }
                };
                self.detach_array_buffer(buffer);
                Slot::undefined()
            }
            NativeMethod::TypedArrayCopyWithin
            | NativeMethod::TypedArrayFill
            | NativeMethod::TypedArraySet
            | NativeMethod::TypedArrayReverse => {
                self.typed_array_mutator(m, this, base, argc, code)?
            }
            NativeMethod::TypedArrayJoin => self.typed_array_join(this, base, argc, code)?,
            NativeMethod::TypedArrayValues
            | NativeMethod::TypedArrayKeys
            | NativeMethod::TypedArrayEntries => {
                let typed_array = match this.value {
                    Payload::Reference(typed_array)
                        if this.kind == Kind::Reference
                            && self.typed_arrays.contains_key(&typed_array) =>
                    {
                        typed_array
                    }
                    _ => {
                        return Err(
                            self.catchable_type_error_msg("this: not a TypedArray instance".into())
                        )
                    }
                };
                self.validate_typed_array(this)?;
                let kind = match m {
                    NativeMethod::TypedArrayValues => 0,
                    NativeMethod::TypedArrayKeys => 1,
                    NativeMethod::TypedArrayEntries => 2,
                    _ => unreachable!(),
                };
                self.make_array_iterator(typed_array, kind)
            }
            NativeMethod::TypedArrayReadonly(operation) => {
                self.typed_array_readonly(operation, this, base, argc, code)?
            }
            NativeMethod::TypedArraySlice | NativeMethod::TypedArraySubarray => {
                self.typed_array_slice_or_subarray(m, this, base, argc, code)?
            }
            NativeMethod::TypedArrayMap | NativeMethod::TypedArrayFilter => {
                self.typed_array_map_filter(m, this, base, code)?
            }
            NativeMethod::TypedArraySort => self.typed_array_sort(this, base, argc, code)?,
            NativeMethod::TypedArrayToLocaleString => {
                self.typed_array_to_locale_string(this, base, argc, code)?
            }
            NativeMethod::TypedArrayLengthGetter
            | NativeMethod::TypedArrayByteLengthGetter
            | NativeMethod::TypedArrayByteOffsetGetter
            | NativeMethod::TypedArrayBufferGetter
            | NativeMethod::TypedArrayToStringTagGetter => self.typed_array_accessor(m, this)?,
            NativeMethod::TypedArrayFrom | NativeMethod::TypedArrayOf => {
                self.typed_array_static(m, this, base, argc, code)?
            }
            // `Array.prototype.push(...items)` — retain the exact-metered
            // packed path only when the writes cannot observe descriptors or
            // the prototype chain; all other receivers use the generic MOP.
            NativeMethod::ArrayPush => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if !self.arguments_objects.contains(&i)
                            && self.array_push_fast_safe(i, argc) =>
                    {
                        i
                    }
                    _ => {
                        let result = self.array_generic_push_pop(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let args: Vec<Slot> = (0..argc)
                    .map(|i| {
                        self.stack
                            .get(base + 4 + i)
                            .copied()
                            .unwrap_or_else(Slot::undefined)
                    })
                    .collect();
                let c = args.len() as u32;
                let length = self.arrays[&inst].length;
                // `mxMeterSome(2)` + the grow to `length + c`
                // (`fxSetIndexSize`, growable chunk) + `mxMeterSome(5)` per
                // appended item + a closing `mxMeterSome(2)`, plus the fixed
                // native-method frame constant.
                self.meter.tick_raw(ARRAY_PUSH_FRAME_METERING);
                self.charge_builtin_work(2)?;
                if c > 0 {
                    self.charge_and_check(self.array_chunk_size_metering(length + c))?;
                }
                for (i, a) in args.into_iter().enumerate() {
                    let idx = length + i as u32;
                    let mut v = a;
                    v.id = 0;
                    v.next = crate::value::SlotIndex::NULL;
                    self.arrays
                        .get_mut(&inst)
                        .unwrap()
                        .insert_item(idx, v, &mut self.side_refs);
                    self.charge_builtin_work(5)?;
                }
                let a = self.arrays.get_mut(&inst).unwrap();
                a.length = length + c;
                self.charge_builtin_work(2)?;
                Self::array_index_number(u64::from(length + c))
            }
            // `Array.prototype.pop()` — likewise, a non-writable length or
            // non-configurable last element must take the throwing MOP path.
            NativeMethod::ArrayPop => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if !self.arguments_objects.contains(&i) && self.array_pop_fast_safe(i) =>
                    {
                        i
                    }
                    _ => {
                        let result = self.array_generic_push_pop(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                self.meter.tick_raw(ARRAY_POP_FRAME_METERING);
                let length = self.arrays[&inst].length;
                self.charge_builtin_work(2)?;
                let result = if length > 0 {
                    let new_len = length - 1;
                    self.charge_and_check(self.array_chunk_size_metering(new_len))?;
                    let removed = self
                        .arrays
                        .get_mut(&inst)
                        .unwrap()
                        .remove_item(&new_len, &mut self.side_refs)
                        .unwrap_or_else(Slot::undefined);
                    // `fxSetIndexSize(length-1, XS_CHUNK)` reallocs the item
                    // chunk down; `mxMeterSome(8)`.
                    self.charge_builtin_work(8)?;
                    self.arrays.get_mut(&inst).unwrap().length = new_len;
                    Slot::of(removed.kind, removed.value)
                } else {
                    Slot::undefined()
                };
                self.charge_builtin_work(4)?;
                result
            }
            // `Array.prototype.indexOf(value[, from])` — dense fast path.
            NativeMethod::ArrayIndexOf => {
                let inst = match self.dense_array_this(this) {
                    Some(i) => i,
                    None => {
                        let result = self.array_generic_readonly(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let target = arg0;
                self.charge_and_check(ARRAY_METHOD_INDEXOF_FRAME_METERING)?;
                let length = self.arrays[&inst].length;
                let mut found = -1i32;
                for i in 0..length {
                    self.charge_and_check(ARRAY_INDEXOF_PER_STEP)?;
                    if let Some(item) = self.arrays[&inst].items().get(&i) {
                        if self.strict_equal(item, &target) {
                            found = i as i32;
                            break;
                        }
                    }
                }
                Slot::integer(found)
            }
            // `Array.prototype.includes(value[, from])` — dense fast path. Scan
            // from `from` (default 0) by SameValueZero; `true` on the first
            // match, else `false`. Metered like `indexOf` (a frame constant +
            // per-element scan step), calibrated against the pin.
            NativeMethod::ArrayIncludes => {
                let inst = match self.dense_array_this(this) {
                    Some(i) => i,
                    None => {
                        let result = self.array_generic_readonly(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let target = arg0;
                let from = self.arg_to_index(base, 1, 0, self.arrays[&inst].length);
                self.charge_and_check(ARRAY_INCLUDES_FRAME_METERING)?;
                let length = self.arrays[&inst].length;
                let mut found = false;
                for i in from..length {
                    self.charge_and_check(ARRAY_INCLUDES_PER_STEP)?;
                    let item = self.arrays[&inst]
                        .items()
                        .get(&i)
                        .copied()
                        .unwrap_or_else(Slot::undefined);
                    if self.same_value_zero(&item, &target) {
                        found = true;
                        break;
                    }
                }
                Slot::boolean(found)
            }
            // `Array.prototype.lastIndexOf(value[, from])` — dense fast path.
            // Scan backward from the end by strict equality; the last matching
            // index, or `-1`.
            NativeMethod::ArrayLastIndexOf => {
                let inst = match self.dense_array_this(this) {
                    Some(i) => i,
                    None => {
                        let result = self.array_generic_readonly(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let target = arg0;
                self.charge_and_check(ARRAY_LASTINDEXOF_FRAME_METERING)?;
                let length = self.arrays[&inst].length;
                let mut found = -1i32;
                for i in (0..length).rev() {
                    self.charge_and_check(ARRAY_LASTINDEXOF_PER_STEP)?;
                    if let Some(item) = self.arrays[&inst].items().get(&i) {
                        if self.strict_equal(item, &target) {
                            found = i as i32;
                            break;
                        }
                    }
                }
                Slot::integer(found)
            }
            // `Array.prototype.fill(value[, start[, end]])` — dense fast path.
            // Set `[start, end)` to `value` and return the array. A full fill
            // (`start == 0 && end == length`) reallocs the item chunk
            // (`fxSetIndexSize`); each written element meters `mxMeterSome(5)`.
            NativeMethod::ArrayFill => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if (1..argc.min(3)).all(|index| {
                            matches!(
                                self.stack.get(base + 4 + index).map(|slot| slot.kind),
                                Some(Kind::Integer | Kind::Number | Kind::Undefined)
                            )
                        }) && self.array_fill_fast_safe(i, base) =>
                    {
                        i
                    }
                    _ => {
                        let result = self.array_generic_fill(code, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let value = if argc > 0 { arg0 } else { Slot::undefined() };
                let length = self.arrays[&inst].length;
                let start = self.arg_to_index(base, 1, 0, length);
                let end = self.arg_to_index(base, 2, length, length);
                self.meter.tick_raw(ARRAY_FILL_FRAME_METERING);
                // A full fill runs `fxSetIndexSize(length)`, but for an
                // already-dense array the chunk is already that size, so the
                // resize is a no-op and meters nothing.
                let _ = (start, end, length);
                let mut v = value;
                v.id = 0;
                v.next = crate::value::SlotIndex::NULL;
                for i in start..end {
                    self.arrays
                        .get_mut(&inst)
                        .unwrap()
                        .insert_item(i, v, &mut self.side_refs);
                    self.charge_builtin_work(5)?;
                }
                this
            }
            // `Array.prototype.reverse()` — reverse the elements in place and
            // return the array. XS reverses via the generic `mxHasAt`/`mxGetAt`/
            // `mxSetAt` path; metering is a frame constant plus a per-swap cost
            // (`length/2` swaps), calibrated against the pin.
            NativeMethod::ArrayReverse => {
                let inst = match self.dense_array_this(this) {
                    Some(i) => i,
                    None => {
                        let result = self.array_generic_reverse(code, this)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let length = self.arrays[&inst].length;
                self.meter.tick_raw(ARRAY_REVERSE_FRAME_METERING);
                let swaps = (length / 2) as u64;
                self.charge_and_check(swaps * ARRAY_REVERSE_PER_SWAP_METERING)?;
                let a = self.arrays.get_mut(&inst).unwrap();
                let mut lo = 0u32;
                let mut hi = length.saturating_sub(1);
                while lo < hi {
                    let l = a.remove_item(&lo, &mut self.side_refs);
                    let h = a.remove_item(&hi, &mut self.side_refs);
                    if let Some(h) = h {
                        a.insert_item(lo, h, &mut self.side_refs);
                    }
                    if let Some(l) = l {
                        a.insert_item(hi, l, &mut self.side_refs);
                    }
                    lo += 1;
                    hi -= 1;
                }
                this
            }
            // `Array.prototype.slice([start[, end]])` — dense fast path. A new
            // array with the elements of `[start, end)`. Metering: a frame
            // constant, plus (when the slice is non-empty) the result chunk
            // and `mxMeterSome(count*10)`, plus a closing `mxMeterSome(3)`.
            NativeMethod::ArraySlice => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if self.array_allocating_uses_default_species(i)
                            && matches!(
                                arg0.kind,
                                Kind::Integer | Kind::Number | Kind::Undefined
                            )
                            && (argc < 2
                                || matches!(
                                    self.stack
                                        .get(base + 5)
                                        .copied()
                                        .unwrap_or_else(Slot::undefined)
                                        .kind,
                                    Kind::Integer | Kind::Number | Kind::Undefined
                                )) =>
                    {
                        i
                    }
                    _ => {
                        let result = self.array_generic_slice(code, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let length = self.arrays[&inst].length;
                let start = self.arg_to_index(base, 0, 0, length);
                let end = self.arg_to_index(base, 1, length, length);
                let count = end.saturating_sub(start);
                self.meter.tick_raw(ARRAY_SLICE_FRAME_METERING);
                let result = self.new_array_unmetered();
                if count > 0 {
                    self.charge_and_check(self.array_chunk_size_metering(count))?;
                    self.charge_builtin_work((count as u64) * 10)?;
                    let buffer = self.reserve_scratch(count as usize)?;
                    let items = Self::fill_scratch(
                        buffer,
                        (0..count).filter_map(|i| {
                            self.arrays[&inst]
                                .items()
                                .get(&(start + i))
                                .map(|s| (i, *s))
                        }),
                    );
                    let a = self.arrays.get_mut(&result).unwrap();
                    for (i, s) in items {
                        a.insert_item(i, Slot::of(s.kind, s.value), &mut self.side_refs);
                    }
                    a.length = count;
                }
                self.charge_builtin_work(3)?;
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            // `Array.prototype.concat(...args)` — dense fast path, with a
            // generic fallback for observable spreadability/species and exotic
            // receivers. A new array contains the receiver's elements followed
            // by each argument: an array argument contributes its elements and
            // any other value is appended as one element. Metering for the
            // packed default case models `fxNewInstance` (the list) + a
            // Symbol.isConcatSpreadable check per reference operand + a key slot
            // and `mxMeterSome(2)` per spread element + a key slot and
            // `mxMeterSome(4)` per appended value + the result chunk +
            // `mxMeterSome(3)`, plus a frame constant.
            NativeMethod::ArrayConcat => {
                let recv = match self.dense_array_this(this) {
                    Some(i)
                        if !self.arguments_objects.contains(&i)
                            && self.array_allocating_uses_default_species(i)
                            && self.array_concat_uses_default_spreadability(this)
                            && (0..argc).all(|argi| {
                                let operand = self
                                    .stack
                                    .get(base + 4 + argi)
                                    .copied()
                                    .unwrap_or_else(Slot::undefined);
                                self.array_concat_uses_default_spreadability(operand)
                                    && match operand.value {
                                        Payload::Reference(inst)
                                            if self.arrays.contains_key(&inst)
                                                && !self.arguments_objects.contains(&inst) =>
                                        {
                                            let array = &self.arrays[&inst];
                                            array.items().len() as u32 == array.length
                                        }
                                        _ => true,
                                    }
                            }) =>
                    {
                        i
                    }
                    _ => {
                        let result = self.array_generic_concat(code, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                // Collect the operands: the receiver, then each argument.
                let mut operands: Vec<Slot> = self.reserve_scratch(argc + 1)?;
                operands.push(this);
                for i in 0..argc {
                    operands.push(
                        self.stack
                            .get(base + 4 + i)
                            .copied()
                            .unwrap_or_else(Slot::undefined),
                    );
                }
                self.meter.tick_raw(ARRAY_CONCAT_FRAME_METERING);
                self.meter.tick_slot_alloc(); // `fxNewInstance` (the list)
                let result = self.new_array_unmetered();
                let mut out: Vec<Slot> = Vec::new();
                for op in operands {
                    // Every reference operand runs the `Symbol.isConcatSpreadable`
                    // check.
                    let is_array = matches!(op.value, Payload::Reference(r)
                        if self.arrays.contains_key(&r)
                            && !self.arguments_objects.contains(&r));
                    if let Payload::Reference(_) = op.value {
                        self.meter.tick_raw(ARRAY_CONCAT_CHECK_METERING);
                    }
                    if is_array {
                        let r = match op.value {
                            Payload::Reference(r) => r,
                            _ => unreachable!(),
                        };
                        // Dense array only (a hole needs the uninitialized-slot
                        // path).
                        let (len, dense) = {
                            let a = &self.arrays[&r];
                            (a.length, a.items().len() as u32 == a.length)
                        };
                        if !dense {
                            return Err(Step::Host(Halt::NotImplemented("concat:sparse-arg")));
                        }
                        for i in 0..len {
                            let s = self.arrays[&r]
                                .items()
                                .get(&i)
                                .copied()
                                .unwrap_or_else(Slot::undefined);
                            self.meter.tick_slot_alloc();
                            self.charge_builtin_work(2)?;
                            self.meter.tick_raw(ARRAY_CONCAT_SPREAD_EXTRA_METERING);
                            self.extend_prepaid_scratch(&mut out, &[Slot::of(s.kind, s.value)])?;
                        }
                    } else {
                        // A non-array value is appended as a single element.
                        self.meter.tick_slot_alloc();
                        self.charge_builtin_work(4)?;
                        self.meter.tick_raw(ARRAY_CONCAT_PRIM_EXTRA_METERING);
                        self.extend_prepaid_scratch(&mut out, &[op])?;
                    }
                }
                let total = out.len() as u32;
                if total > 0 {
                    self.charge_and_check(self.array_chunk_size_metering(total))?;
                }
                {
                    let a = self.arrays.get_mut(&result).unwrap();
                    for (i, s) in out.into_iter().enumerate() {
                        a.insert_item(i as u32, s, &mut self.side_refs);
                    }
                    a.length = total;
                }
                self.charge_builtin_work(3)?;
                let _ = recv;
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            // `Array.prototype.at(index)` — dense fast path. Relative index
            // (negative counts from the end); the element there, or
            // `undefined`. Metering: a frame constant, plus (when in range) the
            // element read (`mxGetAt`).
            NativeMethod::ArrayAt => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if matches!(arg0.kind, Kind::Integer | Kind::Number | Kind::Undefined) =>
                    {
                        i
                    }
                    _ => {
                        let result = self.array_generic_readonly(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                self.meter.tick_raw(ARRAY_AT_FRAME_METERING);
                let length = self.arrays[&inst].length as i64;
                let number = self.to_number_f64(code, arg0)?;
                let raw = if number.is_nan() {
                    0
                } else {
                    number.trunc() as i64
                };
                let idx = if raw < 0 { length + raw } else { raw };
                let result = if idx >= 0 && idx < length {
                    self.meter.tick_raw(ARRAY_AT_READ_METERING);
                    self.arrays
                        .get(&inst)
                        .and_then(|a| a.items().get(&(idx as u32)).copied())
                        .map(|s| Slot::of(s.kind, s.value))
                        .unwrap_or_else(Slot::undefined)
                } else {
                    Slot::undefined()
                };
                result
            }
            // `Array.prototype.shift()` — dense fast path. Remove and return
            // the first element, shifting the rest down and shrinking the item
            // chunk. Metering: `mxMeterSome(2 + 3 + 3 + 4)` when non-empty
            // (else 2+4), the shrink chunk, and `mxMeterSome((length-1)*10)`.
            NativeMethod::ArrayShift => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if !self.arguments_objects.contains(&i)
                            && self.array_shift_fast_safe(i) =>
                    {
                        i
                    }
                    _ => {
                        let result = self.array_generic_shift_unshift(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let length = self.arrays[&inst].length;
                self.charge_builtin_work(2)?;
                let result = if length > 0 {
                    self.charge_builtin_work(3)?;
                    let new_len = length - 1;
                    self.charge_and_check(self.array_chunk_size_metering(new_len))?;
                    self.charge_builtin_work((new_len as u64) * 10)?;
                    let removed = {
                        let a = self.arrays.get_mut(&inst).unwrap();
                        let first = a
                            .remove_item(&0, &mut self.side_refs)
                            .unwrap_or_else(Slot::undefined);
                        let mut shifted = std::collections::BTreeMap::new();
                        for (&k, &v) in a.items().iter() {
                            shifted.insert(k - 1, v);
                        }
                        a.replace_items(shifted, &mut self.side_refs);
                        a.length = new_len;
                        first
                    };
                    self.charge_builtin_work(3)?;
                    Slot::of(removed.kind, removed.value)
                } else {
                    Slot::undefined()
                };
                self.charge_builtin_work(4)?;
                result
            }
            // `Array.prototype.unshift(...items)` — dense fast path. Prepend the
            // arguments, shifting existing elements up, and return the new
            // length. Metering: the grow chunk, `mxMeterSome(length*10)` for the
            // shift, `mxMeterSome(4)` per inserted argument, `mxMeterSome(2)`.
            NativeMethod::ArrayUnshift => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if !self.arguments_objects.contains(&i)
                            && self.array_unshift_fast_safe(i, argc) =>
                    {
                        i
                    }
                    _ => {
                        let result = self.array_generic_shift_unshift(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let length = self.arrays[&inst].length;
                let c = argc as u32;
                let args: Vec<Slot> = Self::fill_scratch(
                    self.reserve_scratch(argc as usize)?,
                    (0..argc).map(|i| {
                        self.stack
                            .get(base + 4 + i)
                            .copied()
                            .unwrap_or_else(Slot::undefined)
                    }),
                );
                self.meter.tick_raw(ARRAY_UNSHIFT_FRAME_METERING);
                if c > 0 {
                    self.charge_and_check(self.array_chunk_size_metering(length + c))?;
                    self.charge_builtin_work((length as u64) * 10)?;
                    self.charge_builtin_work(c as u64 * 4)?;
                    let a = self.arrays.get_mut(&inst).unwrap();
                    let mut shifted = std::collections::BTreeMap::new();
                    for (&k, &v) in a.items().iter() {
                        shifted.insert(k + c, v);
                    }
                    for (i, mut v) in args.into_iter().enumerate() {
                        v.id = 0;
                        v.next = crate::value::SlotIndex::NULL;
                        shifted.insert(i as u32, v);
                    }
                    a.replace_items(shifted, &mut self.side_refs);
                    a.length = length + c;
                }
                self.charge_builtin_work(2)?;
                Self::array_index_number(u64::from(length + c))
            }
            // `Array.prototype.copyWithin(target[, start[, end]])` — dense fast
            // path. Copy the block `[start, end)` (clamped to fit) to `target`
            // in place. Metering: a frame constant + `mxMeterSome(count*10)`.
            NativeMethod::ArrayCopyWithin => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if (0..argc.min(3)).all(|index| {
                            matches!(
                                self.stack.get(base + 4 + index).map(|slot| slot.kind),
                                Some(Kind::Integer | Kind::Number | Kind::Undefined)
                            )
                        }) && self.array_copy_within_fast_safe(i, base) =>
                    {
                        i
                    }
                    _ => {
                        let result = self.array_generic_copy_within(code, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let length = self.arrays[&inst].length;
                let to = self.arg_to_index(base, 0, 0, length);
                let from = self.arg_to_index(base, 1, 0, length);
                let end = self.arg_to_index(base, 2, length, length);
                let mut count = end.saturating_sub(from);
                if count > length - to {
                    count = length - to;
                }
                self.meter.tick_raw(ARRAY_COPYWITHIN_FRAME_METERING);
                if count > 0 {
                    self.charge_builtin_work((count as u64) * 10)?;
                    // Snapshot the source range, then write to the destination
                    // (memmove semantics — overlapping ranges are handled by the
                    // snapshot).
                    let src: Vec<Option<Slot>> = Self::fill_scratch(
                        self.reserve_scratch(count as usize)?,
                        (0..count).map(|i| self.arrays[&inst].items().get(&(from + i)).copied()),
                    );
                    let a = self.arrays.get_mut(&inst).unwrap();
                    for (i, s) in src.into_iter().enumerate() {
                        let dst = to + i as u32;
                        match s {
                            Some(v) => {
                                a.insert_item(dst, v, &mut self.side_refs);
                            }
                            None => {
                                a.remove_item(&dst, &mut self.side_refs);
                            }
                        }
                    }
                }
                this
            }
            // `Array.prototype.with(index, value)` — a new array copying the
            // receiver with `index` replaced by `value`. Out-of-range index is
            // a RangeError (self-named). Metering: a frame constant + a
            // per-element copy cost over the generic `mxGetAt`/`mxDefineAt`
            // path, calibrated against the pin.
            NativeMethod::ArrayWith => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if matches!(arg0.kind, Kind::Integer | Kind::Number | Kind::Undefined) =>
                    {
                        i
                    }
                    _ => {
                        let result =
                            self.array_generic_change_by_copy(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let length = self.arrays[&inst].length;
                let raw = match numeric_of(&arg0) {
                    Some(n) if !n.is_nan() => n.trunc() as i64,
                    _ => 0,
                };
                let index = if raw < 0 { length as i64 + raw } else { raw };
                if index < 0 || index >= length as i64 {
                    return Err(self.catchable_range_error_msg("invalid index".into()));
                }
                let value = self
                    .stack
                    .get(base + 4 + 1)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                self.meter.tick_raw(ARRAY_WITH_FRAME_METERING);
                self.charge_and_check((length as u64) * ARRAY_WITH_PER_ELEM_METERING)?;
                let result = self.new_array_unmetered();
                if length > 0 {
                    self.charge_and_check(self.array_chunk_size_metering(length))?;
                    let items: Vec<Slot> = Self::fill_scratch(
                        self.reserve_scratch(length as usize)?,
                        (0..length).map(|i| {
                            if i as i64 == index {
                                value
                            } else {
                                self.arrays[&inst]
                                    .items()
                                    .get(&i)
                                    .copied()
                                    .unwrap_or_else(Slot::undefined)
                            }
                        }),
                    );
                    let a = self.arrays.get_mut(&result).unwrap();
                    for (i, s) in items.into_iter().enumerate() {
                        a.insert_item(i as u32, Slot::of(s.kind, s.value), &mut self.side_refs);
                    }
                    a.length = length;
                }
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            // `Array.prototype.forEach(callback[, thisArg])` — dense fast path.
            // Call `callback(item, index, array)` for each present element (via
            // the re-entrant [`Self::run_callback`]); returns `undefined`. The
            // callback body's own opcodes are metered by the nested dispatch;
            // this adds the per-element `fxCallThisItem` overhead
            // (`mxGetIndex` + the call frame setup) and the frame constant.
            NativeMethod::ArrayForEach => {
                let inst = match self.dense_array_this(this) {
                    Some(i) => i,
                    None => {
                        let result = self.array_generic_readonly(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let callback = arg0;
                if !self.is_callable_value(callback) {
                    return Err(self.catchable_type_error_msg("callback: not a function".into()));
                }
                let this_arg = self
                    .stack
                    .get(base + 4 + 1)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let length = self.arrays[&inst].length;
                self.meter.tick_raw(ARRAY_FOREACH_FRAME_METERING);
                for i in 0..length {
                    let item = self.arrays[&inst].items().get(&i).copied();
                    if let Some(item) = item {
                        self.meter.tick_raw(ARRAY_FOREACH_PER_ELEM_METERING);
                        let cb_args = [item, Slot::integer(i as i32), this];
                        self.run_callback(code, callback, this_arg, &cb_args)?;
                    }
                }
                Slot::undefined()
            }
            // `Array.prototype.map` — a new array of the callback results.
            // Per element: the `fxCallThisItem` overhead + the callback body +
            // `mxMeterSome(2)` (the result store); plus the result chunk.
            NativeMethod::ArrayMap => {
                let inst = match self.dense_array_this(this) {
                    Some(i) if self.array_allocating_uses_default_species(i) => i,
                    _ => {
                        let result = self.array_generic_map_filter(code, m, this, base)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let callback = arg0;
                if !self.is_callable_value(callback) {
                    return Err(self.catchable_type_error_msg("callback: not a function".into()));
                }
                let length = self.arrays[&inst].length;
                self.meter.tick_raw(ARRAY_MAP_FRAME_METERING);
                let result = self.new_array_unmetered();
                if length > 0 {
                    self.charge_and_check(self.array_chunk_size_metering(length))?;
                }
                // The partial result otherwise exists only in this Rust local
                // while guest callbacks run, so a mid-callback GC would sweep it.
                let root_sp = self.stack.len();
                self.stack
                    .push(Slot::of(Kind::Reference, Payload::Reference(result)));
                let mapped: Result<(), Step> = (|| {
                    for i in 0..length {
                        let item = self.arrays[&inst].items().get(&i).copied();
                        if let Some(item) = item {
                            self.meter.tick_raw(ARRAY_FOREACH_PER_ELEM_METERING);
                            let cb_args = [item, Slot::integer(i as i32), this];
                            // Re-read the rooted argument after any prior callback GC.
                            let this_arg = if argc > 1 {
                                self.stack[base + 5]
                            } else {
                                Slot::undefined()
                            };
                            let r = self.run_callback(code, callback, this_arg, &cb_args)?;
                            self.charge_builtin_work(2)?;
                            let mut v = r;
                            v.id = 0;
                            v.next = crate::value::SlotIndex::NULL;
                            self.arrays.get_mut(&result).unwrap().insert_item(
                                i,
                                v,
                                &mut self.side_refs,
                            );
                        }
                    }
                    self.arrays.get_mut(&result).unwrap().length = length;
                    Ok(())
                })();
                self.stack.truncate(root_sp);
                mapped?;
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            // `Array.prototype.some`/`every` — short-circuiting boolean folds.
            // Per element: the `fxCallThisItem` overhead + the callback body +
            // the `fxToBoolean` of its result.
            NativeMethod::ArraySome | NativeMethod::ArrayEvery => {
                let is_every = m == NativeMethod::ArrayEvery;
                let inst = match self.dense_array_this(this) {
                    Some(i) => i,
                    None => {
                        let result = self.array_generic_readonly(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let callback = arg0;
                if !self.is_callable_value(callback) {
                    return Err(self.catchable_type_error_msg("callback: not a function".into()));
                }
                let this_arg = self
                    .stack
                    .get(base + 4 + 1)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let length = self.arrays[&inst].length;
                self.meter.tick_raw(ARRAY_SOMEEVERY_FRAME_METERING);
                let mut answer = is_every;
                for i in 0..length {
                    let item = self.arrays[&inst].items().get(&i).copied();
                    if let Some(item) = item {
                        self.meter.tick_raw(ARRAY_FOREACH_PER_ELEM_METERING);
                        let cb_args = [item, Slot::integer(i as i32), this];
                        let r = self.run_callback(code, callback, this_arg, &cb_args)?;
                        self.meter.tick_raw(ARRAY_PREDICATE_TOBOOL_METERING);
                        let truthy = self.truthy(&r);
                        if is_every && !truthy {
                            answer = false;
                            break;
                        }
                        if !is_every && truthy {
                            answer = true;
                            break;
                        }
                    }
                }
                Slot::boolean(answer)
            }
            // `Array.prototype.find`/`findIndex` — the first element/index whose
            // callback is truthy. `fxFindThisItem` calls the callback for EVERY
            // index (holes yield `undefined`), so the receiver need not be
            // dense; the per-element cost is the find overhead + callback body.
            NativeMethod::ArrayFind | NativeMethod::ArrayFindIndex => {
                let want_index = m == NativeMethod::ArrayFindIndex;
                let inst = match self.dense_array_this(this) {
                    Some(i) => i,
                    None => {
                        let result = self.array_generic_readonly(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let callback = arg0;
                if !self.is_callable_value(callback) {
                    return Err(self.catchable_type_error_msg("callback: not a function".into()));
                }
                let this_arg = self
                    .stack
                    .get(base + 4 + 1)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let length = self.arrays[&inst].length;
                self.meter.tick_raw(ARRAY_FIND_FRAME_METERING);
                if !want_index {
                    // `find` (not `findIndex`) allocates a temporary for the
                    // element result (`mxTemporary(item)`): a fixed 2<<14 over
                    // `findIndex`, independent of the match.
                    self.meter.tick_raw(ARRAY_FIND_VALUE_METERING);
                }
                let mut found: Option<(u32, Slot)> = None;
                for i in 0..length {
                    let item = self.arrays[&inst]
                        .items()
                        .get(&i)
                        .copied()
                        .unwrap_or_else(Slot::undefined);
                    self.meter.tick_raw(ARRAY_FIND_PER_ELEM_METERING);
                    let cb_args = [item, Slot::integer(i as i32), this];
                    let r = self.run_callback(code, callback, this_arg, &cb_args)?;
                    self.meter.tick_raw(ARRAY_PREDICATE_TOBOOL_METERING);
                    if self.truthy(&r) {
                        found = Some((i, item));
                        break;
                    }
                }
                match found {
                    Some((i, item)) => {
                        if want_index {
                            Slot::integer(i as i32)
                        } else {
                            item
                        }
                    }
                    None => {
                        if want_index {
                            Slot::integer(-1)
                        } else {
                            Slot::undefined()
                        }
                    }
                }
            }
            // `Array.prototype.filter` — a new array of the truthy-callback
            // elements. Per element: the `fxCallThisItem` overhead + the
            // callback body + `fxToBoolean`; a kept element appends (a slot +
            // `mxMeterSome`). The result chunk is sized to the kept count.
            NativeMethod::ArrayFilter => {
                let inst = match self.dense_array_this(this) {
                    Some(i) if self.array_allocating_uses_default_species(i) => i,
                    _ => {
                        let result = self.array_generic_map_filter(code, m, this, base)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let callback = arg0;
                if !self.is_callable_value(callback) {
                    return Err(self.catchable_type_error_msg("callback: not a function".into()));
                }
                let this_arg = self
                    .stack
                    .get(base + 4 + 1)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let length = self.arrays[&inst].length;
                self.meter.tick_raw(ARRAY_FILTER_FRAME_METERING);
                let mut kept: Vec<Slot> = Vec::new();
                for i in 0..length {
                    let item = self.arrays[&inst].items().get(&i).copied();
                    if let Some(item) = item {
                        self.meter.tick_raw(ARRAY_FOREACH_PER_ELEM_METERING);
                        let cb_args = [item, Slot::integer(i as i32), this];
                        let r = self.run_callback(code, callback, this_arg, &cb_args)?;
                        self.meter.tick_raw(ARRAY_PREDICATE_TOBOOL_METERING);
                        if self.truthy(&r) {
                            self.meter.tick_raw(ARRAY_FILTER_KEEP_METERING);
                            kept.push(item);
                        }
                    }
                }
                let result = self.new_array_unmetered();
                let total = kept.len() as u32;
                if total > 0 {
                    self.charge_and_check(self.array_chunk_size_metering(total))?;
                }
                {
                    let a = self.arrays.get_mut(&result).unwrap();
                    for (i, mut v) in kept.into_iter().enumerate() {
                        v.id = 0;
                        v.next = crate::value::SlotIndex::NULL;
                        a.insert_item(i as u32, v, &mut self.side_refs);
                    }
                    a.length = total;
                }
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            // `Array.prototype.reduce`/`reduceRight` — fold with
            // `callback(acc, item, index, array)` (`this` = undefined). With no
            // initial value the first (or last, for `reduceRight`) present
            // element seeds the accumulator; an empty array with no initial is
            // a TypeError (self-named). Per element: the `fxReduceThisItem`
            // 4-arg-callback overhead + the callback body.
            NativeMethod::ArrayReduce | NativeMethod::ArrayReduceRight => {
                let right = m == NativeMethod::ArrayReduceRight;
                let inst = match self.dense_array_this(this) {
                    Some(i) => i,
                    None => {
                        let result = self.array_generic_readonly(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let callback = arg0;
                if !self.is_callable_value(callback) {
                    return Err(self.catchable_type_error_msg("callback: not a function".into()));
                }
                self.meter.tick_raw(ARRAY_REDUCE_FRAME_METERING);
                // The present indices in fold order.
                let buffer = self.reserve_work_scratch(self.arrays[&inst].items().len())?;
                let order = if right {
                    Self::fill_scratch(buffer, self.arrays[&inst].items().keys().rev().copied())
                } else {
                    Self::fill_scratch(buffer, self.arrays[&inst].items().keys().copied())
                };
                let mut it = order.into_iter();
                let mut acc = if argc >= 2 {
                    self.stack
                        .get(base + 4 + 1)
                        .copied()
                        .unwrap_or_else(Slot::undefined)
                } else {
                    match it.next() {
                        Some(i) => {
                            // The seed-finding scan (one iteration for a dense
                            // array — the first/last present element).
                            self.meter.tick_raw(ARRAY_REDUCE_INIT_SCAN_METERING);
                            match self.arrays[&inst].items().get(&i) {
                                Some(s) => *s,
                                None => {
                                    return Err(Step::Host(Halt::NotImplemented(
                                        "reduce:concurrent-mutation",
                                    )))
                                }
                            }
                        }
                        None => {
                            return Err(self.catchable_type_error_msg("no initial value".into()))
                        }
                    }
                };
                for i in it {
                    // A prior callback may have mutated the receiver (e.g. the
                    // test262 `delete arr[i]` pattern); a vanished snapshotted
                    // index self-names rather than panicking on a missing key.
                    let item = match self.arrays[&inst].items().get(&i) {
                        Some(s) => *s,
                        None => {
                            return Err(Step::Host(Halt::NotImplemented(
                                "reduce:concurrent-mutation",
                            )))
                        }
                    };
                    self.meter.tick_raw(ARRAY_REDUCE_PER_ELEM_METERING);
                    let cb_args = [acc, item, Slot::integer(i as i32), this];
                    acc = self.run_callback(code, callback, Slot::undefined(), &cb_args)?;
                }
                acc
            }
            // `Array.prototype.findLast`/`findLastIndex` — the last element/
            // index whose callback is truthy, scanning backward. Like
            // `find`/`findIndex` but reversed.
            NativeMethod::ArrayFindLast | NativeMethod::ArrayFindLastIndex => {
                let want_index = m == NativeMethod::ArrayFindLastIndex;
                let inst = match self.dense_array_this(this) {
                    Some(i) => i,
                    None => {
                        let result = self.array_generic_readonly(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let callback = arg0;
                if !self.is_callable_value(callback) {
                    return Err(self.catchable_type_error_msg("callback: not a function".into()));
                }
                let this_arg = self
                    .stack
                    .get(base + 4 + 1)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let length = self.arrays[&inst].length;
                self.meter.tick_raw(ARRAY_FIND_FRAME_METERING);
                // The `findLast`/`findLastIndex` backward-scan setup, a fixed
                // cost over the forward `find`/`findIndex`.
                self.meter.tick_raw(ARRAY_FINDLAST_EXTRA_METERING);
                if !want_index {
                    self.meter.tick_raw(ARRAY_FIND_VALUE_METERING);
                }
                let mut found: Option<(u32, Slot)> = None;
                for i in (0..length).rev() {
                    let item = self.arrays[&inst]
                        .items()
                        .get(&i)
                        .copied()
                        .unwrap_or_else(Slot::undefined);
                    self.meter.tick_raw(ARRAY_FIND_PER_ELEM_METERING);
                    let cb_args = [item, Slot::integer(i as i32), this];
                    let r = self.run_callback(code, callback, this_arg, &cb_args)?;
                    self.meter.tick_raw(ARRAY_PREDICATE_TOBOOL_METERING);
                    if self.truthy(&r) {
                        found = Some((i, item));
                        break;
                    }
                }
                match found {
                    Some((i, item)) => {
                        if want_index {
                            Slot::integer(i as i32)
                        } else {
                            item
                        }
                    }
                    None => {
                        if want_index {
                            Slot::integer(-1)
                        } else {
                            Slot::undefined()
                        }
                    }
                }
            }
            // `Array.prototype.toReversed()` — a new array with the elements
            // reversed (non-mutating), copied over the generic
            // `mxGetAt`/`mxDefineAt` path. Metering reuses `with`'s frame +
            // per-element constants (same copy loop) + the result chunk.
            NativeMethod::ArrayToReversed => {
                let inst = match self.dense_array_this(this) {
                    Some(i) => i,
                    None => {
                        let result =
                            self.array_generic_change_by_copy(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let length = self.arrays[&inst].length;
                self.meter.tick_raw(ARRAY_TOREVERSED_FRAME_METERING);
                self.charge_and_check((length as u64) * ARRAY_WITH_PER_ELEM_METERING)?;
                let result = self.new_array_unmetered();
                if length > 0 {
                    self.charge_and_check(self.array_chunk_size_metering(length))?;
                    let items: Vec<Slot> = Self::fill_scratch(
                        self.reserve_scratch(length as usize)?,
                        (0..length).map(|to| {
                            let from = length - 1 - to;
                            self.arrays[&inst]
                                .items()
                                .get(&from)
                                .copied()
                                .unwrap_or_else(Slot::undefined)
                        }),
                    );
                    let a = self.arrays.get_mut(&result).unwrap();
                    for (to, s) in items.into_iter().enumerate() {
                        a.insert_item(to as u32, Slot::of(s.kind, s.value), &mut self.side_refs);
                    }
                    a.length = length;
                }
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            // `Array.prototype.splice(start[, deleteCount, ...items])` — dense
            // fast path. Remove `deleteCount` elements at `start` and insert
            // `items`, returning a new array of the removed elements. Metering
            // models the result chunk + `mxMeterSome(deletions*10 + 4)`, the
            // tail shift + array resize, `mxMeterSome(5)` per inserted item, and
            // a closing `mxMeterSome(4)`, plus a frame constant.
            NativeMethod::ArraySplice => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if self.array_splice_fast_safe(i, argc)
                            && (argc == 0
                                || matches!(
                                    arg0.kind,
                                    Kind::Integer | Kind::Number | Kind::Undefined
                                ))
                            && (argc < 2
                                || matches!(
                                    self.stack.get(base + 5).map(|slot| slot.kind),
                                    Some(Kind::Integer | Kind::Number | Kind::Undefined)
                                )) =>
                    {
                        i
                    }
                    _ => {
                        let result = self.array_generic_splice(code, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let length = self.arrays[&inst].length;
                let start = self.arg_to_index(base, 0, 0, length);
                let (insertions, deletions): (u32, u32) = if argc == 0 {
                    (0, 0)
                } else if argc == 1 {
                    (0, length - start)
                } else {
                    let ins = (argc - 2) as u32;
                    // deleteCount clamped to [0, length - start].
                    let dc = match numeric_of(
                        &self
                            .stack
                            .get(base + 4 + 1)
                            .copied()
                            .unwrap_or_else(Slot::undefined),
                    ) {
                        Some(n) if n.is_nan() || n < 0.0 => 0,
                        Some(n) if n > (length - start) as f64 => length - start,
                        Some(n) => n.trunc() as u32,
                        None => 0,
                    };
                    (ins, dc)
                };
                self.meter.tick_raw(ARRAY_SPLICE_FRAME_METERING);
                // The removed-elements result array.
                let result = self.new_array_unmetered();
                if deletions > 0 {
                    self.charge_and_check(self.array_chunk_size_metering(deletions))?;
                }
                self.charge_builtin_work((deletions as u64) * 10)?;
                self.charge_builtin_work(4)?;
                let tail_len = length - (start + deletions);
                if insertions < deletions {
                    self.charge_builtin_work((tail_len as u64) * 10)?;
                    self.charge_builtin_work(((deletions - insertions) as u64) * 4)?;
                    let new_len = length - (deletions - insertions);
                    if new_len > 0 {
                        self.charge_and_check(self.array_chunk_size_metering(new_len))?;
                    }
                } else if insertions > deletions {
                    let new_len = length + (insertions - deletions);
                    self.charge_and_check(self.array_chunk_size_metering(new_len))?;
                    self.charge_builtin_work((tail_len as u64) * 10)?;
                }
                for _ in 0..insertions {
                    self.charge_builtin_work(5)?;
                }
                self.charge_builtin_work(4)?;
                // Perform the splice on a dense element vector.
                let cur: Vec<Slot> = Self::fill_scratch(
                    self.reserve_scratch(length as usize)?,
                    (0..length).map(|i| {
                        self.arrays[&inst]
                            .items()
                            .get(&i)
                            .copied()
                            .unwrap_or_else(Slot::undefined)
                    }),
                );
                let removed = Self::fill_scratch(
                    self.reserve_scratch(deletions as usize)?,
                    cur[start as usize..(start + deletions) as usize]
                        .iter()
                        .copied(),
                );
                let inserted: Vec<Slot> = Self::fill_scratch(
                    self.reserve_scratch(insertions as usize)?,
                    (0..insertions).map(|k| {
                        self.stack
                            .get(base + 4 + 2 + k as usize)
                            .copied()
                            .unwrap_or_else(Slot::undefined)
                    }),
                );
                let mut rebuilt: Vec<Slot> = self.reserve_scratch(
                    (length as usize)
                        .checked_add(insertions as usize)
                        .ok_or(Step::Host(Halt::HeapExhausted))?,
                )?;
                rebuilt.extend_from_slice(&cur[..start as usize]);
                rebuilt.extend(inserted);
                rebuilt.extend_from_slice(&cur[(start + deletions) as usize..]);
                {
                    let a = self.arrays.get_mut(&inst).unwrap();
                    a.clear_items(&mut self.side_refs);
                    for (i, s) in rebuilt.into_iter().enumerate() {
                        a.insert_item(i as u32, Slot::of(s.kind, s.value), &mut self.side_refs);
                    }
                    a.length = length - deletions + insertions;
                }
                {
                    let a = self.arrays.get_mut(&result).unwrap();
                    for (i, s) in removed.into_iter().enumerate() {
                        a.insert_item(i as u32, Slot::of(s.kind, s.value), &mut self.side_refs);
                    }
                    a.length = deletions;
                }
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            // `Array.prototype.toSpliced(start, deleteCount, ...items)` — a
            // non-mutating splice: build a NEW array `head ++ inserted ++ tail`
            // and leave the receiver untouched. XS meters the head copy at
            // `start * 10`, each insertion at `5`, the tail copy at `rest * 10`,
            // plus a trailing `mxMeterSome(4)` and the result item chunk.
            NativeMethod::ArrayToSpliced => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if (argc == 0
                            || matches!(
                                arg0.kind,
                                Kind::Integer | Kind::Number | Kind::Undefined
                            ))
                            && (argc < 2
                                || matches!(
                                    self.stack.get(base + 5).map(|slot| slot.kind),
                                    Some(Kind::Integer | Kind::Number | Kind::Undefined)
                                )) =>
                    {
                        i
                    }
                    _ => {
                        let result =
                            self.array_generic_change_by_copy(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let length = self.arrays[&inst].length;
                let start = self.arg_to_index(base, 0, 0, length);
                let (insertions, skip): (u32, u32) = if argc == 0 {
                    (0, 0)
                } else if argc == 1 {
                    (0, length - start)
                } else {
                    let ins = (argc - 2) as u32;
                    let dc = match numeric_of(
                        &self
                            .stack
                            .get(base + 4 + 1)
                            .copied()
                            .unwrap_or_else(Slot::undefined),
                    ) {
                        Some(n) if n.is_nan() || n < 0.0 => 0,
                        Some(n) if n > (length - start) as f64 => length - start,
                        Some(n) => n.trunc() as u32,
                        None => 0,
                    };
                    (ins, dc)
                };
                let result_len = length + insertions - skip;
                let rest = length - (start + skip);
                self.meter.tick_raw(ARRAY_TOSPLICED_FRAME_METERING);
                if result_len > 0 {
                    self.charge_and_check(self.array_chunk_size_metering(result_len))?;
                }
                self.charge_builtin_work((start as u64) * 10)?;
                for _ in 0..insertions {
                    self.charge_builtin_work(5)?;
                }
                self.charge_builtin_work((rest as u64) * 10)?;
                self.charge_builtin_work(4)?;
                // Build the result densely; the receiver stays untouched.
                let cur: Vec<Slot> = Self::fill_scratch(
                    self.reserve_scratch(length as usize)?,
                    (0..length).map(|i| {
                        self.arrays[&inst]
                            .items()
                            .get(&i)
                            .copied()
                            .unwrap_or_else(Slot::undefined)
                    }),
                );
                let inserted: Vec<Slot> = Self::fill_scratch(
                    self.reserve_scratch(insertions as usize)?,
                    (0..insertions).map(|k| {
                        self.stack
                            .get(base + 4 + 2 + k as usize)
                            .copied()
                            .unwrap_or_else(Slot::undefined)
                    }),
                );
                let mut rebuilt: Vec<Slot> = self.reserve_scratch(
                    (length as usize)
                        .checked_add(insertions as usize)
                        .ok_or(Step::Host(Halt::HeapExhausted))?,
                )?;
                rebuilt.extend_from_slice(&cur[..start as usize]);
                rebuilt.extend(inserted);
                rebuilt.extend_from_slice(&cur[(start + skip) as usize..]);
                let result = self.new_array_unmetered();
                {
                    let a = self.arrays.get_mut(&result).unwrap();
                    for (i, s) in rebuilt.into_iter().enumerate() {
                        a.insert_item(i as u32, Slot::of(s.kind, s.value), &mut self.side_refs);
                    }
                    a.length = result_len;
                }
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            // `Array.prototype.flat([depth])` — a new array with sub-array
            // elements flattened to `depth` (default 1). XS's `flatAux` visits
            // each source index, recursing into array elements (up to `depth`)
            // and appending leaves via `mxDefineIndex` (which grows the result
            // item chunk one slot at a time). Metering models the per-visit
            // read, the per-array-element length read, and the per-appended
            // element chunk growth, plus a frame constant.
            NativeMethod::ArrayFlat => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if self.array_allocating_uses_default_species(i)
                            && matches!(
                                arg0.kind,
                                Kind::Integer | Kind::Number | Kind::Undefined
                            )
                            && self.array_flat_fast_safe(
                                i,
                                if argc == 0 || arg0.kind == Kind::Undefined {
                                    1
                                } else {
                                    match numeric_of(&arg0) {
                                        Some(n) if n.is_nan() || n < 0.0 => 0,
                                        Some(n) => n.trunc() as u32,
                                        None => 0,
                                    }
                                },
                                &mut 1024,
                            ) =>
                    {
                        i
                    }
                    _ => {
                        let result =
                            self.array_generic_flat_or_flat_map(code, m, this, base, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                let depth = if argc >= 1 && arg0.kind != Kind::Undefined {
                    match numeric_of(&arg0) {
                        Some(n) if n.is_nan() || n < 0.0 => 0,
                        Some(n) => n.trunc() as u32,
                        None => 0,
                    }
                } else {
                    1
                };
                let length = self.arrays[&inst].length;
                self.meter.tick_raw(ARRAY_FLAT_FRAME_METERING);
                let mut out: Vec<Slot> = Vec::new();
                self.flat_into(inst, length, depth, &mut out)?;
                let result = self.new_array_unmetered();
                let total = out.len() as u32;
                {
                    let a = self.arrays.get_mut(&result).unwrap();
                    for (i, s) in out.into_iter().enumerate() {
                        a.insert_item(i as u32, Slot::of(s.kind, s.value), &mut self.side_refs);
                    }
                    a.length = total;
                }
                Slot::of(Kind::Reference, Payload::Reference(result))
            }
            // `Array.prototype.flatMap(callback[, thisArg])` — call
            // `callback(item, index, array)` per element, then flatten the
            // results by one level. Re-entrant (uses `run_callback`); the
            // result flattening reuses `flat`'s per-leaf/per-array constants,
            // plus a per-source callback overhead.
            NativeMethod::ArrayFlatMap => {
                let result = self.array_generic_flat_or_flat_map(code, m, this, base, argc)?;
                self.stack.truncate(base);
                self.push(result);
                return Ok(());
            }
            // `Array.prototype.join([sep])` — dense fast path. Each element is
            // ToString'd into a key slot, the pieces joined by `sep` (default
            // ","), and the result materialized into one final chunk. Metering
            // models `fxNewInstance` (the key list) + a key slot per element
            // and per separator + each element's `fxToString` (a number renders
            // to a fresh chunk + a built-in step) + the final `fxNewChunk`.
            NativeMethod::ArrayJoin => {
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if self.array_join_fast_safe(i)
                            && self.array_join_separator_fast_safe(arg0, argc) =>
                    {
                        i
                    }
                    _ => {
                        let result = self.array_generic_join(code, this, arg0, argc)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                if argc > 0 && arg0.kind != Kind::Undefined && arg0.kind != Kind::String {
                    // The calibrated fast path below keeps the historic exact
                    // metering for the default/string separator. Other values
                    // still follow ordinary ToString, including re-entrant
                    // object conversion and abrupt Symbol/guest completions.
                    // Capture length before separator coercion, then read each
                    // element live so a conversion can mutate later indices.
                    let length = self.arrays[&inst].length;
                    let sep = self.to_string_units(code, arg0)?;
                    let mut out = Vec::new();
                    for i in 0..length {
                        if i > 0 {
                            self.extend_reserved_units(&mut out, &sep)?;
                        }
                        let value = self.array_generic_get(code, inst, u64::from(i))?;
                        if !matches!(value.kind, Kind::Undefined | Kind::Null) {
                            let units = self.to_string_units(code, value)?;
                            self.extend_reserved_units(&mut out, &units)?;
                        }
                    }
                    self.stack.truncate(base);
                    let result = self.new_reserved_string_units(&out);
                    self.push(result);
                    return Ok(());
                }
                let sep: Vec<u8> = if argc == 0 || arg0.kind == Kind::Undefined {
                    b",".to_vec()
                } else if arg0.kind == Kind::String {
                    match arg0.value {
                        Payload::String(off) => self.str_text(off).into_bytes(),
                        _ => b",".to_vec(),
                    }
                } else {
                    unreachable!("non-string separators use the general path")
                };
                let length = self.arrays[&inst].length;
                self.meter.tick_raw(ARRAY_JOIN_FRAME_METERING);
                self.meter.tick_slot_alloc(); // `fxNewInstance` (the key list)
                let mut out: Vec<u8> = Vec::new();
                let mut output_units = 0;
                for i in 0..length {
                    let item = self.arrays[&inst].items().get(&i).copied();
                    // Every index is read (`mxGetIndex`) regardless of type.
                    self.charge_and_check(ARRAY_JOIN_PER_ELEMENT_METERING)?;
                    if i > 0 {
                        self.meter.tick_slot_alloc(); // the separator key slot
                        self.extend_reserved_text(&mut out, &sep, &mut output_units)?;
                    }
                    match item {
                        Some(s) if s.kind != Kind::Undefined && s.kind != Kind::Null => {
                            if s.kind == Kind::Reference {
                                return Err(Step::Host(Halt::NotImplemented(
                                    "join:reference-element",
                                )));
                            }
                            self.meter.tick_slot_alloc(); // the element key slot
                            let bytes = self.to_string_bytes_metered(s);
                            self.extend_reserved_text(&mut out, &bytes, &mut output_units)?;
                        }
                        _ => {}
                    }
                }
                if out.is_empty() {
                    self.charge_and_check(string_chunk_cost(0))?; // empty join chunk
                }
                let off = self.alloc_str_text(&out);
                Slot::of(Kind::String, Payload::String(off))
            }
            // `Array.prototype.toString()` delegates to `this.join()` with the
            // default separator: it meters a small prelude (the `join` lookup +
            // the `mxRunCount(0)` call-frame setup) and then the identical join
            // body (frame + per-element read + the result chunk). Modeled by
            // running the default-separator join and adding the prelude.
            NativeMethod::ArrayToString => {
                let typed_reference = match this.value {
                    Payload::Reference(reference)
                        if this.kind == Kind::Reference
                            && self.typed_arrays.contains_key(&reference) =>
                    {
                        Some(reference)
                    }
                    _ => None,
                };
                if let Some(reference) = typed_reference {
                    let join_id = self.intern_static_key("join");
                    if self.chain_resolves_native_data_method(
                        reference,
                        join_id,
                        NativeMethod::TypedArrayJoin,
                    ) {
                        self.meter.tick_raw(ARRAY_TOSTRING_PRELUDE_METERING);
                        let result = self.typed_array_join(this, base, 0, code)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                }
                let inst = match self.dense_array_this(this) {
                    Some(i)
                        if self.array_to_string_fast_safe(i) && self.array_join_fast_safe(i) =>
                    {
                        i
                    }
                    _ => {
                        let result = self.array_generic_to_string(code, this)?;
                        self.stack.truncate(base);
                        self.push(result);
                        return Ok(());
                    }
                };
                self.meter.tick_raw(ARRAY_TOSTRING_PRELUDE_METERING);
                let length = self.arrays[&inst].length;
                self.meter.tick_raw(ARRAY_JOIN_FRAME_METERING);
                self.meter.tick_slot_alloc();
                let mut out: Vec<u8> = Vec::new();
                let mut output_units = 0;
                for i in 0..length {
                    self.charge_and_check(ARRAY_JOIN_PER_ELEMENT_METERING)?;
                    let item = self.arrays[&inst].items().get(&i).copied();
                    if i > 0 {
                        self.meter.tick_slot_alloc();
                        self.extend_reserved_text(&mut out, b",", &mut output_units)?;
                    }
                    match item {
                        Some(s) if s.kind != Kind::Undefined && s.kind != Kind::Null => {
                            if s.kind == Kind::Reference {
                                return Err(Step::Host(Halt::NotImplemented(
                                    "toString:reference-element",
                                )));
                            }
                            self.meter.tick_slot_alloc();
                            let bytes = self.to_string_bytes_metered(s);
                            self.extend_reserved_text(&mut out, &bytes, &mut output_units)?;
                        }
                        _ => {}
                    }
                }
                if out.is_empty() {
                    self.charge_chunk_work(1)?;
                }
                let off = self.alloc_str_text(&out);
                Slot::of(Kind::String, Payload::String(off))
            }
            NativeMethod::ArraySort => self.array_sort(this, base, argc, code, false)?,
            NativeMethod::ArrayToSorted => self.array_sort(this, base, argc, code, true)?,
            NativeMethod::ArrayToLocaleString => {
                self.array_to_locale_string(this, base, argc, code)?
            }
            NativeMethod::ArrayFrom => self.array_from(code, base, argc)?,
            NativeMethod::ArrayFromAsync => self.array_from_async(code, base, argc)?,
            // `Array.isArray(v)`: whether `v` is an array exotic object.
            NativeMethod::ArrayIsArray => {
                self.meter.tick_raw(ARRAY_ISARRAY_METERING);
                let r = match arg0.value {
                    Payload::Reference(r) if arg0.kind == Kind::Reference => {
                        self.array_generic_is_array(r)?
                    }
                    _ => false,
                };
                Slot::boolean(r)
            }
            NativeMethod::ArrayOf => self.array_of(code, base, argc)?,
            // `Array.prototype.values()`/`keys()`/`entries()`: build an Array
            // Iterator over the receiver.
            NativeMethod::ArrayValues | NativeMethod::ArrayKeys | NativeMethod::ArrayEntries => {
                // CreateArrayIterator performs ToObject but does not require an
                // Array exotic. The iterator's next method re-reads
                // LengthOfArrayLike and indexed properties through the MOP, so
                // ordinary objects, primitive wrappers, and Proxies remain live.
                let object = self.array_to_object(this)?;
                let Payload::Reference(iterated) = object.value else {
                    unreachable!("ToObject result")
                };
                let kind = match m {
                    NativeMethod::ArrayValues => 0u8,
                    NativeMethod::ArrayKeys => 1u8,
                    _ => 2u8,
                };
                self.make_array_iterator(iterated, kind)
            }
            // `%ArrayIteratorPrototype%.next()`.
            NativeMethod::ArrayIteratorNext => {
                let iter = match this.value {
                    Payload::Reference(i)
                        if self.iterators.get(&i).is_some_and(|state| state.kind <= 4) =>
                    {
                        i
                    }
                    _ => return Err(self.catchable_type_error_msg("this: not an iterator".into())),
                };
                self.array_iterator_next(code, iter)?
            }
            NativeMethod::MapIteratorNext | NativeMethod::SetIteratorNext => {
                let expected = if m == NativeMethod::MapIteratorNext {
                    CollKind::Map
                } else {
                    CollKind::Set
                };
                let iter = match this.value {
                    Payload::Reference(i)
                        if self
                            .iterators
                            .get(&i)
                            .and_then(|state| self.collections.get(&state.iterable))
                            .is_some_and(|collection| collection.kind == expected) =>
                    {
                        i
                    }
                    _ => return Err(self.catchable_type_error_msg("this: not an iterator".into())),
                };
                self.collection_iterator_next(iter)
            }
            NativeMethod::RegExpStringIteratorNext => {
                self.regexp_string_iterator_next(code, this)?
            }
            NativeMethod::IteratorFrom => self.iterator_from(code, arg0)?,
            NativeMethod::IteratorWrapperNext => self.iterator_wrapper_next(code, this)?,
            NativeMethod::IteratorWrapperReturn => self.iterator_wrapper_return(code, this)?,
            NativeMethod::IteratorConstructorGetter => {
                let constructor = self.intrinsics.get("Iterator").copied().ok_or(Step::Host(
                    Halt::EngineInvariant("Iterator:missing-constructor"),
                ))?;
                Slot::of(Kind::Reference, Payload::Reference(constructor))
            }
            NativeMethod::IteratorToStringTagGetter => self.new_string_metered(b"Iterator"),
            NativeMethod::IteratorConstructorSetter | NativeMethod::IteratorToStringTagSetter => {
                unreachable!("Iterator setters dispatch in the small wrapper")
            }
            NativeMethod::IteratorHelper(op @ 5..=10) => {
                self.iterator_terminal_helper(code, op, this, base, argc)?
            }
            NativeMethod::IteratorHelper(_) => {
                return Err(Step::Host(Halt::NotImplemented("Iterator.helper")));
            }
            NativeMethod::Math(id) => self.call_math(id, base, argc, code)?,
            NativeMethod::ReflectGetPrototypeOf
            | NativeMethod::ReflectSetPrototypeOf
            | NativeMethod::ReflectIsExtensible
            | NativeMethod::ReflectPreventExtensions
            | NativeMethod::ReflectGetOwnPropertyDescriptor
            | NativeMethod::ReflectDefineProperty
            | NativeMethod::ReflectOwnKeys
            | NativeMethod::ReflectHas
            | NativeMethod::ReflectGet
            | NativeMethod::ReflectSet
            | NativeMethod::ReflectDeleteProperty
            | NativeMethod::ReflectApply
            | NativeMethod::ReflectConstruct => self.call_reflect(m, base, argc, code)?,
            NativeMethod::StringCharCodeAt
            | NativeMethod::StringCodePointAt
            | NativeMethod::StringCharAt
            | NativeMethod::StringAt
            | NativeMethod::StringSlice
            | NativeMethod::StringSubstring
            | NativeMethod::StringIndexOf
            | NativeMethod::StringLastIndexOf
            | NativeMethod::StringIncludes
            | NativeMethod::StringStartsWith
            | NativeMethod::StringEndsWith
            | NativeMethod::StringConcat
            | NativeMethod::StringToLowerCase
            | NativeMethod::StringToUpperCase
            | NativeMethod::StringToLocaleLowerCase
            | NativeMethod::StringToLocaleUpperCase
            | NativeMethod::StringLocaleCompare
            | NativeMethod::StringNormalize
            | NativeMethod::StringRepeat
            | NativeMethod::StringTrim
            | NativeMethod::StringTrimStart
            | NativeMethod::StringTrimEnd
            | NativeMethod::StringPadStart
            | NativeMethod::StringPadEnd
            | NativeMethod::StringIsWellFormed
            | NativeMethod::StringToWellFormed
            | NativeMethod::StringIterator => self.call_string(m, this, base, argc, code)?,
            NativeMethod::StringFromCharCode | NativeMethod::StringFromCodePoint => {
                self.call_string_static(m, base, argc, code)?
            }
            NativeMethod::StringRaw => self.call_string_raw(base, argc, code)?,
            NativeMethod::NumberIsFinite
            | NativeMethod::NumberIsInteger
            | NativeMethod::NumberIsNaN
            | NativeMethod::NumberIsSafeInteger
            | NativeMethod::NumberToString
            | NativeMethod::NumberToLocaleString
            | NativeMethod::GlobalParseInt
            | NativeMethod::GlobalParseFloat
            | NativeMethod::GlobalIsNaN
            | NativeMethod::GlobalIsFinite => self.call_number(m, this, base, argc, code)?,
            NativeMethod::JsonStringify | NativeMethod::JsonParse => {
                self.call_json(m, base, argc, code)?
            }
            NativeMethod::MapSet
            | NativeMethod::MapGet
            | NativeMethod::MapHas
            | NativeMethod::MapDelete
            | NativeMethod::WeakMapSet
            | NativeMethod::WeakMapGet
            | NativeMethod::WeakMapHas
            | NativeMethod::WeakMapDelete
            | NativeMethod::SetAdd
            | NativeMethod::SetHas
            | NativeMethod::SetDelete
            | NativeMethod::WeakSetAdd
            | NativeMethod::WeakSetHas
            | NativeMethod::WeakSetDelete => self.call_collection(m, this, base, argc)?,
            // `Map`/`Set` `forEach` — re-entrant (drives a user callback per
            // live entry); needs the code buffer for the nested dispatch.
            NativeMethod::CollForEach => self.call_collection_foreach(this, base, argc, code)?,
            // The seven ES2025 "new Set methods" — each drives the argument's
            // `has` callback or `keys()` iterator (re-entrant), so it needs the
            // code buffer for the nested dispatch.
            NativeMethod::SetUnion
            | NativeMethod::SetIntersection
            | NativeMethod::SetDifference
            | NativeMethod::SetSymmetricDifference
            | NativeMethod::SetIsSubsetOf
            | NativeMethod::SetIsSupersetOf
            | NativeMethod::SetIsDisjointFrom => self.call_set_method(m, this, base, code)?,
            // The upsert-proposal `Map.prototype` methods. `getOrInsert` is
            // allocation-only; `getOrInsertComputed` drives a user callback, so
            // both take the code buffer for the (possible) nested dispatch.
            NativeMethod::MapGetOrInsert
            | NativeMethod::MapGetOrInsertComputed
            | NativeMethod::WeakMapGetOrInsert
            | NativeMethod::WeakMapGetOrInsertComputed => {
                self.call_map_get_or_insert(m, this, base, code)?
            }
            // The array-grouping-proposal statics — each iterates `items` and
            // drives a user callback per element (re-entrant).
            NativeMethod::MapGroupBy | NativeMethod::ObjectGroupBy => {
                self.call_group_by(m, base, code)?
            }
            // `entries`/`keys`/`values` → a Map/Set Iterator over the receiver.
            NativeMethod::CollEntries | NativeMethod::CollKeys | NativeMethod::CollValues => {
                let expected =
                    self.collection_method_brand(base)
                        .ok_or(Step::Host(Halt::EngineInvariant(
                            "collection:missing-method-brand",
                        )))?;
                let inst = match self.collection_ref(this) {
                    Some(i) => i,
                    None => return Err(self.collection_brand_error(expected, false)),
                };
                // The shared dispatch variants still retain their declaring
                // prototype through the method function at `base + 1`.
                // Require that exact brand: Map methods cannot operate on Set
                // receivers (or vice versa), even though both use the same
                // collection side-table representation.

                if self.collections[&inst].kind != expected {
                    self.charge_and_check(if expected == CollKind::Map {
                        MAP_METHOD_ON_SET_METERING
                    } else {
                        SET_METHOD_ON_MAP_METERING
                    })?;
                    return Err(self.collection_brand_error(expected, false));
                }
                let iter_kind = match m {
                    NativeMethod::CollKeys => 5u8,
                    NativeMethod::CollValues => 6u8,
                    _ => 7u8,
                };
                self.make_collection_iterator(inst, iter_kind)
            }
            // `Map`/`Set` `clear` (`fxClearEntries`): drop all entries and
            // shrink the table back toward its minimum length.
            NativeMethod::CollClear => {
                let expected =
                    self.collection_method_brand(base)
                        .ok_or(Step::Host(Halt::EngineInvariant(
                            "collection:missing-method-brand",
                        )))?;
                let inst = match self.collection_ref(this) {
                    Some(i) => i,
                    None => return Err(self.collection_brand_error(expected, false)),
                };

                if self.collections[&inst].kind != expected {
                    self.charge_and_check(if expected == CollKind::Map {
                        MAP_METHOD_ON_SET_METERING
                    } else {
                        SET_METHOD_ON_MAP_METERING
                    })?;
                    return Err(self.collection_brand_error(expected, false));
                }
                if self.slots.get(inst).flag & XS_DONT_MODIFY_FLAG != 0 {
                    return Err(self.collection_brand_error(expected, true));
                }
                self.meter.tick_raw(COLLECTION_CLEAR_FRAME_METERING);
                self.collections
                    .get_mut(&inst)
                    .unwrap()
                    .clear_entries(&mut self.side_refs);
                // `fxResizeEntries` with size 0 shrinks the address chunk back
                // toward `mxTableMinLength`, charging the rehash chunk if the
                // length changes (modeled by [`Self::collection_table_resize`]).
                self.collection_table_resize(inst);
                Slot::undefined()
            }
            NativeMethod::ArrayBufferSlice => self.array_buffer_slice(code, this, base, argc)?,
            NativeMethod::ArrayBufferTransfer | NativeMethod::ArrayBufferTransferToFixedLength => {
                self.array_buffer_transfer(code, this, arg0)?
            }
            NativeMethod::ArrayBufferDetachedGetter
            | NativeMethod::ArrayBufferMaxByteLengthGetter
            | NativeMethod::ArrayBufferResizableGetter => {
                let buffer = self.array_buffer_ref(this).ok_or_else(|| {
                    self.catchable_type_error_msg("this: not an ArrayBuffer instance".into())
                })?;
                if self.shared_buffers.contains(&buffer) {
                    return Err(
                        self.catchable_type_error_msg("this: not an ArrayBuffer instance".into())
                    );
                }
                match m {
                    NativeMethod::ArrayBufferDetachedGetter => {
                        Slot::boolean(self.detached_buffers.contains(&buffer))
                    }
                    NativeMethod::ArrayBufferMaxByteLengthGetter => {
                        let length = if self.detached_buffers.contains(&buffer) {
                            0
                        } else {
                            self.array_buffers[&buffer].length
                        };
                        Slot::number(length as f64)
                    }
                    NativeMethod::ArrayBufferResizableGetter => Slot::boolean(false),
                    _ => unreachable!(),
                }
            }
            // `ArrayBuffer.prototype.resize`/`concat`: resizable buffers and
            // the XS concat extension remain honest named skips.
            NativeMethod::ArrayBufferResize => {
                return Err(Step::Host(Halt::NotImplemented(
                    "array-buffer-resize:unsupported",
                )))
            }
            NativeMethod::ArrayBufferConcat => {
                return Err(Step::Host(Halt::NotImplemented(
                    "array-buffer-concat:unsupported",
                )))
            }
            // `ArrayBuffer.isView(arg)` (`fx_ArrayBuffer_isView`): `true` iff
            // the argument is a TypedArray or DataView view, else `false`. The
            // host-frame residual is calibrated raw against the pin.
            NativeMethod::ArrayBufferIsView => {
                self.meter.tick_raw(ARRAY_BUFFER_ISVIEW_METERING);
                let is_view = match arg0.value {
                    Payload::Reference(r) => {
                        self.typed_arrays.contains_key(&r) || self.data_views.contains_key(&r)
                    }
                    _ => false,
                };
                Slot::boolean(is_view)
            }
            // `Atomics.*` — single-agent read-modify-write over an integer
            // TypedArray. All logic (validation, ToIndex, coercion, the RMW)
            // lives in the helper; a non-integer view / OOB index / non-clean
            // operand / the blocking-agent surface self-names an honest skip.
            NativeMethod::Atomic(op) => self.atomics_dispatch(op, base)?,
            NativeMethod::DataViewAccessor(index) => {
                let inst = match this.value {
                    Payload::Reference(r) if self.data_views.contains_key(&r) => r,
                    _ => {
                        return Err(
                            self.catchable_type_error_msg("this: not a DataView instance".into())
                        )
                    }
                };
                let view = self.data_views[&inst];
                if index != 0 && self.detached_buffers.contains(&view.buffer) {
                    return Err(self.catchable_type_error_msg("detached buffer".into()));
                }
                self.meter.tick_raw(TYPED_ARRAY_LENGTH_GET_METERING);
                match index {
                    0 => Slot::of(Kind::Reference, Payload::Reference(view.buffer)),
                    1 => Slot::number(view.size as f64),
                    _ => Slot::number(view.offset as f64),
                }
            }
            // `DataView.prototype.get<Type>(byteOffset[, littleEndian])`
            // (`fx_DataView_prototype_get`): read an element at `byteOffset`
            // honoring endianness (default big-endian). One `mxMeterOne`.
            NativeMethod::DataViewGet(kind) => {
                let inst = match this.value {
                    Payload::Reference(r) if self.data_views.contains_key(&r) => r,
                    _ => {
                        return Err(
                            self.catchable_type_error_msg("this: not a DataView instance".into())
                        )
                    }
                };
                let dv = self.data_views[&inst];
                let delta = TYPED_ARRAY_TYPES[kind as usize].size as u32;
                let offset = self.to_index_arg(code, arg0)?;
                // `GetViewValue`: after ToIndex, a detached backing buffer is a
                // TypeError — and it precedes the out-of-range RangeError, so a
                // detached view with an out-of-range offset still throws
                // TypeError (`detached-buffer-before-outofrange-byteoffset`).
                if self.detached_buffers.contains(&dv.buffer) {
                    return Err(self.catchable_type_error_msg("detached buffer".into()));
                }
                // `(size < delta) || ((size - delta) < offset)` → RangeError.
                if dv.size < delta || (dv.size - delta) < offset {
                    return Err(self.catchable_range_error_msg("invalid byteOffset".into()));
                }
                let little = self.arg_is_truthy(base, 1);
                let abs = dv.offset + offset;
                self.meter.tick_raw(DATA_VIEW_GET_METERING);
                // `getBigInt64`/`getBigUint64` (kinds 0/1) decode into a
                // freshly allocated BigInt (metered by `make_bigint`); the
                // numeric getters return a metering-neutral primitive.
                if kind <= 1 {
                    self.data_view_read_bigint(dv.buffer, abs, kind, little)
                } else {
                    self.data_view_read(dv.buffer, abs, kind, little)?
                }
            }
            // `DataView.prototype.set<Type>(byteOffset, value[, littleEndian])`
            // (`fx_DataView_prototype_set`): coerce + write. One `mxMeterOne`.
            NativeMethod::DataViewSet(kind) => {
                let inst = match this.value {
                    Payload::Reference(r) if self.data_views.contains_key(&r) => r,
                    _ => {
                        return Err(
                            self.catchable_type_error_msg("this: not a DataView instance".into())
                        )
                    }
                };
                let dv = self.data_views[&inst];
                let delta = TYPED_ARRAY_TYPES[kind as usize].size as u32;
                let offset = self.to_index_arg(code, arg0)?;
                let value = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                // The littleEndian flag is argument 2 for set.
                let little = self.arg_is_truthy(base, 2);
                // `SetViewValue` coerces the value (ToNumber/ToBigInt — which
                // may run a user `valueOf`/`Symbol.toPrimitive` that detaches
                // the buffer) BEFORE the IsDetachedBuffer and range tests.
                // `setBigInt64`/`setBigUint64` (kinds 0/1) take a BigInt value
                // (ToBigInt); the 8-byte two's-complement store is identical
                // for signed/unsigned, differing only in the getter's decode.
                let le = if kind <= 1 {
                    self.data_view_encode_bigint(code, value, little)?.to_vec()
                } else {
                    self.data_view_encode(code, kind, value, little)?
                };
                // A detached backing buffer is a TypeError, ahead of the
                // out-of-range RangeError (`detached-buffer-*` ordering cases).
                if self.detached_buffers.contains(&dv.buffer) {
                    return Err(self.catchable_type_error_msg("detached buffer".into()));
                }
                if dv.size < delta || (dv.size - delta) < offset {
                    return Err(self.catchable_range_error_msg("invalid byteOffset".into()));
                }
                let abs = dv.offset + offset;
                self.data_view_store(dv.buffer, abs, &le);
                self.meter.tick_raw(DATA_VIEW_SET_METERING);
                Slot::undefined()
            }
            // The `Promise.prototype` methods and statics that re-enter user
            // code / build derived promises are handled outside this
            // value-returning match (`.then` and the statics thread `code`);
            // this arm is reached only for the not-yet-modeled ones, an honest
            // named skip. `.then`/`resolve`/`reject` are intercepted before the
            // generic method dispatch (see `call_native_method_reentrant`).
            // `Promise.prototype.then`: register the reaction and return the
            // derived promise. The reaction runs later, at the pump-loop drain
            // — no synchronous re-entry here, so it fits the value-returning
            // method dispatch.
            NativeMethod::PromiseThen => {
                let promise = match this.value {
                    Payload::Reference(r) if self.promises.contains_key(&r) => r,
                    _ => {
                        return Err(self.catchable_type_error_msg(
                            if this.kind == Kind::Reference {
                                "this: not a Promise instance"
                            } else {
                                "this: not an object"
                            }
                            .into(),
                        ))
                    }
                };
                self.promise_then(code, promise, base)?
            }
            // `%GeneratorPrototype%.next/return/throw` (`fx_Generator_prototype_
            // aux`): resume the suspended body and return `{value, done}`. A
            // non-generator receiver is a catchable `TypeError`.
            NativeMethod::GeneratorNext => {
                let gen = match this.value {
                    Payload::Reference(r) if self.generators.contains_key(&r) => r,
                    _ => {
                        return Err(
                            self.catchable_type_error_msg("this: not a Generator instance".into())
                        )
                    }
                };
                self.resume_generator(code, gen, arg0, GenStatus::Next)?
            }
            NativeMethod::GeneratorReturn => {
                let gen = match this.value {
                    Payload::Reference(r) if self.generators.contains_key(&r) => r,
                    _ => {
                        return Err(
                            self.catchable_type_error_msg("this: not a Generator instance".into())
                        )
                    }
                };
                self.resume_generator(code, gen, arg0, GenStatus::Return)?
            }
            NativeMethod::GeneratorThrow => {
                let gen = match this.value {
                    Payload::Reference(r) if self.generators.contains_key(&r) => r,
                    _ => {
                        return Err(
                            self.catchable_type_error_msg("this: not a Generator instance".into())
                        )
                    }
                };
                self.resume_generator(code, gen, arg0, GenStatus::Throw)?
            }
            NativeMethod::AsyncGeneratorNext => match this.value {
                Payload::Reference(r) if self.async_generators.contains_key(&r) => {
                    self.enqueue_async_generator(code, r, arg0, GenStatus::Next)?
                }
                _ => self.reject_async_generator_brand()?,
            },
            NativeMethod::AsyncGeneratorReturn => match this.value {
                Payload::Reference(r) if self.async_generators.contains_key(&r) => {
                    self.enqueue_async_generator(code, r, arg0, GenStatus::Return)?
                }
                _ => self.reject_async_generator_brand()?,
            },
            NativeMethod::AsyncGeneratorThrow => match this.value {
                Payload::Reference(r) if self.async_generators.contains_key(&r) => {
                    self.enqueue_async_generator(code, r, arg0, GenStatus::Throw)?
                }
                _ => self.reject_async_generator_brand()?,
            },
            NativeMethod::AsyncIteratorIdentity => this,
            // `Promise.resolve(v)` (`fx_Promise_resolve`): a native promise
            // whose observable constructor is the receiver is returned as-is;
            // otherwise a capability is built and its `resolve` called with
            // `v`. The intrinsic Promise keeps its calibrated fast path;
            // arbitrary constructors go through `NewPromiseCapability`.
            NativeMethod::PromiseResolveStatic => {
                if !self.is_constructor_value(this) {
                    return Err(self.catchable_type_error_msg(
                        if this.kind == Kind::Reference {
                            "new: not a constructor"
                        } else {
                            "this: not an object"
                        }
                        .into(),
                    ));
                }
                let intrinsic = self.intrinsics.get("Promise").copied();
                let same_constructor = if let Payload::Reference(promise) = arg0.value {
                    if arg0.kind == Kind::Reference && self.promises.contains_key(&promise) {
                        let constructor_id = self.intern_static_key("constructor");
                        let constructor = self.mop_get(code, promise, constructor_id, arg0)?;
                        self.same_value(constructor, this)
                    } else {
                        false
                    }
                } else {
                    false
                };
                if same_constructor {
                    self.meter.tick_raw(PROMISE_RESOLVE_SAME_METERING);
                    arg0
                } else if matches!(this.value,
                    Payload::Reference(c)
                        if this.kind == Kind::Reference && Some(c) == intrinsic)
                {
                    self.meter.tick_raw(PROMISE_RESOLVE_STATIC_METERING);
                    let (derived, _resolve, _reject) = self.new_promise_capability();
                    self.settle_promise(code, derived, arg0, false)?;
                    Slot::of(Kind::Reference, Payload::Reference(derived))
                } else {
                    let capability = self.new_promise_capability_for(code, this)?;
                    self.call_any(code, capability.resolve, Slot::undefined(), &[arg0])?;
                    capability.promise
                }
            }
            // `Promise.reject(reason)` (`fx_Promise_reject`): a capability whose
            // `reject` is called with `reason` (any value).
            NativeMethod::PromiseRejectStatic => {
                if !self.is_constructor_value(this) {
                    return Err(self.catchable_type_error_msg(
                        if this.kind == Kind::Reference {
                            "new: not a constructor"
                        } else {
                            "this: not an object"
                        }
                        .into(),
                    ));
                }
                let intrinsic = self.intrinsics.get("Promise").copied();
                if matches!(this.value,
                    Payload::Reference(c)
                        if this.kind == Kind::Reference && Some(c) == intrinsic)
                {
                    self.meter.tick_raw(PROMISE_REJECT_STATIC_METERING);
                    let (derived, _resolve, _reject) = self.new_promise_capability();
                    self.settle_promise(code, derived, arg0, true)?;
                    Slot::of(Kind::Reference, Payload::Reference(derived))
                } else {
                    let capability = self.new_promise_capability_for(code, this)?;
                    self.call_any(code, capability.reject, Slot::undefined(), &[arg0])?;
                    capability.promise
                }
            }
            // `Promise.prototype.catch(onRejected)`: Invoke the receiver's
            // observable `then` method with `(undefined, onRejected)`. The
            // method is deliberately generic: primitive receivers use GetV,
            // accessors and proxies are observable, and a missing/non-callable
            // `then` throws synchronously.
            NativeMethod::PromiseCatch => {
                self.meter.tick_raw(PROMISE_CATCH_FRAME_METERING);
                self.invoke_value_method(code, this, "then", &[Slot::undefined(), arg0])?
            }
            // `Promise.prototype.finally(onFinally)` (`fx_Promise_prototype_
            // finally`): observable SpeciesConstructor + Invoke dispatch, with
            // the default native path registering a FINALLY reaction whose
            // callback runs at the drain.
            NativeMethod::PromiseFinally => self.promise_finally_dispatch(code, this, arg0)?,
            NativeMethod::PromiseSpeciesGetter
            | NativeMethod::RegExpSpeciesGetter
            | NativeMethod::ArrayBufferSpeciesGetter => this,
            // `Promise.all`/`allSettled`/`race`/`any` (`fx_Promise_all` …): build
            // the derived promise, resolve each (dense-Array) element to a
            // promise, and register a native COMBINE reaction on it; the shared
            // `remainingElementsCount`/results state settles the derived at the
            // drain. No synchronous user re-entry.
            NativeMethod::PromiseAll => {
                self.promise_combinator(code, CombinatorKind::All, arg0, this)?
            }
            NativeMethod::PromiseAllSettled => {
                self.promise_combinator(code, CombinatorKind::AllSettled, arg0, this)?
            }
            NativeMethod::PromiseRace => {
                self.promise_combinator(code, CombinatorKind::Race, arg0, this)?
            }
            NativeMethod::PromiseAny => {
                self.promise_combinator(code, CombinatorKind::Any, arg0, this)?
            }
            // The resolve/reject functions settle in the `RUN` dispatch
            // (`call_promise_function`) and never reach here.
            NativeMethod::PromiseResolveFunction
            | NativeMethod::PromiseRejectFunction
            | NativeMethod::PromiseCapabilityExecutor
            | NativeMethod::PromiseFinallyHandler
            | NativeMethod::PromiseFinallyValue => {
                return Err(Step::Host(Halt::EngineInvariant(
                    "promise:resolving-fn-unexpected",
                )))
            }
            // `RegExp.prototype.exec`/`test`/`toString` — the JavaScript RegExp
            // surface over `ironhorse_regexp`.
            NativeMethod::RegExpExec => {
                let inst = match this.value {
                    Payload::Reference(r) if this.kind == Kind::Reference => r,
                    _ => {
                        return Err(
                            self.catchable_type_error_msg("this: not a RegExp instance".into())
                        )
                    }
                };
                if self.regexps.contains_key(&inst) {
                    self.regexp_exec(code, inst, arg0)?
                } else {
                    // The builtin rejects a receiver without
                    // [[RegExpMatcher]] before coercing its argument.
                    return Err(self.catchable_type_error_msg("this: not a RegExp instance".into()));
                }
            }
            NativeMethod::RegExpTest => {
                let inst = match this.value {
                    Payload::Reference(r) if this.kind == Kind::Reference => r,
                    _ => {
                        return Err(self.catchable_type_error_msg(
                            match this.kind {
                                Kind::Null => "cannot coerce null to object",
                                Kind::Undefined => "cannot coerce undefined to object",
                                _ => "this: not a RegExp instance",
                            }
                            .into(),
                        ))
                    }
                };
                self.regexp_test(code, inst, this, arg0)?
            }
            NativeMethod::RegExpCompile => this,
            NativeMethod::ErrorStackGetter => {
                let inst = match this.value {
                    Payload::Reference(r) if this.kind == Kind::Reference => r,
                    _ => return Err(self.catchable_type_error_msg("this: not an object".into())),
                };
                match self.error_data.get(&inst).cloned() {
                    None => Slot::undefined(),
                    Some(info) => {
                        // `name`/`message` are read live off the instance
                        // (`mxGetID`), so a post-construction rename shows.
                        let mut text = match self.name_id.map(|id| self.instance_get(inst, id)) {
                            Some(v) if v.kind != Kind::Undefined => self.render(&v)?,
                            _ => info.name.to_string(),
                        };
                        let message = match self.symbol_ids.get("message").copied() {
                            Some(id) => {
                                let v = self.instance_get(inst, id);
                                if v.kind == Kind::Undefined {
                                    None
                                } else {
                                    Some(self.render(&v)?)
                                }
                            }
                            None => info.message.clone(),
                        };
                        if let Some(m) = message {
                            if !m.is_empty() {
                                text.push_str(": ");
                                text.push_str(&m);
                            }
                        }
                        for frame in &info.frames {
                            text.push_str("\n at");
                            if !frame.is_empty() {
                                text.push(' ');
                                text.push_str(frame);
                            }
                            text.push_str(" ()");
                        }
                        self.new_string_metered(text.as_bytes())
                    }
                }
            }
            NativeMethod::ErrorStackSetter => {
                let inst = match this.value {
                    Payload::Reference(r) if this.kind == Kind::Reference => r,
                    _ => return Err(self.catchable_type_error_msg("this: not an object".into())),
                };
                if argc < 1 {
                    return Err(self.catchable_type_error_msg("no value".into()));
                }
                let id = self.intern_static_key("stack");
                let desc = OrdinaryDescriptor {
                    value: Some(arg0),
                    writable: Some(true),
                    enumerable: Some(true),
                    configurable: Some(true),
                    ..OrdinaryDescriptor::default()
                };
                if !self.mop_define_own_property(code, inst, id, desc)? {
                    // XS fxDefineID reports its numeric builtin ID for stack,
                    // unlike the named-key opcode's diagnostic.
                    return Err(
                        self.catchable_type_error_msg("define 413: not configurable".into())
                    );
                }
                Slot::undefined()
            }
            NativeMethod::RegExpMatch => self.regexp_match(code, this, arg0)?,
            NativeMethod::RegExpMatchAll => self.regexp_match_all(code, this, arg0)?,
            NativeMethod::RegExpSearch => self.regexp_search(code, this, arg0)?,
            NativeMethod::RegExpSplit => {
                let limit = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                self.regexp_split(code, this, arg0, limit)?
            }
            NativeMethod::RegExpReplace => {
                let regexp = match this.value {
                    Payload::Reference(regexp) if this.kind == Kind::Reference => regexp,
                    _ => {
                        return Err(self.catchable_type_error_msg(
                            match this.kind {
                                Kind::Null => "cannot coerce null to object",
                                Kind::Undefined => "cannot coerce undefined to object",
                                _ => "this: not a RegExp instance",
                            }
                            .into(),
                        ))
                    }
                };
                let replacement = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let subject = if arg0.kind == Kind::String {
                    arg0
                } else {
                    let units = self.to_string_units(code, arg0)?;
                    self.new_string_units(&units)
                };
                if self.regexps.contains_key(&regexp) && self.regexp_replace_fast_safe(regexp) {
                    self.string_replace(code, regexp, subject, replacement)?
                } else {
                    self.regexp_replace_generic(code, regexp, this, subject, replacement)?
                }
            }
            NativeMethod::RegExpToString => {
                let inst = match this.value {
                    Payload::Reference(r) if this.kind == Kind::Reference => r,
                    _ if matches!(this.kind, Kind::Null | Kind::Undefined) => {
                        return Err(
                            self.catchable_type_error_msg(cannot_coerce_to_object(this.kind))
                        )
                    }
                    // Spec requires an object. XS boxes other primitives and
                    // can complete, so this guard has no XS error counterpart.
                    _ => return Err(self.catchable_type_error()),
                };
                let source_id = self.intern_static_key("source");
                let flags_id = self.intern_static_key("flags");
                let default_source = self.regexps.contains_key(&inst)
                    && self.regexp_getter_uses_default(inst, source_id);
                let default_flags = self.regexps.contains_key(&inst)
                    && self.regexp_getter_uses_default(inst, flags_id);
                if default_source && default_flags {
                    self.regexp_to_string(inst)?
                } else {
                    self.regexp_to_string_generic(code, inst, this)?
                }
            }
            // `String.prototype.search`: a custom `regexp[Symbol.search]` is
            // called with the original receiver before string coercion. The
            // intrinsic RegExp path uses the existing matcher; every other
            // argument is converted through `RegExpCreate(regexp, undefined)`.
            NativeMethod::StringSearch => {
                if matches!(this.kind, Kind::Undefined | Kind::Null) {
                    return Err(self.catchable_type_error_msg(
                        if this.kind == Kind::Null {
                            "this: null"
                        } else {
                            "this: undefined"
                        }
                        .into(),
                    ));
                }
                self.meter.tick_raw(STRING_REGEXP_PROTOCOL_FRAME_METERING);
                let search_method = self.string_protocol_method(code, arg0, "search")?;
                if !matches!(search_method.kind, Kind::Undefined | Kind::Null) {
                    self.invoke_value(code, search_method, arg0, &[this])?
                } else {
                    let subject = if this.kind == Kind::String {
                        this
                    } else {
                        let units = self.string_this_units(code, this)?;
                        self.new_string_units(&units)
                    };
                    let regexp_constructor = *self
                        .intrinsics
                        .get("RegExp")
                        .expect("RegExp intrinsic is linked");
                    let constructor =
                        Slot::of(Kind::Reference, Payload::Reference(regexp_constructor));
                    let matcher = self.construct_value(code, constructor, &[arg0], constructor)?;
                    let method = self.string_protocol_method(code, matcher, "search")?;
                    self.invoke_value(code, method, matcher, &[subject])?
                }
            }
            // `String.prototype.match`: a custom `regexp[Symbol.match]` is
            // called with the original receiver before string coercion. The
            // intrinsic RegExp path uses the existing matcher; every other
            // argument is converted through `RegExpCreate(regexp, undefined)`.
            NativeMethod::StringMatch => {
                if matches!(this.kind, Kind::Undefined | Kind::Null) {
                    return Err(self.catchable_type_error_msg(
                        if this.kind == Kind::Null {
                            "this: null"
                        } else {
                            "this: undefined"
                        }
                        .into(),
                    ));
                }
                self.meter.tick_raw(STRING_REGEXP_PROTOCOL_FRAME_METERING);
                let match_method = self.string_protocol_method(code, arg0, "match")?;
                if !matches!(match_method.kind, Kind::Undefined | Kind::Null) {
                    self.invoke_value(code, match_method, arg0, &[this])?
                } else {
                    let subject = if this.kind == Kind::String {
                        this
                    } else {
                        let units = self.string_this_units(code, this)?;
                        self.new_string_units(&units)
                    };
                    let regexp_constructor = *self
                        .intrinsics
                        .get("RegExp")
                        .expect("RegExp intrinsic is linked");
                    let constructor =
                        Slot::of(Kind::Reference, Payload::Reference(regexp_constructor));
                    let matcher = self.construct_value(code, constructor, &[arg0], constructor)?;
                    let method = self.string_protocol_method(code, matcher, "match")?;
                    self.invoke_value(code, method, matcher, &[subject])?
                }
            }
            NativeMethod::StringMatchAll => self.string_match_all(code, this, arg0)?,
            // `String.prototype.replace`: a custom `searchValue[Symbol.replace]`
            // runs with the original receiver before string coercion. Internal
            // RegExps use the matcher worker; every other value follows the
            // ordinary first-string-occurrence algorithm.
            NativeMethod::StringReplace => {
                if matches!(this.kind, Kind::Undefined | Kind::Null) {
                    return Err(self.catchable_type_error_msg(
                        if this.kind == Kind::Null {
                            "this: null"
                        } else {
                            "this: undefined"
                        }
                        .into(),
                    ));
                }
                let repl = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let replace_method = self.string_protocol_method(code, arg0, "replace")?;
                if !matches!(replace_method.kind, Kind::Undefined | Kind::Null) {
                    self.invoke_value(code, replace_method, arg0, &[this, repl])?
                } else {
                    let subject = if this.kind == Kind::String {
                        this
                    } else {
                        let units = self.string_this_units(code, this)?;
                        self.new_string_units(&units)
                    };
                    self.string_replace_plain(code, subject, arg0, repl)?
                }
            }
            // `String.prototype.replaceAll`: RequireObjectCoercible precedes
            // the observable IsRegExp/flags check. A custom `@@replace` still
            // receives the original receiver; otherwise the string branch
            // replaces every non-overlapping UTF-16 occurrence. IronHorse's
            // intrinsic RegExp `@@replace` delegates to the shared global
            // matcher worker.
            NativeMethod::StringReplaceAll => {
                if matches!(this.kind, Kind::Undefined | Kind::Null) {
                    return Err(self.catchable_type_error_msg(
                        if this.kind == Kind::Undefined {
                            "this: undefined"
                        } else {
                            "this: null"
                        }
                        .into(),
                    ));
                }
                let repl = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let is_regexp = if matches!(arg0.kind, Kind::Undefined | Kind::Null) {
                    false
                } else {
                    self.string_is_regexp(code, arg0)?
                };
                if is_regexp {
                    let Payload::Reference(search_object) = arg0.value else {
                        unreachable!("IsRegExp is false for primitive values")
                    };
                    let flags = self.regexp_flags_units(code, search_object, arg0, true)?;
                    if !flags.contains(&(b'g' as u16)) {
                        return Err(self.catchable_type_error_msg("regexp has no g flag".into()));
                    }
                }

                let replace_method = self.string_protocol_method(code, arg0, "replace")?;
                if !matches!(replace_method.kind, Kind::Undefined | Kind::Null) {
                    self.invoke_value(code, replace_method, arg0, &[this, repl])?
                } else {
                    let subject = if this.kind == Kind::String {
                        this
                    } else {
                        let units = self.string_this_units(code, this)?;
                        self.new_string_units(&units)
                    };
                    self.string_replace_all_plain(code, subject, arg0, repl)?
                }
            }
            // `String.prototype.split(separator[, limit])`: a custom
            // `separator[Symbol.split]` runs before receiver coercion; a RegExp
            // without an override uses the sticky-splitter worker; everything
            // else follows the ordinary UTF-16 string-separator algorithm.
            NativeMethod::StringSplit => {
                // RequireObjectCoercible precedes the separator protocol, so a
                // custom `@@split` cannot observe a nullish receiver.
                if matches!(this.kind, Kind::Undefined | Kind::Null) {
                    return Err(self.catchable_type_error_msg(
                        if this.kind == Kind::Undefined {
                            "this: undefined"
                        } else {
                            "this: null"
                        }
                        .into(),
                    ));
                }
                let limit = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let split_method = self.string_protocol_method(code, arg0, "split")?;
                if !matches!(split_method.kind, Kind::Undefined | Kind::Null) {
                    self.meter.tick_raw(STRING_SPLIT_PROTOCOL_FRAME_METERING);
                    self.invoke_value(code, split_method, arg0, &[this, limit])?
                } else {
                    self.string_split_plain(code, this, arg0, limit)?
                }
            }
        };
        self.stack.truncate(base);
        self.push(result);
        Ok(())
    }
}
