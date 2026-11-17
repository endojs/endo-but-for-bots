//! ECMAScript URI globals. Operate on JS UTF-16 code units, not Rust strings:
//! encoding rejects lone surrogates, while decoding preserves unescaped ones.
use super::super::*;

const HEX: &[u8; 16] = b"0123456789ABCDEF";

fn unescaped(byte: u8, component: bool) -> bool {
    byte.is_ascii_alphanumeric()
        || b"-_.!~*'()".contains(&byte)
        || (!component && b";/?:@&=+$,#".contains(&byte))
}

fn hex_digit(unit: u16) -> Option<u8> {
    let byte = u8::try_from(unit).ok()?;
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

impl Interp {
    /// Read the existing guest string directly from its chunk, so a large
    /// argument never becomes an unmetered second UTF-16 buffer. Each input
    /// code unit is charged before the read.
    fn uri_unit(&mut self, off: crate::value::ChunkOffset, pos: usize) -> Result<u16, Step> {
        self.charge_and_check(crate::meter::STRING_METERING)?;
        Ok(self
            .str_unit_at(off, pos as u32)
            .expect("URI index within string"))
    }

    fn uri_percent_byte(
        &mut self,
        off: crate::value::ChunkOffset,
        len: usize,
        pos: usize,
    ) -> Result<Option<(u8, [u16; 3])>, Step> {
        if len.saturating_sub(pos) < 3 {
            return Ok(None);
        }
        let triplet = [
            self.uri_unit(off, pos)?,
            self.uri_unit(off, pos + 1)?,
            self.uri_unit(off, pos + 2)?,
        ];
        if triplet[0] != b'%' as u16 {
            return Ok(None);
        }
        let Some(upper) = hex_digit(triplet[1]) else {
            return Ok(None);
        };
        let Some(lower) = hex_digit(triplet[2]) else {
            return Ok(None);
        };
        Ok(Some(((upper << 4) | lower, triplet)))
    }

    /// Charge input work and admit each output growth before the temporary
    /// buffer expands. This bounds long native calls by the host meter.
    fn encode_uri(
        &mut self,
        off: crate::value::ChunkOffset,
        len: usize,
        component: bool,
    ) -> Result<Option<Vec<u16>>, Step> {
        let mut out = Vec::new();
        let mut pos = 0;
        while pos < len {
            let first = self.uri_unit(off, pos)?;
            pos += 1;
            let scalar = match first {
                0xd800..=0xdbff => {
                    if pos == len {
                        return Ok(None);
                    }
                    let second = self.uri_unit(off, pos)?;
                    pos += 1;
                    if !(0xdc00..=0xdfff).contains(&second) {
                        return Ok(None);
                    }
                    char::from_u32(
                        0x10000 + (((first as u32) - 0xd800) << 10) + (second as u32 - 0xdc00),
                    )
                    .expect("paired UTF-16 surrogates form a scalar")
                }
                0xdc00..=0xdfff => return Ok(None),
                _ => char::from_u32(first as u32).expect("non-surrogate UTF-16 unit"),
            };
            if scalar.is_ascii() && unescaped(scalar as u8, component) {
                self.extend_reserved_units(&mut out, &[scalar as u16])?;
                continue;
            }
            let mut bytes = [0u8; 4];
            for byte in scalar.encode_utf8(&mut bytes).as_bytes() {
                self.extend_reserved_units(
                    &mut out,
                    &[
                        b'%' as u16,
                        HEX[(byte >> 4) as usize] as u16,
                        HEX[(byte & 15) as usize] as u16,
                    ],
                )?;
            }
        }
        Ok(Some(out))
    }

    fn decode_uri(
        &mut self,
        off: crate::value::ChunkOffset,
        len: usize,
        component: bool,
    ) -> Result<Option<Vec<u16>>, Step> {
        let mut out = Vec::new();
        let mut pos = 0;
        while pos < len {
            // The first unit determines the grammar; percent_byte charges its
            // full triplet below, so this branch charges only a direct unit.
            let first_unit = self
                .str_unit_at(off, pos as u32)
                .expect("URI index within string");
            if first_unit != b'%' as u16 {
                self.charge_and_check(crate::meter::STRING_METERING)?;
                self.extend_reserved_units(&mut out, &[first_unit])?;
                pos += 1;
                continue;
            }
            let Some((first, first_triplet)) = self.uri_percent_byte(off, len, pos)? else {
                return Ok(None);
            };
            let width = match first {
                0..=0x7f => 1,
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => return Ok(None),
            };
            let mut bytes = [0u8; 4];
            bytes[0] = first;
            for (offset, byte) in bytes.iter_mut().enumerate().take(width).skip(1) {
                let Some((next, _)) = self.uri_percent_byte(off, len, pos + offset * 3)? else {
                    return Ok(None);
                };
                *byte = next;
            }
            let Some(scalar) = std::str::from_utf8(&bytes[..width])
                .ok()
                .and_then(|text| text.chars().next())
            else {
                return Ok(None);
            };
            if width == 1 && !component && b";/?:@&=+$,#".contains(&first) {
                self.extend_reserved_units(&mut out, &first_triplet)?;
            } else {
                let mut buffer = [0u16; 2];
                self.extend_reserved_units(&mut out, scalar.encode_utf16(&mut buffer))?;
            }
            pos += width * 3;
        }
        Ok(Some(out))
    }

    pub(in crate::interp) fn call_uri(
        &mut self,
        method: NativeMethod,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let value = if argc > 0 {
            self.stack
                .get(base + 4)
                .copied()
                .unwrap_or_else(Slot::undefined)
        } else {
            Slot::undefined()
        };
        self.charge_and_check(0)?;
        let string = self.to_string_slot(code, value)?;
        let Payload::String(off) = string.value else {
            unreachable!("ToString returned a non-string slot");
        };
        let len = self.str_len(off);
        let component = matches!(
            method,
            NativeMethod::UriEncodeComponent | NativeMethod::UriDecodeComponent
        );
        let result = match method {
            NativeMethod::UriEncode | NativeMethod::UriEncodeComponent => {
                self.encode_uri(off, len, component)?
            }
            NativeMethod::UriDecode | NativeMethod::UriDecodeComponent => {
                self.decode_uri(off, len, component)?
            }
            _ => unreachable!(),
        };
        match result {
            Some(units) => Ok(self.new_reserved_string_units(&units)),
            None => {
                let error = self.internal_error("URIError", "URI malformed".into());
                Err(self.raise_js(error))
            }
        }
    }
}
