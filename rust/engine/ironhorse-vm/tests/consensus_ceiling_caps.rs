//! A `consensus` build refuses an arena ceiling that some target cannot
//! honor, whatever the arena's capacity history (`rust/engine/WASM-BLOCKERS.md`,
//! B7 "Latent"). The default profile sits under both caps, so it runs
//! unchanged; other builds accept every ceiling.
use ironhorse_vm::value::{DEFAULT_CHUNK_CEILING, DEFAULT_SLOT_CEILING};
use ironhorse_vm::{Interp, Opcode, CONSENSUS_MAX_CHUNK_CEILING, CONSENSUS_MAX_SLOT_CEILING};

const PROGRAM: [u8; 3] = [
    Opcode::XS_CODE_OBJECT as u8,
    Opcode::XS_CODE_POP as u8,
    Opcode::XS_CODE_RETURN as u8,
];

#[test]
fn the_caps_hold_the_default_profile() {
    assert_eq!(CONSENSUS_MAX_SLOT_CEILING, 44_739_242);
    assert_eq!(CONSENSUS_MAX_CHUNK_CEILING, 1 << 29);
    let mut vm = Interp::new();
    assert_eq!(vm.slots().ceiling(), DEFAULT_SLOT_CEILING);
    assert_eq!(vm.chunks().ceiling(), DEFAULT_CHUNK_CEILING);
    assert_eq!(vm.set_slot_ceiling(DEFAULT_SLOT_CEILING), Ok(()));
    assert_eq!(vm.set_chunk_ceiling(DEFAULT_CHUNK_CEILING), Ok(()));
    assert!(vm.run(&PROGRAM).completed);
    assert_eq!(vm.set_slot_ceiling(CONSENSUS_MAX_SLOT_CEILING), Ok(()));
    assert_eq!(vm.set_chunk_ceiling(CONSENSUS_MAX_CHUNK_CEILING), Ok(()));
    assert!(vm.run(&PROGRAM).completed);
}

#[cfg(feature = "consensus")]
#[test]
fn consensus_refuses_a_ceiling_above_its_cap_and_keeps_the_current_one() {
    use ironhorse_vm::{CeilingRefused, ChunkArena, SlotArena};
    let slot_refusal = |requested: u32| CeilingRefused {
        requested: u64::from(requested),
        cap: u64::from(CONSENSUS_MAX_SLOT_CEILING),
    };
    let chunk_refusal = |requested: usize| CeilingRefused {
        requested: requested as u64,
        cap: CONSENSUS_MAX_CHUNK_CEILING as u64,
    };
    let mut vm = Interp::new();
    for requested in [CONSENSUS_MAX_SLOT_CEILING + 1, u32::MAX] {
        assert_eq!(vm.set_slot_ceiling(requested), Err(slot_refusal(requested)));
        assert_eq!(vm.slots().ceiling(), DEFAULT_SLOT_CEILING);
    }
    for requested in [CONSENSUS_MAX_CHUNK_CEILING + 1, 1 << 30, usize::MAX] {
        assert_eq!(
            vm.set_chunk_ceiling(requested),
            Err(chunk_refusal(requested))
        );
        assert_eq!(vm.chunks().ceiling(), DEFAULT_CHUNK_CEILING);
    }
    assert!(
        vm.run(&PROGRAM).completed,
        "a refusal leaves the machine runnable"
    );

    // The arenas refuse too, so an arena an embedder builds for a restore
    // cannot carry a ceiling the setters would refuse.
    let mut slots = SlotArena::new();
    assert_eq!(slots.set_ceiling(u32::MAX), Err(slot_refusal(u32::MAX)));
    assert_eq!(slots.ceiling(), DEFAULT_SLOT_CEILING);
    let mut chunks = ChunkArena::new();
    assert_eq!(chunks.set_ceiling(1 << 30), Err(chunk_refusal(1 << 30)));
    assert_eq!(chunks.ceiling(), DEFAULT_CHUNK_CEILING);
    assert_eq!(
        chunk_refusal(1 << 30).to_string(),
        "ceiling 1073741824 exceeds the consensus cap 536870912"
    );
}

#[cfg(not(feature = "consensus"))]
#[test]
fn other_builds_accept_every_ceiling() {
    let mut vm = Interp::new();
    assert_eq!(vm.set_slot_ceiling(u32::MAX), Ok(()));
    assert_eq!(vm.slots().ceiling(), u32::MAX);
    assert_eq!(vm.set_chunk_ceiling(1 << 30), Ok(()));
    assert_eq!(vm.chunks().ceiling(), 1 << 30);
}
