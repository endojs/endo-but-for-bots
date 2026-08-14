import { expectTypeOf } from 'expect-type';

import type {
  ContentStore as PackageContentStore,
  ContentStoreBlob as PackageContentStoreBlob,
  ReadableBlob as PackageReadableBlob,
  RichReadableBlob as PackageRichReadableBlob,
} from '@endo/platform/fs/lite/types';
import type {
  ReadableBlob as PackageJsReadableBlob,
  RichReadableBlob as PackageJsRichReadableBlob,
} from '@endo/platform/fs/lite/types.js';
import type {
  Search as PackageSearch,
  SearchFilePowers as PackageSearchFilePowers,
} from '@endo/platform/fs/search.types';
import type {
  Search as PackageJsSearch,
  SearchFilePowers as PackageJsSearchFilePowers,
} from '@endo/platform/fs/search.types.js';
import type { Reader } from '@endo/stream';

import type {
  DirEntry as PackageBackendDirEntry,
  FsBackend as PackageBackendFsBackend,
  NodeKind as PackageBackendNodeKind,
  WatchEvent as PackageBackendWatchEvent,
} from '@endo/platform/fs/extended/backend-types';
import type {
  DirEntry as PackageJsBackendDirEntry,
  FsBackend as PackageJsBackendFsBackend,
  NodeKind as PackageJsBackendNodeKind,
  WatchEvent as PackageJsBackendWatchEvent,
} from '@endo/platform/fs/extended/backend-types.js';
import type {
  DirEntry as PackageExtendedDirEntry,
  FsBackend as PackageExtendedFsBackend,
  NodeKind as PackageExtendedNodeKind,
  WatchEvent as PackageExtendedWatchEvent,
} from '@endo/platform/fs/extended';
import type {
  DirEntry as PackageJsExtendedDirEntry,
  FsBackend as PackageJsExtendedFsBackend,
  NodeKind as PackageJsExtendedNodeKind,
  WatchEvent as PackageJsExtendedWatchEvent,
} from '@endo/platform/fs/extended/types-index.js';
import type {
  ContentStore as SourceContentStore,
  ContentStoreBlob as SourceContentStoreBlob,
  ReadableBlob as SourceReadableBlob,
  RichReadableBlob as SourceRichReadableBlob,
} from '../src/fs/types.js';
import type {
  Search as SourceSearch,
  SearchFilePowers as SourceSearchFilePowers,
} from '../src/fs/search-types.js';
import type {
  DirEntry as SourceBackendDirEntry,
  FsBackend as SourceBackendFsBackend,
  NodeKind as SourceBackendNodeKind,
  WatchEvent as SourceBackendWatchEvent,
} from '../src/fs/extended/backend-types.js';

type ExpectedReadableBlob = {
  streamBase64: (synPromise: unknown) => Promise<unknown>;
  text: () => Promise<string>;
  json: () => Promise<any>;
  help: (method?: string) => string;
};

type ExpectedContentStoreBlob = {
  makeFileReader: () => Reader<Uint8Array>;
  text: () => Promise<string>;
  json: () => Promise<any>;
  size?: () => Promise<bigint>;
  readRange?: (offset: number, length: number) => Promise<Uint8Array>;
};

// The `fs/lite/types` subpath-export entrypoints (bare and `.js`) must stay
// identical to the source module they re-export, and the source surface
// itself must match the documented blob shape exactly, so consumers
// importing the public entrypoint see the same type callers of the source
// see.
expectTypeOf<PackageReadableBlob>().toEqualTypeOf<SourceReadableBlob>();
expectTypeOf<PackageJsReadableBlob>().toEqualTypeOf<SourceReadableBlob>();
expectTypeOf<SourceReadableBlob>().toEqualTypeOf<ExpectedReadableBlob>();

// RichReadableBlob extends the plain blob surface with content identity and
// composable byte and line attenuation. Its exported and source shapes match.
expectTypeOf<PackageRichReadableBlob>().toEqualTypeOf<SourceRichReadableBlob>();
expectTypeOf<PackageJsRichReadableBlob>().toEqualTypeOf<SourceRichReadableBlob>();
expectTypeOf<keyof SourceRichReadableBlob>().toEqualTypeOf<
  keyof ExpectedReadableBlob | 'getInfo' | 'range' | 'textRange'
>();

// ContentStoreBlob and ContentStore must stay in parity with the source, and
// a fetched ContentStoreBlob must not leak host-only backing helpers
// (`makeFileReader`, `size`, `readRange`) onto the public rich blob surface
// that crosses the wire.
expectTypeOf<PackageContentStoreBlob>().toEqualTypeOf<SourceContentStoreBlob>();
expectTypeOf<SourceContentStoreBlob>().toEqualTypeOf<ExpectedContentStoreBlob>();
expectTypeOf<PackageContentStore>().toEqualTypeOf<SourceContentStore>();
expectTypeOf<
  ReturnType<SourceContentStore['fetch']>
>().toEqualTypeOf<SourceContentStoreBlob>();
expectTypeOf<
  Extract<keyof SourceRichReadableBlob, 'makeFileReader' | 'size' | 'readRange'>
>().toEqualTypeOf<never>();

// The `fs/search.types` subpath-export entrypoints (bare and `.js`) must
// stay in parity with the source search types.
expectTypeOf<PackageSearch>().toEqualTypeOf<SourceSearch>();
expectTypeOf<PackageJsSearch>().toEqualTypeOf<SourceSearch>();
expectTypeOf<PackageSearchFilePowers>().toEqualTypeOf<SourceSearchFilePowers>();
expectTypeOf<PackageJsSearchFilePowers>().toEqualTypeOf<SourceSearchFilePowers>();

// The `fs/extended/backend-types` and `fs/extended` subpath-export
// entrypoints (bare and `.js`, direct and barrel) must all mirror the same
// source backend types, so the watch/dir/node-kind contracts stay
// single-sourced regardless of which entrypoint a consumer imports.
expectTypeOf<PackageBackendDirEntry>().toEqualTypeOf<SourceBackendDirEntry>();
expectTypeOf<PackageJsBackendDirEntry>().toEqualTypeOf<SourceBackendDirEntry>();
expectTypeOf<PackageBackendFsBackend>().toEqualTypeOf<SourceBackendFsBackend>();
expectTypeOf<PackageJsBackendFsBackend>().toEqualTypeOf<SourceBackendFsBackend>();
expectTypeOf<PackageBackendNodeKind>().toEqualTypeOf<SourceBackendNodeKind>();
expectTypeOf<PackageJsBackendNodeKind>().toEqualTypeOf<SourceBackendNodeKind>();
expectTypeOf<PackageBackendWatchEvent>().toEqualTypeOf<SourceBackendWatchEvent>();
expectTypeOf<PackageJsBackendWatchEvent>().toEqualTypeOf<SourceBackendWatchEvent>();
expectTypeOf<PackageExtendedDirEntry>().toEqualTypeOf<SourceBackendDirEntry>();
expectTypeOf<PackageJsExtendedDirEntry>().toEqualTypeOf<SourceBackendDirEntry>();
expectTypeOf<PackageExtendedFsBackend>().toEqualTypeOf<SourceBackendFsBackend>();
expectTypeOf<PackageJsExtendedFsBackend>().toEqualTypeOf<SourceBackendFsBackend>();
expectTypeOf<PackageExtendedNodeKind>().toEqualTypeOf<SourceBackendNodeKind>();
expectTypeOf<PackageJsExtendedNodeKind>().toEqualTypeOf<SourceBackendNodeKind>();
expectTypeOf<PackageExtendedWatchEvent>().toEqualTypeOf<SourceBackendWatchEvent>();
expectTypeOf<PackageJsExtendedWatchEvent>().toEqualTypeOf<SourceBackendWatchEvent>();
