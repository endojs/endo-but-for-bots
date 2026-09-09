import { expectTypeOf } from 'expect-type';

import type { SecretAdmin, SecretBlob } from '../src/types.js';

declare const admin: SecretAdmin;
declare const blob: SecretBlob;

// A replacement reports the generation it committed. This is what a holder
// staging a multi-step change pins its second write to, so a contract that
// promised nothing back would silently leave that caller with only a guess.
// `types.d.ts` is exempt from `tsc` under `skipLibCheck`, so without a fixture
// in this project nothing checks it against the exo at all.
expectTypeOf(
  admin.replaceBase64('' as string),
).resolves.toEqualTypeOf<bigint>();

// The precondition is optional and takes only a generation, which is a bigint
// because that is what the record counts in.
expectTypeOf(admin.replaceBase64)
  .parameter(1)
  .toEqualTypeOf<{ ifGeneration?: bigint } | undefined>();

// The read side pairs the bytes with the version they came from, so the two
// cannot be sampled separately across a window in which the record moves.
expectTypeOf(blob.readBase64WithGeneration()).resolves.toEqualTypeOf<{
  base64: string;
  generation: bigint;
}>();
