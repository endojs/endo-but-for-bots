use ironhorse_unicode::{is_identifier_first, is_identifier_next};

#[test]
fn identifier_boundaries() {
    for c in ['$' as u32, '_' as u32, 'A' as u32, 'z' as u32, 0x10400] {
        assert!(is_identifier_first(c), "start U+{c:04X}");
        assert!(is_identifier_next(c), "continue U+{c:04X}");
    }
    for c in [
        '0' as u32, '9' as u32, 0x300, 0x200c, 0x200d, 0xe0100, 0xe01ef,
    ] {
        assert!(!is_identifier_first(c), "start U+{c:04X}");
        assert!(is_identifier_next(c), "continue U+{c:04X}");
    }
    // The variation-selector supplement is the out-of-table trailing range.
    for c in [
        0,
        0x20,
        0x40,
        0x5b,
        0xd800,
        0xdfff,
        0xe00ff,
        0xe01f0,
        0x10ffff,
        0x110000,
        u32::MAX,
    ] {
        assert!(!is_identifier_first(c), "start U+{c:04X}");
        assert!(!is_identifier_next(c), "continue U+{c:04X}");
    }
}

#[test]
fn full_domain_matches_pre_extraction_classification() {
    // Frozen from c250cf311's regexp/unicode.rs, before the leaf-crate move.
    // Each code point contributes the two verdict bits to FNV-1a in order.
    // This is independent of the delta-table representation and includes gaps,
    // surrogate code points, and the explicit trailing continuation range.
    let mut hash = 0xcbf29ce484222325u64;
    let mut counts = [0usize; 2];
    for c in 0..=0x10ffff {
        let first = is_identifier_first(c);
        let next = is_identifier_next(c);
        counts[0] += usize::from(first);
        counts[1] += usize::from(next);
        hash = (hash ^ (u64::from(first) | (u64::from(next) << 1))).wrapping_mul(0x100000001b3);
    }
    assert_eq!(counts, [145918, 149241]);
    assert_eq!(hash, 0x068123ca24dabc63);
}
