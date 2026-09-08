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

#[derive(Clone, Default)]
pub(crate) struct SymbolIds(std::collections::HashMap<SymbolName, u16>);
impl SymbolIds {
    pub fn get(&self, name: impl Into<SymbolName>) -> Option<&u16> {
        self.0.get(&name.into())
    }
    pub fn contains_key(&self, name: impl Into<SymbolName>) -> bool {
        self.get(name).is_some()
    }
    pub fn insert(&mut self, name: impl Into<SymbolName>, id: u16) -> Option<u16> {
        self.0.insert(name.into(), id)
    }
    pub fn entry(
        &mut self,
        name: SymbolName,
    ) -> std::collections::hash_map::Entry<'_, SymbolName, u16> {
        self.0.entry(name)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&SymbolName, &u16)> {
        self.0.iter()
    }
}

/// Decode trusted symbols for tooling. Malformed atoms produce no names.
/// Use `parse_symbols_checked` at execution boundaries to report malformed input.
pub fn parse_symbols(atom: &[u8]) -> Vec<SymbolName> {
    parse_symbols_checked(atom).unwrap_or_default()
}

/// Decode a complete XS symbol atom without replacing any code unit.
pub fn parse_symbols_checked(atom: &[u8]) -> Result<Vec<SymbolName>, crate::Halt> {
    let invalid = || crate::Halt::Decode("invalid CESU-8 symbols atom".into());
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
