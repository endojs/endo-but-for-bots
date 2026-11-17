//! A `JSON.rawJSON` result keeps its `[[IsRawJSON]]` brand across persistence.
//! The brand is an internal slot at the head of the object's property chain,
//! so it travels with the slot arena (`HEAP`) and needs no side-table row.

#[path = "common/twin.rs"]
mod carry;
use carry::twin;

use ironhorse_snapshot::store::MemoryStore;

#[test]
fn resumed_raw_json_objects_keep_their_brand() {
    let crank1 = "var r = 0; var fake = 0; var t = 0; \
         r = JSON.rawJSON('12345678901234567890'); \
         fake = Object.freeze(Object.assign(Object.create(null), {rawJSON: '1'})); t = 7; t";
    let observations = [
        "var r; var fake; [JSON.isRawJSON(r), JSON.isRawJSON(fake)].join()",
        "var r; JSON.stringify({a: r})",
        "var r; [Object.isFrozen(r), Object.getPrototypeOf(r), Reflect.ownKeys(r).join()].join()",
    ];
    let mut memory = MemoryStore::new();
    let seen = twin(crank1, &observations, &mut memory);
    assert_eq!(
        seen.iter()
            .map(|(_, _, value, _)| value.as_str())
            .collect::<Vec<_>>(),
        [
            "true,false",
            "{\"a\":12345678901234567890}",
            "true,,rawJSON",
        ],
    );
}
