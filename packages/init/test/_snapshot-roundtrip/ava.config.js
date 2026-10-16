// snapshotDir is a fresh temporary directory per run, supplied through
// ENDO_SNAPSHOT_ROUNDTRIP_DIR, so the fixture never writes into the tree.
export default {
  files: ['test/_snapshot-roundtrip/fixture.js'],
  snapshotDir: process.env.ENDO_SNAPSHOT_ROUNDTRIP_DIR,
  timeout: '2m',
};
