// @ts-check
import '@endo/init';
import { makeMailHubSqlite } from '../../scripts/mail-hub-sqlite.mjs';
import { makeNodePowers } from '../../src/platform/node/powers.js';

const backend = makeMailHubSqlite(makeNodePowers().syncFiles);
backend.syncFiles.writeTextAtomic(process.argv[2], '{"sequence":42}\n');
// Keep the IPC channel open. The parent kills this process without closing the
// database, leaving committed state in the WAL for recovery by a fresh process.
process.on('message', () => {});
process.send?.({committed: true});
