// @ts-check
import test from '@endo/ses-ava/test.js';

import { limits } from '../config/defaults.js';
// eslint-disable-next-line import/no-relative-packages -- not exported (J-0132)
import * as evaluateSource from '../../thixotrope/src/core/evaluate-source.js';

// The core cannot import the harness config, so the staging chunk is a
// second copy of frameBytes (CORE-1b, QC advisory 5); keep them equal.
test('the core staging frame is the harness frameBytes', t => {
  t.is(evaluateSource.STAGING_FRAME_BYTES, limits.frameBytes);
  t.true(evaluateSource.STAGING_CHUNK_CHARS * 3 <= limits.frameBytes);
});

test('the settings keep their stated margins', t => {
  t.true(limits.crankOutBytes >= limits.frameBytes);
  t.true(limits.inlineBytes <= limits.frameBytes);
  t.true(limits.execSourceBytes >= limits.frameBytes);
});
