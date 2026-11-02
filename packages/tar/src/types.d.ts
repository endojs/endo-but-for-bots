/**
 * A block-aligned tar source. Reads the archive one 512-byte block at a
 * time and streams each entry's content without buffering the whole
 * archive: at most one header block plus a partial source chunk are held
 * at a time.
 */
export interface TarReader {
  /** Read the next 512-byte block, or `undefined` at a clean end of archive. */
  readBlock(): Promise<Uint8Array | undefined>;
  /**
   * Stream `size` content bytes, then consume the trailing padding to the next
   * 512-byte boundary. Yields slices as they arrive so the consumer never sees
   * the whole entry buffered.
   */
  streamContent(size: number, archivePath: string): AsyncGenerator<Uint8Array>;
}

/**
 * A parsed tar entry yielded by `readTarEntries`. The header has been decoded
 * and any preceding pax extended-header overrides applied, but the path is not
 * yet validated into segments (use `tarPathSegments`). The consumer MUST fully
 * drain `content` before requesting the next entry; the underlying reader is
 * stateful and block-aligned.
 */
export interface TarEntry {
  type: 'file' | 'directory' | 'symlink';
  /** The archive path (pax `path` override applied). */
  path: string;
  /** The content byte length (pax `size` override applied). */
  size: number;
  /** The permission bits of the ustar header. */
  mode: number;
  /**
   * The symlink target (pax `linkpath` override applied; only meaningful when
   * `type` is `'symlink'`; otherwise `''`).
   */
  linkname: string;
  /**
   * The entry's content bytes, streamed chunk-by-chunk and followed by
   * block-padding consumption. For directories and symlinks this still must be
   * drained to stay block aligned, even though the bytes are not the entry's
   * data.
   */
  content: AsyncGenerator<Uint8Array>;
}
