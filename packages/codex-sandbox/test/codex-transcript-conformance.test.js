// @ts-check
import '@endo/init';

import { testTranscriptRestoration } from '@endo/hosted-agent/test/transcript-conformance.js';
import {
  readResponsesApiItems,
  responsesApiItems,
} from '@endo/hosted-agent/transcript-records.js';

// Codex takes its history as raw Responses API items through
// `thread/inject_items` (codex-client.js), so the "native store" here is the
// item list the app-server is handed, serialized so a retried revival can be
// compared byte for byte.
testTranscriptRestoration({
  label: 'codex',
  restore: records => JSON.stringify(responsesApiItems(records)),
  readBack: native => readResponsesApiItems(JSON.parse(native)),
});
