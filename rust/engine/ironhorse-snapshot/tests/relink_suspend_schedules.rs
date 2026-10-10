//! Deterministic comparison of every suspension boundary with changing names.
use ironhorse_snapshot::{store::MemoryStore, store_suite::metamorphic_with_suspend_schedule};

#[test]
fn changing_names_survive_every_suspend_subset() {
    let cranks = [
        "var retained = {value: 1}; var next = function(n) { retained.value += n; return retained.value; }; 0",
        "var introduced = next(2); introduced",
        "retained.value + next(3)",
        "next(1)",
    ];
    for mask in 0..8 {
        let schedule = [false, mask & 1 != 0, mask & 2 != 0, mask & 4 != 0];
        metamorphic_with_suspend_schedule(MemoryStore::new, "changing names", &cranks, &schedule);
    }
}
