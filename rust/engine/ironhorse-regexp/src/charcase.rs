//! Case canonicalization for the `i` flag — a port of
//! `fxCharCaseCanonicalize` (`xsre.c`) and the two tables it needs.
//!
//! `fxCharCaseCanonicalize(character, flag)` has two modes. `flag == 0`
//! (the non-`u`/`v` path) folds via `gxCharCaseIgnore0`, mapping toward
//! the upper case (`a`..`z` -> `A`..`Z`); `flag == 1` (the `u`/`v` path)
//! folds via `gxCharCaseFold0`/`gxCharCaseFold1`, mapping toward the lower
//! case (`A`..`Z` -> `a`..`z`) and — unlike the non-`u` path — folding
//! astral (`>= 0x10000`) code points through `gxCharCaseFold1`. Both modes
//! share the same per-row operand/delta application; only the table (and
//! the astral branch) differ.

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

/// `gxCharCaseFold0` (xsre.c), the `u`/`v` (`flag == 1`) canonicalization
/// table for the BMP, transcribed verbatim from the pin. Sorted by `code`.
/// Where `gxCharCaseIgnore0` folds toward the upper case, this folds toward
/// the lower case (`A`..`Z` map to `a`..`z`), matching the unicode
/// case-folding the `u` flag applies.
static FOLD0: &[CharCase] = &[
    CharCase { code: 0x0041, count: 0x1A, operand: 0x40, delta: 0x0020 }, CharCase { code: 0x00B5, count: 0x01, operand: 0x40, delta: 0x0307 }, CharCase { code: 0x00C0, count: 0x17, operand: 0x40, delta: 0x0020 }, CharCase { code: 0x00D8, count: 0x07, operand: 0x40, delta: 0x0020 }, CharCase { code: 0x0100, count: 0x2F, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x0132, count: 0x05, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x0139, count: 0x0F, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x014A, count: 0x2D, operand: 0x60, delta: 0x0001 },
    CharCase { code: 0x0178, count: 0x01, operand: 0x80, delta: 0x0079 }, CharCase { code: 0x0179, count: 0x05, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x017F, count: 0x01, operand: 0x80, delta: 0x010C }, CharCase { code: 0x0181, count: 0x01, operand: 0x40, delta: 0x00D2 }, CharCase { code: 0x0182, count: 0x03, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x0186, count: 0x01, operand: 0x40, delta: 0x00CE }, CharCase { code: 0x0187, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x0189, count: 0x02, operand: 0x40, delta: 0x00CD },
    CharCase { code: 0x018B, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x018E, count: 0x01, operand: 0x40, delta: 0x004F }, CharCase { code: 0x018F, count: 0x01, operand: 0x40, delta: 0x00CA }, CharCase { code: 0x0190, count: 0x01, operand: 0x40, delta: 0x00CB }, CharCase { code: 0x0191, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x0193, count: 0x01, operand: 0x40, delta: 0x00CD }, CharCase { code: 0x0194, count: 0x01, operand: 0x40, delta: 0x00CF }, CharCase { code: 0x0196, count: 0x01, operand: 0x40, delta: 0x00D3 },
    CharCase { code: 0x0197, count: 0x01, operand: 0x40, delta: 0x00D1 }, CharCase { code: 0x0198, count: 0x01, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x019C, count: 0x01, operand: 0x40, delta: 0x00D3 }, CharCase { code: 0x019D, count: 0x01, operand: 0x40, delta: 0x00D5 }, CharCase { code: 0x019F, count: 0x01, operand: 0x40, delta: 0x00D6 }, CharCase { code: 0x01A0, count: 0x05, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x01A6, count: 0x01, operand: 0x40, delta: 0x00DA }, CharCase { code: 0x01A7, count: 0x01, operand: 0x50, delta: 0x0001 },
    CharCase { code: 0x01A9, count: 0x01, operand: 0x40, delta: 0x00DA }, CharCase { code: 0x01AC, count: 0x01, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x01AE, count: 0x01, operand: 0x40, delta: 0x00DA }, CharCase { code: 0x01AF, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x01B1, count: 0x02, operand: 0x40, delta: 0x00D9 }, CharCase { code: 0x01B3, count: 0x03, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x01B7, count: 0x01, operand: 0x40, delta: 0x00DB }, CharCase { code: 0x01B8, count: 0x01, operand: 0x60, delta: 0x0001 },
    CharCase { code: 0x01BC, count: 0x01, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x01C4, count: 0x01, operand: 0x40, delta: 0x0002 }, CharCase { code: 0x01C5, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x01C7, count: 0x01, operand: 0x40, delta: 0x0002 }, CharCase { code: 0x01C8, count: 0x01, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x01CA, count: 0x01, operand: 0x40, delta: 0x0002 }, CharCase { code: 0x01CB, count: 0x11, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x01DE, count: 0x11, operand: 0x60, delta: 0x0001 },
    CharCase { code: 0x01F1, count: 0x01, operand: 0x40, delta: 0x0002 }, CharCase { code: 0x01F2, count: 0x03, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x01F6, count: 0x01, operand: 0x80, delta: 0x0061 }, CharCase { code: 0x01F7, count: 0x01, operand: 0x80, delta: 0x0038 }, CharCase { code: 0x01F8, count: 0x27, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x0220, count: 0x01, operand: 0x80, delta: 0x0082 }, CharCase { code: 0x0222, count: 0x11, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x023A, count: 0x01, operand: 0x40, delta: 0x2A2B },
    CharCase { code: 0x023B, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x023D, count: 0x01, operand: 0x80, delta: 0x00A3 }, CharCase { code: 0x023E, count: 0x01, operand: 0x40, delta: 0x2A28 }, CharCase { code: 0x0241, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x0243, count: 0x01, operand: 0x80, delta: 0x00C3 }, CharCase { code: 0x0244, count: 0x01, operand: 0x40, delta: 0x0045 }, CharCase { code: 0x0245, count: 0x01, operand: 0x40, delta: 0x0047 }, CharCase { code: 0x0246, count: 0x09, operand: 0x60, delta: 0x0001 },
    CharCase { code: 0x0345, count: 0x01, operand: 0x40, delta: 0x0074 }, CharCase { code: 0x0370, count: 0x03, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x0376, count: 0x01, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x037F, count: 0x01, operand: 0x40, delta: 0x0074 }, CharCase { code: 0x0386, count: 0x01, operand: 0x40, delta: 0x0026 }, CharCase { code: 0x0388, count: 0x03, operand: 0x40, delta: 0x0025 }, CharCase { code: 0x038C, count: 0x01, operand: 0x40, delta: 0x0040 }, CharCase { code: 0x038E, count: 0x02, operand: 0x40, delta: 0x003F },
    CharCase { code: 0x0391, count: 0x11, operand: 0x40, delta: 0x0020 }, CharCase { code: 0x03A3, count: 0x09, operand: 0x40, delta: 0x0020 }, CharCase { code: 0x03C2, count: 0x01, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x03CF, count: 0x01, operand: 0x40, delta: 0x0008 }, CharCase { code: 0x03D0, count: 0x01, operand: 0x80, delta: 0x001E }, CharCase { code: 0x03D1, count: 0x01, operand: 0x80, delta: 0x0019 }, CharCase { code: 0x03D5, count: 0x01, operand: 0x80, delta: 0x000F }, CharCase { code: 0x03D6, count: 0x01, operand: 0x80, delta: 0x0016 },
    CharCase { code: 0x03D8, count: 0x17, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x03F0, count: 0x01, operand: 0x80, delta: 0x0036 }, CharCase { code: 0x03F1, count: 0x01, operand: 0x80, delta: 0x0030 }, CharCase { code: 0x03F4, count: 0x01, operand: 0x80, delta: 0x003C }, CharCase { code: 0x03F5, count: 0x01, operand: 0x80, delta: 0x0040 }, CharCase { code: 0x03F7, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x03F9, count: 0x01, operand: 0x80, delta: 0x0007 }, CharCase { code: 0x03FA, count: 0x01, operand: 0x60, delta: 0x0001 },
    CharCase { code: 0x03FD, count: 0x03, operand: 0x80, delta: 0x0082 }, CharCase { code: 0x0400, count: 0x10, operand: 0x40, delta: 0x0050 }, CharCase { code: 0x0410, count: 0x20, operand: 0x40, delta: 0x0020 }, CharCase { code: 0x0460, count: 0x21, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x048A, count: 0x35, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x04C0, count: 0x01, operand: 0x40, delta: 0x000F }, CharCase { code: 0x04C1, count: 0x0D, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x04D0, count: 0x5F, operand: 0x60, delta: 0x0001 },
    CharCase { code: 0x0531, count: 0x26, operand: 0x40, delta: 0x0030 }, CharCase { code: 0x10A0, count: 0x26, operand: 0x40, delta: 0x1C60 }, CharCase { code: 0x10C7, count: 0x01, operand: 0x40, delta: 0x1C60 }, CharCase { code: 0x10CD, count: 0x01, operand: 0x40, delta: 0x1C60 }, CharCase { code: 0x13F8, count: 0x06, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1C80, count: 0x01, operand: 0x80, delta: 0x184E }, CharCase { code: 0x1C81, count: 0x01, operand: 0x80, delta: 0x184D }, CharCase { code: 0x1C82, count: 0x01, operand: 0x80, delta: 0x1844 },
    CharCase { code: 0x1C83, count: 0x02, operand: 0x80, delta: 0x1842 }, CharCase { code: 0x1C85, count: 0x01, operand: 0x80, delta: 0x1843 }, CharCase { code: 0x1C86, count: 0x01, operand: 0x80, delta: 0x183C }, CharCase { code: 0x1C87, count: 0x01, operand: 0x80, delta: 0x1824 }, CharCase { code: 0x1C88, count: 0x01, operand: 0x40, delta: 0x89C3 }, CharCase { code: 0x1C89, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x1C90, count: 0x2B, operand: 0x80, delta: 0x0BC0 }, CharCase { code: 0x1CBD, count: 0x03, operand: 0x80, delta: 0x0BC0 },
    CharCase { code: 0x1E00, count: 0x95, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x1E9B, count: 0x01, operand: 0x80, delta: 0x003A }, CharCase { code: 0x1E9E, count: 0x01, operand: 0x80, delta: 0x1DBF }, CharCase { code: 0x1EA0, count: 0x5F, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x1F08, count: 0x08, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1F18, count: 0x06, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1F28, count: 0x08, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1F38, count: 0x08, operand: 0x80, delta: 0x0008 },
    CharCase { code: 0x1F48, count: 0x06, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1F59, count: 0x01, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1F5B, count: 0x01, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1F5D, count: 0x01, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1F5F, count: 0x01, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1F68, count: 0x08, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1F88, count: 0x08, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1F98, count: 0x08, operand: 0x80, delta: 0x0008 },
    CharCase { code: 0x1FA8, count: 0x08, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1FB8, count: 0x02, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1FBA, count: 0x02, operand: 0x80, delta: 0x004A }, CharCase { code: 0x1FBC, count: 0x01, operand: 0x80, delta: 0x0009 }, CharCase { code: 0x1FBE, count: 0x01, operand: 0x80, delta: 0x1C05 }, CharCase { code: 0x1FC8, count: 0x04, operand: 0x80, delta: 0x0056 }, CharCase { code: 0x1FCC, count: 0x01, operand: 0x80, delta: 0x0009 }, CharCase { code: 0x1FD3, count: 0x01, operand: 0x80, delta: 0x1C43 },
    CharCase { code: 0x1FD8, count: 0x02, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1FDA, count: 0x02, operand: 0x80, delta: 0x0064 }, CharCase { code: 0x1FE3, count: 0x01, operand: 0x80, delta: 0x1C33 }, CharCase { code: 0x1FE8, count: 0x02, operand: 0x80, delta: 0x0008 }, CharCase { code: 0x1FEA, count: 0x02, operand: 0x80, delta: 0x0070 }, CharCase { code: 0x1FEC, count: 0x01, operand: 0x80, delta: 0x0007 }, CharCase { code: 0x1FF8, count: 0x02, operand: 0x80, delta: 0x0080 }, CharCase { code: 0x1FFA, count: 0x02, operand: 0x80, delta: 0x007E },
    CharCase { code: 0x1FFC, count: 0x01, operand: 0x80, delta: 0x0009 }, CharCase { code: 0x2126, count: 0x01, operand: 0x80, delta: 0x1D5D }, CharCase { code: 0x212A, count: 0x01, operand: 0x80, delta: 0x20BF }, CharCase { code: 0x212B, count: 0x01, operand: 0x80, delta: 0x2046 }, CharCase { code: 0x2132, count: 0x01, operand: 0x40, delta: 0x001C }, CharCase { code: 0x2160, count: 0x10, operand: 0x40, delta: 0x0010 }, CharCase { code: 0x2183, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x24B6, count: 0x1A, operand: 0x40, delta: 0x001A },
    CharCase { code: 0x2C00, count: 0x30, operand: 0x40, delta: 0x0030 }, CharCase { code: 0x2C60, count: 0x01, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x2C62, count: 0x01, operand: 0x80, delta: 0x29F7 }, CharCase { code: 0x2C63, count: 0x01, operand: 0x80, delta: 0x0EE6 }, CharCase { code: 0x2C64, count: 0x01, operand: 0x80, delta: 0x29E7 }, CharCase { code: 0x2C67, count: 0x05, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x2C6D, count: 0x01, operand: 0x80, delta: 0x2A1C }, CharCase { code: 0x2C6E, count: 0x01, operand: 0x80, delta: 0x29FD },
    CharCase { code: 0x2C6F, count: 0x01, operand: 0x80, delta: 0x2A1F }, CharCase { code: 0x2C70, count: 0x01, operand: 0x80, delta: 0x2A1E }, CharCase { code: 0x2C72, count: 0x01, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x2C75, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x2C7E, count: 0x02, operand: 0x80, delta: 0x2A3F }, CharCase { code: 0x2C80, count: 0x63, operand: 0x60, delta: 0x0001 }, CharCase { code: 0x2CEB, count: 0x03, operand: 0x50, delta: 0x0001 }, CharCase { code: 0x2CF2, count: 0x01, operand: 0x60, delta: 0x0001 },
    CharCase { code: 0xA640, count: 0x2D, operand: 0x60, delta: 0x0001 }, CharCase { code: 0xA680, count: 0x1B, operand: 0x60, delta: 0x0001 }, CharCase { code: 0xA722, count: 0x0D, operand: 0x60, delta: 0x0001 }, CharCase { code: 0xA732, count: 0x3D, operand: 0x60, delta: 0x0001 }, CharCase { code: 0xA779, count: 0x03, operand: 0x50, delta: 0x0001 }, CharCase { code: 0xA77D, count: 0x01, operand: 0x80, delta: 0x8A04 }, CharCase { code: 0xA77E, count: 0x09, operand: 0x60, delta: 0x0001 }, CharCase { code: 0xA78B, count: 0x01, operand: 0x50, delta: 0x0001 },
    CharCase { code: 0xA78D, count: 0x01, operand: 0x80, delta: 0xA528 }, CharCase { code: 0xA790, count: 0x03, operand: 0x60, delta: 0x0001 }, CharCase { code: 0xA796, count: 0x13, operand: 0x60, delta: 0x0001 }, CharCase { code: 0xA7AA, count: 0x01, operand: 0x80, delta: 0xA544 }, CharCase { code: 0xA7AB, count: 0x01, operand: 0x80, delta: 0xA54F }, CharCase { code: 0xA7AC, count: 0x01, operand: 0x80, delta: 0xA54B }, CharCase { code: 0xA7AD, count: 0x01, operand: 0x80, delta: 0xA541 }, CharCase { code: 0xA7AE, count: 0x01, operand: 0x80, delta: 0xA544 },
    CharCase { code: 0xA7B0, count: 0x01, operand: 0x80, delta: 0xA512 }, CharCase { code: 0xA7B1, count: 0x01, operand: 0x80, delta: 0xA52A }, CharCase { code: 0xA7B2, count: 0x01, operand: 0x80, delta: 0xA515 }, CharCase { code: 0xA7B3, count: 0x01, operand: 0x40, delta: 0x03A0 }, CharCase { code: 0xA7B4, count: 0x0F, operand: 0x60, delta: 0x0001 }, CharCase { code: 0xA7C4, count: 0x01, operand: 0x80, delta: 0x0030 }, CharCase { code: 0xA7C5, count: 0x01, operand: 0x80, delta: 0xA543 }, CharCase { code: 0xA7C6, count: 0x01, operand: 0x80, delta: 0x8A38 },
    CharCase { code: 0xA7C7, count: 0x03, operand: 0x50, delta: 0x0001 }, CharCase { code: 0xA7CB, count: 0x01, operand: 0x80, delta: 0xA567 }, CharCase { code: 0xA7CC, count: 0x0F, operand: 0x60, delta: 0x0001 }, CharCase { code: 0xA7DC, count: 0x01, operand: 0x80, delta: 0xA641 }, CharCase { code: 0xA7F5, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0xAB70, count: 0x50, operand: 0x80, delta: 0x97D0 }, CharCase { code: 0xFB05, count: 0x01, operand: 0x50, delta: 0x0001 }, CharCase { code: 0xFF21, count: 0x1A, operand: 0x40, delta: 0x0020 },
];

/// `gxCharCaseFold1` (xsre.c), the `u`/`v` fold table for the astral planes.
/// A code point `>= 0x10000` is looked up by its low 16 bits (`character &
/// 0xFFFF`), and the delta is applied to the whole scalar — exactly the
/// XS behavior (`fxCharCaseCanonicalize`, the `character < 0x10000` else
/// branch), false-positives across planes and all.
static FOLD1: &[CharCase] = &[
    CharCase { code: 0x0400, count: 0x28, operand: 0x40, delta: 0x0028 }, CharCase { code: 0x04B0, count: 0x24, operand: 0x40, delta: 0x0028 }, CharCase { code: 0x0570, count: 0x0B, operand: 0x40, delta: 0x0027 }, CharCase { code: 0x057C, count: 0x0F, operand: 0x40, delta: 0x0027 }, CharCase { code: 0x058C, count: 0x07, operand: 0x40, delta: 0x0027 }, CharCase { code: 0x0594, count: 0x02, operand: 0x40, delta: 0x0027 }, CharCase { code: 0x0C80, count: 0x33, operand: 0x40, delta: 0x0040 }, CharCase { code: 0x0D50, count: 0x16, operand: 0x40, delta: 0x0020 },
    CharCase { code: 0x18A0, count: 0x20, operand: 0x40, delta: 0x0020 }, CharCase { code: 0x6E40, count: 0x20, operand: 0x40, delta: 0x0020 }, CharCase { code: 0x6EA0, count: 0x19, operand: 0x40, delta: 0x001B }, CharCase { code: 0xE900, count: 0x22, operand: 0x40, delta: 0x0022 },
];

/// Binary search a `txCharCase` table for the row whose `[code, code+count)`
/// run covers `ch` (`fxCharCaseCompare` + `c_bsearch`).
fn find_row(table: &[CharCase], ch: u16) -> Option<&CharCase> {
    let mut lo = 0usize;
    let mut hi = table.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        let it = &table[mid];
        if (it.code as u32 + it.count as u32) <= ch as u32 {
            lo = mid + 1;
        } else if (ch as u32) < it.code as u32 {
            hi = mid;
        } else {
            return Some(it);
        }
    }
    None
}

/// Apply a matched row's operand/delta to `character`
/// (`fxCharCaseCanonicalize`, the `if (it)` tail).
fn apply_row(character: i64, it: &CharCase) -> i64 {
    let operand = it.operand;
    // Even-only / odd-only run guards (0x10 / 0x20).
    if (operand & 0x10) != 0 && (character & 1) == 0 {
        return character;
    }
    if (operand & 0x20) != 0 && (character & 1) != 0 {
        return character;
    }
    if operand & 0x40 != 0 {
        character + it.delta as i64
    } else if operand & 0x80 != 0 {
        character - it.delta as i64
    } else {
        character
    }
}

/// Port of `fxCharCaseCanonicalize(character, flag)`. Returns the canonical
/// code point `character` folds to under the `i` flag (itself if it does not
/// fold). `fold` selects the table: `false` is the non-`u`/`v` `Ignore0`
/// fold (upper-ward, BMP only); `true` is the `u`/`v` `Fold0`/`Fold1` fold
/// (lower-ward, and astral through `Fold1`).
pub fn canonicalize(character: i64, fold: bool) -> i64 {
    if character < 0 {
        return character;
    }
    let found = if character < 0x1_0000 {
        find_row(if fold { FOLD0 } else { IGNORE0 }, character as u16)
    } else if fold {
        // `u`/`v`: astral is looked up by its low 16 bits in `Fold1`; the
        // non-`u` path never folds astral (`it = C_NULL`).
        find_row(FOLD1, (character & 0xFFFF) as u16)
    } else {
        None
    };
    match found {
        Some(it) => apply_row(character, it),
        None => character,
    }
}
