// Configuration for the child ava run driven by
// test/snapshot-roundtrip.test.js. The snapshot directory is a fresh
// temporary directory per run so the fixture never writes into the tree.
export default {
  files: ['test/_snapshot-roundtrip/fixture.js'],
  snapshotDir: process.env.ENDO_SNAPSHOT_ROUNDTRIP_DIR,
  timeout: '2m',
};
