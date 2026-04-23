//! Wire descriptor for a capability reference.
//!
//! A descriptor is a two-element CBOR array: `[kind_byte, position]`.
//! The `kind_byte` packs [`Direction`] and [`Kind`] together; the
//! position is a CBOR unsigned integer.  Direction is expressed from
//! the *sender's* frame — so `Direction::Local` on an inbound message
//! means the sending session allocated the position.
//!
//! ```text
//!   kind_byte layout:
//!     bit 0      : direction (0 = Local, 1 = Remote)
//!     bits 1..=2 : kind (0 Object, 1 Promise, 2 Answer, 3 Device)
//!     bits 3..=7 : reserved (must be zero)
//! ```

use crate::error::{Result, SlotError};
use crate::vref::{Direction as VrefDir, Vref, VrefType};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Direction {
    Local,
    Remote,
}

impl Direction {
    pub fn to_vref_dir(self) -> VrefDir {
        match self {
            Direction::Local => VrefDir::Local,
            Direction::Remote => VrefDir::Remote,
        }
    }

    pub fn from_vref_dir(d: VrefDir) -> Self {
        match d {
            VrefDir::Local => Direction::Local,
            VrefDir::Remote => Direction::Remote,
        }
    }

    /// Flip the frame: what the sender called Local, the receiver
    /// sees as Remote, and vice versa.
    pub fn flip(self) -> Self {
        match self {
            Direction::Local => Direction::Remote,
            Direction::Remote => Direction::Local,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Kind {
    Object,
    Promise,
    Answer,
    Device,
}

impl Kind {
    pub fn to_vref_type(self) -> VrefType {
        match self {
            Kind::Object => VrefType::Object,
            Kind::Promise => VrefType::Promise,
            Kind::Answer => VrefType::Answer,
            Kind::Device => VrefType::Device,
        }
    }

    pub fn from_vref_type(t: VrefType) -> Self {
        match t {
            VrefType::Object => Kind::Object,
            VrefType::Promise => Kind::Promise,
            VrefType::Answer => Kind::Answer,
            VrefType::Device => Kind::Device,
        }
    }
}

/// Wire-level capability reference.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Descriptor {
    pub dir: Direction,
    pub kind: Kind,
    pub position: u64,
}

impl Descriptor {
    pub fn new(dir: Direction, kind: Kind, position: u64) -> Self {
        Descriptor { dir, kind, position }
    }

    pub fn to_kind_byte(self) -> u8 {
        let dir_bit = match self.dir {
            Direction::Local => 0,
            Direction::Remote => 1,
        };
        let kind_bits = match self.kind {
            Kind::Object => 0,
            Kind::Promise => 1,
            Kind::Answer => 2,
            Kind::Device => 3,
        };
        (kind_bits << 1) | dir_bit
    }

    pub fn from_kind_byte(b: u8, position: u64) -> Result<Self> {
        if b & 0b1111_1000 != 0 {
            return Err(SlotError::Invariant(format!(
                "descriptor kind byte {b:#04x} has reserved bits set"
            )));
        }
        let dir = if b & 0b1 == 0 { Direction::Local } else { Direction::Remote };
        let kind = match (b >> 1) & 0b11 {
            0 => Kind::Object,
            1 => Kind::Promise,
            2 => Kind::Answer,
            3 => Kind::Device,
            _ => unreachable!(),
        };
        Ok(Descriptor { dir, kind, position })
    }

    pub fn to_vref(self) -> Vref {
        Vref {
            ty: self.kind.to_vref_type(),
            dir: self.dir.to_vref_dir(),
            durability: Default::default(),
            id: self.position,
            subid: None,
            facet: None,
        }
    }

    pub fn from_vref(v: &Vref) -> Self {
        Descriptor {
            dir: Direction::from_vref_dir(v.dir),
            kind: Kind::from_vref_type(v.ty),
            position: v.id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_byte_roundtrip() {
        for dir in [Direction::Local, Direction::Remote] {
            for kind in [Kind::Object, Kind::Promise, Kind::Answer, Kind::Device] {
                let d = Descriptor::new(dir, kind, 42);
                let b = d.to_kind_byte();
                let d2 = Descriptor::from_kind_byte(b, 42).unwrap();
                assert_eq!(d, d2);
            }
        }
    }

    #[test]
    fn reserved_bits_rejected() {
        assert!(Descriptor::from_kind_byte(0b1000, 0).is_err());
        assert!(Descriptor::from_kind_byte(0xff, 0).is_err());
    }

    #[test]
    fn vref_bridge() {
        let v = Vref::object_local(7);
        let d = Descriptor::from_vref(&v);
        assert_eq!(d.dir, Direction::Local);
        assert_eq!(d.kind, Kind::Object);
        assert_eq!(d.position, 7);
        assert_eq!(d.to_vref(), v);
    }
}
