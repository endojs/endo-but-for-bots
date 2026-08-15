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
//! Scope note: XS's `u`/`v` codec (`mxStringByteDecode` = `fxCESU8Decode`,
//! and the `XS_REGEXP_UV` branches of `fxFindCharacter`/`fxGetCharacter`)
//! differs from the plain path only when the bytes encode a surrogate as its
//! own sub-sequence (CESU-8) — which a well-formed UTF-8 subject never does.
//! For every input this engine is actually fed, the `u`/`v` decode and the
//! plain decode yield the identical scalar and the identical byte stride, so
//! [`find_character`] needs no `UV` branch and [`get_character`] differs only
//! in which case-fold table the `i` flag consults.

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
    Utf8Sequence {
        size: 1,
        cmask: 0x80,
        cval: 0x00,
        lmask: 0x0000_007F,
    },
    Utf8Sequence {
        size: 2,
        cmask: 0xE0,
        cval: 0xC0,
        lmask: 0x0000_07FF,
    },
    Utf8Sequence {
        size: 3,
        cmask: 0xF0,
        cval: 0xE0,
        lmask: 0x0000_FFFF,
    },
    Utf8Sequence {
        size: 4,
        cmask: 0xF8,
        cval: 0xF0,
        lmask: 0x001F_FFFF,
    },
    Utf8Sequence {
        size: 5,
        cmask: 0xFC,
        cval: 0xF8,
        lmask: 0x03FF_FFFF,
    },
    Utf8Sequence {
        size: 6,
        cmask: 0xFE,
        cval: 0xFC,
        lmask: 0x7FFF_FFFF,
    },
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

/// Port of `fxGetCharacter`: decode the character at `offset`, and — under
/// the `i` flag — fold it to its canonical code point
/// (`fxCharCaseCanonicalize`), exactly as XS does before every comparison in
/// the match loop. The fold table is selected by `u`/`v` (`flag == 1` in XS):
/// the `u`/`v` path folds lower-ward and folds astral, the plain `i` path
/// folds upper-ward over the BMP only.
///
/// For a well-formed UTF-8 subject (all this engine is fed), the `u`/`v`
/// CESU-8 decode (`mxStringByteDecode`) and the plain `fxUTF8Decode` produce
/// the identical scalar — a lone/paired surrogate byte sequence cannot occur
/// — so the codec branch collapses to one `utf8_decode`; only the fold table
/// differs between the two modes.
pub fn get_character(bytes: &[u8], offset: usize, flags: u32) -> i64 {
    use crate::flags::{XS_REGEXP_I, XS_REGEXP_U, XS_REGEXP_V};
    let c = utf8_decode(bytes, offset).0;
    if flags & XS_REGEXP_I != 0 && c >= 0 {
        let fold = flags & (XS_REGEXP_U | XS_REGEXP_V) != 0;
        crate::charcase::canonicalize(c, fold)
    } else {
        c
    }
}
