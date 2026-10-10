//! String storage access, construction, and primitive formatting.
use super::*;

impl Interp {
    /// The content bytes of a heap string (up to the C NUL terminator, or
    /// the whole payload for an interned string stored without one): XS's
    /// `mxStringLength`/`c_strlen` view of a string value.
    #[inline]
    /// The raw stored payload of a string value: its **UTF-16 big-endian**
    /// code-unit bytes (2 bytes per code unit, revised 2026-07-06 from the
    /// CESU-8 build — design § Value and heap model). There is no NUL
    /// terminator (a UTF-16 code unit U+0000 is `00 00`, so a byte scan
    /// cannot mark the end); the length comes from the chunk header. Big-
    /// endian is chosen so byte-lexicographic order over this slice equals
    /// UTF-16 code-unit order, which is exactly the ECMAScript string
    /// ordering — the relational/equality opcodes therefore compare these
    /// bytes directly with no decode.
    pub(super) fn str_content(
        &self,
        off: crate::value::ChunkOffset,
    ) -> crate::value::ChunkSlice<'_> {
        self.chunks.payload(off)
    }

    /// The string value's code units (`str_content` decoded from UTF-16BE).
    pub(super) fn str_units(&self, off: crate::value::ChunkOffset) -> Vec<u16> {
        string_decode_instrumentation::record();
        be16_to_units(&self.str_content(off))
    }

    /// The single code unit at `index`, read straight out of the stored
    /// UTF-16BE payload.
    ///
    /// O(1), and that is the point: reading one unit through [`Self::str_units`]
    /// decodes and ALLOCATES the whole string first, so walking a String
    /// wrapper's units one at a time was quadratic. At 70,000 units
    /// `harden(new String('x'.repeat(70000)))` spent over 400 seconds for
    /// ~18,000 computrons — work the meter cannot see, which is a denial of
    /// service in a metered engine even though nothing is minted.
    pub(super) fn str_unit_at(&self, off: crate::value::ChunkOffset, index: u32) -> Option<u16> {
        let at = (index as usize).checked_mul(2)?;
        let bytes = self.chunks.payload_range(off, at..at.checked_add(2)?)?;
        Some(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    /// The string value's code-unit length (`length`, O(1) — half the stored
    /// byte payload, no decode walk).
    #[inline]
    pub(super) fn str_len(&self, off: crate::value::ChunkOffset) -> usize {
        self.chunks.len_of(off) / 2
    }

    /// The string value rendered to a Rust `String` (`String::from_utf16_lossy`
    /// over the code units), only for display/debug diagnostics. Guest value
    /// and source production must use code units; grammar parsing must use
    /// `str_scalar_text` and handle invalid input explicitly.
    pub(super) fn str_text_lossy(&self, off: crate::value::ChunkOffset) -> String {
        String::from_utf16_lossy(&self.str_units(off))
    }

    /// Convert only when all units form Unicode scalar values. Grammar
    /// consumers must choose their specified invalid-input result on None.
    pub(super) fn str_scalar_text(&self, off: crate::value::ChunkOffset) -> Option<String> {
        String::from_utf16(&self.str_units(off)).ok()
    }

    /// StringNumericLiteral cannot contain an unpaired surrogate.
    pub(super) fn str_number(&self, off: crate::value::ChunkOffset) -> f64 {
        self.str_scalar_text(off)
            .map_or(f64::NAN, |text| string_to_number(text.as_bytes(), true))
    }

    /// Allocate a String value's chunk from **UTF-8 text** bytes, encoding them
    /// to the stored UTF-16BE form. Unmetered — callers that meter the
    /// allocation do so separately (at code-unit granularity). For text that is
    /// pure ASCII (rendered numbers, names, typeof atoms) the code-unit count
    /// equals the input byte count.
    pub(super) fn alloc_str_text(&mut self, text: &str) -> crate::value::ChunkOffset {
        let units: Vec<u16> = text.encode_utf16().collect();
        self.chunks.alloc(&units_to_be16(&units))
    }

    /// Allocate and price UTF-8 text using the same UTF-16 length as storage.
    pub(super) fn alloc_str_text_metered(
        &mut self,
        text: &[u8],
    ) -> Result<crate::value::ChunkOffset, Step> {
        let text = String::from_utf8_lossy(text);
        let count = text.encode_utf16().count();
        self.charge_and_check(string_chunk_cost(count as u64))?;
        self.admit_scratch::<u16>(count)?;
        let mut units = Self::reserved_vec(count)?;
        units.extend(text.encode_utf16());
        Ok(self.chunks.alloc(&units_to_be16(&units)))
    }

    /// Allocate a fresh String slot from **UTF-8 text** `bytes`, decoding them
    /// to UTF-16 code units and storing them as UTF-16BE. Metered by code-unit
    /// length (`n_units + 1`, the re-based O(n) string-op weight; for ASCII
    /// text this equals the old CESU-8 `len + 1`, so ASCII results meter
    /// identically). An empty result reuses the interned empty string (no
    /// chunk), exactly as XS returns `mxEmptyString`.
    pub(super) fn new_string_metered(&mut self, bytes: &[u8]) -> Slot {
        let units: Vec<u16> = String::from_utf8_lossy(bytes).encode_utf16().collect();
        self.new_string_units(&units)
    }

    /// Allocate a fresh String slot from UTF-16 code `units` (the direct
    /// storage form — used where the result is a code-unit slice of an existing
    /// string, so lone surrogates survive without a lossy text round-trip).
    /// Metered by code-unit length (`n_units + 1`); an empty result is the
    /// interned empty string (no metered chunk).
    pub(super) fn new_string_units(&mut self, units: &[u16]) -> Slot {
        if units.is_empty() {
            // XS's `mxEmptyString` — an interned "", no metered fxNewChunk.
            let off = self.chunks.alloc(&[]);
            return Slot::of(Kind::String, Payload::String(off));
        }
        self.meter.tick_string(units.len() as u64);
        let off = self.chunks.alloc(&units_to_be16(units));
        Slot::of(Kind::String, Payload::String(off))
    }

    /// String `+`: `ToString` both operands and concatenate, metering
    /// exactly at XS's sites — a `ToString` of a number allocates its
    /// rendered chunk (`tick_chunk_new(len+1)`; `ToString` of a
    /// string/boolean/null/undefined is an interned or identity no-op with
    /// no allocation), and `fxConcatString` allocates the joined chunk
    /// `fxNewChunk(aSize + bSize + 1)`. The result is a new heap String.
    pub(super) fn concat_add(&mut self, a: Slot, b: Slot) {
        let ua = self.to_string_units_metered(a);
        let ub = self.to_string_units_metered(b);
        // fxConcatString: one fxNewChunk over the joined code units. Metered by
        // total code-unit length (`+1`, the re-based O(n) string weight; for
        // ASCII operands this equals the old CESU-8 `aSize + bSize + 1`).
        self.meter.tick_string((ua.len() + ub.len()) as u64);
        let mut joined = Vec::with_capacity(ua.len() + ub.len());
        joined.extend_from_slice(&ua);
        joined.extend_from_slice(&ub);
        let off = self.chunks.alloc(&units_to_be16(&joined));
        self.push(Slot::of(Kind::String, Payload::String(off)));
    }

    /// `ToString` of a primitive to its content bytes (no NUL), metering
    /// the allocation XS's `fxToString` performs: a number renders to a
    /// fresh chunk (`fxNumberToString` → `tick_chunk_new(len+1)`); a string
    /// is identity and a boolean/null/undefined is an interned string, both
    /// allocation-free.
    /// Coerce a value to a **String slot** (`fxToString`), metering exactly
    /// the allocation `fxToString` performs. A string is identity (no chunk);
    /// a number/bigint renders into a fresh chunk; a boolean/null/undefined is
    /// an interned string. Used where the coerced string itself is retained
    /// (e.g. `exec`'s `input`, which XS aliases to the argument string rather
    /// than copying).
    pub(super) fn to_string_slot_metered(&mut self, s: Slot) -> Slot {
        if s.kind == Kind::String {
            return s;
        }
        let units = self.to_string_units_metered(s);
        // `to_string_units_metered` already charged the render chunk; store the
        // slot without double-charging (a number's chunk was metered; the
        // boolean/null/undefined interned strings carry no chunk).
        let off = self.chunks.alloc(&units_to_be16(&units));
        Slot::of(Kind::String, Payload::String(off))
    }

    /// Primitive ToString has one representation: UTF-16 code units. A
    /// string is copied losslessly; numeric renderers produce scalar text and
    /// retain their existing conversion/allocation charges.
    pub(super) fn to_string_units_metered(&mut self, s: Slot) -> Vec<u16> {
        let bytes = match s.value {
            Payload::String(off) => return self.str_units(off),
            Payload::Integer(i) => {
                let r = i.to_string().into_bytes();
                // `fxToString`/`fxNumberToString` on a number renders into a
                // fresh chunk (`tick_chunk_new(len+1)`) and meters one
                // built-in step (`mxMeterOne`) for the conversion — measured
                // against the pin as exactly `XS_BUILTIN_METERING` over the
                // allocation.
                self.meter.tick_builtin();
                self.meter.tick_string(r.len() as u64);
                r
            }
            Payload::Number(n) => {
                let r = number_to_ecma_string(n).into_bytes();
                self.meter.tick_builtin();
                self.meter.tick_string(r.len() as u64);
                r
            }
            Payload::Boolean(bv) => {
                if bv {
                    b"true".to_vec()
                } else {
                    b"false".to_vec()
                }
            }
            Payload::None => match s.kind {
                Kind::Null => b"null".to_vec(),
                _ => b"undefined".to_vec(),
            },
            Payload::Reference(_) => Vec::new(), // unreachable: op_add rejects references
            Payload::At(..) => Vec::new(),       // unreachable: not a primitive value
            // `String(aBigInt)` — the decimal magnitude with a leading `-`.
            // `fxBigIntToString` renders into a fresh chunk; metered as a
            // number's ToString is (one built-in step + the result chunk).
            Payload::BigInt(off) => {
                let (neg, mag) = self.read_bigint(off);
                let r = bi_to_decimal(neg, &mag).into_bytes();
                self.meter.tick_builtin();
                self.meter.tick_string(r.len() as u64);
                r
            }
        };
        // Every non-string rendering above is ASCII.
        bytes.into_iter().map(u16::from).collect()
    }
}
