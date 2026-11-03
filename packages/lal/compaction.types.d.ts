export interface CompactionSettings {
  /** Governs automatic compaction; `/compact` works regardless. */
  enabled: boolean;
  /** Reserved for the model's response. */
  reserveTokens: number;
  /** Recent context kept verbatim. */
  keepRecentTokens: number;
  /** Appended to every summary prompt. */
  customInstructions: string | undefined;
}

export interface CompactionRecord {
  summary: string;
  elidedMessages: number;
  retainedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
  readFiles: string[];
  modifiedFiles: string[];
}

export interface Compactor {
  /**
   * Resolves to undefined when there is nothing to summarize. Rejects during a
   * round or while another compaction is running.
   */
  compact(options?: {
    instructions?: string;
    signal?: AbortSignal;
  }): Promise<CompactionRecord | undefined>;
  /**
   * Compacts past the threshold. A failure is logged, not thrown. Does nothing
   * during a round or while another compaction is running.
   */
  compactIfNeeded(signal?: AbortSignal): Promise<CompactionRecord | undefined>;
}
