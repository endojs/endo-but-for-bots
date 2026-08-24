import { expectTypeOf } from 'expect-type';
import { E } from '@endo/eventual-send';

import type { EndoHost, SandboxHandle } from '../types.js';

declare const host: EndoHost;
declare const profile: Parameters<EndoHost['provideSandbox']>[1];

const handlePromise = host.provideSandbox('sandbox', profile);

// The public package entry point must expose the runtime handle rather than
// erasing provideSandbox() to unknown.  This contract is compiled by the
// daemon `test:types` project in tsconfig.test-types.json.
expectTypeOf(handlePromise).resolves.toEqualTypeOf<SandboxHandle>();

declare const handle: Awaited<typeof handlePromise>;
E(handle).spawn(['/bin/true']);
E(handle).mount(undefined, '/workspace');
E(handle).scratch('/scratch');
E(handle).open('/etc/hostname');
E(handle).fork();
E(handle).reset();
E(handle).dispose();
