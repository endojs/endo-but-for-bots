import { expectTypeOf } from 'expect-type';

import type { PathEntry, PathEntryIssuer } from '../src/fs/types.js';

declare const issuer: PathEntryIssuer;
const entry: PathEntry = issuer.entry(['src', 'index.js']);

// PathEntry#child must keep returning PathEntry rather than widening, so
// callers can chain traversal without re-annotating each step.
const child = entry.child('test.js');
expectTypeOf(child).toEqualTypeOf<PathEntry>();
