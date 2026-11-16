//! Ironhorse's own UTF-8 codec statics on `%Uint8Array%`: `decodeUtf8`,
//! `encodeUtf8` and `encodeUtf8Into`.
//!
//! Ironhorse has no host `TextDecoder`/`TextEncoder`. The boot's codec
//! polyfill (`rust/endo/xsnap/src/polyfills.js`) captures these three and
//! deletes them before any other code runs, and builds the WHATWG classes on
//! them; without them it decodes in metered JavaScript, which halts a crank
//! below about 100 KB at the default budget.
//!
//! - `Uint8Array.decodeUtf8(bytes, fatal)`: decode the whole of the
//!   `Uint8Array` `bytes` by the WHATWG Encoding Standard's UTF-8 decoder
//!   (section 9.1.1), answering `{ text, consumed }`. A malformed sequence is
//!   replaced by one U+FFFD per maximal subpart, or throws a `TypeError` when
//!   `fatal` is truthy. A sequence that is valid so far but cut short by the
//!   end of `bytes` is neither: decoding stops before its first byte and
//!   `consumed` says where, so a streaming caller carries those (at most
//!   three) bytes into its next call and a flushing one reports one error.
//!   No byte order mark is stripped; that is the caller's.
//! - `Uint8Array.encodeUtf8(text)`: the UTF-8 of the string `text` as a new
//!   `%Uint8Array%`, each unpaired surrogate as U+FFFD (`EF BF BD`).
//! - `Uint8Array.encodeUtf8Into(text, bytes)`: the same bytes written into the
//!   `Uint8Array` `bytes`, stopping before the first code point that would not
//!   fit whole, answering `{ read, written }` in UTF-16 units and bytes, as
//!   `TextEncoder.prototype.encodeInto` does.
//!
//! No conversions: `text` must be a string and `bytes` a `Uint8Array`, or the
//! call throws a `TypeError`. Each input byte or code unit is charged one
//! builtin unit before it is read, and every output is admitted before it is
//! made.
use super::super::*;

/// The decoder's output: UTF-16 code units, and the bytes consumed.
struct Decoded {
    units: Vec<u16>,
    consumed: usize,
    malformed: bool,
}

/// WHATWG UTF-8 decode of `bytes` into `units`, whose capacity the caller has
/// admitted (one unit per input byte is always enough). Stops at the first
/// malformed sequence when `fatal`, and before a truncated final sequence
/// always.
fn decode(bytes: &[u8], fatal: bool, mut units: Vec<u16>) -> Decoded {
    let n = bytes.len();
    let mut malformed = false;
    let mut i = 0;
    'outer: while i < n {
        // ASCII runs dominate real text.
        let b0 = bytes[i];
        if b0 < 0x80 {
            units.push(u16::from(b0));
            i += 1;
            continue;
        }
        // UTF-8 bytes needed, the bounds of the next byte, and the bits the
        // lead byte contributes (Encoding Standard 9.1.1, step 3).
        let (needed, mut lower, mut upper, mut code_point) = match b0 {
            0xc2..=0xdf => (1, 0x80, 0xbf, u32::from(b0 & 0x1f)),
            0xe0 => (2, 0xa0, 0xbf, u32::from(b0 & 0x0f)),
            0xed => (2, 0x80, 0x9f, u32::from(b0 & 0x0f)),
            0xe1..=0xef => (2, 0x80, 0xbf, u32::from(b0 & 0x0f)),
            0xf0 => (3, 0x90, 0xbf, u32::from(b0 & 0x07)),
            0xf4 => (3, 0x80, 0x8f, u32::from(b0 & 0x07)),
            0xf1..=0xf3 => (3, 0x80, 0xbf, u32::from(b0 & 0x07)),
            _ => {
                // A continuation byte, C0, C1 or F5..FF: an error of one byte.
                malformed = true;
                if fatal {
                    break 'outer;
                }
                units.push(0xfffd);
                i += 1;
                continue;
            }
        };
        let mut j = i + 1;
        for _ in 0..needed {
            if j == n {
                // Valid so far and cut short by the end of the input: leave it
                // for the caller.
                break 'outer;
            }
            let byte = bytes[j];
            if byte < lower || byte > upper {
                // The maximal subpart `bytes[i..j]` is one error; `byte` is
                // read again as the start of the next sequence.
                malformed = true;
                if fatal {
                    break 'outer;
                }
                units.push(0xfffd);
                i = j;
                continue 'outer;
            }
            lower = 0x80;
            upper = 0xbf;
            code_point = (code_point << 6) | u32::from(byte & 0x3f);
            j += 1;
        }
        if code_point < 0x1_0000 {
            units.push(code_point as u16);
        } else {
            let c = code_point - 0x1_0000;
            units.push(0xd800 | (c >> 10) as u16);
            units.push(0xdc00 | (c & 0x3ff) as u16);
        }
        i = j;
    }
    Decoded {
        units,
        consumed: i,
        malformed,
    }
}

/// UTF-8 of `units`, unpaired surrogates as U+FFFD, into `out` until the next
/// code point would take it past `limit` bytes. Answers the units read.
fn encode(units: &[u16], limit: usize, out: &mut Vec<u8>) -> usize {
    let mut read = 0;
    while read < units.len() {
        let unit = units[read];
        if unit < 0x80 {
            if out.len() == limit {
                break;
            }
            out.push(unit as u8);
            read += 1;
            continue;
        }
        let (code_point, width) = match unit {
            0xd800..=0xdbff => match units.get(read + 1) {
                Some(&next @ 0xdc00..=0xdfff) => (
                    0x1_0000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(next) - 0xdc00),
                    2,
                ),
                _ => (0xfffd, 1),
            },
            0xdc00..=0xdfff => (0xfffd, 1),
            _ => (u32::from(unit), 1),
        };
        let size = if code_point < 0x800 {
            2
        } else if code_point < 0x1_0000 {
            3
        } else {
            4
        };
        if out.len() + size > limit {
            break;
        }
        match size {
            2 => {
                out.push(0xc0 | (code_point >> 6) as u8);
                out.push(0x80 | (code_point & 0x3f) as u8);
            }
            3 => {
                out.push(0xe0 | (code_point >> 12) as u8);
                out.push(0x80 | ((code_point >> 6) & 0x3f) as u8);
                out.push(0x80 | (code_point & 0x3f) as u8);
            }
            _ => {
                out.push(0xf0 | (code_point >> 18) as u8);
                out.push(0x80 | ((code_point >> 12) & 0x3f) as u8);
                out.push(0x80 | ((code_point >> 6) & 0x3f) as u8);
                out.push(0x80 | (code_point & 0x3f) as u8);
            }
        }
        read += width;
    }
    read
}

/// The exact UTF-8 length of `units`, unpaired surrogates as U+FFFD.
fn encoded_length(units: &[u16]) -> usize {
    let mut length = 0;
    let mut i = 0;
    while i < units.len() {
        let unit = units[i];
        length += match unit {
            0..=0x7f => 1,
            0x80..=0x7ff => 2,
            0xd800..=0xdbff if matches!(units.get(i + 1), Some(0xdc00..=0xdfff)) => {
                i += 1;
                4
            }
            _ => 3,
        };
        i += 1;
    }
    length
}

impl Interp {
    /// `Uint8Array.decodeUtf8`, `encodeUtf8` and `encodeUtf8Into`.
    /// Out of line from the method dispatcher, whose frame every native
    /// re-entry carries (`benches/stack_height.py`).
    #[inline(never)]
    pub(in crate::interp) fn call_uint8_array_utf8(
        &mut self,
        m: NativeMethod,
        base: usize,
        argc: usize,
    ) -> Result<Slot, Step> {
        let arg = |vm: &Self, i: usize| {
            if i < argc {
                vm.stack
                    .get(base + 4 + i)
                    .copied()
                    .unwrap_or_else(Slot::undefined)
            } else {
                Slot::undefined()
            }
        };
        match m {
            NativeMethod::Uint8ArrayDecodeUtf8 => {
                let ta = self.utf8_bytes_arg(arg(self, 0), "decodeUtf8")?;
                let fatal = {
                    let value = arg(self, 1);
                    self.truthy(&value)
                };
                let length = self.checked_ta_length(ta)? as usize;
                self.charge_builtin_work(length as u64)?;
                // One unit per byte bounds the output: a byte decodes to at
                // most one unit, a four-byte sequence to two.
                let count = self.reserve_units(length as u64)?;
                let units = Self::reserved_vec(count)?;
                let data = self.array_buffers[&ta.buffer].data;
                let start = ta.offset as usize;
                let bytes = self
                    .chunks
                    .payload_range(data, start..start + length)
                    .ok_or(Step::Host(Halt::EngineInvariant("Uint8Array:span")))?;
                let decoded = decode(&bytes, fatal, units);
                drop(bytes);
                if fatal && decoded.malformed {
                    return Err(self.catchable_type_error_msg(
                        "The encoded data was not valid for encoding utf-8".into(),
                    ));
                }
                let text = self.new_reserved_string_units(&decoded.units);
                self.meter.tick_slot_alloc();
                let result = self.slots.alloc(Slot::instance(self.object_proto));
                self.define_descriptor_field(result, "text", text);
                self.define_descriptor_field(
                    result,
                    "consumed",
                    Slot::number(decoded.consumed as f64),
                );
                Ok(Slot::of(Kind::Reference, Payload::Reference(result)))
            }
            NativeMethod::Uint8ArrayEncodeUtf8 => {
                let units = self.utf8_text_arg(arg(self, 0), "encodeUtf8", None)?;
                let size = encoded_length(&units);
                let mut out = self.reserve_scratch::<u8>(size)?;
                encode(&units, size, &mut out);
                self.new_uint8_array(&out)
            }
            NativeMethod::Uint8ArrayEncodeUtf8Into => {
                let text = arg(self, 0);
                let ta = self.utf8_bytes_arg(arg(self, 1), "encodeUtf8Into")?;
                let limit = self.checked_ta_length(ta)? as usize;
                // Each byte written reads at most one unit, so no more than
                // `limit` units (and one past them, to see a pair) are read.
                let units = self.utf8_text_arg(text, "encodeUtf8Into", Some(limit + 1))?;
                let mut out = self.reserve_scratch::<u8>(limit.min(units.len() * 3))?;
                let read = encode(&units, limit, &mut out);
                let written = out.len();
                if written > 0 {
                    let data = self.array_buffers[&ta.buffer].data;
                    let start = ta.offset as usize;
                    self.chunks.slice_mut(data, start + written)[start..start + written]
                        .copy_from_slice(&out);
                }
                self.meter.tick_slot_alloc();
                let result = self.slots.alloc(Slot::instance(self.object_proto));
                self.define_descriptor_field(result, "read", Slot::number(read as f64));
                self.define_descriptor_field(result, "written", Slot::number(written as f64));
                Ok(Slot::of(Kind::Reference, Payload::Reference(result)))
            }
            _ => unreachable!("not a Uint8Array UTF-8 member"),
        }
    }

    /// A `Uint8Array` argument, or a `TypeError`.
    fn utf8_bytes_arg(&mut self, value: Slot, who: &str) -> Result<TypedArrayData, Step> {
        match value.value {
            Payload::Reference(inst) if value.kind == Kind::Reference => {
                self.typed_arrays.get(&inst).copied()
            }
            _ => None,
        }
        .filter(|ta| TYPED_ARRAY_TYPES[ta.kind as usize].name == "Uint8Array")
        .ok_or_else(|| self.catchable_type_error_msg(format!("{who}: bytes is not a Uint8Array")))
    }

    /// A string argument's code units, at most `cap` of them, each charged one
    /// builtin unit before it is read; or a `TypeError`.
    fn utf8_text_arg(
        &mut self,
        value: Slot,
        who: &str,
        cap: Option<usize>,
    ) -> Result<Vec<u16>, Step> {
        let off = match value.value {
            Payload::String(off) if value.kind == Kind::String => off,
            _ => return Err(self.catchable_type_error_msg(format!("{who}: text is not a string"))),
        };
        let length = self.str_len(off);
        let take = cap.map_or(length, |cap| cap.min(length));
        self.charge_builtin_work(take as u64)?;
        let units = self.reserve_scratch::<u16>(take)?;
        let content = self
            .chunks
            .payload_range(off, 0..take * 2)
            .ok_or(Step::Host(Halt::EngineInvariant("Uint8Array:span")))?;
        let units = Self::fill_scratch(
            units,
            content
                .chunks_exact(2)
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]])),
        );
        drop(content);
        Ok(units)
    }
}
