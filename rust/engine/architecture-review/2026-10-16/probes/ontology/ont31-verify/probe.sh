#!/bin/sh
# ONT-31 verifier probe: compare ARCHITECTURE.md identifier table with the constants.
R=/home/user/endo-but-for-bots/rust/engine
cd "$R" || exit 2
echo "== doc table =="
grep -n '^| `\(IRONHORSE_FORMAT_VERSION\|STORE_SCHEMA_VERSION\|ROW_SCHEMA_VERSION\|COST_TABLE_VERSION\)`' ARCHITECTURE.md | cut -c1-80
echo "== code =="
grep -n 'pub const IRONHORSE_FORMAT_VERSION' ironhorse-snapshot/src/format.rs
grep -n 'pub const STORE_SCHEMA_VERSION' ironhorse-snapshot/src/store.rs
grep -n 'pub const ROW_SCHEMA_VERSION' ironhorse-vm/src/snapshot_api.rs
grep -n 'pub const COST_TABLE_VERSION' ironhorse-meter/src/lib.rs
echo "== ledger tail =="
tail -1 ironhorse-snapshot/tests/fixtures/row_schema_releases.tsv | cut -f1-3
echo "== row-contract note vs gate/decoder =="
sed -n 371,374p ironhorse-vm/src/interp/snapshot_rows.rs
sed -n 704,707p ironhorse-vm/src/interp/persist.rs
sed -n 3235,3238p ironhorse-vm/src/interp/persist.rs
echo "== harness wording =="
grep -n 'version-4\|ironhorse-meter-9' ironhorse-262/src/xst.rs
echo "== doc checks reading ARCHITECTURE.md =="
grep -rln 'ARCHITECTURE.md' --include=*.rs --include=*.py . | grep -v '/target/' | xargs grep -ln 'read_to_string\|include_str\|open(' 2>/dev/null || echo none
