//! UTF-16 storage, CESU-8 decoding, and admitted Unicode transformations.

use super::{Halt, Interp, Step};

/// Decode a string value's stored **UTF-16 big-endian** payload into its
/// code units. A trailing odd byte (never produced by the store path) is
/// ignored. This is the inverse of [`units_to_be16`].
pub(super) fn be16_to_units(content: &[u8]) -> Vec<u16> {
    content
        .chunks_exact(2)
        .map(|p| u16::from_be_bytes([p[0], p[1]]))
        .collect()
}

/// Encode code `units` to the stored **UTF-16 big-endian** payload (2 bytes
/// per unit). Big-endian so a byte-lexicographic compare of two payloads
/// equals their code-unit ordering (the ECMAScript string relation).
pub(super) fn units_to_be16(units: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(units.len() * 2);
    for &u in units {
        out.extend_from_slice(&u.to_be_bytes());
    }
    out
}

/// Apply locale-insensitive Unicode case conversion to a JavaScript UTF-16
/// string. Valid scalar runs go through Rust's whole-string mapping so
/// context-sensitive SpecialCasing rules see their neighbors. An unpaired
/// surrogate is a Unicode code point in ECMAScript string iteration but not a
/// Rust `char`; it maps to itself and acts as a boundary between scalar runs.
pub(super) fn unicode_case_convert_utf16(
    vm: &mut Interp,
    units: &[u16],
    upper: bool,
) -> Result<Vec<u16>, Step> {
    let mut output_units = 0u64;
    let mut output_bytes = 0usize;
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(ch) => {
                if upper {
                    for mapped in ch.to_uppercase() {
                        output_units += mapped.len_utf16() as u64;
                        output_bytes += mapped.len_utf8();
                    }
                } else {
                    for mapped in ch.to_lowercase() {
                        output_units += mapped.len_utf16() as u64;
                        output_bytes += mapped.len_utf8();
                    }
                }
            }
            Err(_) => {
                output_units += 1;
            }
        }
    }
    let size = vm.reserve_units(output_units)?;
    vm.admit_scratch::<u8>(output_bytes)?;
    let mut out = Interp::reserved_vec(size)?;
    let mut scalar_run = admitted_scalar_run(vm, units.len())?;
    let flush = |scalar_run: &mut String, out: &mut Vec<u16>| {
        if upper {
            out.extend(scalar_run.to_uppercase().encode_utf16());
        } else {
            out.extend(scalar_run.to_lowercase().encode_utf16());
        }
        scalar_run.clear();
    };
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(ch) => scalar_run.push(ch),
            Err(error) => {
                flush(&mut scalar_run, &mut out);
                out.push(error.unpaired_surrogate());
            }
        }
    }
    flush(&mut scalar_run, &mut out);
    debug_assert_eq!(out.len(), size);
    Ok(out)
}

/// At most three UTF-8 bytes per UTF-16 code unit (four bytes for a pair).
fn admitted_scalar_run(vm: &mut Interp, units: usize) -> Result<String, Step> {
    let bytes = units
        .checked_mul(3)
        .ok_or(Step::Host(Halt::HeapExhausted))?;
    vm.admit_scratch::<u8>(bytes)?;
    let mut run = String::new();
    run.try_reserve_exact(bytes)
        .map_err(|_| Step::Host(Halt::HeapExhausted))?;
    Ok(run)
}

/// Apply the locale tailoring required by the frozen Intl profile before the
/// Unicode whole-string conversion. Turkish and Azeri specialize dotted and
/// dotless I; every other supported or fallback locale uses default casing.
pub(super) fn unicode_locale_case_convert_utf16(
    vm: &mut Interp,
    units: &[u16],
    upper: bool,
    locale: &str,
) -> Result<Vec<u16>, Step> {
    let language = locale.split('-').next().unwrap_or(locale);
    if !matches!(language, "tr" | "az") {
        return unicode_case_convert_utf16(vm, units, upper);
    }
    let mut tailored = vm.reserve_scratch(units.len())?;
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        if upper {
            tailored.push(match unit {
                0x0069 => 0x0130,
                0x0131 => 0x0049,
                _ => unit,
            });
        } else if unit == 0x0130 {
            tailored.push(0x0069);
        } else if unit == 0x0049 {
            if units.get(index + 1) == Some(&0x0307) {
                tailored.push(0x0069);
                index += 1;
            } else {
                tailored.push(0x0131);
            }
        } else {
            tailored.push(unit);
        }
        index += 1;
    }
    unicode_case_convert_utf16(vm, &tailored, upper)
}

#[derive(Clone, Copy)]
pub(super) enum UnicodeNormalizationForm {
    Nfc,
    Nfd,
    Nfkc,
    Nfkd,
}

/// Normalize a JavaScript UTF-16 string without replacing lone surrogates.
/// ICU4X's UTF-16 entry point deliberately maps invalid pairs to U+FFFD, so
/// valid scalar runs are normalized separately and each unpaired surrogate is
/// copied verbatim as a normalization boundary.
pub(super) fn unicode_normalize_utf16(
    vm: &mut Interp,
    units: &[u16],
    form: UnicodeNormalizationForm,
) -> Result<Vec<u16>, Step> {
    let mut out = Vec::new();
    let mut scalar_run = admitted_scalar_run(vm, units.len())?;
    // ICU's canonical-ordering buffer retains (scalar, combining class) pairs.
    // The pinned ICU data's largest compatibility decomposition is 18
    // scalars (U+FDFA); include its complete expansion in scratch admission.
    vm.admit_scratch::<(char, u8)>(
        units
            .len()
            .checked_mul(18)
            .ok_or(Step::Host(Halt::HeapExhausted))?,
    )?;
    let flush =
        |vm: &mut Interp, scalar_run: &mut String, out: &mut Vec<u16>| -> Result<(), Step> {
            let mut append = |ch: char| -> Result<(), Step> {
                let mut units = [0u16; 2];
                vm.extend_reserved_units(out, ch.encode_utf16(&mut units))
            };
            match form {
                UnicodeNormalizationForm::Nfc => {
                    for ch in icu_normalizer::ComposingNormalizer::new_nfc()
                        .normalize_iter(scalar_run.chars())
                    {
                        append(ch)?;
                    }
                }
                UnicodeNormalizationForm::Nfd => {
                    for ch in icu_normalizer::DecomposingNormalizer::new_nfd()
                        .normalize_iter(scalar_run.chars())
                    {
                        append(ch)?;
                    }
                }
                UnicodeNormalizationForm::Nfkc => {
                    for ch in icu_normalizer::ComposingNormalizer::new_nfkc()
                        .normalize_iter(scalar_run.chars())
                    {
                        append(ch)?;
                    }
                }
                UnicodeNormalizationForm::Nfkd => {
                    for ch in icu_normalizer::DecomposingNormalizer::new_nfkd()
                        .normalize_iter(scalar_run.chars())
                    {
                        append(ch)?;
                    }
                }
            }
            scalar_run.clear();
            Ok(())
        };
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(ch) => scalar_run.push(ch),
            Err(error) => {
                flush(vm, &mut scalar_run, &mut out)?;
                vm.extend_reserved_units(&mut out, &[error.unpaired_surrogate()])?;
            }
        }
    }
    flush(vm, &mut scalar_run, &mut out)?;
    Ok(out)
}

/// The stored UTF-16BE payload for a Rust `&str`, encoding it to code units
/// (`str::encode_utf16`) then to big-endian bytes.
pub(super) fn str_to_be16(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 2);
    for u in s.encode_utf16() {
        out.extend_from_slice(&u.to_be_bytes());
    }
    out
}

/// Decode the XS compiler's CESU-8 string-literal operand (as it sits in the
/// bytecode, including its trailing NUL) into UTF-16 code units. CESU-8 encodes
/// each UTF-16 code unit as its own 1–3 byte UTF-8-shaped sequence — a BMP
/// scalar directly, a surrogate half (`0xED 0xA0..BF ..`) as one unit — so the
/// decode is one unit per sequence, preserving lone surrogates. A stray 4-byte
/// UTF-8 astral sequence (should not appear in CESU-8) is split into its
/// surrogate pair. A trailing NUL and any malformed tail are dropped.
pub(super) fn cesu8_to_units(bytes: &[u8]) -> Vec<u16> {
    let mut units = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i];
        if b0 == 0 {
            break; // the compiler's trailing NUL terminator
        } else if b0 < 0x80 {
            units.push(b0 as u16);
            i += 1;
        } else if b0 < 0xE0 {
            if i + 1 >= bytes.len() {
                break;
            }
            let cp = (((b0 & 0x1F) as u32) << 6) | (bytes[i + 1] & 0x3F) as u32;
            units.push(cp as u16);
            i += 2;
        } else if b0 < 0xF0 {
            if i + 2 >= bytes.len() {
                break;
            }
            let cp = (((b0 & 0x0F) as u32) << 12)
                | (((bytes[i + 1] & 0x3F) as u32) << 6)
                | (bytes[i + 2] & 0x3F) as u32;
            units.push(cp as u16); // BMP scalar or a lone surrogate half
            i += 3;
        } else {
            if i + 3 >= bytes.len() {
                break;
            }
            let cp = (((b0 & 0x07) as u32) << 18)
                | (((bytes[i + 1] & 0x3F) as u32) << 12)
                | (((bytes[i + 2] & 0x3F) as u32) << 6)
                | (bytes[i + 3] & 0x3F) as u32;
            // A genuine astral scalar → its surrogate pair (two code units).
            let v = cp - 0x10000;
            units.push((0xD800 + (v >> 10)) as u16);
            units.push((0xDC00 + (v & 0x3FF)) as u16);
            i += 4;
        }
    }
    units
}

/// Whether a Unicode scalar/code unit belongs to ECMAScript's exact
/// WhiteSpace or LineTerminator set. In particular U+FEFF is included and
/// U+0085 (which Rust's Unicode `trim` accepts) is not.
pub(super) fn is_ecma_whitespace(c: u32) -> bool {
    matches!(
        c,
        0x0009..=0x000D
            | 0x0020
            | 0x00A0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    )
}

pub(super) fn trim_ecma_whitespace(source: &str) -> &str {
    source.trim_matches(|c: char| is_ecma_whitespace(c as u32))
}
