//! Case canonicalization for the `i` flag — a port of
//! `fxCharCaseCanonicalize` (`xsre.c`) and the table it needs.
//!
//! This is the **non-`u`/`v`** path (`flag == 0` in the C function),
//! which folds via `gxCharCaseIgnore0`; the `u`/`v` fold tables
//! (`gxCharCaseFold0/1`) are part of the deferred unicode increment. For
//! ASCII this is exactly "map `a`..`z` to `A`..`Z`"; the table extends
//! that to the BMP letters XS folds. Astral (`> 0xFFFF`) code points do
//! not fold in the non-`u` path (they are a named skip anyway).

/// One `txCharCase` row: a run of `count` code points starting at `code`,
/// with a fold `operand` and `delta` (verbatim from the pin).
struct CharCase {
    code: u16,
    count: u8,
    operand: u8,
    delta: u16,
}

/// `gxCharCaseIgnore0` (xsre.c), the non-`u`/`v` canonicalization table,
/// transcribed verbatim from the pin. Sorted by `code`.
static IGNORE0: &[CharCase] = &[
    CharCase { code: 0x0061, count: 0x1A, operand: 0x80, delta: 0x0020 },
    CharCase { code: 0x00B5, count: 0x01, operand: 0x40, delta: 0x02E7 },
    CharCase { code: 0x00E0, count: 0x17, operand: 0x80, delta: 0x0020 },
    CharCase { code: 0x00F8, count: 0x07, operand: 0x80, delta: 0x0020 },
    CharCase { code: 0x00FF, count: 0x01, operand: 0x40, delta: 0x0079 },
    CharCase { code: 0x0101, count: 0x2F, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x0133, count: 0x05, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x013A, count: 0x0F, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x014B, count: 0x2D, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x017A, count: 0x05, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x0180, count: 0x01, operand: 0x40, delta: 0x00C3 },
    CharCase { code: 0x0183, count: 0x03, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x0188, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x018C, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x0192, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x0195, count: 0x01, operand: 0x40, delta: 0x0061 },
    CharCase { code: 0x0199, count: 0x01, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x019A, count: 0x01, operand: 0x40, delta: 0x00A3 },
    CharCase { code: 0x019B, count: 0x01, operand: 0x40, delta: 0xA641 },
    CharCase { code: 0x019E, count: 0x01, operand: 0x40, delta: 0x0082 },
    CharCase { code: 0x01A1, count: 0x05, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x01A8, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x01AD, count: 0x01, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x01B0, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x01B4, count: 0x03, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x01B9, count: 0x01, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x01BD, count: 0x01, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x01BF, count: 0x01, operand: 0x40, delta: 0x0038 },
    CharCase { code: 0x01C5, count: 0x01, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x01C6, count: 0x01, operand: 0x80, delta: 0x0002 },
    CharCase { code: 0x01C8, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x01C9, count: 0x01, operand: 0x80, delta: 0x0002 },
    CharCase { code: 0x01CB, count: 0x01, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x01CC, count: 0x01, operand: 0x80, delta: 0x0002 },
    CharCase { code: 0x01CE, count: 0x0F, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x01DD, count: 0x01, operand: 0x80, delta: 0x004F },
    CharCase { code: 0x01DF, count: 0x11, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x01F2, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x01F3, count: 0x01, operand: 0x80, delta: 0x0002 },
    CharCase { code: 0x01F5, count: 0x01, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x01F9, count: 0x27, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x0223, count: 0x11, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x023C, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x023F, count: 0x02, operand: 0x40, delta: 0x2A3F },
    CharCase { code: 0x0242, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x0247, count: 0x09, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x0250, count: 0x01, operand: 0x40, delta: 0x2A1F },
    CharCase { code: 0x0251, count: 0x01, operand: 0x40, delta: 0x2A1C },
    CharCase { code: 0x0252, count: 0x01, operand: 0x40, delta: 0x2A1E },
    CharCase { code: 0x0253, count: 0x01, operand: 0x80, delta: 0x00D2 },
    CharCase { code: 0x0254, count: 0x01, operand: 0x80, delta: 0x00CE },
    CharCase { code: 0x0256, count: 0x02, operand: 0x80, delta: 0x00CD },
    CharCase { code: 0x0259, count: 0x01, operand: 0x80, delta: 0x00CA },
    CharCase { code: 0x025B, count: 0x01, operand: 0x80, delta: 0x00CB },
    CharCase { code: 0x025C, count: 0x01, operand: 0x40, delta: 0xA54F },
    CharCase { code: 0x0260, count: 0x01, operand: 0x80, delta: 0x00CD },
    CharCase { code: 0x0261, count: 0x01, operand: 0x40, delta: 0xA54B },
    CharCase { code: 0x0263, count: 0x01, operand: 0x80, delta: 0x00CF },
    CharCase { code: 0x0264, count: 0x01, operand: 0x40, delta: 0xA567 },
    CharCase { code: 0x0265, count: 0x01, operand: 0x40, delta: 0xA528 },
    CharCase { code: 0x0266, count: 0x01, operand: 0x40, delta: 0xA544 },
    CharCase { code: 0x0268, count: 0x01, operand: 0x80, delta: 0x00D1 },
    CharCase { code: 0x0269, count: 0x01, operand: 0x80, delta: 0x00D3 },
    CharCase { code: 0x026A, count: 0x01, operand: 0x40, delta: 0xA544 },
    CharCase { code: 0x026B, count: 0x01, operand: 0x40, delta: 0x29F7 },
    CharCase { code: 0x026C, count: 0x01, operand: 0x40, delta: 0xA541 },
    CharCase { code: 0x026F, count: 0x01, operand: 0x80, delta: 0x00D3 },
    CharCase { code: 0x0271, count: 0x01, operand: 0x40, delta: 0x29FD },
    CharCase { code: 0x0272, count: 0x01, operand: 0x80, delta: 0x00D5 },
    CharCase { code: 0x0275, count: 0x01, operand: 0x80, delta: 0x00D6 },
    CharCase { code: 0x027D, count: 0x01, operand: 0x40, delta: 0x29E7 },
    CharCase { code: 0x0280, count: 0x01, operand: 0x80, delta: 0x00DA },
    CharCase { code: 0x0282, count: 0x01, operand: 0x40, delta: 0xA543 },
    CharCase { code: 0x0283, count: 0x01, operand: 0x80, delta: 0x00DA },
    CharCase { code: 0x0287, count: 0x01, operand: 0x40, delta: 0xA52A },
    CharCase { code: 0x0288, count: 0x01, operand: 0x80, delta: 0x00DA },
    CharCase { code: 0x0289, count: 0x01, operand: 0x80, delta: 0x0045 },
    CharCase { code: 0x028A, count: 0x02, operand: 0x80, delta: 0x00D9 },
    CharCase { code: 0x028C, count: 0x01, operand: 0x80, delta: 0x0047 },
    CharCase { code: 0x0292, count: 0x01, operand: 0x80, delta: 0x00DB },
    CharCase { code: 0x029D, count: 0x01, operand: 0x40, delta: 0xA515 },
    CharCase { code: 0x029E, count: 0x01, operand: 0x40, delta: 0xA512 },
    CharCase { code: 0x0345, count: 0x01, operand: 0x40, delta: 0x0054 },
    CharCase { code: 0x0371, count: 0x03, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x0377, count: 0x01, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x037B, count: 0x03, operand: 0x40, delta: 0x0082 },
    CharCase { code: 0x03AC, count: 0x01, operand: 0x80, delta: 0x0026 },
    CharCase { code: 0x03AD, count: 0x03, operand: 0x80, delta: 0x0025 },
    CharCase { code: 0x03B1, count: 0x11, operand: 0x80, delta: 0x0020 },
    CharCase { code: 0x03C2, count: 0x01, operand: 0x80, delta: 0x001F },
    CharCase { code: 0x03C3, count: 0x09, operand: 0x80, delta: 0x0020 },
    CharCase { code: 0x03CC, count: 0x01, operand: 0x80, delta: 0x0040 },
    CharCase { code: 0x03CD, count: 0x02, operand: 0x80, delta: 0x003F },
    CharCase { code: 0x03D0, count: 0x01, operand: 0x80, delta: 0x003E },
    CharCase { code: 0x03D1, count: 0x01, operand: 0x80, delta: 0x0039 },
    CharCase { code: 0x03D5, count: 0x01, operand: 0x80, delta: 0x002F },
    CharCase { code: 0x03D6, count: 0x01, operand: 0x80, delta: 0x0036 },
    CharCase { code: 0x03D7, count: 0x01, operand: 0x80, delta: 0x0008 },
    CharCase { code: 0x03D9, count: 0x17, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x03F0, count: 0x01, operand: 0x80, delta: 0x0056 },
    CharCase { code: 0x03F1, count: 0x01, operand: 0x80, delta: 0x0050 },
    CharCase { code: 0x03F2, count: 0x01, operand: 0x40, delta: 0x0007 },
    CharCase { code: 0x03F3, count: 0x01, operand: 0x80, delta: 0x0074 },
    CharCase { code: 0x03F5, count: 0x01, operand: 0x80, delta: 0x0060 },
    CharCase { code: 0x03F8, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x03FB, count: 0x01, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x0430, count: 0x20, operand: 0x80, delta: 0x0020 },
    CharCase { code: 0x0450, count: 0x10, operand: 0x80, delta: 0x0050 },
    CharCase { code: 0x0461, count: 0x21, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x048B, count: 0x35, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x04C2, count: 0x0D, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x04CF, count: 0x01, operand: 0x80, delta: 0x000F },
    CharCase { code: 0x04D1, count: 0x5F, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x0561, count: 0x26, operand: 0x80, delta: 0x0030 },
    CharCase { code: 0x10D0, count: 0x2B, operand: 0x40, delta: 0x0BC0 },
    CharCase { code: 0x10FD, count: 0x03, operand: 0x40, delta: 0x0BC0 },
    CharCase { code: 0x13F8, count: 0x06, operand: 0x80, delta: 0x0008 },
    CharCase { code: 0x1C80, count: 0x01, operand: 0x80, delta: 0x186E },
    CharCase { code: 0x1C81, count: 0x01, operand: 0x80, delta: 0x186D },
    CharCase { code: 0x1C82, count: 0x01, operand: 0x80, delta: 0x1864 },
    CharCase { code: 0x1C83, count: 0x02, operand: 0x80, delta: 0x1862 },
    CharCase { code: 0x1C85, count: 0x01, operand: 0x80, delta: 0x1863 },
    CharCase { code: 0x1C86, count: 0x01, operand: 0x80, delta: 0x185C },
    CharCase { code: 0x1C87, count: 0x01, operand: 0x80, delta: 0x1825 },
    CharCase { code: 0x1C88, count: 0x01, operand: 0x40, delta: 0x89C2 },
    CharCase { code: 0x1C8A, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x1D79, count: 0x01, operand: 0x40, delta: 0x8A04 },
    CharCase { code: 0x1D7D, count: 0x01, operand: 0x40, delta: 0x0EE6 },
    CharCase { code: 0x1D8E, count: 0x01, operand: 0x40, delta: 0x8A38 },
    CharCase { code: 0x1E01, count: 0x95, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x1E9B, count: 0x01, operand: 0x80, delta: 0x003B },
    CharCase { code: 0x1EA1, count: 0x5F, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x1F00, count: 0x08, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1F10, count: 0x06, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1F20, count: 0x08, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1F30, count: 0x08, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1F40, count: 0x06, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1F51, count: 0x01, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1F53, count: 0x01, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1F55, count: 0x01, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1F57, count: 0x01, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1F60, count: 0x08, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1F70, count: 0x02, operand: 0x40, delta: 0x004A },
    CharCase { code: 0x1F72, count: 0x04, operand: 0x40, delta: 0x0056 },
    CharCase { code: 0x1F76, count: 0x02, operand: 0x40, delta: 0x0064 },
    CharCase { code: 0x1F78, count: 0x02, operand: 0x40, delta: 0x0080 },
    CharCase { code: 0x1F7A, count: 0x02, operand: 0x40, delta: 0x0070 },
    CharCase { code: 0x1F7C, count: 0x02, operand: 0x40, delta: 0x007E },
    CharCase { code: 0x1F80, count: 0x08, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1F90, count: 0x08, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1FA0, count: 0x08, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1FB0, count: 0x02, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1FB3, count: 0x01, operand: 0x40, delta: 0x0009 },
    CharCase { code: 0x1FBE, count: 0x01, operand: 0x80, delta: 0x1C25 },
    CharCase { code: 0x1FC3, count: 0x01, operand: 0x40, delta: 0x0009 },
    CharCase { code: 0x1FD0, count: 0x02, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1FE0, count: 0x02, operand: 0x40, delta: 0x0008 },
    CharCase { code: 0x1FE5, count: 0x01, operand: 0x40, delta: 0x0007 },
    CharCase { code: 0x1FF3, count: 0x01, operand: 0x40, delta: 0x0009 },
    CharCase { code: 0x214E, count: 0x01, operand: 0x80, delta: 0x001C },
    CharCase { code: 0x2170, count: 0x10, operand: 0x80, delta: 0x0010 },
    CharCase { code: 0x2184, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x24D0, count: 0x1A, operand: 0x80, delta: 0x001A },
    CharCase { code: 0x2C30, count: 0x30, operand: 0x80, delta: 0x0030 },
    CharCase { code: 0x2C61, count: 0x01, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x2C65, count: 0x01, operand: 0x80, delta: 0x2A2B },
    CharCase { code: 0x2C66, count: 0x01, operand: 0x80, delta: 0x2A28 },
    CharCase { code: 0x2C68, count: 0x05, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x2C73, count: 0x01, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x2C76, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x2C81, count: 0x63, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x2CEC, count: 0x03, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0x2CF3, count: 0x01, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0x2D00, count: 0x26, operand: 0x80, delta: 0x1C60 },
    CharCase { code: 0x2D27, count: 0x01, operand: 0x80, delta: 0x1C60 },
    CharCase { code: 0x2D2D, count: 0x01, operand: 0x80, delta: 0x1C60 },
    CharCase { code: 0xA641, count: 0x2D, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0xA681, count: 0x1B, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0xA723, count: 0x0D, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0xA733, count: 0x3D, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0xA77A, count: 0x03, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0xA77F, count: 0x09, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0xA78C, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0xA791, count: 0x03, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0xA794, count: 0x01, operand: 0x40, delta: 0x0030 },
    CharCase { code: 0xA797, count: 0x13, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0xA7B5, count: 0x0F, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0xA7C8, count: 0x03, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0xA7CD, count: 0x0F, operand: 0x90, delta: 0x0001 },
    CharCase { code: 0xA7F6, count: 0x01, operand: 0xA0, delta: 0x0001 },
    CharCase { code: 0xAB53, count: 0x01, operand: 0x80, delta: 0x03A0 },
    CharCase { code: 0xAB70, count: 0x50, operand: 0x80, delta: 0x97D0 },
    CharCase { code: 0xFF41, count: 0x1A, operand: 0x80, delta: 0x0020 },
];

/// Port of `fxCharCaseCanonicalize(character, 0)`: the non-`u`/`v` fold.
/// Returns the canonical code point `character` folds to under the `i`
/// flag (itself if it does not fold).
pub fn canonicalize(character: i64) -> i64 {
    if character < 0 || character >= 0x1_0000 {
        // Astral does not fold in the non-`u` path (and is a named skip).
        return character;
    }
    let ch = character as u16;
    // Binary search for the row whose `[code, code+count)` run covers ch.
    let mut lo = 0usize;
    let mut hi = IGNORE0.len();
    let found = loop {
        if lo >= hi {
            break None;
        }
        let mid = (lo + hi) / 2;
        let it = &IGNORE0[mid];
        if (it.code as u32 + it.count as u32) <= ch as u32 {
            lo = mid + 1;
        } else if (ch as u32) < it.code as u32 {
            hi = mid;
        } else {
            break Some(it);
        }
    };
    if let Some(it) = found {
        let operand = it.operand;
        // Even-only / odd-only run guards (0x10 / 0x20).
        if (operand & 0x10) != 0 && (character & 1) == 0 {
            return character;
        }
        if (operand & 0x20) != 0 && (character & 1) != 0 {
            return character;
        }
        if operand & 0x40 != 0 {
            return character + it.delta as i64;
        } else if operand & 0x80 != 0 {
            return character - it.delta as i64;
        }
    }
    character
}
