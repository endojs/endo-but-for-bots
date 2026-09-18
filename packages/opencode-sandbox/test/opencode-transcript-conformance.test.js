// @ts-check
import '@endo/init';

import { testTranscriptRestoration } from '@endo/hosted-agent/test/transcript-conformance.js';

import {
  importedTurnsFor,
  readImportedTurns,
} from '../src/opencode-transcript.js';

// OpenCode takes its history through the fork's import route
// (`op: 'import'` on the bridge, opencode-client.js), so the "native store"
// here is the turn list that route is handed, serialized so a retried revival
// can be compared byte for byte. The read-back models the CLI's own context
// assembly: everything from the latest compaction onward.
testTranscriptRestoration({
  label: 'opencode',
  restore: records => JSON.stringify(importedTurnsFor(records)),
  readBack: native => readImportedTurns(JSON.parse(native)),
});
