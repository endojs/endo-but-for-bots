import { expectTypeOf } from 'expect-type';

import type { RunBackendInput } from '@endo/exo-package-manager/types-index.js';

declare const runInput: RunBackendInput;

// The run backend protocol carries both Yarn version components forwarded from
// workspace inspection. Omitting the minor version would prevent a backend
// from selecting the Yarn 2 lifecycle-suppression syntax consistently.
expectTypeOf(runInput.yarnMajorVersion).toEqualTypeOf<number | undefined>();
expectTypeOf(runInput.yarnMinorVersion).toEqualTypeOf<number | undefined>();
