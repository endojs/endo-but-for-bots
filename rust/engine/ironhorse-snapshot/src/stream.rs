//! The streaming whole-heap container writer: the `XS_M` bytes of a live
//! machine, encoded straight from its arenas and side tables into a sink.
//!
//! [`crate::image::write_machine`] encodes a [`crate::image::MachineImage`],
//! and building that image of a live machine copies the heap once; the
//! image writer then built the `HEAP` payload in two more buffers and the
//! atom body in a fourth before `finish` copied it into the output. A
//! checkpoint of a 16-million-entry Map therefore held several copies of
//! a 640 MB heap, and on wasm32 the doubling buffer failed to allocate
//! 1 GiB and aborted (WASM-BLOCKERS.md B7, "Checkpointing needs several
//! copies of the heap"; the multiplier of B8).
//!
//! This writer makes two passes over the live machine with no copy of the
//! bulk state in between. The **sizing pass** runs every atom's encoder
//! into a [`ByteCounter`], because an atom's header carries its length
//! and the envelope's header the total, so both must be known before the
//! first byte goes out; the `BLOC` and `HEAP` lengths are arithmetic. The
//! **write pass** runs the same encoders into the sink, checking each
//! atom's byte count against the sizing pass. The bytes are, by
//! construction, those of `write_machine` over `snapshot_image`: the
//! atoms come in the roster's order, each present under the roster's
//! content-determined rule, and every payload from the one encoder the
//! image writer uses (`tests/streaming_identity.rs` holds the lock).
//!
//! What is still copied: the quiescent small state the vm hands out as
//! owned rows (functions, promises, iterators, and the other per-instance
//! tables), which is O(exotic rows), never O(heap); the arrays, index
//! properties and collections, which carry the bulk slot payloads, are
//! read in place through the vm's row views, and the arenas through
//! [`ironhorse_vm::SlotArena::records_iter`] and
//! [`ironhorse_vm::ChunkArena::raw_bytes`].

use crate::atom::{appended_atom_size, atom_size, ATOM_HEADER};
use crate::format::{
    FourCc, Signature, SnapshotError, Version, BLOC, CREA, HEAP, SIGN, VERS, XS_M,
};
use crate::image::{
    encode_array_rows_into, encode_collection_rows_into, encode_heap_into, encode_names_into,
    heap_payload_len, runtime_intern_floor, CreationParams,
};
use crate::machine::{small_state_of, MachineSnapshotError};
use crate::sink::{ByteCounter, Counting, Sink};
use crate::snapshot_roster::{encode_payload_into, section_present, PAYLOADS};
use crate::store::SmallState;
use crate::store_sections::SmallSection;
use crate::stored_slots::VisitSlots;
use ironhorse_vm::snapshot_api::{ArrayRowView, CollectionRowView};
use ironhorse_vm::{Interp, Slot, SlotIndex, SnapshotDirty, SnapshotSection};

/// A live machine admitted for streaming: the persist gate has passed,
/// the signature is boot-stamped, and the stored-key-id audit found every
/// stored property id registered. The shared borrow of the machine is the
/// immutability proof an image's [`crate::image::GatedImage`] wrapper
/// gives the image writer: nothing can mutate the machine between
/// admission and the last byte.
pub(crate) struct LiveSnapshot<'a> {
    interp: &'a Interp,
    version: Version,
    signature: Signature,
    creation: CreationParams,
    /// Every section the roster encodes from a small state, except the
    /// four read in place below (their fields stay empty here).
    small: SmallState,
    arrays: Vec<ArrayRowView<'a>>,
    index_props: Vec<ArrayRowView<'a>>,
    collections: Vec<CollectionRowView<'a>>,
}

/// One atom of the plan the sizing pass produces: its tag, the section it
/// encodes (none for the five fixed atoms), and its payload length.
struct PlannedAtom {
    tag: FourCc,
    section: Option<SmallSection>,
    payload_len: u64,
}

/// A sized snapshot: the plan plus the total container length, ready to
/// write as many times as the caller likes.
pub(crate) struct SizedSnapshot<'s, 'a> {
    live: &'s LiveSnapshot<'a>,
    atoms: Vec<PlannedAtom>,
    total: u32,
}

impl<'a> LiveSnapshot<'a> {
    /// Admit `interp` under `signature`: the same gate, in the same order,
    /// as [`crate::machine::MachineSnapshot::snapshot_image`], so a machine
    /// refuses by the same name on either path.
    pub(crate) fn admit(
        interp: &'a Interp,
        signature: &Signature,
    ) -> Result<LiveSnapshot<'a>, MachineSnapshotError> {
        use crate::machine::MachineSnapshot;
        interp.persist_gate()?;
        signature.check_boot()?;
        // The small state, minus the sections read in place. `Names` is
        // encoded from the live table too; the floor and the audit read
        // its length from there.
        let dirty = SnapshotDirty::all()
            .without(SnapshotSection::Arrays)
            .without(SnapshotSection::IndexProperties)
            .without(SnapshotSection::Collections)
            .without(SnapshotSection::Names);
        let live = LiveSnapshot {
            interp,
            version: Version::current(),
            signature: signature.clone(),
            creation: CreationParams {
                initial_slot_count: interp.slots().capacity(),
                initial_chunk_bytes: interp.chunks().byte_size() as u32,
            },
            small: small_state_of(interp, dirty),
            arrays: interp.arrays_rows(),
            index_props: interp.index_props_rows(),
            collections: interp.collections_rows(),
        };
        // The id-space audit of `snapshot_image`, asked of the same stored
        // slots the image would hold (the image visitor's enumeration:
        // live heap records, then every slot-bearing row), read in place.
        if live.stored_unregistered_key_id().is_some() {
            return Err(MachineSnapshotError::Snapshot(SnapshotError::Corrupt(
                "stored property id outside the name and symbol-key tables",
            )));
        }
        Ok(live)
    }

    /// [`crate::image::MachineImage::stored_unregistered_key_id`] over the
    /// live machine.
    fn stored_unregistered_key_id(&self) -> Option<u16> {
        let floor = runtime_intern_floor(self.interp.program_symbol_names().len())?;
        let registered = self.small.symbols.id_set();
        let check = |slot: &Slot| {
            slot.stored_key_id()
                .filter(|&id| id >= floor && !registered.contains(&id))
        };
        // The arena: live records only, as the image visitor skips the
        // free list's opaque records.
        let slots = self.interp.slots();
        for (index, record) in slots.records_iter().enumerate() {
            if slots.is_free_index(SlotIndex(index as u32)) {
                continue;
            }
            if let Some(id) = check(&record) {
                return Some(id);
            }
        }
        for row in self.arrays.iter().chain(&self.index_props) {
            for (_, value) in row.items() {
                if let Some(id) = check(&value) {
                    return Some(id);
                }
            }
        }
        for row in &self.collections {
            for (key, value) in row.entries() {
                if let Some(id) = check(&key).or_else(|| check(&value)) {
                    return Some(id);
                }
            }
        }
        // Everything else, by the image visitor's own classification of
        // the small state's rows.
        let mut first = None;
        self.small.visit(&mut |slot| {
            if first.is_none() {
                first = check(slot);
            }
        });
        first
    }

    /// The roster's content-determined omission rule for `section`, asked
    /// of the live data.
    fn present(&self, section: SmallSection) -> bool {
        match section {
            SmallSection::Arrays => !self.arrays.is_empty(),
            SmallSection::IndexProperties => !self.index_props.is_empty(),
            SmallSection::Collections => !self.collections.is_empty(),
            SmallSection::Names => true,
            other => section_present(&self.small, other),
        }
    }

    /// `section`'s payload, from the live data where it is read in place
    /// and from the small state otherwise: the one encoder per section
    /// the image writer and the store use.
    fn encode_section<S: Sink>(&self, section: SmallSection, sink: &mut S) {
        match section {
            SmallSection::Arrays => encode_array_rows_into(&self.arrays, sink),
            SmallSection::IndexProperties => encode_array_rows_into(&self.index_props, sink),
            SmallSection::Collections => encode_collection_rows_into(&self.collections, sink),
            SmallSection::Names => encode_names_into(self.interp.program_symbol_names(), sink),
            other => encode_payload_into(&self.small, other, sink),
        }
    }

    /// One atom's payload.
    fn encode_atom<S: Sink>(&self, atom: &PlannedAtom, sink: &mut S) {
        match atom.section {
            Some(section) => self.encode_section(section, sink),
            None => match atom.tag {
                VERS => sink.put(&self.version.encode()),
                SIGN => sink.put(&self.signature.encode()),
                CREA => sink.put(&self.creation.encode()),
                BLOC => sink.put(&self.interp.chunks().raw_bytes()),
                HEAP => {
                    let slots = self.interp.slots();
                    encode_heap_into(
                        slots.capacity(),
                        slots.free_list(),
                        slots.live_count(),
                        slots.records_iter(),
                        sink,
                    );
                }
                other => unreachable!("fixed atom {} has no encoder", other.as_str()),
            },
        }
    }

    /// The sizing pass: every atom's length, and the container's, with the
    /// wire-size checks [`crate::atom::AtomWriter`] makes, in its order,
    /// so an oversized atom or envelope refuses by the same error.
    pub(crate) fn sized(&self) -> Result<SizedSnapshot<'_, 'a>, SnapshotError> {
        let slots = self.interp.slots();
        let mut atoms = vec![
            PlannedAtom {
                tag: VERS,
                section: None,
                payload_len: self.version.encode().len() as u64,
            },
            PlannedAtom {
                tag: SIGN,
                section: None,
                payload_len: self.signature.encode().len() as u64,
            },
            PlannedAtom {
                tag: CREA,
                section: None,
                payload_len: self.creation.encode().len() as u64,
            },
            PlannedAtom {
                tag: BLOC,
                section: None,
                payload_len: self.interp.chunks().byte_size() as u64,
            },
            PlannedAtom {
                tag: HEAP,
                section: None,
                payload_len: heap_payload_len(slots.capacity(), slots.free_list().len()),
            },
        ];
        for payload in PAYLOADS {
            let Some(tag) = payload.atom else {
                continue;
            };
            if !self.present(payload.section) {
                continue;
            }
            let mut counter = ByteCounter::default();
            self.encode_section(payload.section, &mut counter);
            atoms.push(PlannedAtom {
                tag,
                section: Some(payload.section),
                payload_len: counter.len,
            });
        }
        let mut body_len = 0usize;
        for atom in &atoms {
            let payload_len = usize::try_from(atom.payload_len)
                .map_err(|_| SnapshotError::Atom(crate::atom::AtomError::TooLarge))?;
            let total = appended_atom_size(body_len, payload_len)?;
            body_len += total as usize;
        }
        let total = atom_size(body_len)?;
        Ok(SizedSnapshot {
            live: self,
            atoms,
            total,
        })
    }
}

impl SizedSnapshot<'_, '_> {
    /// The write pass: the envelope, then each atom's header and payload,
    /// straight from the live machine into `sink`. Every atom's byte count
    /// is checked against the sizing pass, so a mismatch (an encoder that
    /// is not a pure function of its input, which none is) can never leave
    /// a container whose headers lie about their payloads.
    pub(crate) fn write_into<S: Sink>(&self, sink: &mut S) -> Result<(), SnapshotError> {
        sink.put(&self.total.to_be_bytes());
        sink.put(&XS_M.0);
        for atom in &self.atoms {
            sink.put(&(atom.payload_len as u32 + ATOM_HEADER as u32).to_be_bytes());
            sink.put(&atom.tag.0);
            let mut counting = Counting {
                inner: sink,
                len: 0,
            };
            self.live.encode_atom(atom, &mut counting);
            if counting.len != atom.payload_len {
                return Err(SnapshotError::Corrupt(
                    "streamed atom length differs from its sizing pass",
                ));
            }
        }
        Ok(())
    }

    /// The container in one exactly pre-sized buffer.
    pub(crate) fn write_to_vec(&self) -> Result<Vec<u8>, SnapshotError> {
        let mut out = Vec::with_capacity(self.total as usize);
        self.write_into(&mut out)?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironhorse_vm::Interp;

    /// The write pass refuses to continue past an atom whose payload did
    /// not come out the length its header promised: a torn container must
    /// be an error, never a file whose headers lie.
    #[test]
    fn a_header_that_disagrees_with_its_payload_is_refused() {
        let machine = Interp::new();
        let signature = Signature::new("stream-self-check");
        let live = LiveSnapshot::admit(&machine, &signature).unwrap();
        let mut sized = live.sized().unwrap();
        let heap = sized
            .atoms
            .iter()
            .position(|atom| atom.tag == HEAP)
            .unwrap();
        sized.atoms[heap].payload_len += 1;
        let mut out = Vec::new();
        assert_eq!(
            sized.write_into(&mut out),
            Err(SnapshotError::Corrupt(
                "streamed atom length differs from its sizing pass"
            ))
        );
    }
}
