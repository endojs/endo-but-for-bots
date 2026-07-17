import { expectTypeOf } from 'expect-type';

import type { PassableBytesReader } from '@endo/exo-stream';
import type {
  ContentStore as PackageContentStore,
  ContentStoreBlob as PackageContentStoreBlob,
  ReadableBlob as PackageReadableBlob,
  ReadableBlobRange as PackageReadableBlobRange,
  ReadableBlobRangeRead as PackageReadableBlobRangeRead,
} from '@endo/platform/fs/lite/types';
import type {
  ReadableBlob as PackageJsReadableBlob,
  ReadableBlobRange as PackageJsReadableBlobRange,
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
  ContentStore as SourceContentStore,
  ContentStoreBlob as SourceContentStoreBlob,
  ReadableBlob as SourceReadableBlob,
  ReadableBlobRange as SourceReadableBlobRange,
  ReadableBlobRangeRead as SourceReadableBlobRangeRead,
} from '../src/fs/types.js';
import type {
  Search as SourceSearch,
  SearchFilePowers as SourceSearchFilePowers,
} from '../src/fs/search.types.js';

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

// ReadableBlobRange extends the plain blob surface with range-fetch
// members; its exported and source shapes must match, and `fetch` must stay
// the streaming range read rather than widen to a buffered one.
expectTypeOf<PackageReadableBlobRange>().toEqualTypeOf<SourceReadableBlobRange>();
expectTypeOf<PackageJsReadableBlobRange>().toEqualTypeOf<SourceReadableBlobRange>();
expectTypeOf<keyof SourceReadableBlobRange>().toEqualTypeOf<
  keyof ExpectedReadableBlob | 'getInfo' | 'fetch'
>();
expectTypeOf<SourceReadableBlobRange['fetch']>().toEqualTypeOf<
  (offset: bigint, length: bigint) => Promise<PassableBytesReader>
>();

// ReadableBlobRangeRead layers `rangeRead`/`rangeReadText` convenience
// helpers on top of ReadableBlobRange; its exported and source shapes must
// match.
expectTypeOf<PackageReadableBlobRangeRead>().toEqualTypeOf<SourceReadableBlobRangeRead>();
expectTypeOf<keyof SourceReadableBlobRangeRead>().toEqualTypeOf<
  keyof SourceReadableBlobRange | 'rangeRead' | 'rangeReadText'
>();

// ContentStoreBlob and ContentStore must stay in parity with the source, and
// a fetched ContentStoreBlob must not leak host-only backing helpers
// (`makeFileReader`, `size`, `readRange`) onto the public range-read surface
// that crosses the wire.
expectTypeOf<PackageContentStoreBlob>().toEqualTypeOf<SourceContentStoreBlob>();
expectTypeOf<SourceContentStoreBlob>().toEqualTypeOf<ExpectedContentStoreBlob>();
expectTypeOf<PackageContentStore>().toEqualTypeOf<SourceContentStore>();
expectTypeOf<
  ReturnType<SourceContentStore['fetch']>
>().toEqualTypeOf<SourceContentStoreBlob>();
expectTypeOf<
  Extract<
    keyof SourceReadableBlobRangeRead,
    'makeFileReader' | 'size' | 'readRange'
  >
>().toEqualTypeOf<never>();

// The `fs/search.types` subpath-export entrypoints (bare and `.js`) must
// stay in parity with the source search types.
expectTypeOf<PackageSearch>().toEqualTypeOf<SourceSearch>();
expectTypeOf<PackageJsSearch>().toEqualTypeOf<SourceSearch>();
expectTypeOf<PackageSearchFilePowers>().toEqualTypeOf<SourceSearchFilePowers>();
expectTypeOf<PackageJsSearchFilePowers>().toEqualTypeOf<SourceSearchFilePowers>();
