import { expectTypeOf } from 'expect-type';
import type { PassableReader } from '@endo/exo-stream';
import type { TypeFromInterfaceGuard } from '@endo/patterns';
import type {
  DirectoryWriteSource,
  PathEntry,
  PathEntryIssuer,
  SnapshotTree,
} from '@endo/platform/fs/lite/types';

import { MountInterface } from '../src/interfaces.js';
import type {
  EndoMount,
  EndoMountEntry,
  EndoMountFile,
  EndoMountStat,
  MountNameChange,
  ReadableTreeView,
} from '../src/types.js';

type RuntimeMount = TypeFromInterfaceGuard<typeof MountInterface>;

declare const mount: EndoMount;
declare const file: EndoMountFile;
declare const source: DirectoryWriteSource;
const issuer: PathEntryIssuer = mount;
const entry = issuer.entry(['src']);

// `entry()` mints the same `PathEntry` the rest of `EndoMount`'s API
// consumes and returns.
expectTypeOf(entry).toEqualTypeOf<ReturnType<PathEntryIssuer['entry']>>();

// Every accessor's declared return type must match the interface's inferred
// signature exactly: a widened or narrowed return here would silently change
// what callers across the daemon can rely on.
expectTypeOf(mount.has('src', 'index.js')).resolves.toEqualTypeOf<boolean>();
expectTypeOf(mount.has(entry)).resolves.toEqualTypeOf<boolean>();
expectTypeOf(mount.kind()).toEqualTypeOf<'directory'>();
expectTypeOf(file.kind()).toEqualTypeOf<'file'>();
expectTypeOf(file.list()).toEqualTypeOf<Promise<never>>();
expectTypeOf(mount.lookup(entry)).resolves.toEqualTypeOf<
  EndoMount | EndoMountFile
>();
expectTypeOf(mount.maybeLookup(entry)).resolves.toEqualTypeOf<
  EndoMount | EndoMountFile | undefined
>();
expectTypeOf(mount.subView(entry)).resolves.toEqualTypeOf<EndoMount>();
expectTypeOf(mount.readOnly()).toEqualTypeOf<ReadableTreeView>();
expectTypeOf(mount.snapshot()).resolves.toEqualTypeOf<SnapshotTree>();
expectTypeOf(mount.followNameChanges('src')).toEqualTypeOf<
  PassableReader<MountNameChange, undefined>
>();
expectTypeOf(mount.stat(entry)).resolves.toEqualTypeOf<
  EndoMountStat | undefined
>();
expectTypeOf(mount.write(entry, source)).resolves.toEqualTypeOf<void>();
expectTypeOf(mount.makeFile(entry, 'contents')).resolves.toEqualTypeOf<void>();

// The public `write`/`makeFile` payload types stay exactly what the daemon
// promises callers: a `DirectoryWriteSource` for `write`, and an optional
// `string` for `makeFile`'s content.
expectTypeOf<
  Parameters<EndoMount['write']>[1]
>().toEqualTypeOf<DirectoryWriteSource>();
expectTypeOf<Parameters<EndoMount['makeFile']>[1]>().toEqualTypeOf<
  string | undefined
>();

// Runtime patterns cannot encode the semantic payload of a promise, but each
// precise public promise still fits the broad guarded result: the compiled
// type must be assignable to whatever `RuntimeMount` (the pattern-derived
// guard type) infers for the same method, or the runtime guard would reject
// values the static type promises are valid.
expectTypeOf<ReturnType<EndoMount['lookup']>>().toExtend<
  ReturnType<RuntimeMount['lookup']>
>();
expectTypeOf<ReturnType<EndoMount['subView']>>().toExtend<
  ReturnType<RuntimeMount['subView']>
>();
expectTypeOf<ReturnType<EndoMount['snapshot']>>().toExtend<
  ReturnType<RuntimeMount['snapshot']>
>();

// The pattern guard must still infer a concrete (non-`any`) async result for
// `maybeLookup`; an `any` guard would silently stop catching malformed
// mount-lookup results at the pattern layer.
expectTypeOf<ReturnType<RuntimeMount['maybeLookup']>>().not.toBeAny();
expectTypeOf<ReturnType<RuntimeMount['maybeLookup']>>().toExtend<
  PromiseLike<unknown>
>();

// The runtime guard's `makeFile` content parameter must track the same
// optional-`string` contract as the static `EndoMount` method.
expectTypeOf<Parameters<RuntimeMount['makeFile']>[1]>().toEqualTypeOf<
  string | undefined
>();

// The portable `EndoMountEntry` a caller constructs must be accepted
// wherever the runtime guard expects a lookup path, and it must remain
// exactly the platform's canonical `PathEntry` — never a daemon-private
// widening or narrowing of it.
expectTypeOf<EndoMountEntry>().toExtend<
  Parameters<RuntimeMount['lookup']>[0]
>();
expectTypeOf<EndoMountEntry>().toEqualTypeOf<PathEntry>();
