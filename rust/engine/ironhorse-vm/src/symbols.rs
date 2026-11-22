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

pub use ironhorse_text::SymbolName;

/// The name-to-id map, plus a [`SymbolIds::stamp`] that changes whenever
/// the map may have changed, plus a derived index of the names that are the
/// decimal spelling of a `u32` (see [`SymbolIds::get_index`]).
#[derive(Clone)]
pub(crate) struct SymbolIds(
    std::collections::HashMap<SymbolName, u16>,
    u64,
    std::collections::BTreeMap<u32, u16>,
);

/// A process-wide source of [`SymbolIds::stamp`] values. Every possible
/// mutation takes a fresh one, so two maps (or one map at two times) share a
/// stamp only when one is an unmodified copy of the other. The value is never
/// persisted or otherwise observable; only stamp equality is consulted.
fn fresh_symbol_ids_stamp() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// The `u32` whose `to_string()` is exactly `name`, if any: ASCII digits, no
/// leading zero unless the whole name is `0`, and in range. This is a
/// bijection between such names and `u32` values, so a lookup of
/// `index.to_string()` and a lookup of `index` here find the same entry.
fn decimal_u32_name(name: &SymbolName) -> Option<u32> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || (bytes.len() > 1 && bytes[0] == b'0') {
        return None;
    }
    let mut value: u64 = 0;
    for &b in bytes {
        if !b.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u64::from(b - b'0');
    }
    u32::try_from(value).ok()
}

impl Default for SymbolIds {
    fn default() -> Self {
        Self(
            Default::default(),
            fresh_symbol_ids_stamp(),
            Default::default(),
        )
    }
}

/// A name to look up in [`SymbolIds`], probed by its CESU-8 bytes: a
/// [`SymbolName`] lends its own, and most text lends its UTF-8, which is the
/// same bytes (see [`SymbolName::cesu8_of_str`]). Building the key name for
/// every probe, as an `Into<SymbolName>` argument does, costs one to three
/// heap allocations per lookup on the property paths that resolve names.
pub(crate) trait SymbolLookup {
    fn with_cesu8<R>(self, probe: impl FnOnce(&[u8]) -> R) -> R;
}

impl SymbolLookup for &SymbolName {
    #[inline]
    fn with_cesu8<R>(self, probe: impl FnOnce(&[u8]) -> R) -> R {
        probe(self.as_bytes())
    }
}

impl SymbolLookup for SymbolName {
    #[inline]
    fn with_cesu8<R>(self, probe: impl FnOnce(&[u8]) -> R) -> R {
        probe(self.as_bytes())
    }
}

impl SymbolLookup for &str {
    #[inline]
    fn with_cesu8<R>(self, probe: impl FnOnce(&[u8]) -> R) -> R {
        match SymbolName::cesu8_of_str(self) {
            Some(bytes) => probe(bytes),
            None => probe(SymbolName::from(self).as_bytes()),
        }
    }
}

impl SymbolLookup for &String {
    #[inline]
    fn with_cesu8<R>(self, probe: impl FnOnce(&[u8]) -> R) -> R {
        self.as_str().with_cesu8(probe)
    }
}

impl SymbolLookup for String {
    #[inline]
    fn with_cesu8<R>(self, probe: impl FnOnce(&[u8]) -> R) -> R {
        self.as_str().with_cesu8(probe)
    }
}

impl SymbolLookup for &Vec<u16> {
    #[inline]
    fn with_cesu8<R>(self, probe: impl FnOnce(&[u8]) -> R) -> R {
        probe(SymbolName::from_units(self).as_bytes())
    }
}

impl SymbolLookup for Vec<u16> {
    #[inline]
    fn with_cesu8<R>(self, probe: impl FnOnce(&[u8]) -> R) -> R {
        probe(SymbolName::from_units(&self).as_bytes())
    }
}

impl SymbolIds {
    /// The id of `name`. The map is probed with the name's bytes, which
    /// `SymbolName` hashes and compares as (its `Borrow<[u8]>`), so the answer
    /// is the one a probe with a built `SymbolName` gives.
    pub fn get(&self, name: impl SymbolLookup) -> Option<&u16> {
        name.with_cesu8(|bytes| self.0.get(bytes))
    }
    /// `self.get(index.to_string())` without building the name: the id of
    /// the name spelling `index` in decimal, if one is interned. The derived
    /// table is maintained by every mutation below (there is no removal), is
    /// empty in most programs, and is never persisted: a restored machine
    /// re-inserts its names and so rebuilds it.
    #[inline]
    pub fn get_index(&self, index: u32) -> Option<&u16> {
        if self.2.is_empty() {
            return None;
        }
        self.2.get(&index)
    }
    pub fn contains_key(&self, name: impl SymbolLookup) -> bool {
        self.get(name).is_some()
    }
    pub fn insert(&mut self, name: impl Into<SymbolName>, id: u16) -> Option<u16> {
        self.1 = fresh_symbol_ids_stamp();
        let name = name.into();
        if let Some(index) = decimal_u32_name(&name) {
            self.2.insert(index, id);
        }
        self.0.insert(name, id)
    }
    /// Bind `name` to `id` unless it is already bound (the first binding
    /// wins). Counts as a mutation whether or not it inserts.
    pub fn insert_if_absent(&mut self, name: SymbolName, id: u16) {
        self.1 = fresh_symbol_ids_stamp();
        if let std::collections::hash_map::Entry::Vacant(entry) = self.0.entry(name) {
            if let Some(index) = decimal_u32_name(entry.key()) {
                self.2.insert(index, id);
            }
            entry.insert(id);
        }
    }
    /// Equal stamps mean an unchanged map: a derived cache keyed on this
    /// stamp stays valid exactly while no name has been added or rebound.
    pub fn stamp(&self) -> u64 {
        self.1
    }
}

/// Decode trusted symbols for tooling. Malformed atoms produce no names.
/// Use `parse_symbols_checked` at execution boundaries to report malformed input.
pub fn parse_symbols(atom: &[u8]) -> Vec<SymbolName> {
    parse_symbols_checked(atom).unwrap_or_default()
}

/// Decode a complete XS symbol atom without replacing any code unit.
pub fn parse_symbols_checked(atom: &[u8]) -> Result<Vec<SymbolName>, crate::Halt> {
    let invalid = || crate::Halt::Decode(crate::DecodeError::InvalidSymbols);
    if atom.is_empty() {
        return Ok(Vec::new());
    }
    let header: [u8; 2] = atom
        .get(..2)
        .ok_or_else(invalid)?
        .try_into()
        .map_err(|_| invalid())?;
    let count = u16::from_le_bytes(header)
        .checked_sub(1)
        .ok_or_else(invalid)? as usize;
    let mut names = Vec::new();
    let mut rest = &atom[2..];
    for _ in 0..count {
        let end = rest.iter().position(|&b| b == 0).ok_or_else(invalid)?;
        names.push(SymbolName::from_cesu8(&rest[..end]).ok_or_else(invalid)?);
        rest = &rest[end + 1..];
    }
    if !rest.is_empty() {
        return Err(invalid());
    }
    Ok(names)
}

pub(crate) fn decode_refusal(halt: crate::Halt) -> crate::RunOutcome {
    crate::RunOutcome {
        unhandled_rejection: None,
        meter_raw_this_run: 0,
        computrons_this_run: 0,
        dispatched_this_run: 0,
        completed: false,
        result: String::new(),
        coercion_error: None,
        host_render_halt: None,
        computrons: 0,
        dispatched: 0,
        meter_raw: 0,
        halt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_table_matches_decimal_name_lookups() {
        let mut ids = SymbolIds::default();
        let names = [
            "0",
            "00",
            "01",
            "1",
            "7",
            "42",
            "4294967295",
            "4294967296",
            "99999999999",
            "-1",
            "+1",
            "1e3",
            "1.0",
            " 1",
            "x",
            "",
            "\u{0660}",
        ];
        for (k, name) in names.iter().enumerate() {
            ids.insert(*name, k as u16 + 1);
        }
        ids.insert_if_absent(SymbolName::from("5"), 100);
        ids.insert_if_absent(SymbolName::from("42"), 200);
        ids.insert("7", 300);
        for index in [0u32, 1, 5, 7, 42, 100, u32::MAX, u32::MAX - 1] {
            assert_eq!(ids.get_index(index), ids.get(index.to_string()), "{index}");
        }
        assert_eq!(ids.get_index(42), Some(&6));
        assert_eq!(ids.get_index(7), Some(&300));
        assert_eq!(ids.get_index(5), Some(&100));
        assert_eq!(SymbolIds::default().get_index(0), None);
    }

    #[test]
    fn single_symbol_is_id_one() {
        // `02 00 'O' 'b' 'j' 'e' 'c' 't' 00` — count 2 (id 0 reserved +
        // one real symbol), the name "Object" as id 1.
        let atom = [0x02, 0x00, b'O', b'b', b'j', b'e', b'c', b't', 0x00];
        let names = parse_symbols(&atom);
        assert_eq!(names, vec![SymbolName::from("Object")]);
        // names[0] is id 1.
    }

    #[test]
    fn two_symbols_number_in_order() {
        // `03 00 'f' 'o' 'o' 00 'O' 'b' 'j' 'e' 'c' 't' 00`.
        let atom = [
            0x03, 0x00, b'f', b'o', b'o', 0x00, b'O', b'b', b'j', b'e', b'c', b't', 0x00,
        ];
        let names = parse_symbols(&atom);
        assert_eq!(
            names,
            vec![SymbolName::from("foo"), SymbolName::from("Object")]
        );
    }

    #[test]
    fn empty_atom_is_no_symbols() {
        assert!(parse_symbols(&[]).is_empty());
        assert!(parse_symbols(&[0x00]).is_empty());
        assert!(parse_symbols(&[0x02, 0x00]).is_empty());
    }
}
