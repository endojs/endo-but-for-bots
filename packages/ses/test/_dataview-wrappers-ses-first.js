// This dependency runs the SES repair before the next dependency installs the
// immutable ArrayBuffer shim. The dependency edge, rather than textual calls
// in this module, makes the evaluation order deterministic under ESM.
import './_install-nan-taming-first.js';
import '@endo/immutable-arraybuffer/shim.js';
