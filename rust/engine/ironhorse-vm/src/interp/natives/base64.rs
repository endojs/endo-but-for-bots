//! The Uint8Array base64 and hex members (ES2026 23.3.1 to 23.3.3), ported
//! from XS's `xsDataView.c`: `Uint8Array.fromBase64`, `fromHex`, and the
//! prototype's `setFromBase64`, `setFromHex`, `toBase64` and `toHex`.
//!
//! The decoders read the string's UTF-16 code units in place, charging each
//! before it is read, and stop at the first error with the bytes decoded so
//! far, as `FromBase64` and `FromHex` specify: `setFromBase64` and
//! `setFromHex` write those bytes before they throw.
use super::super::*;

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";

/// `lastChunkHandling`.
#[derive(Clone, Copy, PartialEq)]
enum LastChunk {
    Loose,
    Strict,
    StopBeforePartial,
}

/// What `FromBase64` or `FromHex` answers: the code units read, the bytes
/// decoded, and whether it stopped at a SyntaxError.
struct Decoded {
    read: usize,
    bytes: Vec<u8>,
    error: bool,
}

fn base64_value(unit: u16, url: bool) -> Option<u8> {
    let byte = u8::try_from(unit).ok()?;
    let alphabet = if url { BASE64_URL } else { BASE64 };
    alphabet
        .iter()
        .position(|&candidate| candidate == byte)
        .map(|value| value as u8)
}

fn hex_value(unit: u16) -> Option<u8> {
    u8::try_from(unit)
        .ok()
        .and_then(|byte| (byte as char).to_digit(16))
        .map(|digit| digit as u8)
}

/// `DecodeBase64Chunk`: two, three or four sextets to one, two or three
/// bytes, or `None` when `strict` and the unused bits are not zero.
fn decode_chunk(chunk: &[u8], strict: bool) -> Option<Vec<u8>> {
    let mut sextets = [0u8; 4];
    sextets[..chunk.len()].copy_from_slice(chunk);
    let bits = u32::from(sextets[0]) << 18
        | u32::from(sextets[1]) << 12
        | u32::from(sextets[2]) << 6
        | u32::from(sextets[3]);
    let bytes = [(bits >> 16) as u8, (bits >> 8) as u8, bits as u8];
    let kept = chunk.len() - 1;
    if strict && kept < 3 && bytes[kept] != 0 {
        return None;
    }
    Some(bytes[..kept].to_vec())
}

fn is_ascii_whitespace(unit: u16) -> bool {
    matches!(unit, 0x09 | 0x0a | 0x0c | 0x0d | 0x20)
}

impl Interp {
    /// The code unit at `pos`, charged.
    fn base64_unit(&mut self, off: crate::value::ChunkOffset, pos: usize) -> Result<u16, Step> {
        self.charge_and_check(crate::meter::STRING_METERING)?;
        Ok(self
            .str_unit_at(off, pos as u32)
            .expect("base64 index within string"))
    }

    /// `SkipAsciiWhitespace`: the index of the first unit at or after `pos`
    /// that is not ASCII whitespace, and that unit, or `None` at the end.
    /// Every unit it reads is charged once, the returned one included, so
    /// the caller uses it rather than reading it again.
    fn base64_skip_whitespace(
        &mut self,
        off: crate::value::ChunkOffset,
        len: usize,
        mut pos: usize,
    ) -> Result<(usize, Option<u16>), Step> {
        while pos < len {
            let unit = self.base64_unit(off, pos)?;
            if !is_ascii_whitespace(unit) {
                return Ok((pos, Some(unit)));
            }
            pos += 1;
        }
        Ok((pos, None))
    }

    /// `FromBase64(string, alphabet, lastChunkHandling, maxLength)`.
    fn from_base64(
        &mut self,
        off: crate::value::ChunkOffset,
        url: bool,
        last_chunk: LastChunk,
        max_length: usize,
    ) -> Result<Decoded, Step> {
        let len = self.str_len(off);
        let capacity = max_length.min(len / 4 * 3 + 3);
        self.admit_scratch::<u8>(capacity)?;
        let mut bytes = Self::reserved_vec(capacity)?;
        let mut read = 0;
        let mut chunk = Vec::with_capacity(4);
        let mut index = 0;
        let stop = |bytes: Vec<u8>, read: usize, error: bool| Decoded { read, bytes, error };
        if max_length == 0 {
            return Ok(stop(bytes, 0, false));
        }
        loop {
            let (next, unit) = self.base64_skip_whitespace(off, len, index)?;
            index = next;
            let Some(unit) = unit else {
                if !chunk.is_empty() {
                    match last_chunk {
                        LastChunk::StopBeforePartial => return Ok(stop(bytes, read, false)),
                        LastChunk::Loose if chunk.len() > 1 => {
                            bytes.extend(decode_chunk(&chunk, false).expect("loose decodes"));
                        }
                        _ => return Ok(stop(bytes, read, true)),
                    }
                }
                return Ok(stop(bytes, len, false));
            };
            index += 1;
            if unit == u16::from(b'=') {
                if chunk.len() < 2 {
                    return Ok(stop(bytes, read, true));
                }
                let (next, mut after) = self.base64_skip_whitespace(off, len, index)?;
                index = next;
                if chunk.len() == 2 {
                    let Some(second) = after else {
                        let error = last_chunk != LastChunk::StopBeforePartial;
                        return Ok(stop(bytes, read, error));
                    };
                    if second == u16::from(b'=') {
                        (_, after) = self.base64_skip_whitespace(off, len, index + 1)?;
                    }
                }
                if after.is_some() {
                    return Ok(stop(bytes, read, true));
                }
                let Some(decoded) = decode_chunk(&chunk, last_chunk == LastChunk::Strict) else {
                    return Ok(stop(bytes, read, true));
                };
                bytes.extend(decoded);
                return Ok(stop(bytes, len, false));
            }
            let Some(sextet) = base64_value(unit, url) else {
                return Ok(stop(bytes, read, true));
            };
            let remaining = max_length - bytes.len();
            if (remaining == 1 && chunk.len() == 2) || (remaining == 2 && chunk.len() == 3) {
                return Ok(stop(bytes, read, false));
            }
            chunk.push(sextet);
            if chunk.len() == 4 {
                bytes.extend(decode_chunk(&chunk, false).expect("a whole chunk decodes"));
                chunk.clear();
                read = index;
                if bytes.len() == max_length {
                    return Ok(stop(bytes, read, false));
                }
            }
        }
    }

    /// `FromHex(string, maxLength)`.
    fn from_hex(
        &mut self,
        off: crate::value::ChunkOffset,
        max_length: usize,
    ) -> Result<Decoded, Step> {
        let len = self.str_len(off);
        if len % 2 != 0 {
            return Ok(Decoded {
                read: 0,
                bytes: Vec::new(),
                error: true,
            });
        }
        let capacity = max_length.min(len / 2);
        self.admit_scratch::<u8>(capacity)?;
        let mut bytes = Self::reserved_vec(capacity)?;
        let mut read = 0;
        while read < len && bytes.len() < max_length {
            let high = self.base64_unit(off, read)?;
            let low = self.base64_unit(off, read + 1)?;
            let (Some(high), Some(low)) = (hex_value(high), hex_value(low)) else {
                return Ok(Decoded {
                    read,
                    bytes,
                    error: true,
                });
            };
            read += 2;
            bytes.push(high << 4 | low);
        }
        Ok(Decoded {
            read,
            bytes,
            error: false,
        })
    }

    /// `GetOptionsObject` and the reads of `alphabet` and, for the decoders,
    /// `lastChunkHandling`, then, for `toBase64`, `omitPadding`, in that
    /// order. Each must be undefined or one of its names; no conversion runs.
    fn base64_options(
        &mut self,
        code: &[u8],
        options: Slot,
        decoding: bool,
    ) -> Result<(bool, LastChunk, bool), Step> {
        if options.kind == Kind::Undefined {
            return Ok((false, LastChunk::Loose, false));
        }
        let Payload::Reference(inst) = options.value else {
            return Err(self.catchable_type_error_msg("options: not an object".into()));
        };
        if options.kind != Kind::Reference {
            return Err(self.catchable_type_error_msg("options: not an object".into()));
        }
        // The option's value: `None` when it is undefined, else the one of
        // `names` it spells, compared unit by unit without copying the
        // string, or "" when it spells none of them or is not a string.
        let choice = |vm: &mut Self,
                      key: &'static str,
                      names: &[&'static str]|
         -> Result<Option<&'static str>, Step> {
            let id = vm.intern_static_key(key);
            let value = vm.mop_get(code, inst, id, options)?;
            Ok(match value.value {
                _ if value.kind == Kind::Undefined => None,
                Payload::String(off) if value.kind == Kind::String => {
                    let len = vm.str_len(off);
                    let spells = |name: &str| {
                        name.len() == len
                            && (name.bytes().zip(0..))
                                .all(|(byte, at)| vm.str_unit_at(off, at) == Some(u16::from(byte)))
                    };
                    let found = names.iter().copied().find(|name| spells(name));
                    Some(found.unwrap_or(""))
                }
                _ => Some(""),
            })
        };
        let url = match choice(self, "alphabet", &["base64", "base64url"])? {
            None | Some("base64") => false,
            Some("base64url") => true,
            Some(_) => {
                return Err(self.catchable_type_error_msg(
                    "options.alphabet: neither 'base64' nor 'base64url'".into(),
                ))
            }
        };
        let last_chunk = if decoding {
            match choice(
                self,
                "lastChunkHandling",
                &["loose", "strict", "stop-before-partial"],
            )? {
                None | Some("loose") => LastChunk::Loose,
                Some("strict") => LastChunk::Strict,
                Some("stop-before-partial") => LastChunk::StopBeforePartial,
                Some(_) => {
                    return Err(self.catchable_type_error_msg(
                        "options.lastChunkHandling: neither 'loose' nor 'strict' nor 'stop-before-partial'"
                            .into(),
                    ))
                }
            }
        } else {
            LastChunk::Loose
        };
        let omit_padding = if decoding {
            false
        } else {
            let id = self.intern_static_key("omitPadding");
            let value = self.mop_get(code, inst, id, options)?;
            self.truthy(&value)
        };
        Ok((url, last_chunk, omit_padding))
    }

    /// `ValidateUint8Array(this)`: a TypedArray whose element type is Uint8.
    fn validate_uint8_array(&mut self, this: Slot) -> Result<TypedArrayData, Step> {
        match this.value {
            Payload::Reference(inst) if this.kind == Kind::Reference => {
                self.typed_arrays.get(&inst).copied()
            }
            _ => None,
        }
        .filter(|ta| TYPED_ARRAY_TYPES[ta.kind as usize].name == "Uint8Array")
        .ok_or_else(|| self.catchable_type_error_msg("this: not a Uint8Array instance".into()))
    }

    /// A new `%Uint8Array%` over exactly `bytes`.
    fn new_uint8_array(&mut self, bytes: &[u8]) -> Result<Slot, Step> {
        let length = u32::try_from(bytes.len())
            .ok()
            .filter(|&length| length <= 0x7FFF_FFFF)
            .ok_or_else(|| self.catchable_range_error_msg("byteLength too big".into()))?;
        let kind = TYPED_ARRAY_TYPES
            .iter()
            .position(|ty| ty.name == "Uint8Array")
            .expect("Uint8Array is a TypedArray") as u8;
        let proto = self
            .intrinsics
            .get("Uint8Array")
            .and_then(|ctor| self.ctor_prototype.get(ctor))
            .copied()
            .unwrap_or(crate::value::SlotIndex::NULL);
        self.meter.tick_raw(TYPED_ARRAY_LENGTH_CTOR_FRAME_METERING);
        let buffer = self.alloc_array_buffer(length)?;
        let data = self.array_buffers[&buffer].data;
        self.chunks
            .slice_mut(data, bytes.len())
            .copy_from_slice(bytes);
        let inst = self.slots.alloc(Slot::instance(proto));
        self.typed_arrays.insert(
            inst,
            TypedArrayData {
                kind,
                buffer,
                offset: 0,
                array_length: Some(length),
                resizable_buffer: false,
            },
        );
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    /// The Uint8Array base64 and hex members.
    /// Out of line from the method dispatcher, whose frame every native
    /// re-entry carries (`benches/stack_height.py`).
    #[inline(never)]
    pub(in crate::interp) fn call_uint8_array_base64(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
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
        let string_arg = |vm: &mut Self| {
            let value = arg(vm, 0);
            match value.value {
                Payload::String(off) if value.kind == Kind::String => Ok(off),
                _ => Err(vm.catchable_type_error_msg("string: not a string".into())),
            }
        };
        match m {
            NativeMethod::Uint8ArrayFromBase64 | NativeMethod::Uint8ArrayFromHex => {
                let off = string_arg(self)?;
                let decoded = if m == NativeMethod::Uint8ArrayFromBase64 {
                    let (url, last_chunk, _) = self.base64_options(code, arg(self, 1), true)?;
                    self.from_base64(off, url, last_chunk, usize::MAX)?
                } else {
                    self.from_hex(off, usize::MAX)?
                };
                if decoded.error {
                    return Err(self.catchable_syntax_error_with_message("invalid string".into()));
                }
                self.new_uint8_array(&decoded.bytes)
            }
            NativeMethod::Uint8ArraySetFromBase64 | NativeMethod::Uint8ArraySetFromHex => {
                let ta = self.validate_uint8_array(this)?;
                let off = string_arg(self)?;
                let options = if m == NativeMethod::Uint8ArraySetFromBase64 {
                    Some(self.base64_options(code, arg(self, 1), true)?)
                } else {
                    None
                };
                // The options' getters may detach or resize the buffer:
                // `IsTypedArrayOutOfBounds` and `TypedArrayLength` come after
                // them.
                let byte_length = self.checked_ta_length(ta)? as usize;
                let decoded = match options {
                    Some((url, last_chunk, _)) => {
                        self.from_base64(off, url, last_chunk, byte_length)?
                    }
                    None => self.from_hex(off, byte_length)?,
                };
                let written = decoded.bytes.len();
                if written > 0 {
                    let data = self.array_buffers[&ta.buffer].data;
                    let start = ta.offset as usize;
                    self.chunks.slice_mut(data, start + written)[start..start + written]
                        .copy_from_slice(&decoded.bytes);
                }
                if decoded.error {
                    return Err(self.catchable_syntax_error_with_message("invalid string".into()));
                }
                self.meter.tick_slot_alloc();
                let result = self.slots.alloc(Slot::instance(self.object_proto));
                self.define_descriptor_field(result, "read", Slot::number(decoded.read as f64));
                self.define_descriptor_field(result, "written", Slot::number(written as f64));
                Ok(Slot::of(Kind::Reference, Payload::Reference(result)))
            }
            NativeMethod::Uint8ArrayToBase64 | NativeMethod::Uint8ArrayToHex => {
                let ta = self.validate_uint8_array(this)?;
                let (url, _, omit_padding) = if m == NativeMethod::Uint8ArrayToBase64 {
                    self.base64_options(code, arg(self, 0), false)?
                } else {
                    (false, LastChunk::Loose, false)
                };
                // `GetUint8ArrayBytes`, after the options' getters.
                let length = self.checked_ta_length(ta)? as usize;
                let size = if m == NativeMethod::Uint8ArrayToHex {
                    length as u64 * 2
                } else if omit_padding {
                    (length as u64 * 4).div_ceil(3)
                } else {
                    length.div_ceil(3) as u64 * 4
                };
                let count = self.reserve_units(size)?;
                self.charge_builtin_work(length as u64)?;
                let mut units = Self::reserved_vec(count)?;
                let data = self.array_buffers[&ta.buffer].data;
                let start = ta.offset as usize;
                let bytes = self
                    .chunks
                    .payload_range(data, start..start + length)
                    .ok_or(Step::Host(Halt::EngineInvariant("Uint8Array:span")))?;
                if m == NativeMethod::Uint8ArrayToHex {
                    for &byte in bytes.iter() {
                        units.push(u16::from(HEX_LOWER[(byte >> 4) as usize]));
                        units.push(u16::from(HEX_LOWER[(byte & 15) as usize]));
                    }
                } else {
                    let alphabet = if url { BASE64_URL } else { BASE64 };
                    for group in bytes.chunks(3) {
                        let bits = u32::from(group[0]) << 16
                            | u32::from(*group.get(1).unwrap_or(&0)) << 8
                            | u32::from(*group.get(2).unwrap_or(&0));
                        for position in 0..=group.len() {
                            let sextet = (bits >> (18 - 6 * position)) & 63;
                            units.push(u16::from(alphabet[sextet as usize]));
                        }
                        if !omit_padding {
                            for _ in group.len()..3 {
                                units.push(u16::from(b'='));
                            }
                        }
                    }
                }
                drop(bytes);
                Ok(self.new_reserved_string_units(&units))
            }
            _ => unreachable!("not a Uint8Array base64 member"),
        }
    }
}
