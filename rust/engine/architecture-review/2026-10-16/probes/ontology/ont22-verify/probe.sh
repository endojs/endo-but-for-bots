#!/bin/sh
# ONT-22 verifier probe: which files feed the row fingerprint, and do the
# tuple row shapes appear in them?
E=/home/user/endo-but-for-bots/rust/engine
echo "== include_str! in row_schema.rs"; grep -n 'include_str!' $E/ironhorse-snapshot/tests/row_schema.rs
echo "== tuple shapes in fingerprinted files (expect none)"
for s in 'u32, u32, u32, u8, u32' 'u32, u8, u32, u32, u32' 'u32, u64)' 'u32, i128' 'Vec<u8>, u32'; do
  printf '%s: ' "$s"; cat $E/ironhorse-vm/src/interp/snapshot_rows.rs $E/ironhorse-vm/src/interp/intl_data.rs | grep -c "$s"
done
echo "== VIEW_LENGTH_TRACKING declared in"; grep -rn 'pub const VIEW_LENGTH_TRACKING' $E/ironhorse-vm/src
echo "== ledger tail / wire / row"; tail -1 $E/ironhorse-snapshot/tests/fixtures/row_schema_releases.tsv
grep -n 'pub const IRONHORSE_FORMAT_VERSION:' $E/ironhorse-snapshot/src/format.rs
grep -n 'pub const STORE_SCHEMA_VERSION:' $E/ironhorse-snapshot/src/store.rs
grep -n 'pub const ROW_SCHEMA_VERSION' $E/ironhorse-vm/src/snapshot_api.rs
echo "== consumers of ROW_SCHEMA_VERSION"; grep -rln 'ROW_SCHEMA_VERSION' $E --include=*.rs --include=*.py | grep -v /target/
echo "== ARCHITECTURE.md table row"; grep -n '^| `ROW_SCHEMA_VERSION`\|^| `IRONHORSE_FORMAT_VERSION`\|^| `STORE_SCHEMA_VERSION`' $E/ARCHITECTURE.md | cut -c1-90
