//! Decoder for the XS script `symbols` atom (the `SYMB` payload the
//! oracle shim hands back alongside the bytecode).
//!
//! The interpreter resolves a variable/property name by its 16-bit symbol
//! **id**, but those ids are the XS compiler's *program-local* numbering,
//! assigned compactly per compilation (the first referenced name is id 1,
//! the next id 2, …). A built-in name like `Object` therefore has no fixed
//! id ironhorse could hard-code — it is whatever the compiler assigned it in
//! *this* program. The symbols atom is the id→name table that lets ironhorse
//! relink: bind the intrinsic named `Object` to the id the program uses
//! (design § test262 conformance — the corpus/oracle share one symbol
//! numbering, and ironhorse binds intrinsics against the program's).
//!
//! Wire format (little-endian, no atom header — the shim strips it):
//! a 2-byte count, then that-many-minus-one NUL-terminated CESU-8 strings
//! (id 0 is XS's reserved `XS_NO_ID`, so the first string is id 1). The
//! returned vector is indexed 0-based, so `names[k]` is the name of symbol
//! id `k + 1`.

/// Decode the symbols atom into `names`, where `names[k]` is the name of
/// symbol id `k + 1` (id 0 is `XS_NO_ID`, reserved). An empty or too-short
/// atom (a program that references no named symbols) yields an empty vector.
pub fn parse_symbols(atom: &[u8]) -> Vec<String> {
    // The leading 2-byte count is `distinct + 1` (it reserves id 0); we
    // read strings to the buffer end rather than trusting the count, so a
    // short or malformed buffer degrades to fewer names rather than panicking.
    if atom.len() < 2 {
        return Vec::new();
    }
    let mut names = Vec::new();
    let mut i = 2usize;
    let mut start = i;
    while i < atom.len() {
        if atom[i] == 0 {
            // Strings are CESU-8; `from_utf8_lossy` matches how the oracle
            // shim renders names for comparison (see `xs-oracle`).
            names.push(String::from_utf8_lossy(&atom[start..i]).into_owned());
            i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_symbol_is_id_one() {
        // `02 00 'O' 'b' 'j' 'e' 'c' 't' 00` — count 2 (id 0 reserved +
        // one real symbol), the name "Object" as id 1.
        let atom = [0x02, 0x00, b'O', b'b', b'j', b'e', b'c', b't', 0x00];
        let names = parse_symbols(&atom);
        assert_eq!(names, vec!["Object".to_string()]);
        // names[0] is id 1.
    }

    #[test]
    fn two_symbols_number_in_order() {
        // `03 00 'f' 'o' 'o' 00 'O' 'b' 'j' 'e' 'c' 't' 00`.
        let atom = [
            0x03, 0x00, b'f', b'o', b'o', 0x00, b'O', b'b', b'j', b'e', b'c', b't', 0x00,
        ];
        let names = parse_symbols(&atom);
        assert_eq!(names, vec!["foo".to_string(), "Object".to_string()]);
    }

    #[test]
    fn empty_atom_is_no_symbols() {
        assert!(parse_symbols(&[]).is_empty());
        assert!(parse_symbols(&[0x00]).is_empty());
        assert!(parse_symbols(&[0x02, 0x00]).is_empty());
    }
}
