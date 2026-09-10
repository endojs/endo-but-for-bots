//! Host-facing value and uncaught-exception rendering.
use super::*;

impl Interp {
    /// Render a completion/thrown value the way the oracle shim does:
    /// `fxToString` then a lossy decode of the string's code units
    /// (`String::from_utf16_lossy`), the display/debug boundary the design's
    /// § Value and heap model routes through UTF-16. Non-string kinds defer to
    /// [`slot_to_ecma_string`].
    ///
    /// The array arm recurses over the elements (the `join` XS's `fxToString`
    /// runs), so a self-containing or deeply nested array is bounded by the
    /// native-recursion budget: past [`NATIVE_DEPTH_LIMIT`] the render fails
    /// with [`Halt::ReentryLimit`], the abort XS reaches for the same value
    /// through its C stack, rather than overflowing the host's. The budget is
    /// threaded as a parameter because this renderer is `&self`; it starts at
    /// whatever native depth the caller is at, so a diagnostic render from
    /// inside a native shares the one ceiling.
    pub(super) fn render(&self, s: &Slot) -> Result<String, Step> {
        self.render_at(s, self.native_depth)
    }

    /// The renderer's budget for one more level of element recursion, or the
    /// refusal. Charged only where the renderer actually descends, so a
    /// scalar or an error object renders at any depth — including a
    /// diagnostic render at the very ceiling — and only nesting is refused.
    pub(super) fn render_descend(&self, depth: usize) -> Result<usize, Step> {
        if depth + LIGHT_FRAME_COST > NATIVE_DEPTH_LIMIT {
            return Err(Step::Host(Halt::ReentryLimit {
                depth: depth + LIGHT_FRAME_COST,
                limit: NATIVE_DEPTH_LIMIT,
            }));
        }
        Ok(depth + LIGHT_FRAME_COST)
    }

    pub(super) fn render_at(&self, s: &Slot, depth: usize) -> Result<String, Step> {
        Ok(match s.value {
            Payload::String(off) => self.str_text(off),
            // A BigInt completion renders as its decimal magnitude (XS's
            // `String(aBigInt)`), no `n` suffix.
            Payload::BigInt(off) => {
                let (neg, mag) = self.read_bigint(off);
                bi_to_decimal(neg, &mag)
            }
            Payload::Reference(r) => {
                // An Error instance stringifies through `Error.prototype.
                // toString`: `name` with an empty/absent message, else
                // `name: message` — the abort/completion value parity the
                // Error hierarchy graduates.
                if self.arguments_objects.contains(&r) {
                    // An `arguments` object's `Object.prototype.toString`
                    // builtinTag is `Arguments` (its prototype is
                    // `Object.prototype`, so `String(arguments)` does NOT run
                    // `Array.prototype.join`). It is stored in the array side
                    // table for its indexed elements, so this arm precedes the
                    // array arm to keep the join from mis-rendering `1,2` where
                    // the oracle reports `[object Arguments]`.
                    "[object Arguments]".to_string()
                } else if let Some(a) = self.arrays.get(&r) {
                    // An array stringifies through `Array.prototype.toString` →
                    // `join(",")`: each index in `[0, length)` rendered, holes
                    // and `undefined`/`null` rendered as the empty string,
                    // joined with commas.
                    let depth = self.render_descend(depth)?;
                    let mut out = String::new();
                    for i in 0..a.length {
                        if i > 0 {
                            out.push(',');
                        }
                        if let Some(item) = a.items().get(&i) {
                            if item.kind != Kind::Undefined && item.kind != Kind::Null {
                                out.push_str(&self.render_at(item, depth)?);
                            }
                        } else if let Some(id) = self.symbol_ids.get(i.to_string()).copied() {
                            // A restrictive `defineProperty` descriptor moves
                            // the index out of the compact item table and into
                            // the ordinary property chain. Completion rendering
                            // is the host's `String(result)`/array join boundary;
                            // include a materialized data index just as the
                            // guest `join` path's MOP read does. (An accessor
                            // would require re-entering guest code after the
                            // run and remains outside this read-only renderer.)
                            if let Some(property) = self.find_property(r, id) {
                                let item = self.slots.get(property);
                                if item.flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) == 0
                                    && item.kind != Kind::Undefined
                                    && item.kind != Kind::Null
                                {
                                    out.push_str(&self.render_at(&item, depth)?);
                                }
                            }
                        }
                    }
                    out
                } else if self.typed_arrays.contains_key(&r) {
                    // A TypedArray's `toString` IS `Array.prototype.toString`
                    // (`%TypedArray%.prototype.toString === Array.prototype.
                    // toString`), so `String(new Int8Array(3))` is the `join(",")`
                    // of its elements (`0,0,0`) — NOT the `[object …]` tag its
                    // shared `Symbol.toStringTag` would give through
                    // `Object.prototype.toString`. Render each in-bounds element.
                    let ta = self.typed_arrays[&r];
                    let mut out = String::new();
                    for i in 0..ta.length {
                        if i > 0 {
                            out.push(',');
                        }
                        // A BigInt-element view (kinds 0/1) reads through the
                        // decimal helper; every other kind decodes to a Number.
                        let text = if ta.kind <= 1 {
                            self.typed_array_element_bigint_decimal(ta, i)
                        } else {
                            match self.typed_array_element_get(ta, i) {
                                Some(slot) => self.render_at(&slot, depth)?,
                                None => String::new(),
                            }
                        };
                        out.push_str(&text);
                    }
                    out
                } else if self.array_buffers.contains_key(&r) {
                    // `ArrayBuffer`/`SharedArrayBuffer` inherit
                    // `Object.prototype.toString`; their prototype's
                    // `Symbol.toStringTag` is `ArrayBuffer`/`SharedArrayBuffer`.
                    if self.shared_buffers.contains(&r) {
                        "[object SharedArrayBuffer]".to_string()
                    } else {
                        "[object ArrayBuffer]".to_string()
                    }
                } else if self.data_views.contains_key(&r) {
                    // `DataView` inherits `Object.prototype.toString`; its
                    // prototype's `Symbol.toStringTag` is `DataView`.
                    "[object DataView]".to_string()
                } else if let Some(c) = self.collections.get(&r) {
                    // A Map/Set/WeakMap/WeakSet stringifies through
                    // `Object.prototype.toString` under its `Symbol.toStringTag`
                    // ("Map"/"Set"/…): `[object Map]` &co. — the completion the
                    // oracle reports for a bare collection.
                    match c.kind {
                        CollKind::Map => "[object Map]".to_string(),
                        CollKind::Set => "[object Set]".to_string(),
                        CollKind::WeakMap => "[object WeakMap]".to_string(),
                        CollKind::WeakSet => "[object WeakSet]".to_string(),
                    }
                } else if self.promises.contains_key(&r) {
                    // A promise stringifies through `Object.prototype.toString`
                    // under its `Symbol.toStringTag` ("Promise"): `[object
                    // Promise]` — the completion the oracle reports for a bare
                    // promise.
                    "[object Promise]".to_string()
                } else if let Some(d) = self.regexps.get(&r) {
                    // A RegExp stringifies through `RegExp.prototype.toString`
                    // as the `/source/flags` literal (the empty pattern renders
                    // its `(?:)` source).
                    let (source, _alloc) = self.regexp_source_bytes(r);
                    format!("/{}/{}", String::from_utf8_lossy(&source), d.flags)
                } else if let Some(info) = self.error_data.get(&r) {
                    match &info.message {
                        Some(m) if !m.is_empty() => format!("{}: {}", info.name, m),
                        _ => info.name.to_string(),
                    }
                } else if let Some(prim) = self.wrapper_data.get(&r).copied() {
                    // A primitive wrapper (`new Boolean`/`Number`/`String`)
                    // stringifies as its wrapped primitive value.
                    self.render_at(&prim, self.render_descend(depth)?)?
                } else if let Some(n) = self.native_of(r) {
                    // A native (intrinsic) function stringifies through
                    // `Function.prototype.toString` as a host function
                    // (verified against the pin for a bare `Object`/`Boolean`).
                    format!("function [\"{}\"] (){{[native code]}}", n.display_name())
                } else if let Some(fi) = self
                    .functions
                    .get(&r)
                    .filter(|fi| fi.native.is_none() && fi.method.is_none())
                {
                    // A user (bytecode) function, an arrow, a class constructor,
                    // or a bound function (`f.bind(...)`, whose `name` is already
                    // `"bound "+target`) stringifies through the SAME
                    // `Function.prototype.toString` host-function synthesis the
                    // pinned Moddable emits for every callable:
                    // `function ["<name>"] (){[native code]}`, its own `.name`
                    // interpolated (empty for an anonymous function/arrow). XS's
                    // toString never reproduces the source text, so no
                    // source-span retention is needed; this is a display-only
                    // render (no metering), closing the `non-primitive-
                    // completion` gap for a function-valued completion. A native
                    // *prototype method* (`[].map`, dispatched by `NativeMethod`
                    // so `native_of` is `None`) is excluded here: its `FuncInfo`
                    // carries no `.name`, so it stays the generic reference stub
                    // rather than mis-render as an empty-named host function
                    // (which would turn an honest skip into a divergence).
                    format!("function [\"{}\"] (){{[native code]}}", fi.name)
                } else if let Some(tag) = self.string_tag_of(r) {
                    // An ordinary object carrying a string `Symbol.toStringTag`
                    // on its own/inherited chain stringifies through
                    // `Object.prototype.toString` step 15 as `[object <Tag>]`.
                    // In the pinned oracle profile no *metered* case has such a
                    // tag (only guest-set tags reach here), so this closes the
                    // gap for a `Symbol.toStringTag` completion without
                    // perturbing a covered case (which has no tag and falls
                    // through to the generic reference stub below).
                    format!("[object {}]", tag)
                } else {
                    slot_to_ecma_string(s)
                }
            }
            _ => slot_to_ecma_string(s),
        })
    }

    /// Render an uncaught thrown value the way the oracle shim's host
    /// boundary does (`String(exception)` after `fxRunScript`): a thrown user
    /// object runs its guest `toString` (sta.js's `Test262Error` carries
    /// one), so the abort value matches the oracle's rendering of the same
    /// failure. Native errors also use their observable `name`, `message`,
    /// and coercion hooks: the guest may have changed them since construction.
    /// Any failure inside guest coercion falls back to the static rendering.
    ///
    /// Called from [`Self::run`] only, once the halt has actually reached the
    /// host. An escape out of a nested dispatch is not yet uncaught — a
    /// native `mxTry` (a promise executor, a reaction, a disposer) may still
    /// catch it, and XS's `mxCatch` copies `mxException` without running any
    /// guest code — so the escape sites carry the static render and the
    /// guest `toString` runs here or never. See
    /// `tests/engine_throws_are_catchable.rs` for the once-at-host-boundary lock. The shim's
    /// stringification is post-run, so its metering is discarded too: the
    /// oracle records the run-only count at the throw.
    ///
    /// The text is a diagnostic and never decides the crank's outcome: the
    /// guest coercion running past the native-recursion budget (a thrown
    /// self-containing array's `join`) is discarded like any other failure,
    /// and a value the static renderer refuses for the same reason gets the
    /// reference stub ([`Self::render_or_stub`]). XS's host does abort
    /// rendering such a value; ironhorse reports the throw with the stub
    /// text instead — a divergence confined to the text of a throw nothing
    /// could have caught.
    pub(super) fn render_uncaught(&mut self, code: &[u8], v: Slot) -> String {
        // Rendering is a host diagnostic boundary, not a second guest throw:
        // if the diagnostic ToPrimitive itself fails, discard that attempt
        // completely so it cannot replace the original value (or leave an
        // extra callback frame behind).
        let saved_exception = self.exception;
        let saved_meter = self.meter.clone();
        let stack_base = self.stack.len();
        let call_depth = self.call_stack.len();
        let jump_depth = self.jumps.len();
        if let Payload::Reference(_) = v.value {
            if v.kind == Kind::Reference {
                match self.to_primitive(code, v, true) {
                    Ok(prim) => {
                        self.exception = saved_exception;
                        self.meter = saved_meter;
                        if prim.kind == Kind::String {
                            if let Payload::String(off) = prim.value {
                                return self.str_text(off);
                            }
                        }
                        if prim.kind != Kind::Reference {
                            return self.render_or_stub(&prim);
                        }
                    }
                    Err(_) => {
                        while self.call_stack.len() > call_depth {
                            let _ = self.leave_call();
                        }
                        self.stack.truncate(stack_base);
                        self.jumps.truncate(jump_depth);
                        self.meter = saved_meter;
                    }
                }
            }
        }
        self.exception = saved_exception;
        self.render_or_stub(&v)
    }

    /// [`Self::render`], or the bounded reference stub when the render
    /// refuses the value (a self-containing or very deep array runs past the
    /// native-recursion budget) — for the throw-site and host-boundary
    /// renders of a thrown value, which must not turn the throw into a halt.
    pub(super) fn render_or_stub(&self, s: &Slot) -> String {
        self.render(s).unwrap_or_else(|_| slot_to_ecma_string(s))
    }

    /// The string value of an instance's `Symbol.toStringTag` (own or
    /// inherited), for the completion-render boundary — a read-only (`&self`)
    /// analogue of [`Self::string_to_string_tag`] that never interns. Returns
    /// `None` when the well-known `Symbol.toStringTag` was never used as a key
    /// (so no property can carry it), when no chain slot holds it, or when the
    /// held value is not a string (`Object.prototype.toString` ignores a
    /// non-string tag).
    pub(super) fn string_tag_of(&self, inst: crate::value::SlotIndex) -> Option<String> {
        // The well-known `Symbol.toStringTag`'s descriptor identity, then the
        // interned key id it maps to. Both must already exist: a program that
        // set `[Symbol.toStringTag]` interned the key when it wrote the
        // property, so a missing entry means no such property can exist.
        let descriptor = self
            .well_known_symbols
            .iter()
            .find_map(|(name, value)| (*name == "toStringTag").then_some(value.value))?;
        let descriptor = match descriptor {
            Payload::Reference(d) => d,
            _ => return None,
        };
        let tag_id = *self.symbol_key_ids.get(&descriptor)?;
        let mut cur = inst;
        while !cur.is_null() {
            if let Some(prop) = self.find_property(cur, tag_id) {
                let slot = self.slots.get(prop);
                if slot.kind == Kind::String {
                    if let Payload::String(off) = slot.value {
                        return Some(self.str_text(off));
                    }
                }
                return None;
            }
            cur = self.instance_prototype(cur);
        }
        None
    }

    /// The descriptive string of a symbol value (XS's `fxSymbolToString`):
    /// `Symbol(` + the description (empty when the description is `undefined`)
    /// + `)`. A symbol carries `Payload::Reference(desc)`, the description slot
    /// (a `String` or `undefined`).
    pub(super) fn symbol_descriptive_bytes(&self, sym: Slot) -> Vec<u8> {
        let mut out = b"Symbol(".to_vec();
        if let Payload::Reference(d) = sym.value {
            if let Payload::String(off) = self.slots.get(d).value {
                out.extend_from_slice(self.str_text(off).as_bytes());
            }
        }
        out.push(b')');
        out
    }
}
