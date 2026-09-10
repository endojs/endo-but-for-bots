//! RegExp execution, lastIndex, and the string/regexp protocol methods.
use super::super::*;

impl Interp {
    /// The canonical flag string for a compiled flags word (`code[0]`), in
    /// the fixed `d g i m s u v y` order XS's `fx_RegExp_prototype_get_flags`
    /// emits (each bit read from `code[0]`).
    pub(in crate::interp) fn regexp_flag_string(flags: u32) -> String {
        use ironhorse_regexp::{
            XS_REGEXP_D, XS_REGEXP_G, XS_REGEXP_I, XS_REGEXP_M, XS_REGEXP_S, XS_REGEXP_U,
            XS_REGEXP_V, XS_REGEXP_Y,
        };
        let mut s = String::new();
        if flags & XS_REGEXP_D != 0 {
            s.push('d');
        }
        if flags & XS_REGEXP_G != 0 {
            s.push('g');
        }
        if flags & XS_REGEXP_I != 0 {
            s.push('i');
        }
        if flags & XS_REGEXP_M != 0 {
            s.push('m');
        }
        if flags & XS_REGEXP_S != 0 {
            s.push('s');
        }
        if flags & XS_REGEXP_U != 0 {
            s.push('u');
        }
        if flags & XS_REGEXP_V != 0 {
            s.push('v');
        }
        if flags & XS_REGEXP_Y != 0 {
            s.push('y');
        }
        s
    }

    /// The canonical `lastIndex` key. It is an XS boot-default key, so making
    /// it visible for an instance constructed by code that never spelled the
    /// name is unmetered, just like the pre-existing intrinsic property.
    pub(in crate::interp) fn regexp_last_index_id(&mut self) -> u16 {
        if let Some(id) = self.last_index_id {
            return id;
        }
        let id = self.intern_static_key_unmetered("lastIndex");
        self.last_index_id = Some(id);
        id
    }

    /// Install the mandatory RegExp-instance `lastIndex` data property:
    /// writable, non-enumerable, and non-configurable.
    pub(in crate::interp) fn install_regexp_last_index(
        &mut self,
        inst: crate::value::SlotIndex,
        value: Slot,
    ) {
        let id = self.regexp_last_index_id();
        self.set_own_unmetered_with_flag(inst, id, value, XS_DONT_ENUM_FLAG | XS_DONT_DELETE_FLAG);
    }

    pub(in crate::interp) fn regexp_get_last_index(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
    ) -> Result<Slot, Step> {
        let id = self.regexp_last_index_id();
        let receiver = Slot::of(Kind::Reference, Payload::Reference(inst));
        self.mop_get(code, inst, id, receiver)
    }

    /// `Set(R, "lastIndex", value, true)`: every RegExp algorithm uses the
    /// throwing form, so a frozen instance reports a catchable TypeError.
    pub(in crate::interp) fn regexp_set_last_index(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        value: Slot,
    ) -> Result<(), Step> {
        let id = self.regexp_last_index_id();
        let receiver = Slot::of(Kind::Reference, Payload::Reference(inst));
        if self.mop_set(code, inst, id, value, receiver)? {
            Ok(())
        } else {
            Err(self.failed_set_error(inst, id, "C: xsSet"))
        }
    }

    pub(in crate::interp) fn regexp_last_index_length(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
    ) -> Result<u64, Step> {
        let value = self.regexp_get_last_index(code, inst)?;
        self.to_length_value(code, value)
    }

    /// `SpeciesConstructor(R, %RegExp%)` for the RegExp protocol methods.
    /// Constructor and `@@species` reads remain observable through the full
    /// object MOP; undefined constructor and nullish species select the realm
    /// intrinsic.
    pub(in crate::interp) fn regexp_species_constructor(
        &mut self,
        code: &[u8],
        regexp: Slot,
    ) -> Result<Slot, Step> {
        let regexp_inst = match regexp.value {
            Payload::Reference(inst) if regexp.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg("this: not an object".into())),
        };
        let default_ref = *self
            .intrinsics
            .get("RegExp")
            .expect("RegExp intrinsic is linked");
        let default = Slot::of(Kind::Reference, Payload::Reference(default_ref));
        let constructor_id = self.intern_static_key("constructor");
        let constructor = self.mop_get(code, regexp_inst, constructor_id, regexp)?;
        if constructor.kind == Kind::Undefined {
            return Ok(default);
        }
        let constructor_inst = match constructor.value {
            Payload::Reference(inst) if constructor.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg("no constructor".into())),
        };
        let species_id = self
            .well_known_symbol_property_id("species")
            .expect("well-known species symbol");
        let species = self.mop_get(code, constructor_inst, species_id, constructor)?;
        let selected = if matches!(species.kind, Kind::Null | Kind::Undefined) {
            default
        } else {
            species
        };
        if !self.is_constructor_value(selected) {
            return Err(self.catchable_type_error_msg("no constructor".into()));
        }
        Ok(selected)
    }

    pub(in crate::interp) fn regexp_advance_last_index(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        subject: &[u16],
    ) -> Result<(), Step> {
        let index = self.regexp_last_index_length(code, inst)?;
        let unicode = self.regexps[&inst].program.flags()
            & (ironhorse_regexp::XS_REGEXP_U | ironhorse_regexp::XS_REGEXP_V)
            != 0;
        let next = Self::advance_string_index(subject, index, unicode);
        self.regexp_set_last_index(code, inst, Slot::number(next as f64))
    }

    /// Read `%RegExp.prototype%.flags` through the observable property seam.
    /// IronHorse keeps the intrinsic RegExp accessors implicit, so the default
    /// getter is expanded here into its eight ordered flag-property reads;
    /// own/inherited overrides and proxies still route through `[[Get]]`.
    pub(in crate::interp) fn regexp_flags_units(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        receiver: Slot,
        reject_nullish: bool,
    ) -> Result<Vec<u16>, Step> {
        let flags_id = self.intern_static_key("flags");
        if !self.regexps.contains_key(&inst) || !self.regexp_getter_uses_default(inst, flags_id) {
            let flags = self.mop_get(code, inst, flags_id, receiver)?;
            if reject_nullish && matches!(flags.kind, Kind::Undefined | Kind::Null) {
                // Keep RequireObjectCoercible from the spec. Pinned XS instead
                // stringifies these values and reports its missing-global-flag error.
                return Err(self.catchable_type_error_msg(
                    "RegExp: flags must not be null or undefined".into(),
                ));
            }
            return self.to_string_units(code, flags);
        }

        use ironhorse_regexp::{
            XS_REGEXP_D, XS_REGEXP_G, XS_REGEXP_I, XS_REGEXP_M, XS_REGEXP_S, XS_REGEXP_U,
            XS_REGEXP_V, XS_REGEXP_Y,
        };
        let mut units = Vec::with_capacity(8);
        for (name, flag, unit) in [
            ("hasIndices", XS_REGEXP_D, b'd' as u16),
            ("global", XS_REGEXP_G, b'g' as u16),
            ("ignoreCase", XS_REGEXP_I, b'i' as u16),
            ("multiline", XS_REGEXP_M, b'm' as u16),
            ("dotAll", XS_REGEXP_S, b's' as u16),
            ("unicode", XS_REGEXP_U, b'u' as u16),
            ("unicodeSets", XS_REGEXP_V, b'v' as u16),
            ("sticky", XS_REGEXP_Y, b'y' as u16),
        ] {
            let id = self.intern_static_key(name);
            let value = if self.regexp_getter_uses_default(inst, id) {
                Slot::boolean(self.regexps[&inst].program.flags() & flag != 0)
            } else {
                self.mop_get(code, inst, id, receiver)?
            };
            if self.truthy(&value) {
                units.push(unit);
            }
        }
        self.meter.tick_raw(REGEXP_FLAGS_GETTER_METERING);
        // XS materializes the flags string here, and the callers that only
        // want the units drop it immediately. Charge exactly the chunk
        // `new_string_units` would have charged instead of allocating one:
        // every observable flags read (@@replace, @@split, @@match,
        // @@matchAll, String.prototype.matchAll, RegExp.prototype.toString)
        // reaches this, so the discarded chunk was per-dispatch garbage.
        if !units.is_empty() {
            self.charge_and_check(string_chunk_cost(units.len() as u64))?;
        }
        Ok(units)
    }

    /// Whether the existing internal replacement worker is observationally
    /// equivalent to the generic `@@replace` algorithm. The fast path is only
    /// valid when every implicit flag accessor and `exec` is still the realm
    /// default and no Proxy interrupts the prototype walk.
    pub(in crate::interp) fn regexp_replace_fast_safe(
        &self,
        inst: crate::value::SlotIndex,
    ) -> bool {
        let default_accessor_unshadowed = |name: &str| {
            let Some(&id) = self.symbol_ids.get(name) else {
                return true;
            };
            let mut current = inst;
            while !current.is_null() {
                if self.proxies.contains_key(&current) {
                    return false;
                }
                if self.find_property(current, id).is_some() {
                    return false;
                }
                if current == self.regexp_proto {
                    return true;
                }
                current = self.instance_prototype(current);
            }
            false
        };
        if ![
            "flags",
            "hasIndices",
            "global",
            "ignoreCase",
            "multiline",
            "dotAll",
            "unicode",
            "unicodeSets",
            "sticky",
        ]
        .iter()
        .all(|name| default_accessor_unshadowed(name))
        {
            return false;
        }

        let Some(&exec_id) = self.symbol_ids.get("exec") else {
            // Sparse intrinsic linking leaves the default method implicit when
            // no source unit names it; RegExpExec then takes the builtin arm.
            return true;
        };
        let mut current = inst;
        while !current.is_null() {
            if self.proxies.contains_key(&current) {
                return false;
            }
            if let Some(property) = self.find_property(current, exec_id) {
                if current != self.regexp_proto {
                    return false;
                }
                let slot = self.slots.get(property);
                let Payload::Reference(function) = slot.value else {
                    return false;
                };
                return slot.flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) == 0
                    && self.method_of(function) == Some(NativeMethod::RegExpExec);
            }
            if current == self.regexp_proto {
                return true;
            }
            current = self.instance_prototype(current);
        }
        false
    }

    /// `AdvanceStringIndex(S, index, unicode)`: advance by one UTF-16 code
    /// unit, except that `u`/`v` mode consumes a valid surrogate pair as one
    /// code point. An index at/past the end still advances by one.
    pub(in crate::interp) fn advance_string_index(
        subject: &[u16],
        index: u64,
        unicode: bool,
    ) -> u64 {
        if unicode {
            if let Ok(i) = usize::try_from(index) {
                if i + 1 < subject.len()
                    && (0xD800..=0xDBFF).contains(&subject[i])
                    && (0xDC00..=0xDFFF).contains(&subject[i + 1])
                {
                    return index.saturating_add(2);
                }
            }
        }
        index.saturating_add(1)
    }

    /// Build a RegExp instance from a coerced pattern + flags string
    /// (`fx_RegExp` → `fxNewRegExpInstance` + `fxInitializeRegExp`): compile
    /// the pattern with `ironhorse_regexp`, chain the instance to
    /// `%RegExp.prototype%`, and record its program/source/flags +
    /// `lastIndex` = 0 in the `regexps` side table. An invalid pattern throws a
    /// catchable `SyntaxError` (as `fxCompileRegExp` failing does); a
    /// not-yet-ported pattern feature self-names an honest skip.
    pub(in crate::interp) fn build_regexp(
        &mut self,
        pattern: Vec<u16>,
        flags: String,
    ) -> Result<Slot, Step> {
        self.charge_and_check(0)?;
        let budget = if self.meter.is_armed() {
            (u64::MAX - self.meter.raw()) / XS_PARSE_REGEXP_METERING
        } else {
            u64::MAX
        };
        let mut charged = 0;
        let outcome = {
            let mut check = |raw| {
                let delta = raw - charged;
                charged = raw;
                self.charge_and_check(delta).is_ok()
            };
            ironhorse_regexp::compile_units_checked(&pattern, &flags, budget, Some(&mut check))
        };
        if outcome.work_meter_raw > charged {
            self.charge_and_check(outcome.work_meter_raw - charged)?;
        }
        let program = match outcome.result {
            Err(ironhorse_regexp::CompileError::BudgetExceeded) => {
                return Err(Step::Host(Halt::MeterAbort))
            }
            Err(ironhorse_regexp::CompileError::ResourceLimit) => {
                return Err(Step::Host(Halt::HeapExhausted))
            }
            Ok(p) => p,
            Err(ironhorse_regexp::CompileError::Syntax(reason)) => {
                // An invalid pattern is a catchable `SyntaxError`, exactly as
                // `fxCompileRegExp` failing makes `new RegExp(...)` throw.
                let message = format!("invalid regular expression: {reason}");
                // XS fxThrowMessage renders into a 128-byte C buffer.
                let bytes = message.as_bytes();
                let message = String::from_utf8_lossy(&bytes[..bytes.len().min(127)]).into_owned();
                return Err(self.catchable_syntax_error_with_message(message));
            }
            Err(ironhorse_regexp::CompileError::Unsupported(regexp_feature)) => {
                return Err(Step::Host(Halt::NotImplemented(regexp_feature)))
            }
        };
        // `fxNewRegExpInstance`: four `fxNewSlot`s — the instance, the
        // `XS_REGEXP_KIND` internal slot, the source-key slot, and the
        // `lastIndex` integer property.
        for _ in 0..4 {
            self.meter.tick_slot_alloc();
        }
        // Compiler work, including code emission, was prepaid above.
        // `fxCompileRegExp` allocates two `fxNewChunk`s: the `code` buffer
        // (the emitted words times four) and the `data` scratch buffer, sized from
        // the term counts (`captureCount*sizeof(txCaptureData) +
        // nameCount*sizeof(txInteger) + assertionCount*sizeof(txAssertionData)
        // + quantifierCount*sizeof(txQuantifierData)`, the 64-bit oracle
        // struct sizes 8/4/16/12). Both scale with the pattern, so modeling
        // them explicitly keeps construction raw-exact across every pattern
        // shape (not just the calibration set).
        let code_bytes = program.code.len() as u64 * 4;
        self.charge_chunk_work(code_bytes)?;
        let data_bytes = (program.capture_count * 8
            + program.name_count * 4
            + program.assertion_count * 16
            + program.quantifier_count * 12) as u64;
        self.charge_chunk_work(data_bytes)?;
        // The `fx_RegExp` host frame + `fxGetPrototypeFromConstructor` + the
        // `mxRunCount(2)` `fxInitializeRegExp` call framing (the residual
        // beyond the explicit slot/chunk allocations and the compile meter).
        self.meter.tick_raw(REGEXP_CTOR_FRAME_METERING);
        let canonical_flags = Self::regexp_flag_string(program.flags());
        let proto = self.regexp_proto;
        let inst = self.slots.alloc(Slot::instance(proto));
        self.regexps.insert(
            inst,
            RegExpData {
                program,
                source: pattern,
                flags: canonical_flags,
                last_index: 0.0,
            },
        );
        self.install_regexp_last_index(inst, Slot::integer(0));
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    /// Drive the matcher for `exec`/`test` (`fxMatchRegExp` from the resolved
    /// `lastIndex`): returns `(matched, captures, names)`, with captures in
    /// **code-unit** offsets, charging the match meter and updating
    /// `lastIndex`. The matcher itself uses XS CESU-8 byte offsets; `offsets`
    /// is the exact code-unit-boundary map for the encoded subject.
    pub(in crate::interp) fn regexp_match_drive(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        subject: &[u8],
        subject_units: &[u16],
        offsets: &[usize],
    ) -> Result<(bool, Vec<(i32, i32)>, Vec<i32>), Step> {
        let (unicode, global, sticky) = {
            let d = &self.regexps[&inst];
            let f = d.program.flags();
            (
                f & (ironhorse_regexp::XS_REGEXP_U | ironhorse_regexp::XS_REGEXP_V) != 0,
                f & ironhorse_regexp::XS_REGEXP_G != 0,
                f & ironhorse_regexp::XS_REGEXP_Y != 0,
            )
        };
        let advance = global || sticky;
        // RegExpBuiltinExec applies `ToLength(Get(R, "lastIndex"))` before
        // selecting the zero start used by non-global/non-sticky expressions.
        // The property may hold any JS value; assignment itself never coerces.
        let last_index = self.regexp_last_index_length(code, inst)?;
        let subject_len = offsets.len().saturating_sub(1) as u64;
        if advance && last_index > subject_len {
            // `lastIndex` past the end: no match, reset to 0.
            self.regexp_set_last_index(code, inst, Slot::integer(0))?;
            let mut captures = self.reserve_scratch(self.regexps[&inst].program.capture_count)?;
            captures.resize(self.regexps[&inst].program.capture_count, (-1, -1));
            let mut names = self.reserve_scratch(self.regexps[&inst].program.name_count)?;
            names.resize(self.regexps[&inst].program.name_count, -1);
            return Ok((false, captures, names));
        }
        if advance {
            // `fxCacheUnicodeToUTF8Offset` (read `lastIndex` → byte offset) +
            // `fxCacheUTF8ToUnicodeOffset` (write the match end back) framing.
            self.meter.tick_raw(REGEXP_STATEFUL_METERING);
        }
        let start_i = if advance {
            let mut start_index = last_index as usize;
            // CompileToCharSet under `u`/`v` treats a valid surrogate pair as
            // one input character. A UTF-16 `lastIndex` on its trailing code
            // unit therefore maps to the character's leading boundary. This
            // is GetStringIndex's round-down behavior; pinned XS 8.3.1 omits
            // it and incorrectly exposes the low surrogate as a character.
            if unicode
                && start_index > 0
                && start_index < subject_len as usize
                && (0xDC00..=0xDFFF).contains(&subject_units[start_index])
                && (0xD800..=0xDBFF).contains(&subject_units[start_index - 1])
            {
                start_index -= 1;
            }
            offsets[start_index] as i32
        } else {
            0
        };
        let outcome = self.match_regexp_metered(inst, subject, start_i)?;
        if !outcome.matched {
            if advance {
                self.regexp_set_last_index(code, inst, Slot::integer(0))?;
            }
            return Ok((false, outcome.captures, outcome.names));
        }
        let captures: Vec<(i32, i32)> = outcome
            .captures
            .iter()
            .map(|&(from, to)| {
                if from < 0 {
                    return (-1, -1);
                }
                let from = offsets
                    .binary_search(&(from as usize))
                    .expect("matcher capture starts at a CESU-8 code-unit boundary");
                let to = offsets
                    .binary_search(&(to as usize))
                    .expect("matcher capture ends at a CESU-8 code-unit boundary");
                (from as i32, to as i32)
            })
            .collect();
        if advance {
            // Advance `lastIndex` to the whole-match end in UTF-16 code units.
            let end = captures[0].1;
            self.regexp_set_last_index(code, inst, Slot::integer(end))?;
        }
        Ok((true, captures, outcome.names))
    }

    /// Run the compiled matcher for `inst` over `subject` and charge its
    /// meter, interruptibly when a meter is armed. Dispatch-only check
    /// points cannot bound a long-running backtracking match; the matcher
    /// must expose its own incremental work to the same host limit.
    ///
    /// Un-armed (the differential harness): the plain matcher, the whole
    /// `match_meter_raw` charged once after it returns — bit-identical to
    /// the historical behavior. Armed: the matcher calls back every
    /// [`ironhorse_regexp::MATCH_CHECK_STRIDE`] steps; the callback
    /// charges the meter INCREMENTALLY with what the match has accumulated
    /// so far and runs the same `check` the loop-closing points run, so
    /// the host sees the match's computrons on its normal cadence and its
    /// refusal halts the crank with [`Halt::MeterAbort`]. The total
    /// charged is the same `match_meter_raw` either way — the seam moves
    /// WHEN the charge lands, never how much, so computrons are identical
    /// armed and un-armed. An armed meter with no host attached fails
    /// closed here exactly as [`Self::check_meter`] does.
    pub(in crate::interp) fn match_regexp_metered(
        &mut self,
        inst: crate::value::SlotIndex,
        subject: &[u8],
        start: i32,
    ) -> Result<ironhorse_regexp::MatchOutcome, Step> {
        self.charge_and_check(0)?;
        let program = &self.regexps[&inst].program;
        let budget = (u64::MAX - self.meter.raw()) / ironhorse_regexp::XS_REGEXP_METERING;
        let meter = &mut self.meter;
        let mut host = self.meter_host.as_mut();
        let mut charged: u64 = 0;
        let outcome = {
            let mut check = |raw: u64| -> bool {
                let delta = raw - charged;
                charged = raw;
                match host.as_mut() {
                    Some(h) => meter.charge_and_check(delta, h) == MeterCheck::Continue,
                    None if !meter.is_armed() => {
                        meter.tick_raw(delta);
                        true
                    }
                    None => false,
                }
            };
            ironhorse_regexp::match_regexp_budgeted(
                program,
                subject,
                start,
                budget,
                Some(&mut check),
            )
        };
        self.charge_and_check(outcome.match_meter_raw - charged)?;
        if outcome.resource_limit {
            return Err(Step::Host(Halt::HeapExhausted));
        }
        if outcome.aborted {
            return Err(Step::Host(Halt::MeterAbort));
        }
        Ok(outcome)
    }

    /// `RegExp.prototype.exec(string)` (`fx_RegExp_prototype_exec`): the match
    /// drive plus the result-array construction (`[whole, ...captures]` with
    /// the `index`/`input`/`groups` own properties), or `null` on no match.
    pub(in crate::interp) fn regexp_exec(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        arg0: Slot,
    ) -> Result<Slot, Step> {
        Ok(self.regexp_exec_inner(code, inst, arg0)?.0)
    }

    /// `RegExpExec(R, S)`: call an observable `R.exec` when it is callable,
    /// otherwise fall back to the builtin matcher for a branded RegExp. The
    /// callable result must be an object or `null`.
    pub(in crate::interp) fn regexp_exec_abstract(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        receiver: Slot,
        subject: Slot,
    ) -> Result<Slot, Step> {
        let exec_id = self.intern_static_key("exec");
        let exec = self.mop_get(code, inst, exec_id, receiver)?;
        if self.is_callable_value(exec) {
            let result = self.invoke_value(code, exec, receiver, &[subject])?;
            return match result.kind {
                Kind::Null | Kind::Reference => Ok(result),
                _ => Err(self.catchable_type_error_msg("invalid exec result".into())),
            };
        }
        if self.regexps.contains_key(&inst) {
            self.regexp_exec(code, inst, subject)
        } else {
            Err(self.catchable_type_error_msg("this: not a RegExp instance".into()))
        }
    }

    /// `%RegExp.prototype%[@@match]`: run abstract `RegExpExec` once for a
    /// non-global receiver, or repeatedly collect each whole-match string.
    /// Empty global matches advance the observable `lastIndex`, including a
    /// complete surrogate pair in `u`/`v` mode.
    pub(in crate::interp) fn regexp_match(
        &mut self,
        code: &[u8],
        regexp: Slot,
        input: Slot,
    ) -> Result<Slot, Step> {
        let regexp_inst = match regexp.value {
            Payload::Reference(inst) if regexp.kind == Kind::Reference => inst,
            _ => {
                return Err(self.catchable_type_error_msg(
                    match regexp.kind {
                        Kind::Null => "cannot coerce null to object",
                        Kind::Undefined => "cannot coerce undefined to object",
                        _ => "this: not a RegExp instance",
                    }
                    .into(),
                ))
            }
        };
        self.meter.tick_raw(REGEXP_MATCH_FRAME_METERING);
        let subject = self.to_string_slot(code, input)?;
        let subject_units = match subject.value {
            Payload::String(off) if subject.kind == Kind::String => self.str_units(off),
            _ => unreachable!("ToString returns a String"),
        };
        let flags = self.regexp_flags_units(code, regexp_inst, regexp, false)?;
        let global = flags.contains(&(b'g' as u16));
        if !global {
            return self.regexp_exec_abstract(code, regexp_inst, regexp, subject);
        }
        let full_unicode = flags
            .iter()
            .any(|unit| *unit == b'u' as u16 || *unit == b'v' as u16);
        self.regexp_set_last_index(code, regexp_inst, Slot::integer(0))?;

        let matches = self.new_array();
        let mut count = 0u64;
        loop {
            let result = self.regexp_exec_abstract(code, regexp_inst, regexp, subject)?;
            if result.kind == Kind::Null {
                return if count == 0 {
                    Ok(Slot::null())
                } else {
                    Ok(Slot::of(Kind::Reference, Payload::Reference(matches)))
                };
            }
            let Payload::Reference(result_inst) = result.value else {
                unreachable!("RegExpExec returns an object or null")
            };
            let zero_id = self.array_generic_index_id(0)?;
            let whole = self.mop_get(code, result_inst, zero_id, result)?;
            let match_string = self.to_string_slot(code, whole)?;
            self.array_generic_create_data_property(code, matches, count, match_string)?;
            count = count.saturating_add(1);

            let empty = match match_string.value {
                Payload::String(off) if match_string.kind == Kind::String => self.str_len(off) == 0,
                _ => unreachable!("ToString returns a String"),
            };
            if empty {
                let index = self.regexp_last_index_length(code, regexp_inst)?;
                let next = Self::advance_string_index(&subject_units, index, full_unicode);
                self.regexp_set_last_index(code, regexp_inst, Slot::number(next as f64))?;
            }
        }
    }

    /// `%RegExp.prototype%[@@search]`: search from `lastIndex = 0`, then
    /// restore the exact prior value when the matcher changed it. The result's
    /// `index` property is returned without coercion.
    pub(in crate::interp) fn regexp_search(
        &mut self,
        code: &[u8],
        regexp: Slot,
        input: Slot,
    ) -> Result<Slot, Step> {
        let regexp_inst = match regexp.value {
            Payload::Reference(inst) if regexp.kind == Kind::Reference => inst,
            _ => {
                return Err(self.catchable_type_error_msg(
                    match regexp.kind {
                        Kind::Null => "cannot coerce null to object",
                        Kind::Undefined => "cannot coerce undefined to object",
                        _ => "this: not a RegExp instance",
                    }
                    .into(),
                ))
            }
        };
        self.meter.tick_raw(REGEXP_SEARCH_FRAME_METERING);
        let subject = self.to_string_slot(code, input)?;
        let previous = self.regexp_get_last_index(code, regexp_inst)?;
        let zero = Slot::number(0.0);
        if !self.same_value(previous, zero) {
            self.regexp_set_last_index(code, regexp_inst, zero)?;
        }
        // `RegExpBuiltinExec` creates the result's own `index` property. Its
        // key must be interned before invoking `exec`, even when guest source
        // never spells the name and `@@search` is the only consumer.
        let index_id = self.intern_static_key("index");
        self.regexp_result_ids.index = Some(index_id);
        let result = self.regexp_exec_abstract(code, regexp_inst, regexp, subject)?;
        let current = self.regexp_get_last_index(code, regexp_inst)?;
        if !self.same_value(current, previous) {
            self.regexp_set_last_index(code, regexp_inst, previous)?;
        }
        if result.kind == Kind::Null {
            return Ok(Slot::integer(-1));
        }
        let Payload::Reference(result_inst) = result.value else {
            unreachable!("RegExpExec returns an object or null")
        };
        self.meter.tick_raw(REGEXP_SEARCH_INDEX_GET_METERING);
        self.mop_get(code, result_inst, index_id, result)
    }

    /// `%RegExp.prototype%[@@split]`: construct the observable species with a
    /// sticky flag, then execute it at each UTF-16 position. Result creation
    /// and capture reads use the ordinary object MOP so custom constructors,
    /// accessors, proxies, and abrupt completions retain specification order.
    pub(in crate::interp) fn regexp_split(
        &mut self,
        code: &[u8],
        regexp: Slot,
        input: Slot,
        limit_slot: Slot,
    ) -> Result<Slot, Step> {
        let regexp_inst = match regexp.value {
            Payload::Reference(inst) if regexp.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg("this: not an object".into())),
        };
        let subject = self.to_string_slot(code, input)?;
        let subject_units = match subject.value {
            Payload::String(off) if subject.kind == Kind::String => self.str_units(off),
            _ => unreachable!("ToString returns a String"),
        };

        let constructor = self.regexp_species_constructor(code, regexp)?;
        let flags = self.regexp_flags_units(code, regexp_inst, regexp, false)?;
        let full_unicode = flags
            .iter()
            .any(|unit| *unit == b'u' as u16 || *unit == b'v' as u16);
        let mut new_flags = flags;
        if !new_flags.contains(&(b'y' as u16)) {
            new_flags.push(b'y' as u16);
        }
        let flags_slot = self.new_string_units(&new_flags);
        let splitter =
            self.construct_value(code, constructor, &[regexp, flags_slot], constructor)?;
        let splitter_inst = match splitter.value {
            Payload::Reference(inst) if splitter.kind == Kind::Reference => inst,
            _ => {
                return Err(self.catchable_type_error_msg(
                    "RegExp.split: species constructor must return an object".into(),
                ))
            }
        };

        let array = self.new_array();
        let array_slot = Slot::of(Kind::Reference, Payload::Reference(array));
        let limit = self.string_split_limit(code, limit_slot)? as u64;
        self.meter.tick_raw(REGEXP_SPLIT_FRAME_METERING);
        if limit == 0 {
            return Ok(array_slot);
        }

        let size = subject_units.len();
        let mut count = 0u64;
        if size == 0 {
            self.meter.tick_raw(REGEXP_SPLIT_EMPTY_METERING);
            let result = self.regexp_exec_abstract(code, splitter_inst, splitter, subject)?;
            if result.kind == Kind::Null {
                let empty = self.new_string_units(&[]);
                self.array_generic_create_data_property(code, array, count, empty)?;
            }
            return Ok(array_slot);
        }

        let mut p = 0usize;
        let mut q = 0usize;
        while q < size {
            self.meter.tick_raw(REGEXP_SPLIT_PER_STEP_METERING);
            self.regexp_set_last_index(code, splitter_inst, Slot::number(q as f64))?;
            let result = self.regexp_exec_abstract(code, splitter_inst, splitter, subject)?;
            if result.kind == Kind::Null {
                q = Self::advance_string_index(&subject_units, q as u64, full_unicode) as usize;
                continue;
            }

            self.meter.tick_raw(REGEXP_SPLIT_MATCH_STEP_METERING);
            let e = self
                .regexp_last_index_length(code, splitter_inst)?
                .min(size as u64) as usize;
            if e == p {
                self.meter.untick_raw(REGEXP_SPLIT_EMPTY_ADVANCE_DISCOUNT);
                q = Self::advance_string_index(&subject_units, q as u64, full_unicode) as usize;
                continue;
            }

            let segment = self.new_string_units(&subject_units[p..q]);
            self.array_generic_create_data_property(code, array, count, segment)?;
            count += 1;
            if count == limit {
                return Ok(array_slot);
            }

            p = e;
            let result_inst = match result.value {
                Payload::Reference(inst) if result.kind == Kind::Reference => inst,
                _ => unreachable!("RegExpExec returns an object or null"),
            };
            let length_id = self.intern_static_key("length");
            let result_length = self.mop_get(code, result_inst, length_id, result)?;
            let capture_count = self.to_length_value(code, result_length)?.saturating_sub(1);
            for capture_index in 1..=capture_count {
                self.meter.tick_raw(REGEXP_SPLIT_PER_CAPTURE_METERING);
                let capture_id = self.array_generic_index_id(capture_index)?;
                let capture = self.mop_get(code, result_inst, capture_id, result)?;
                self.array_generic_create_data_property(code, array, count, capture)?;
                count += 1;
                if count == limit {
                    return Ok(array_slot);
                }
            }
            q = p;
        }

        let tail = self.new_string_units(&subject_units[p..size]);
        self.array_generic_create_data_property(code, array, count, tail)?;
        Ok(array_slot)
    }

    /// `%RegExp.prototype%[@@matchAll]`: coerce the input, clone the receiver
    /// through `SpeciesConstructor`, transfer its observable `lastIndex`, and
    /// create a lazy RegExp String Iterator. The iterator records `global` and
    /// full-Unicode from the original flags string; it never probes similarly
    /// named properties on the species result.
    pub(in crate::interp) fn regexp_match_all(
        &mut self,
        code: &[u8],
        regexp: Slot,
        input: Slot,
    ) -> Result<Slot, Step> {
        let regexp_inst = match regexp.value {
            Payload::Reference(inst) if regexp.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg("this: not an object".into())),
        };
        let subject = self.to_string_slot(code, input)?;
        let subject_units = match subject.value {
            Payload::String(off) if subject.kind == Kind::String => self.str_units(off),
            _ => unreachable!("ToString returns a String"),
        };
        let constructor = self.regexp_species_constructor(code, regexp)?;
        let flags = self.regexp_flags_units(code, regexp_inst, regexp, false)?;
        let flags_slot = self.new_string_units(&flags);
        let matcher =
            self.construct_value(code, constructor, &[regexp, flags_slot], constructor)?;
        let matcher_inst = match matcher.value {
            Payload::Reference(inst) if matcher.kind == Kind::Reference => inst,
            _ => {
                return Err(self.catchable_type_error_msg(
                    "RegExp.matchAll: species constructor must return an object".into(),
                ))
            }
        };
        let last_index = self.regexp_last_index_length(code, regexp_inst)?;
        let last_index_id = self.regexp_last_index_id();
        if !self.mop_set(
            code,
            matcher_inst,
            last_index_id,
            Slot::number(last_index as f64),
            matcher,
        )? {
            return Err(self.failed_set_error(matcher_inst, last_index_id, "C: xsSet"));
        }
        let global = flags.contains(&(b'g' as u16));
        let full_unicode = flags
            .iter()
            .any(|unit| *unit == b'u' as u16 || *unit == b'v' as u16);
        Ok(self.make_regexp_string_iterator(matcher_inst, &subject_units, global, full_unicode))
    }

    /// Create a `%RegExpStringIterator%`. Kind 9 reuses the persisted iterator
    /// row: `iterable` is the cloned matcher, `str_bytes` is the input UTF-16,
    /// and the low two index bits are `global`/`fullUnicode`. `result` is
    /// an internal arena anchor because this iterator creates a fresh public
    /// iterator-result object on every `next()` call, as the specification
    /// requires.
    pub(in crate::interp) fn make_regexp_string_iterator(
        &mut self,
        matcher: crate::value::SlotIndex,
        subject: &[u16],
        global: bool,
        full_unicode: bool,
    ) -> Slot {
        let value_id = self.intern_static_key("value");
        let done_id = self.intern_static_key("done");
        self.value_id = Some(value_id);
        self.done_id = Some(done_id);
        let anchor = self.slots.alloc(Slot::instance(self.object_proto));
        let iterator = self
            .slots
            .alloc(Slot::instance(self.regexp_string_iterator_proto));
        self.iterators.insert(
            iterator,
            IterState {
                iterable: matcher,
                index: u32::from(global) | (u32::from(full_unicode) << 1),
                kind: 9,
                generation: 0,
                result: anchor,
                done: false,
                enum_keys: std::rc::Rc::default(),
                str_bytes: std::rc::Rc::new(units_to_be16(subject)),
            },
        );
        Slot::of(Kind::Reference, Payload::Reference(iterator))
    }

    /// Allocate a fresh ordinary iterator-result object.
    pub(in crate::interp) fn regexp_string_iterator_result(
        &mut self,
        value: Slot,
        done: bool,
    ) -> Slot {
        let value_id = self
            .value_id
            .unwrap_or_else(|| self.intern_static_key("value"));
        let done_id = self
            .done_id
            .unwrap_or_else(|| self.intern_static_key("done"));
        self.value_id = Some(value_id);
        self.done_id = Some(done_id);
        let result = self.slots.alloc(Slot::instance(self.object_proto));
        self.set_own_unmetered(result, value_id, value);
        self.set_own_unmetered(result, done_id, Slot::boolean(done));
        Slot::of(Kind::Reference, Payload::Reference(result))
    }

    /// `%RegExpStringIteratorPrototype%.next()`: drive the captured matcher
    /// through abstract `RegExpExec`. A non-global iterator yields once; a
    /// global empty match advances the matcher's `lastIndex` by one UTF-16 code
    /// unit or one Unicode code point so iteration cannot stall.
    pub(in crate::interp) fn regexp_string_iterator_next(
        &mut self,
        code: &[u8],
        receiver: Slot,
    ) -> Result<Slot, Step> {
        let iterator = match receiver.value {
            Payload::Reference(inst)
                if receiver.kind == Kind::Reference
                    && self
                        .iterators
                        .get(&inst)
                        .is_some_and(|state| state.kind == 9) =>
            {
                inst
            }
            _ => return Err(self.catchable_type_error_msg("this: not an iterator".into())),
        };
        let state = self.iterators[&iterator].clone();
        if state.done {
            return Ok(self.regexp_string_iterator_result(Slot::undefined(), true));
        }
        let subject_units = be16_to_units(&state.str_bytes);
        let subject = self.new_string_units(&subject_units);
        let matcher = Slot::of(Kind::Reference, Payload::Reference(state.iterable));
        let result = self.regexp_exec_abstract(code, state.iterable, matcher, subject)?;
        if result.kind == Kind::Null {
            self.iterators.get_mut(&iterator).unwrap().done = true;
            return Ok(self.regexp_string_iterator_result(Slot::undefined(), true));
        }

        let global = state.index & 1 != 0;
        let full_unicode = state.index & 2 != 0;
        if !global {
            self.iterators.get_mut(&iterator).unwrap().done = true;
        } else {
            let Payload::Reference(result_inst) = result.value else {
                unreachable!("RegExpExec returns an object or null")
            };
            let zero_id = self.array_generic_index_id(0)?;
            let match_value = self.mop_get(code, result_inst, zero_id, result)?;
            let match_string = self.to_string_units(code, match_value)?;
            if match_string.is_empty() {
                let last_index = self.regexp_last_index_length(code, state.iterable)?;
                let next_index =
                    Self::advance_string_index(&subject_units, last_index, full_unicode);
                let last_index_id = self.regexp_last_index_id();
                if !self.mop_set(
                    code,
                    state.iterable,
                    last_index_id,
                    Slot::number(next_index as f64),
                    matcher,
                )? {
                    return Err(self.failed_set_error(state.iterable, last_index_id, "C: xsSet"));
                }
            }
        }
        Ok(self.regexp_string_iterator_result(result, false))
    }

    /// Encode UTF-16 code units in XS's modified CESU-8 spelling and return
    /// the byte offset of every code-unit boundary. U+0000 is `C0 80`, and
    /// each surrogate is its own three-byte sequence; the matcher combines a
    /// valid pair only when `u`/`v` is active.
    pub(in crate::interp) fn regexp_subject_bytes(
        &mut self,
        units: &[u16],
    ) -> Result<(Vec<u8>, Vec<usize>), Step> {
        let mut bytes = self.reserve_scratch(units.len() * 3)?;
        let mut offsets = self.reserve_scratch(units.len() + 1)?;
        for &unit in units {
            offsets.push(bytes.len());
            match unit {
                0 => bytes.extend_from_slice(&[0xC0, 0x80]),
                1..=0x7F => bytes.push(unit as u8),
                0x80..=0x7FF => {
                    bytes.push(0xC0 | (unit >> 6) as u8);
                    bytes.push(0x80 | (unit & 0x3F) as u8);
                }
                _ => {
                    bytes.push(0xE0 | (unit >> 12) as u8);
                    bytes.push(0x80 | ((unit >> 6) & 0x3F) as u8);
                    bytes.push(0x80 | (unit & 0x3F) as u8);
                }
            }
        }
        offsets.push(bytes.len());
        Ok((bytes, offsets))
    }

    /// The `exec` body, returning `(result, Some(match_start))` on a match so
    /// the String-side `search`/`match` methods (which drive the full `exec`,
    /// as XS's `fxExecuteRegExp` does) can read the match position without
    /// re-deriving it from the result array's `index` property (which is
    /// present only when the program references `index`).
    pub(in crate::interp) fn regexp_exec_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        arg0: Slot,
    ) -> Result<(Slot, Option<i32>), Step> {
        self.meter.tick_raw(REGEXP_EXEC_FRAME_METERING);
        let subject_slot = self.to_string_slot(code, arg0)?;
        let subject_units = match subject_slot.value {
            Payload::String(off) => self.str_units(off),
            _ => Vec::new(),
        };
        let (subject, offsets) = self.regexp_subject_bytes(&subject_units)?;
        // The declared named groups, one entry per UNIQUE name in name-slot
        // order — the `groups` object's own-key order. Duplicate names share a
        // slot, so a name appears once; its live capture is resolved through
        // the matcher's runtime `names[]` array (below).
        let group_names: Vec<(String, i32)> =
            self.regexps[&inst].program.capture_group_names.clone();
        let has_indices = self.regexps[&inst].program.flags() & ironhorse_regexp::XS_REGEXP_D != 0;
        let (matched, captures, names) =
            self.regexp_match_drive(code, inst, &subject, &subject_units, &offsets)?;
        if !matched {
            return Ok((Slot::null(), None));
        }
        // On a match XS charges a per-match residual plus a small per-extra-
        // capture residual (the `fxCacheUTF8ToUnicodeOffset` remaps and
        // `fxCacheArray`), beyond the explicit per-capture slot/chunk allocs.
        let capture_count = captures.len() as u64;
        self.charge_and_check(
            REGEXP_EXEC_MATCH_METERING + REGEXP_EXEC_PER_CAPTURE * capture_count.saturating_sub(1),
        )?;
        let match_start = captures[0].0;
        // The result array: one element per capture (whole match at 0).
        let result = self.new_array_unmetered();
        let mut items: Vec<(u32, Slot)> = self.reserve_scratch(captures.len())?;
        // The per-capture value slots, indexed by capture number, so the
        // `groups` object can point each name at its group's value.
        let mut capture_slots: Vec<Slot> = self.reserve_scratch(captures.len())?;
        for (i, &(from, to)) in captures.iter().enumerate() {
            // `resultItem = fxNewSlot` per capture.
            self.meter.tick_slot_alloc();
            let slot = if from >= 0 {
                self.new_string_units(&subject_units[from as usize..to as usize])
            } else {
                Slot::undefined()
            };
            capture_slots.push(slot);
            items.push((i as u32, slot));
        }
        {
            let a = self.arrays.get_mut(&result).unwrap();
            for (i, s) in items {
                a.insert_item(i, s, &mut self.side_refs);
            }
            a.length = captures.len() as u32;
        }
        // The three named own properties `index`/`input`/`groups`, each a
        // `fxNewSlot` on the result array.
        self.meter.tick_slot_alloc(); // index
        if let Some(id) = self.regexp_result_ids.index {
            self.instance_put_raw(result, id, Slot::integer(match_start));
        }
        self.meter.tick_slot_alloc(); // input
        if let Some(id) = self.regexp_result_ids.input {
            // XS aliases `input` to the argument string (no copy), so reuse the
            // coerced subject slot rather than allocating a fresh chunk.
            self.instance_put_raw(result, id, subject_slot);
        }
        self.meter.tick_slot_alloc(); // groups
        if let Some(id) = self.regexp_result_ids.groups {
            // `RegExpBuiltinExec` step 24/25: a pattern with named groups gets a
            // `groups` object built with `ObjectCreate(null)`; otherwise
            // `groups` is `undefined`. Each name is a `CreateDataProperty`
            // (writable/enumerable/configurable) pointing at its group's value,
            // in pattern (left-to-right) order.
            let groups = if group_names.is_empty() {
                Slot::undefined()
            } else {
                let obj = self.new_object();
                // ObjectCreate(null): a null [[Prototype]], stored in the
                // instance payload exactly as `Object.create(null)` does.
                self.slots.get_mut(obj).value = Payload::Reference(crate::value::SlotIndex::NULL);
                for (slot, (name, _)) in group_names.iter().enumerate() {
                    let key = self.intern_key(name)?;
                    // `captureIndex = data[2*captureCount + nameIndex]`: the
                    // capture the name's group last participated in (a duplicate
                    // name resolves to whichever alternative matched), or `-1`
                    // when it did not participate → the property stays undefined.
                    let cap_idx = names.get(slot).copied().unwrap_or(-1);
                    let val = if cap_idx >= 0 {
                        capture_slots
                            .get(cap_idx as usize)
                            .copied()
                            .unwrap_or_else(Slot::undefined)
                    } else {
                        Slot::undefined()
                    };
                    self.meter.tick_slot_alloc();
                    self.instance_put_raw(obj, key, val);
                }
                Slot::of(Kind::Reference, Payload::Reference(obj))
            };
            self.instance_put_raw(result, id, groups);
        }
        // The `d` flag's `.indices` array (`RegExpBuiltinExec` step 34 →
        // `MakeMatchIndicesIndexPairArray`): one `[start, end]` pair per
        // participating capture (an absent capture is `undefined`), plus a
        // parallel `.indices.groups` object keyed like `.groups`. Mirrors the
        // `hasIndicesFlag` branch of XS's `fxExecuteRegExp`.
        if has_indices {
            let indices = self.regexp_build_indices(&captures, &group_names, &names)?;
            if let Some(id) = self.regexp_result_ids.indices {
                self.instance_put_raw(result, id, indices);
            }
        }
        Ok((
            Slot::of(Kind::Reference, Payload::Reference(result)),
            Some(match_start),
        ))
    }

    /// Build the `d`-flag `.indices` array + its `.groups` object, mirroring the
    /// `hasIndicesFlag` branch of `fxExecuteRegExp`: element `i` is the
    /// `[start, end]` pair of capture `i` when it participated, else
    /// `undefined`; `.indices.groups` maps each unique name to the SAME pair
    /// (via the matcher's runtime `names[]`), or `undefined`. Allocation is
    /// mirrored slot-for-slot (`fxNewArrayInstance`, `fxNewSlot`,
    /// `fxConstructArrayEntry`, `fxNewInstance`) so the exec meter tracks XS.
    pub(in crate::interp) fn regexp_build_indices(
        &mut self,
        captures: &[(i32, i32)],
        group_names: &[(String, i32)],
        names: &[i32],
    ) -> Result<Slot, Step> {
        // `fxNewArrayInstance` for the outer indices array.
        let arr = self.new_array_unmetered();
        self.meter.tick_slot_alloc();
        // The `[start, end]` pair slot per capture index (for `.indices.groups`
        // to alias), or `None` when the capture did not participate.
        let mut pair_slots: Vec<Option<Slot>> = self.reserve_scratch(captures.len())?;
        let mut items: Vec<(u32, Slot)> = self.reserve_scratch(captures.len())?;
        for (i, &(from, to)) in captures.iter().enumerate() {
            // `indicesItem = fxNewSlot` per capture.
            self.meter.tick_slot_alloc();
            let entry = if from >= 0 {
                // `fxConstructArrayEntry`: a fresh two-element `[from, to]`
                // array (instance slot + two element slots).
                let pair = self.new_array_unmetered();
                self.meter.tick_slot_alloc();
                self.meter.tick_slot_alloc();
                self.meter.tick_slot_alloc();
                {
                    let a = self.arrays.get_mut(&pair).unwrap();
                    a.insert_item(0, Slot::integer(from), &mut self.side_refs);
                    a.insert_item(1, Slot::integer(to), &mut self.side_refs);
                    a.length = 2;
                }
                let s = Slot::of(Kind::Reference, Payload::Reference(pair));
                pair_slots.push(Some(s));
                s
            } else {
                pair_slots.push(None);
                Slot::undefined()
            };
            items.push((i as u32, entry));
        }
        {
            let a = self.arrays.get_mut(&arr).unwrap();
            for (i, s) in items {
                a.insert_item(i, s, &mut self.side_refs);
            }
            a.length = captures.len() as u32;
        }
        // The `.groups` own property on the indices array (`indicesItem =
        // fxNewSlot`), an `ObjectCreate(null)` object when named, else undefined.
        self.meter.tick_slot_alloc();
        if let Some(gid) = self.regexp_result_ids.groups {
            let groups = if group_names.is_empty() {
                Slot::undefined()
            } else {
                let obj = self.new_object();
                self.slots.get_mut(obj).value = Payload::Reference(crate::value::SlotIndex::NULL);
                for (slot, (name, _)) in group_names.iter().enumerate() {
                    let key = self.intern_key(name)?;
                    let cap = names.get(slot).copied().unwrap_or(-1);
                    let val = if cap >= 0 {
                        pair_slots
                            .get(cap as usize)
                            .and_then(|p| *p)
                            .unwrap_or_else(Slot::undefined)
                    } else {
                        Slot::undefined()
                    };
                    self.meter.tick_slot_alloc();
                    self.instance_put_raw(obj, key, val);
                }
                Slot::of(Kind::Reference, Payload::Reference(obj))
            };
            self.instance_put_raw(arr, gid, groups);
        }
        Ok(Slot::of(Kind::Reference, Payload::Reference(arr)))
    }

    /// `RegExp.prototype.test(string)` (`fx_RegExp_prototype_test` →
    /// `fxExecuteRegExp`): XS's `test` invokes `this.exec(string)` in full
    /// (building the result array) and maps the result to a boolean, so the
    /// metering is `exec`'s entire cost plus `test`'s own frame and the
    /// `mxGetID(_exec)` + `mxRunCount(1)` re-entrant call framing. ironhorse
    /// mirrors that: run the exec machinery, discard the array, return the
    /// boolean.
    pub(in crate::interp) fn regexp_test(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        receiver: Slot,
        arg0: Slot,
    ) -> Result<Slot, Step> {
        self.meter.tick_raw(REGEXP_TEST_FRAME_METERING);
        let subject = self.to_string_slot(code, arg0)?;
        let result = self.regexp_exec_abstract(code, inst, receiver, subject)?;
        Ok(Slot::boolean(result.kind != Kind::Null))
    }

    /// `GetSubstitution` for an ordinary string search (no captures or named
    /// captures). Operates directly on UTF-16 code units so lone surrogates are
    /// preserved across `$&`, prefix, and suffix insertion.
    pub(in crate::interp) fn string_plain_substitution(
        &mut self,
        subject: &[u16],
        search: &[u16],
        pos: usize,
        replacement: &[u16],
    ) -> Result<Vec<u16>, Step> {
        let tail = pos + search.len();
        let mut out = self.reserve_scratch(replacement.len())?;
        let mut i = 0;
        while i < replacement.len() {
            if replacement[i] != b'$' as u16 || i + 1 >= replacement.len() {
                self.extend_work_scratch(&mut out, &[replacement[i]])?;
                i += 1;
                continue;
            }
            match replacement[i + 1] {
                v if v == b'$' as u16 => self.extend_work_scratch(&mut out, &[b'$' as u16])?,
                v if v == b'&' as u16 => self.extend_work_scratch(&mut out, search)?,
                v if v == b'`' as u16 => self.extend_work_scratch(&mut out, &subject[..pos])?,
                v if v == b'\'' as u16 => self.extend_work_scratch(&mut out, &subject[tail..])?,
                _ => {
                    self.extend_work_scratch(&mut out, &[b'$' as u16])?;
                    i += 1;
                    continue;
                }
            }
            i += 2;
        }
        Ok(out)
    }

    /// The ordinary-string branch of `String.prototype.replace`. Coercions
    /// happen before the search, including replacement-string coercion on a
    /// no-match path. A callable replacement receives `(matched, position,
    /// string)` and its result is converted to a string after the call.
    pub(in crate::interp) fn string_replace_plain(
        &mut self,
        code: &[u8],
        subject: Slot,
        search: Slot,
        replacement: Slot,
    ) -> Result<Slot, Step> {
        let subject_units = match subject.value {
            Payload::String(off) => self.str_units(off),
            _ => unreachable!("replace subject was already converted to String"),
        };
        let search_units = self.to_string_units(code, search)?;
        let functional = self.is_callable_value(replacement);
        let replacement_units = if functional {
            None
        } else {
            Some(self.to_string_units(code, replacement)?)
        };
        let pos = if search_units.is_empty() {
            Some(0)
        } else if search_units.len() <= subject_units.len() {
            subject_units
                .windows(search_units.len())
                .position(|window| window == search_units)
        } else {
            None
        };
        let Some(pos) = pos else {
            return Ok(subject);
        };
        let replacement_units = if functional {
            let matched = self.new_string_units(&search_units);
            let value = self.invoke_value(
                code,
                replacement,
                Slot::undefined(),
                &[matched, Slot::number(pos as f64), subject],
            )?;
            self.to_string_units(code, value)?
        } else {
            self.string_plain_substitution(
                &subject_units,
                &search_units,
                pos,
                replacement_units.as_deref().unwrap(),
            )?
        };
        let tail = pos + search_units.len();
        let mut out = self
            .reserve_scratch(subject_units.len() - search_units.len() + replacement_units.len())?;
        self.extend_work_scratch(&mut out, &subject_units[..pos])?;
        self.extend_work_scratch(&mut out, &replacement_units)?;
        self.extend_work_scratch(&mut out, &subject_units[tail..])?;
        Ok(self.new_string_units(&out))
    }

    /// The ordinary-string branch of `String.prototype.replaceAll`. Search
    /// positions are collected as non-overlapping UTF-16 code-unit matches;
    /// an empty search matches before, between, and after every code unit.
    /// Replacement conversion happens once even when there is no match, while
    /// a callable replacement is invoked and converted once per position.
    pub(in crate::interp) fn string_replace_all_plain(
        &mut self,
        code: &[u8],
        subject: Slot,
        search: Slot,
        replacement: Slot,
    ) -> Result<Slot, Step> {
        let subject_units = match subject.value {
            Payload::String(off) => self.str_units(off),
            _ => unreachable!("replaceAll subject was already converted to String"),
        };
        let search_units = self.to_string_units(code, search)?;
        let functional = self.is_callable_value(replacement);
        let replacement_units = if functional {
            None
        } else {
            Some(self.to_string_units(code, replacement)?)
        };

        let mut positions = Vec::new();
        let empty_search = search_units.is_empty();
        if !empty_search {
            let mut next = 0usize;
            while next + search_units.len() <= subject_units.len() {
                let Some(relative) = subject_units[next..]
                    .windows(search_units.len())
                    .position(|window| window == search_units)
                else {
                    break;
                };
                let position = next + relative;
                self.extend_work_scratch(&mut positions, &[position])?;
                next = position + search_units.len();
            }
        }
        if !empty_search && positions.is_empty() {
            return Ok(subject);
        }

        let mut out = Vec::new();
        let mut next_source_position = 0usize;
        // An empty search visits every boundary without materializing an
        // usize per code unit. The immutable subject fixes these positions.
        let boundaries = if empty_search {
            0..subject_units.len() + 1
        } else {
            0..0
        };
        for position in positions.into_iter().chain(boundaries) {
            self.extend_work_scratch(&mut out, &subject_units[next_source_position..position])?;
            let substitution = if functional {
                let matched = self.new_string_units(&search_units);
                let value = self.invoke_value(
                    code,
                    replacement,
                    Slot::undefined(),
                    &[matched, Slot::number(position as f64), subject],
                )?;
                self.to_string_units(code, value)?
            } else {
                self.string_plain_substitution(
                    &subject_units,
                    &search_units,
                    position,
                    replacement_units.as_deref().unwrap(),
                )?
            };
            self.extend_work_scratch(&mut out, &substitution)?;
            next_source_position = position + search_units.len();
        }
        self.extend_work_scratch(&mut out, &subject_units[next_source_position..])?;
        Ok(self.new_string_units(&out))
    }

    /// `String.prototype.replace(regexp, replacement)` (`fx_String_prototype_
    /// replace` → `fx_RegExp_prototype_replace` via the `Symbol.replace`
    /// protocol). XS reads `flags` (the eight-property cascade), collects one
    /// match or every global match, then assembles the source gaps and each
    /// string/function substitution into a final result. Empty global matches
    /// advance explicitly so collection always terminates.
    pub(in crate::interp) fn string_replace(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        subject: Slot,
        replacement: Slot,
    ) -> Result<Slot, Step> {
        let global = self.regexps[&inst].program.flags() & ironhorse_regexp::XS_REGEXP_G != 0;
        let functional = self.is_callable_value(replacement);
        let subject_units = match self.string_receiver_units(subject) {
            Some(c) => c,
            None => {
                return Err(Step::Host(Halt::NotImplemented(
                    "String.replace:non-string-receiver",
                )))
            }
        };
        // A non-callable replacement is converted once before any match is
        // attempted. Callable replacements are converted only after each call.
        let repl_units = if functional {
            None
        } else {
            Some(self.to_string_units(code, replacement)?)
        };
        let has_named_captures = !self.regexps[&inst].program.capture_group_names.is_empty();
        if has_named_captures {
            // A functional replacer receives the groups object directly, so
            // `groups` can be observable even when the source never names the
            // result-array property. Interning the boot key also makes every
            // collected exec result retain its own duplicate-name resolution.
            self.intern_static_key("groups");
        }
        self.meter.tick_raw(STRING_REPLACE_FRAME_METERING);
        // `mxGetID(_flags)` (the `globalFlag` test) — the eight-property
        // cascade.
        self.meter.tick_raw(REGEXP_FLAGS_GETTER_METERING);
        // `fxNewInstance` for the segment list.
        self.meter.tick_slot_alloc();
        if global {
            self.regexp_set_last_index(code, inst, Slot::integer(0))?;
        }
        let mut results = Vec::new();
        loop {
            let (result, start) = self.regexp_exec_inner(code, inst, subject)?;
            let Some(pos) = start else {
                break;
            };
            let match_len = self.regexp_whole_match_len(result);
            self.extend_work_scratch(&mut results, &[(result, pos as usize, match_len)])?;
            if !global {
                break;
            }
            if match_len == 0 {
                self.regexp_advance_last_index(code, inst, &subject_units)?;
            }
        }
        if results.is_empty() {
            return Ok(subject);
        }
        if functional {
            let mut assembled = Vec::new();
            let mut next_source_position = 0;
            for (result, pos, match_len) in results {
                self.meter.tick_raw(STRING_REPLACE_MATCH_METERING);
                let capture_count = self.regexp_capture_count(result);
                self.charge_and_check(
                    STRING_REPLACE_PER_CAPTURE * capture_count.saturating_sub(1) as u64,
                )?;
                self.extend_work_scratch(
                    &mut assembled,
                    &subject_units[next_source_position..pos.min(subject_units.len())],
                )?;
                let mut args =
                    self.reserve_scratch(capture_count + if has_named_captures { 3 } else { 2 })?;
                for i in 0..capture_count {
                    args.push(self.array_index_slot(result, i as u32));
                }
                args.push(Slot::number(pos as f64));
                args.push(subject);
                if has_named_captures {
                    let groups_id = self
                        .regexp_result_ids
                        .groups
                        .expect("string_replace interned the groups key");
                    args.push(self.regexp_result_property(result, groups_id));
                }
                let value = self.invoke_value(code, replacement, Slot::undefined(), &args)?;
                let units = self.to_string_units(code, value)?;
                self.meter.tick_slot_alloc();
                self.charge_and_check(string_chunk_cost(units.len() as u64))?;
                self.extend_work_scratch(&mut assembled, &units)?;
                next_source_position = pos.saturating_add(match_len);
            }
            self.extend_work_scratch(&mut assembled, &subject_units[next_source_position..])?;
            self.charge_and_check(string_chunk_cost(assembled.len() as u64))?;
            let off = self.chunks.alloc(&units_to_be16(&assembled));
            return Ok(Slot::of(Kind::String, Payload::String(off)));
        }
        let mut assembled = Vec::new();
        let mut next_source_position = 0;
        for (result, pos, match_len) in results {
            self.meter.tick_raw(STRING_REPLACE_MATCH_METERING);
            let capture_count = self.regexp_capture_count(result);
            self.charge_and_check(
                STRING_REPLACE_PER_CAPTURE * capture_count.saturating_sub(1) as u64,
            )?;
            self.extend_work_scratch(&mut assembled, &subject_units[next_source_position..pos])?;
            let repl = repl_units.as_deref().unwrap();
            let subst_units = if repl.contains(&(b'$' as u16)) {
                self.regexp_get_substitution(inst, result, &subject_units, pos, match_len, repl)?
            } else {
                repl.to_vec()
            };
            self.meter.tick_slot_alloc();
            self.charge_and_check(string_chunk_cost(subst_units.len() as u64))?;
            self.extend_work_scratch(&mut assembled, &subst_units)?;
            next_source_position = pos + match_len;
        }
        self.extend_work_scratch(&mut assembled, &subject_units[next_source_position..])?;
        // The final assembly `fxNewChunk(total + 1)`.
        self.charge_and_check(string_chunk_cost(assembled.len() as u64))?;
        let off = self.chunks.alloc(&units_to_be16(&assembled));
        Ok(Slot::of(Kind::String, Payload::String(off)))
    }

    /// The fully generic `%RegExp.prototype%[Symbol.replace]` algorithm. It
    /// deliberately collects result objects before reading their array-like
    /// fields, then performs every `Get` and coercion through the MOP so an
    /// overridden `exec`, Proxy, accessor result, or RegExp subclass observes
    /// the standard order and abrupt-completion behavior.
    pub(in crate::interp) fn regexp_replace_generic(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        receiver: Slot,
        subject: Slot,
        replacement: Slot,
    ) -> Result<Slot, Step> {
        let subject_units = match subject.value {
            Payload::String(off) if subject.kind == Kind::String => self.str_units(off),
            _ => unreachable!("RegExp @@replace subject was already converted to String"),
        };
        let functional = self.is_callable_value(replacement);
        let replacement_units = if functional {
            None
        } else {
            Some(self.to_string_units(code, replacement)?)
        };

        // RegExpBuiltinExec materializes these standard result properties only
        // when the sparse realm has an id for them. The algorithm references
        // them regardless of guest source spelling, so seed the same ids here
        // before the first exec result is built.
        let index_id = self.intern_static_key("index");
        let groups_id = self.intern_static_key("groups");
        if self.regexp_result_ids.index.is_none() {
            self.regexp_result_ids.index = Some(index_id);
        }
        if self.regexp_result_ids.groups.is_none() {
            self.regexp_result_ids.groups = Some(groups_id);
        }

        let flags = self.regexp_flags_units(code, inst, receiver, false)?;
        let global = flags.contains(&(b'g' as u16));
        if global {
            let last_index_id = self.regexp_last_index_id();
            if !self.mop_set(code, inst, last_index_id, Slot::integer(0), receiver)? {
                return Err(self.failed_set_error(inst, last_index_id, "C: xsSet"));
            }
        }

        let full_unicode = flags.contains(&(b'u' as u16)) || flags.contains(&(b'v' as u16));
        let zero_id = self.intern_static_key("0");
        let mut results = Vec::new();
        loop {
            let result = self.regexp_exec_abstract(code, inst, receiver, subject)?;
            if result.kind == Kind::Null {
                break;
            }
            let Payload::Reference(result_inst) = result.value else {
                unreachable!("RegExpExec validates object-or-null results")
            };
            self.extend_work_scratch(&mut results, &[result])?;
            if !global {
                break;
            }
            let matched = self.mop_get(code, result_inst, zero_id, result)?;
            let matched = self.to_string_units(code, matched)?;
            if matched.is_empty() {
                let last_index_id = self.regexp_last_index_id();
                let last_index = self.mop_get(code, inst, last_index_id, receiver)?;
                let index = self.to_length_value(code, last_index)?;
                let next = Self::advance_string_index(&subject_units, index, full_unicode);
                if !self.mop_set(
                    code,
                    inst,
                    last_index_id,
                    Slot::number(next as f64),
                    receiver,
                )? {
                    return Err(self.failed_set_error(inst, last_index_id, "C: xsSet"));
                }
            }
        }

        let mut assembled = Vec::new();
        let mut next_source_position = 0usize;
        for result in results {
            let Payload::Reference(result_inst) = result.value else {
                unreachable!("collected RegExpExec result is an object")
            };
            let result_length = self.arraylike_length(code, result_inst, result)?;
            let result_length = self.to_length_value(code, result_length)?;
            let captures_count = result_length.saturating_sub(1);
            const GENERIC_CAPTURE_CAP: u64 = 1 << 24;
            if captures_count > GENERIC_CAPTURE_CAP {
                return Err(Step::Host(Halt::Refused("RegExp.replace:oversized-result")));
            }

            let matched = self.mop_get(code, result_inst, zero_id, result)?;
            let matched = self.to_string_slot(code, matched)?;
            let matched_units = match matched.value {
                Payload::String(off) => self.str_units(off),
                _ => unreachable!("ToString returns a String slot"),
            };
            let index = self.mop_get(code, result_inst, index_id, result)?;
            let position = self.array_to_integer_or_infinity(code, index)?;
            let position = if position <= 0.0 {
                0
            } else if position >= subject_units.len() as f64 {
                subject_units.len()
            } else {
                position as usize
            };

            let mut captures = self.reserve_work_scratch(captures_count as usize)?;
            for capture_number in 1..=captures_count {
                let id = self.array_generic_index_id(capture_number)?;
                let capture = self.mop_get(code, result_inst, id, result)?;
                if capture.kind == Kind::Undefined {
                    captures.push(capture);
                } else {
                    captures.push(self.to_string_slot(code, capture)?);
                }
            }
            let named_captures = self.mop_get(code, result_inst, groups_id, result)?;
            let replacement_units = if functional {
                let mut args = self.reserve_scratch(
                    captures.len() + 3 + usize::from(named_captures.kind != Kind::Undefined),
                )?;
                args.push(matched);
                args.extend(captures.iter().copied());
                args.push(Self::array_index_number(position as u64));
                args.push(subject);
                if named_captures.kind != Kind::Undefined {
                    args.push(named_captures);
                }
                let value = self.invoke_value(code, replacement, Slot::undefined(), &args)?;
                self.to_string_units(code, value)?
            } else {
                let named = if named_captures.kind == Kind::Undefined {
                    None
                } else {
                    let object = self.array_to_object(named_captures)?;
                    let Payload::Reference(object_inst) = object.value else {
                        unreachable!("ToObject returns an object")
                    };
                    Some((object_inst, object))
                };
                self.regexp_generic_substitution(
                    code,
                    &matched_units,
                    &subject_units,
                    position,
                    &captures,
                    named,
                    replacement_units.as_deref().unwrap(),
                )?
            };

            // Ill-behaved exec results can move backwards. Their property
            // reads, coercions, and replacer call above still occur, but the
            // corresponding source segment and replacement are ignored.
            if position >= next_source_position {
                self.extend_work_scratch(
                    &mut assembled,
                    &subject_units[next_source_position..position],
                )?;
                self.extend_work_scratch(&mut assembled, &replacement_units)?;
                next_source_position = position.saturating_add(matched_units.len());
            }
        }
        if next_source_position < subject_units.len() {
            self.extend_work_scratch(&mut assembled, &subject_units[next_source_position..])?;
        }
        Ok(self.new_string_units(&assembled))
    }

    /// `GetSubstitution` over already-coerced generic captures. Named capture
    /// reads remain live and observable while replacement tokens are scanned.
    pub(in crate::interp) fn regexp_generic_substitution(
        &mut self,
        code: &[u8],
        matched: &[u16],
        subject: &[u16],
        position: usize,
        captures: &[Slot],
        named_captures: Option<(crate::value::SlotIndex, Slot)>,
        replacement: &[u16],
    ) -> Result<Vec<u16>, Step> {
        let tail = position.saturating_add(matched.len()).min(subject.len());
        let mut out = self.reserve_scratch(replacement.len())?;
        let mut i = 0;
        while i < replacement.len() {
            if replacement[i] != b'$' as u16 || i + 1 >= replacement.len() {
                self.extend_work_scratch(&mut out, &[replacement[i]])?;
                i += 1;
                continue;
            }
            match replacement[i + 1] {
                c if c == b'$' as u16 => {
                    self.extend_work_scratch(&mut out, &[b'$' as u16])?;
                    i += 2;
                }
                c if c == b'&' as u16 => {
                    self.extend_work_scratch(&mut out, matched)?;
                    i += 2;
                }
                c if c == b'`' as u16 => {
                    self.extend_work_scratch(&mut out, &subject[..position])?;
                    i += 2;
                }
                c if c == b'\'' as u16 => {
                    self.extend_work_scratch(&mut out, &subject[tail..])?;
                    i += 2;
                }
                c if (b'0' as u16..=b'9' as u16).contains(&c) => {
                    let first = (c - b'0' as u16) as usize;
                    let mut capture = 0usize;
                    let mut consumed = 0usize;
                    if i + 2 < replacement.len()
                        && (b'0' as u16..=b'9' as u16).contains(&replacement[i + 2])
                    {
                        let two = first * 10 + (replacement[i + 2] - b'0' as u16) as usize;
                        if (1..=captures.len()).contains(&two) {
                            capture = two;
                            consumed = 3;
                        }
                    }
                    if consumed == 0 && (1..=captures.len()).contains(&first) {
                        capture = first;
                        consumed = 2;
                    }
                    if consumed == 0 {
                        self.extend_work_scratch(&mut out, &[b'$' as u16])?;
                        i += 1;
                    } else {
                        let capture = captures[capture - 1];
                        if let Payload::String(off) = capture.value {
                            self.extend_work_scratch(&mut out, &self.str_units(off))?;
                        }
                        i += consumed;
                    }
                }
                c if c == b'<' as u16 && named_captures.is_some() => {
                    if let Some(relative) = replacement[i + 2..]
                        .iter()
                        .position(|&unit| unit == b'>' as u16)
                    {
                        let end = i + 2 + relative;
                        let name = SymbolName::from_units(&replacement[i + 2..end]);
                        let id = self.intern_key(&name)?;
                        let (object_inst, object) = named_captures.unwrap();
                        let capture = self.mop_get(code, object_inst, id, object)?;
                        if capture.kind != Kind::Undefined {
                            let units = self.to_string_units(code, capture)?;
                            self.extend_work_scratch(&mut out, &units)?;
                        }
                        i = end + 1;
                    } else {
                        self.extend_work_scratch(&mut out, &[b'$' as u16, b'<' as u16])?;
                        i += 2;
                    }
                }
                _ => {
                    self.extend_work_scratch(&mut out, &[b'$' as u16])?;
                    i += 1;
                }
            }
        }
        Ok(out)
    }

    /// The capture count (result-array length, including the whole match at 0)
    /// of an `exec` result array.
    pub(in crate::interp) fn regexp_capture_count(&self, result: Slot) -> usize {
        if let Payload::Reference(r) = result.value {
            if let Some(a) = self.arrays.get(&r) {
                return a.length as usize;
            }
        }
        0
    }

    /// The UTF-16 code units of capture group `idx` from an `exec` result
    /// array, or `None` when the group did not participate (its result element
    /// is `undefined`).
    pub(in crate::interp) fn regexp_capture_units(
        &self,
        result: Slot,
        idx: usize,
    ) -> Option<Vec<u16>> {
        let r = match result.value {
            Payload::Reference(r) => r,
            _ => return None,
        };
        let item = self.arrays.get(&r)?.items().get(&(idx as u32)).copied()?;
        match item.value {
            Payload::String(off) if item.kind == Kind::String => Some(self.str_units(off)),
            _ => None,
        }
    }

    /// An ordinary own property of a RegExp exec result. The result's named
    /// fields are built as raw data slots, so no user code is involved in this
    /// internal read.
    pub(in crate::interp) fn regexp_result_property(&self, result: Slot, id: u16) -> Slot {
        let Payload::Reference(r) = result.value else {
            return Slot::undefined();
        };
        self.ordinary_get_own_descriptor(r, id)
            .and_then(|descriptor| descriptor.value)
            .unwrap_or_else(Slot::undefined)
    }

    /// Read one named capture from this particular exec result's `groups`
    /// object. Keeping the lookup tied to the result (rather than the most
    /// recent matcher state) is required when a global replacement collects
    /// several matches before performing substitutions.
    pub(in crate::interp) fn regexp_named_capture_units(
        &self,
        result: Slot,
        name: &str,
    ) -> Option<Vec<u16>> {
        let groups_id = self.regexp_result_ids.groups?;
        let groups = self.regexp_result_property(result, groups_id);
        let Payload::Reference(groups) = groups.value else {
            return None;
        };
        let name_id = self.symbol_ids.get(name).copied()?;
        let value = self
            .ordinary_get_own_descriptor(groups, name_id)
            .and_then(|descriptor| descriptor.value)?;
        match value {
            Slot {
                kind: Kind::String,
                value: Payload::String(off),
                ..
            } => Some(self.str_units(off)),
            _ => None,
        }
    }

    /// `GetSubstitution` (ECMA-262 22.1.3.19.1): expand the `$` tokens of a
    /// `String.prototype.replace` replacement string against one match —
    /// `$$`→`$`, `$&`→matched, `` $` ``→prefix, `$'`→suffix, `$n`/`$nn`→the
    /// nth capture (empty when the group is unset, literal when out of range),
    /// and `$<name>`→the named capture (only when the pattern declares named
    /// groups; empty when the name is absent or unset). Any other `$X` is
    /// literal.
    pub(in crate::interp) fn regexp_get_substitution(
        &mut self,
        inst: crate::value::SlotIndex,
        result: Slot,
        subject: &[u16],
        pos: usize,
        match_len: usize,
        repl: &[u16],
    ) -> Result<Vec<u16>, Step> {
        let count = self.regexp_capture_count(result); // includes whole match at 0
        let names: Vec<(String, i32)> = self.regexps[&inst].program.capture_group_names.clone();
        let matched = &subject[pos..(pos + match_len).min(subject.len())];
        let mut out = self.reserve_scratch(repl.len())?;
        let mut i = 0;
        while i < repl.len() {
            if repl[i] != b'$' as u16 || i + 1 >= repl.len() {
                self.extend_work_scratch(&mut out, &[repl[i]])?;
                i += 1;
                continue;
            }
            match repl[i + 1] {
                c if c == b'$' as u16 => {
                    self.extend_work_scratch(&mut out, &[b'$' as u16])?;
                    i += 2;
                }
                c if c == b'&' as u16 => {
                    self.extend_work_scratch(&mut out, matched)?;
                    i += 2;
                }
                c if c == b'`' as u16 => {
                    self.extend_work_scratch(&mut out, &subject[..pos])?;
                    i += 2;
                }
                c if c == b'\'' as u16 => {
                    self.extend_work_scratch(
                        &mut out,
                        &subject[(pos + match_len).min(subject.len())..],
                    )?;
                    i += 2;
                }
                c if (b'0' as u16..=b'9' as u16).contains(&c) => {
                    let d1 = (repl[i + 1] - b'0' as u16) as usize;
                    // Prefer a two-digit reference when the second digit forms
                    // an in-range group number, else fall back to one digit.
                    let mut group = 0usize;
                    let mut consumed = 0usize;
                    if i + 2 < repl.len() && (b'0' as u16..=b'9' as u16).contains(&repl[i + 2]) {
                        let two = d1 * 10 + (repl[i + 2] - b'0' as u16) as usize;
                        if two >= 1 && two < count {
                            group = two;
                            consumed = 3;
                        }
                    }
                    if consumed == 0 && d1 >= 1 && d1 < count {
                        group = d1;
                        consumed = 2;
                    }
                    if consumed == 0 {
                        // Out of range: `$` and the digits stay literal.
                        self.extend_work_scratch(&mut out, &[b'$' as u16])?;
                        i += 1;
                    } else {
                        if let Some(units) = self.regexp_capture_units(result, group) {
                            self.extend_work_scratch(&mut out, &units)?;
                        }
                        i += consumed;
                    }
                }
                c if c == b'<' as u16 && !names.is_empty() => {
                    // `$<name>`: scan to the next `>`; a missing `>` leaves the
                    // `$<` literal (matching the `$<snd` → `$<snd` case). The
                    // name's live capture is resolved through the matcher's
                    // runtime `names[]` (slot = the name's position in the
                    // slot-ordered `capture_group_names`), so a duplicate name
                    // expands to whichever alternative matched.
                    if let Some(rel) = repl[i + 2..].iter().position(|&c| c == b'>' as u16) {
                        let name = &repl[i + 2..i + 2 + rel];
                        if let Some((name, _)) = names
                            .iter()
                            .find(|(nm, _)| nm.encode_utf16().eq(name.iter().copied()))
                        {
                            if let Some(units) = self.regexp_named_capture_units(result, name) {
                                self.extend_work_scratch(&mut out, &units)?;
                            }
                            // An unset or absent name expands to the empty string.
                        }
                        i += 2 + rel + 1;
                    } else {
                        self.extend_work_scratch(&mut out, &[b'$' as u16, b'<' as u16])?;
                        i += 2;
                    }
                }
                _ => {
                    // `$` followed by any other code unit is a literal `$`.
                    self.extend_work_scratch(&mut out, &[b'$' as u16])?;
                    i += 1;
                }
            }
        }
        Ok(out)
    }

    /// `GetMethod(value, @@name)` for String prototype protocols. The protocol
    /// is consulted only when `value` is an Object; primitive arguments proceed
    /// directly to coercion without reading their wrapper prototypes. Object
    /// access uses full `[[Get]]` (including proxies and accessors). A present
    /// non-callable is returned and rejected by [`Self::invoke_value`] with a
    /// catchable `TypeError`.
    pub(in crate::interp) fn string_protocol_method(
        &mut self,
        code: &[u8],
        value: Slot,
        name: &str,
    ) -> Result<Slot, Step> {
        let Payload::Reference(inst) = value.value else {
            return Ok(Slot::undefined());
        };
        if value.kind != Kind::Reference {
            return Ok(Slot::undefined());
        }
        let Some(id) = self.well_known_symbol_property_id(name) else {
            return Ok(Slot::undefined());
        };
        self.mop_get(code, inst, id, value)
    }

    /// `String.prototype.matchAll(regexp)`: validate a RegExp argument's
    /// observable flags before consulting `@@matchAll`; a present method is
    /// called with the original receiver. If absent, create a global RegExp
    /// through the realm constructor and invoke its (possibly overridden)
    /// `@@matchAll` with the coerced string.
    pub(in crate::interp) fn string_match_all(
        &mut self,
        code: &[u8],
        receiver: Slot,
        regexp: Slot,
    ) -> Result<Slot, Step> {
        if matches!(receiver.kind, Kind::Undefined | Kind::Null) {
            return Err(self.catchable_type_error_msg(
                if receiver.kind == Kind::Null {
                    "this: null"
                } else {
                    "this: undefined"
                }
                .into(),
            ));
        }
        if !matches!(regexp.kind, Kind::Undefined | Kind::Null) {
            if self.string_is_regexp(code, regexp)? {
                let Payload::Reference(inst) = regexp.value else {
                    unreachable!("IsRegExp is false for primitive values")
                };
                let flags = self.regexp_flags_units(code, inst, regexp, true)?;
                if !flags.contains(&(b'g' as u16)) {
                    return Err(self.catchable_type_error_msg("regexp has no g flag".into()));
                }
            }
            let method = self.string_protocol_method(code, regexp, "matchAll")?;
            if !matches!(method.kind, Kind::Undefined | Kind::Null) {
                return self.invoke_value(code, method, regexp, &[receiver]);
            }
        }

        let subject = self.to_string_slot(code, receiver)?;
        let regexp_constructor = *self
            .intrinsics
            .get("RegExp")
            .expect("RegExp intrinsic is linked");
        let constructor = Slot::of(Kind::Reference, Payload::Reference(regexp_constructor));
        let global = self.new_string_units(&[b'g' as u16]);
        let matcher = self.construct_value(code, constructor, &[regexp, global], constructor)?;
        let method = self.string_protocol_method(code, matcher, "matchAll")?;
        self.invoke_value(code, method, matcher, &[subject])
    }

    /// ECMA-262 `IsRegExp(argument)`: non-objects are never RegExps; an
    /// observable `@@match` property overrides the internal matcher brand,
    /// while `undefined` falls back to that brand. This is shared by
    /// `includes`, `startsWith`, and `endsWith`, which reject RegExp search
    /// values before applying `ToString`.
    pub(in crate::interp) fn string_is_regexp(
        &mut self,
        code: &[u8],
        value: Slot,
    ) -> Result<bool, Step> {
        let Payload::Reference(inst) = value.value else {
            return Ok(false);
        };
        if value.kind != Kind::Reference {
            return Ok(false);
        }
        let matcher = self.string_protocol_method(code, value, "match")?;
        if matcher.kind != Kind::Undefined {
            return Ok(self.truthy(&matcher));
        }
        Ok(self.regexps.contains_key(&inst))
    }

    /// ECMAScript `ToUint32`, used by the ordinary string-split limit. The
    /// coercion is re-entrant and therefore observes object conversion hooks;
    /// Symbols and BigInts reject through the shared `ToNumber` path.
    pub(in crate::interp) fn string_split_limit(
        &mut self,
        code: &[u8],
        limit: Slot,
    ) -> Result<u32, Step> {
        if limit.kind == Kind::Undefined {
            return Ok(u32::MAX);
        }
        let primitive = self.to_primitive(code, limit, false)?;
        if primitive.kind == Kind::Symbol {
            return Err(self.catchable_type_error_msg("cannot coerce symbol to unsigned".into()));
        }
        if primitive.kind == Kind::BigInt {
            return Err(self.catchable_type_error_msg("cannot coerce to unsigned".into()));
        }
        let n = self.to_number_f64(code, primitive)?;
        if !n.is_finite() || n == 0.0 {
            return Ok(0);
        }
        Ok(n.trunc().rem_euclid(4_294_967_296.0) as u32)
    }

    /// The `String.prototype.split` `withoutRegexp` path. Both the subject and
    /// separator use ordinary `ToString`; matching and slicing operate on
    /// UTF-16 code units so empty separators split surrogate pairs into their
    /// individual code units as required by ECMA-262.
    pub(in crate::interp) fn string_split_plain(
        &mut self,
        code: &[u8],
        subject: Slot,
        separator: Slot,
        limit_slot: Slot,
    ) -> Result<Slot, Step> {
        if matches!(subject.kind, Kind::Undefined | Kind::Null) {
            return Err(self.catchable_type_error_msg(
                if subject.kind == Kind::Null {
                    "this: null"
                } else {
                    "this: undefined"
                }
                .into(),
            ));
        }
        let subject_units = self.to_string_units(code, subject)?;
        let limit = self.string_split_limit(code, limit_slot)? as usize;
        let array = self.new_array_unmetered();
        let mut segments = Vec::new();
        // For a present separator, ToString precedes the zero-limit return;
        // an abrupt conversion remains observable even when the result would
        // otherwise be the empty array.
        let separator_units = if separator.kind == Kind::Undefined {
            None
        } else {
            Some(self.to_string_units(code, separator)?)
        };
        if limit == 0 {
            return Ok(self.finish_split_array(array, segments));
        }
        let push = |this: &mut Self, units: &[u16], out: &mut Vec<Slot>| {
            this.meter.tick_slot_alloc();
            out.push(this.new_string_units(units));
        };
        let Some(separator_units) = separator_units else {
            push(self, &subject_units, &mut segments);
            return Ok(self.finish_split_array(array, segments));
        };
        if separator_units.is_empty() {
            for unit in subject_units.iter().take(limit) {
                push(self, std::slice::from_ref(unit), &mut segments);
            }
            return Ok(self.finish_split_array(array, segments));
        }

        let mut from = 0usize;
        while segments.len() < limit {
            let found = subject_units[from..]
                .windows(separator_units.len())
                .position(|window| window == separator_units)
                .map(|offset| from + offset);
            let Some(at) = found else {
                break;
            };
            push(self, &subject_units[from..at], &mut segments);
            from = at + separator_units.len();
        }
        if segments.len() < limit {
            push(self, &subject_units[from..], &mut segments);
        }
        Ok(self.finish_split_array(array, segments))
    }

    /// Read element `i` of an array instance (for `split`'s capture insertion),
    /// or `undefined`.
    pub(in crate::interp) fn array_index_slot(&self, arr: Slot, i: u32) -> Slot {
        if let Payload::Reference(r) = arr.value {
            if let Some(a) = self.arrays.get(&r) {
                if let Some(s) = a.items().get(&i) {
                    return *s;
                }
            }
        }
        Slot::undefined()
    }

    /// Populate a `split` result array from its ordered segment slots (each
    /// already metered) and return it.
    pub(in crate::interp) fn finish_split_array(
        &mut self,
        array: crate::value::SlotIndex,
        segments: Vec<Slot>,
    ) -> Slot {
        let n = segments.len() as u32;
        let a = self.arrays.get_mut(&array).unwrap();
        for (i, s) in segments.into_iter().enumerate() {
            a.insert_item(i as u32, s, &mut self.side_refs);
        }
        a.length = n;
        Slot::of(Kind::Reference, Payload::Reference(array))
    }

    /// The whole-match byte length from an `exec` result array (its element 0,
    /// the matched string).
    pub(in crate::interp) fn regexp_whole_match_len(&self, result: Slot) -> usize {
        if let Payload::Reference(r) = result.value {
            if let Some(a) = self.arrays.get(&r) {
                if let Some(s) = a.items().get(&0) {
                    if let Payload::String(off) = s.value {
                        return self.str_len(off);
                    }
                }
            }
        }
        0
    }

    /// `RegExp.prototype.toString()` (`fx_RegExp_prototype_toString`): the
    /// `/source/flags` literal, built from the (escaped) source and the flag
    /// string.
    pub(in crate::interp) fn regexp_to_string(
        &mut self,
        inst: crate::value::SlotIndex,
    ) -> Result<Slot, Step> {
        // The `toString` host frame (the two `mxGetID` gets + the base
        // `fxStringX("/")`).
        self.meter.tick_raw(REGEXP_TOSTRING_METERING);
        // `mxGetID(_source)` → the source getter: an escaped source allocates a
        // fresh chunk (charged here); an unescaped source is the interned key.
        let (source_bytes, source_escaped) = self.regexp_source_units_metered(inst)?;
        if source_escaped {
            self.charge_and_check(string_chunk_cost(source_bytes.len() as u64))?;
        }
        // `mxGetID(_flags)` → the composite flags getter (the eight-property
        // cascade) + its result-string chunk.
        self.meter.tick_raw(REGEXP_FLAGS_GETTER_METERING);
        let flags = self.regexps[&inst].flags.clone();
        self.charge_and_check(string_chunk_cost(flags.len() as u64))?;
        // The three growing concatenations XS performs
        // (`fxConcatString`/`fxConcatStringC`): `"/"` + source, + `"/"`, +
        // flags — each `fxNewChunk` of the running content length.
        let s = source_bytes.len();
        let units = source_bytes.len();
        let f = flags.len();
        self.charge_and_check(string_chunk_cost((1 + units) as u64))?; // "/" + source
        self.charge_and_check(string_chunk_cost((2 + units) as u64))?; // + "/"
        self.charge_and_check(string_chunk_cost((2 + units + f) as u64))?; // + flags
        let mut out = self.reserve_scratch(s + f + 2)?;
        out.push(b'/' as u16);
        out.extend_from_slice(&source_bytes);
        out.push(b'/' as u16);
        out.extend(flags.encode_utf16());
        // The final chunk is the third concat, already metered; allocate it
        // without re-charging.
        let off = self.chunks.alloc(&units_to_be16(&out));
        Ok(Slot::of(Kind::String, Payload::String(off)))
    }

    /// Generic `RegExp.prototype.toString`: observe `source` and `flags` in
    /// specification order, including user accessors and their ToString
    /// conversions. A branded RegExp whose implicit intrinsic getter is still
    /// reached obtains that value from the RegExp side table.
    pub(in crate::interp) fn regexp_to_string_generic(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        self.meter.tick_raw(REGEXP_TOSTRING_METERING);
        let source_id = self.intern_static_key("source");
        let source = if self.regexps.contains_key(&inst)
            && self.regexp_getter_uses_default(inst, source_id)
        {
            self.meter.tick_raw(REGEXP_GETTER_METERING);
            let (bytes, allocated) = self.regexp_source_units_metered(inst)?;
            if allocated {
                self.new_string_units(&bytes)
            } else {
                let offset = self.chunks.alloc(&units_to_be16(&bytes));
                Slot::of(Kind::String, Payload::String(offset))
            }
        } else {
            self.mop_get(code, inst, source_id, receiver)?
        };
        let source = self.to_string_units(code, source)?;

        let flags_id = self.intern_static_key("flags");
        let flags = if self.regexps.contains_key(&inst)
            && self.regexp_getter_uses_default(inst, flags_id)
        {
            self.meter.tick_raw(REGEXP_FLAGS_GETTER_METERING);
            let flags = self.regexps[&inst].flags.clone();
            self.new_string_metered(flags.as_bytes())
        } else {
            self.mop_get(code, inst, flags_id, receiver)?
        };
        let flags = self.to_string_units(code, flags)?;

        // XS builds the result as three growing concatenations: `"/" +
        // source`, then `+ "/"`, then `+ flags`.
        self.charge_and_check(string_chunk_cost((source.len() + 1) as u64))?;
        self.charge_and_check(string_chunk_cost((source.len() + 2) as u64))?;
        self.charge_and_check(string_chunk_cost((source.len() + flags.len() + 2) as u64))?;
        let mut out = self.reserve_scratch(source.len() + flags.len() + 2)?;
        out.push(b'/' as u16);
        out.extend_from_slice(&source);
        out.push(b'/' as u16);
        out.extend_from_slice(&flags);
        let off = self.chunks.alloc(&units_to_be16(&out));
        Ok(Slot::of(Kind::String, Payload::String(off)))
    }

    /// Render the source as UTF-16, escaping ECMAScript line terminators and
    /// unescaped delimiters. The boolean records whether escaping allocated
    /// a fresh source chunk in the reference engine.
    pub(in crate::interp) fn regexp_source_units_metered(
        &mut self,
        inst: crate::value::SlotIndex,
    ) -> Result<(Vec<u16>, bool), Step> {
        let length = self.regexps[&inst].source.len();
        // Prepay the minimum scan before decoding. Charge the remaining
        // width per code point to retain the scalar UTF-8 entry's bill.
        self.charge_and_check(
            (length as u64)
                .checked_mul(crate::meter::BUILTIN_METERING)
                .ok_or(Step::Host(Halt::MeterAbort))?,
        )?;
        let mut index = 0;
        while index < length {
            let unit = self.regexps[&inst].source[index];
            let paired = (0xd800..=0xdbff).contains(&unit)
                && self.regexps[&inst]
                    .source
                    .get(index + 1)
                    .is_some_and(|next| (0xdc00..=0xdfff).contains(next));
            let extra = if paired {
                2
            } else if unit < 0x80 {
                0
            } else if unit < 0x800 {
                1
            } else {
                2
            };
            self.charge_and_check(extra * crate::meter::BUILTIN_METERING)?;
            index += if paired { 2 } else { 1 };
        }
        let capacity = regexp_rendered_source_len(&self.regexps[&inst].source);
        self.admit_scratch::<u16>(capacity)?;
        Ok(self.regexp_source_units(inst))
    }

    pub(in crate::interp) fn regexp_source_units(
        &self,
        inst: crate::value::SlotIndex,
    ) -> (Vec<u16>, bool) {
        let src = &self.regexps[&inst].source;
        if src.is_empty() {
            return ("(?:)".encode_utf16().collect(), false);
        }
        let mut out = self.reserve_copy_scratch(regexp_rendered_source_len(src));
        let mut escaped = false;
        let mut allocated = false;
        for &unit in src {
            let replacement = regexp_source_escape(unit, escaped);
            if let Some(text) = replacement {
                out.extend(text.encode_utf16());
                allocated = true;
            } else {
                out.push(unit);
            }
            escaped = unit == 0x5c && !escaped;
        }
        (out, allocated)
    }
}

fn regexp_source_escape(unit: u16, escaped: bool) -> Option<&'static str> {
    match unit {
        0x2f if !escaped => Some("\\/"),
        10 => Some("\\n"),
        13 => Some("\\r"),
        0x2028 => Some("\\u2028"),
        0x2029 => Some("\\u2029"),
        _ => None,
    }
}

fn regexp_rendered_source_len(source: &[u16]) -> usize {
    if source.is_empty() {
        return 4;
    }
    let mut length = 0usize;
    let mut escaped = false;
    for &unit in source {
        let width = regexp_source_escape(unit, escaped).map_or(1, str::len);
        length = length
            .checked_add(width)
            .unwrap_or_else(|| crate::value::heap_exhausted());
        escaped = unit == 0x5c && !escaped;
    }
    length
}
