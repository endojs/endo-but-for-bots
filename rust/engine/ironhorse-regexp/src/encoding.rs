//! The subject/pattern byte codec, a faithful port of the XS UTF-8
//! helpers in `xsCommon.c` that `xsre.c` relies on.
//!
//! The matcher and the compiler both walk their inputs one *character*
//! at a time over a NUL-terminated byte string, exactly as XS does:
//! `fxUTF8Decode` decodes one code point, `fxFindCharacter` advances or
//! retreats by whole multi-byte sequences (skipping `0x80..=0xBF`
//! continuation bytes). We operate in the same UTF-8 byte-offset space
//! the C engine does (design's resolved question 6), so offsets compare
//! directly against the oracle shim with no UTF-16 conversion.
//!
//! Scope note (honest, per the stage bar): this is the **non-`u`/`v`**
//! codec — plain `fxUTF8Decode`, the branch `fxGetCharacter` takes when
//! `XS_REGEXP_UV` is clear. The `u`/`v` CESU-8 surrogate path and astral
//! (`> 0xFFFF`) handling are a named later increment.

/// XS `C_EOF` (`EOF`, `-1`): the sentinel `fxUTF8Decode` returns at the
/// terminating NUL.
pub const C_EOF: i64 = -1;

/// One entry of `gxUTF8Sequences` (xsCommon.c): a leading-byte class.
struct Utf8Sequence {
    size: i32,
    cmask: u32,
    cval: u32,
    lmask: u32,
}

/// `gxUTF8Sequences`, verbatim from the pin (xsCommon.c). The `shift`
/// field is derived (`(size - 1) * 6`) rather than stored.
const UTF8_SEQUENCES: [Utf8Sequence; 6] = [
    Utf8Sequence { size: 1, cmask: 0x80, cval: 0x00, lmask: 0x0000_007F },
    Utf8Sequence { size: 2, cmask: 0xE0, cval: 0xC0, lmask: 0x0000_07FF },
    Utf8Sequence { size: 3, cmask: 0xF0, cval: 0xE0, lmask: 0x0000_FFFF },
    Utf8Sequence { size: 4, cmask: 0xF8, cval: 0xF0, lmask: 0x001F_FFFF },
    Utf8Sequence { size: 5, cmask: 0xFC, cval: 0xF8, lmask: 0x03FF_FFFF },
    Utf8Sequence { size: 6, cmask: 0xFE, cval: 0xFC, lmask: 0x7FFF_FFFF },
];

/// Port of `fxUTF8Decode`: decode the code point at `bytes[offset]`,
/// returning `(character, next_offset)`. A leading NUL yields `C_EOF`
/// and leaves the offset one past the NUL (matching the C pointer
/// advance). Continuation bytes are combined without validation, exactly
/// as XS does (it treats the string as already-valid UTF-8).
pub fn utf8_decode(bytes: &[u8], offset: usize) -> (i64, usize) {
    let mut p = offset;
    let first = read8(bytes, p);
    p += 1;
    if first == 0 {
        return (C_EOF, p);
    }
    let mut c = first as u32;
    if c & 0x80 != 0 {
        let seq = UTF8_SEQUENCES
            .iter()
            .find(|s| (c & s.cmask) == s.cval)
            .unwrap_or(&UTF8_SEQUENCES[5]);
        let mut size = seq.size - 1;
        while size > 0 {
            size -= 1;
            c = (c << 6) | (read8(bytes, p) as u32 & 0x3F);
            p += 1;
        }
        c &= seq.lmask;
    }
    (c as i64, p)
}

/// Port of `fxUTF8Length`: the byte length one `character` encodes to.
/// (Part of the faithful codec surface; the V-mode string-set path that
/// consumes it is a named later increment.)
#[allow(dead_code)]
pub fn utf8_length(character: i64) -> usize {
    if character < 0 {
        0
    } else if character == 0 {
        2
    } else if character < 0x80 {
        1
    } else if character < 0x800 {
        2
    } else if character < 0x1_0000 {
        3
    } else if character < 0x11_0000 {
        4
    } else {
        0
    }
}

/// Port of `fxUTF8Encode`: append `character`'s UTF-8 bytes to `out`.
/// (Codec surface for the deferred V-mode string-set increment.)
#[allow(dead_code)]
pub fn utf8_encode(out: &mut Vec<u8>, character: i64) {
    let c = character as u32;
    if character < 0 {
    } else if character == 0 {
        out.push(0xC0);
        out.push(0x80);
    } else if character < 0x80 {
        out.push(c as u8);
    } else if character < 0x800 {
        out.push((0xC0 | (c >> 6)) as u8);
        out.push((0x80 | (c & 0x3F)) as u8);
    } else if character < 0x1_0000 {
        out.push((0xE0 | (c >> 12)) as u8);
        out.push((0x80 | ((c >> 6) & 0x3F)) as u8);
        out.push((0x80 | (c & 0x3F)) as u8);
    } else if character < 0x11_0000 {
        out.push((0xF0 | (c >> 18)) as u8);
        out.push((0x80 | ((c >> 12) & 0x3F)) as u8);
        out.push((0x80 | ((c >> 6) & 0x3F)) as u8);
        out.push((0x80 | (c & 0x3F)) as u8);
    }
}

/// `c_read8`: byte at `offset`, or `0` at/after the terminating NUL (the
/// subject slice always carries a trailing NUL, mirroring an XS string).
#[inline]
fn read8(bytes: &[u8], offset: usize) -> u8 {
    bytes.get(offset).copied().unwrap_or(0)
}

/// Port of `fxFindCharacter` (the non-`UV` branch): move `offset` by one
/// whole UTF-8 sequence in `direction` (`+1` forward, `-1` backward),
/// skipping continuation bytes (`(byte & 0xC0) == 0x80`).
pub fn find_character(bytes: &[u8], offset: usize, direction: i32) -> usize {
    let mut p = offset as i64 + direction as i64;
    loop {
        let c = if p < 0 { 0 } else { read8(bytes, p as usize) };
        if c == 0 || (c & 0xC0) != 0x80 {
            break;
        }
        p += direction as i64;
    }
    if p < 0 {
        0
    } else {
        p as usize
    }
}

/// Port of `fxGetCharacter` (the non-`UV` branch): decode the character
/// at `offset`, and — under the `i` flag — fold it to its canonical code
/// point (`fxCharCaseCanonicalize`), exactly as XS does before every
/// comparison in the match loop.
pub fn get_character(bytes: &[u8], offset: usize, flags: u32) -> i64 {
    let c = utf8_decode(bytes, offset).0;
    if flags & crate::flags::XS_REGEXP_I != 0 && c >= 0 {
        crate::charcase::canonicalize(c)
    } else {
        c
    }
}
