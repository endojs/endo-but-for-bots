//! Vref parser and formatter, ported from liveslots' parseVatSlots.js.
//!
//! Format: `T[+|-]D?N[/I][:F]` where
//!   * `T` ∈ {`o`, `d`, `p`} — object, device, promise
//!   * `+` / `-` — allocation direction (local vs. remote)
//!   * `D` ∈ {`d`, `v`, ε} — durable, merely-virtual, ephemeral
//!   * `N` — Nat position
//!   * `/I` (optional) — subid, only on virtual/durable objects
//!   * `:F` (optional) — facet index on a multi-faceted cohort
//!
//! v1 of slot-machine accepts `d`/`v` durability markers and subid/facet
//! syntax in the parser (so we can interoperate with liveslots-derived
//! payloads), but the refcount & GC layers treat every object opaquely.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::error::{Result, SlotError};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub enum VrefType {
    Object,
    Promise,
    Answer,
    Device,
}

impl VrefType {
    fn prefix(self) -> char {
        match self {
            VrefType::Object => 'o',
            VrefType::Promise => 'p',
            VrefType::Answer => 'a',
            VrefType::Device => 'd',
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub enum Direction {
    /// `+` — allocated by this side (local export).
    Local,
    /// `-` — allocated by the peer (our import).
    Remote,
}

impl Direction {
    fn sign(self) -> char {
        match self {
            Direction::Local => '+',
            Direction::Remote => '-',
        }
    }
}

/// Durability marker; default is `Ephemeral`.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub enum Durability {
    #[default]
    Ephemeral,
    Virtual,
    Durable,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct Vref {
    pub ty: VrefType,
    pub dir: Direction,
    pub durability: Durability,
    pub id: u64,
    pub subid: Option<u64>,
    pub facet: Option<u32>,
}

impl Vref {
    pub fn object_local(id: u64) -> Self {
        Vref { ty: VrefType::Object, dir: Direction::Local, durability: Durability::Ephemeral, id, subid: None, facet: None }
    }
    pub fn object_remote(id: u64) -> Self {
        Vref { ty: VrefType::Object, dir: Direction::Remote, durability: Durability::Ephemeral, id, subid: None, facet: None }
    }
    pub fn promise_local(id: u64) -> Self {
        Vref { ty: VrefType::Promise, dir: Direction::Local, durability: Durability::Ephemeral, id, subid: None, facet: None }
    }
    pub fn promise_remote(id: u64) -> Self {
        Vref { ty: VrefType::Promise, dir: Direction::Remote, durability: Durability::Ephemeral, id, subid: None, facet: None }
    }
    pub fn answer_local(id: u64) -> Self {
        Vref { ty: VrefType::Answer, dir: Direction::Local, durability: Durability::Ephemeral, id, subid: None, facet: None }
    }

    pub fn is_local(&self) -> bool {
        matches!(self.dir, Direction::Local)
    }

    pub fn parse(s: &str) -> Result<Self> {
        let bad = || SlotError::ParseVref(s.to_string());
        let mut chars = s.chars();
        let type_char = chars.next().ok_or_else(bad)?;
        let ty = match type_char {
            'o' => VrefType::Object,
            'p' => VrefType::Promise,
            'a' => VrefType::Answer,
            'd' => VrefType::Device,
            _ => return Err(bad()),
        };
        let sign = chars.next().ok_or_else(bad)?;
        let dir = match sign {
            '+' => Direction::Local,
            '-' => Direction::Remote,
            _ => return Err(bad()),
        };
        let rest: String = chars.collect();

        let (main, facet) = match rest.split_once(':') {
            Some((m, f)) => (m, Some(f.parse::<u32>().map_err(|_| bad())?)),
            None => (rest.as_str(), None),
        };

        // Durability marker is only meaningful on objects, but we
        // tolerate (and ignore) it on other types to keep the parser
        // forgiving — liveslots itself rejects, but we're primarily
        // a wire-level ferry.
        let (durability, body) = if let Some(body) = main.strip_prefix('d') {
            (Durability::Durable, body)
        } else if let Some(body) = main.strip_prefix('v') {
            (Durability::Virtual, body)
        } else {
            (Durability::Ephemeral, main)
        };

        let (id_str, subid) = match body.split_once('/') {
            Some((a, b)) => (a, Some(b.parse::<u64>().map_err(|_| bad())?)),
            None => (body, None),
        };
        let id = id_str.parse::<u64>().map_err(|_| bad())?;
        Ok(Vref { ty, dir, durability, id, subid, facet })
    }

    /// Canonical string form, round-trippable through [`parse`].
    pub fn to_canonical(&self) -> String {
        let mut out = String::with_capacity(8);
        out.push(self.ty.prefix());
        out.push(self.dir.sign());
        match self.durability {
            Durability::Ephemeral => {}
            Durability::Virtual => out.push('v'),
            Durability::Durable => out.push('d'),
        }
        out.push_str(&self.id.to_string());
        if let Some(sub) = self.subid {
            out.push('/');
            out.push_str(&sub.to_string());
        }
        if let Some(f) = self.facet {
            out.push(':');
            out.push_str(&f.to_string());
        }
        out
    }
}

impl fmt::Display for Vref {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_canonical())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_object_local() {
        let v = Vref::parse("o+1").unwrap();
        assert_eq!(v.ty, VrefType::Object);
        assert_eq!(v.dir, Direction::Local);
        assert_eq!(v.id, 1);
        assert_eq!(v.to_canonical(), "o+1");
    }

    #[test]
    fn parse_promise_remote() {
        let v = Vref::parse("p-42").unwrap();
        assert_eq!(v.ty, VrefType::Promise);
        assert_eq!(v.dir, Direction::Remote);
        assert_eq!(v.id, 42);
    }

    #[test]
    fn parse_durable_with_subid_and_facet() {
        let v = Vref::parse("o+d5/10:2").unwrap();
        assert_eq!(v.durability, Durability::Durable);
        assert_eq!(v.id, 5);
        assert_eq!(v.subid, Some(10));
        assert_eq!(v.facet, Some(2));
        assert_eq!(v.to_canonical(), "o+d5/10:2");
    }

    #[test]
    fn reject_empty_and_bad_type() {
        assert!(Vref::parse("").is_err());
        assert!(Vref::parse("x+1").is_err());
        assert!(Vref::parse("o*1").is_err());
        assert!(Vref::parse("o+notanumber").is_err());
    }

    #[test]
    fn answer_parses() {
        let v = Vref::parse("a+0").unwrap();
        assert_eq!(v.ty, VrefType::Answer);
        assert_eq!(v.id, 0);
        assert!(v.is_local());
    }
}
