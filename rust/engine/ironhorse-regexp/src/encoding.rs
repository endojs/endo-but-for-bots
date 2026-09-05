//! The subject/pattern byte codec, a faithful port of the XS CESU-8/UTF-8
//! helpers in `xsCommon.c` that `xsre.c` relies on.
//!
//! The matcher and the compiler both walk their inputs one *character*
//! at a time over a NUL-terminated byte string, exactly as XS does:
//! `fxUTF8Decode` decodes one encoded UTF-16 code unit, while
//! `fxCESU8Decode` combines a valid surrogate pair for `u`/`v` matching.
//! `fxFindCharacter` advances or retreats by one code unit normally and one
//! code point under `u`/`v`. Offsets remain byte offsets inside the matcher;
//! the VM maps them to ECMAScript UTF-16 indices at its boundary.

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

/// Port of `fxCESU8Decode`: decode one CESU-8 code point, combining a leading
/// surrogate followed immediately by a trailing surrogate. A lone surrogate
/// remains a standalone value and consumes only its own byte sequence.
pub fn cesu8_decode(bytes: &[u8], offset: usize) -> (i64, usize) {
    let (mut character, next) = utf8_decode(bytes, offset);
    if (0xD800..=0xDBFF).contains(&character) {
        let (surrogate, after) = utf8_decode(bytes, next);
        if (0xDC00..=0xDFFF).contains(&surrogate) {
            character = 0x10000 + ((character & 0x3FF) << 10) + (surrogate & 0x3FF);
            return (character, after);
        }
    }
    (character, next)
}

/// `c_read8`: byte at `offset`, or `0` at/after the terminating NUL (the
/// subject slice always carries a trailing NUL, mirroring an XS string).
#[inline]
fn read8(bytes: &[u8], offset: usize) -> u8 {
    bytes.get(offset).copied().unwrap_or(0)
}

/// Port of `fxFindCharacter`: move `offset` by one character in `direction`
/// (`+1` forward, `-1` backward). Normally that is one CESU-8 sequence (one
/// UTF-16 code unit); under `u`/`v`, a valid surrogate pair is one character.
pub fn find_character(bytes: &[u8], offset: usize, direction: i32, flags: u32) -> usize {
    use crate::flags::{XS_REGEXP_U, XS_REGEXP_V};

    if flags & (XS_REGEXP_U | XS_REGEXP_V) != 0 {
        if direction > 0 {
            return cesu8_decode(bytes, offset).1.min(bytes.len());
        }
        if offset == 0 {
            return 0;
        }
        let mut p = offset - 1;
        while p > 0 && read8(bytes, p) & 0xC0 == 0x80 {
            p -= 1;
        }
        let (character, _) = utf8_decode(bytes, p);
        if (0xDC00..=0xDFFF).contains(&character) && p > 0 {
            let mut q = p - 1;
            while q > 0 && read8(bytes, q) & 0xC0 == 0x80 {
                q -= 1;
            }
            let (former, _) = utf8_decode(bytes, q);
            if (0xD800..=0xDBFF).contains(&former) {
                p = q;
            }
        }
        return p;
    }

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
pub fn get_character(bytes: &[u8], offset: usize, flags: u32) -> i64 {
    use crate::flags::{XS_REGEXP_I, XS_REGEXP_U, XS_REGEXP_V};
    let unicode = flags & (XS_REGEXP_U | XS_REGEXP_V) != 0;
    let c = if unicode {
        cesu8_decode(bytes, offset).0
    } else {
        utf8_decode(bytes, offset).0
    };
    if flags & XS_REGEXP_I != 0 && c >= 0 {
        crate::charcase::canonicalize(c, unicode)
    } else {
        c
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flags::XS_REGEXP_U;

    const GRIN_CESU8: &[u8] = &[0xED, 0xA0, 0xBD, 0xED, 0xB8, 0x80];

    #[test]
    fn cesu8_decode_combines_only_valid_pairs() {
        assert_eq!(cesu8_decode(GRIN_CESU8, 0), (0x1F600, 6));
        assert_eq!(utf8_decode(GRIN_CESU8, 0), (0xD83D, 3));
        assert_eq!(cesu8_decode(&GRIN_CESU8[..3], 0), (0xD83D, 3));
    }

    #[test]
    fn find_character_observes_unicode_mode() {
        assert_eq!(find_character(GRIN_CESU8, 0, 1, 0), 3);
        assert_eq!(find_character(GRIN_CESU8, 3, 1, 0), 6);
        assert_eq!(find_character(GRIN_CESU8, 0, 1, XS_REGEXP_U), 6);
        assert_eq!(find_character(GRIN_CESU8, 6, -1, XS_REGEXP_U), 0);
        assert_eq!(find_character(GRIN_CESU8, 6, -1, 0), 3);
    }
}
