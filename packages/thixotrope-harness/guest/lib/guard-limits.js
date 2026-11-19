// @ts-check
// Bounds used by the base and environment guard tables. The native manager
// installs these guards without bundling unrelated session and UI settings.
export const guardLimits = harden({
  /** A text field larger than this is staged as a Blob (M1b; M1a refused it). */
  inlineBytes: 8192,
  /** Ids the vat mints: session key `s<n>`, turn id `t<n>`, op id `t<n>/r<r>/c<k>`, entry key `q<n>`. */
  idUnits: 64,
  /** A tool name. */
  toolNameUnits: 128,
  /** A tool description shown to the model. */
  toolDescriptionUnits: 4096,
  /** A tool's JSON schema, as JSON text (rule 12.10). */
  toolParametersUnits: 8192,
  /** An error or failure reason, a note, a hold text. */
  reasonUnits: 4096,
  /** Preview of a message in pages and lists (architecture 9). */
  messagePreviewUnits: 1024,
  /** Tool output into the model, marker included (R4-100, R4-46). */
  toolOutputUnits: 32_768,
  /** Staged strings one `splitArgs` answer may carry. */
  splitStagedStrings: 16,
  /** An endowment's or an inventory entry's label (Fae: 80 characters). */
  endowmentLabelUnits: 80,
  /** A method name rendered for a remote capability. */
  methodNameUnits: 128,
  /** Method names rendered for a remote capability (exec/render.js keeps 128). */
  maxMethodNames: 128,
  /** Attachments one message carries (R3-9, R4-99). */
  maxAttachments: 32,
  /** `readSources` lines per item (Fae: 1-200, default 80). */
  readSourcesLineCount: 200,
  /** `readSources` largest start line (Fae: 1,000,000). */
  readSourcesMaxStartLine: 1_000_000,
  /** `readSources` text per item (Fae: 8,000 characters). */
  readSourcesItemUnits: 8000,
  /** `readSources` path segments (Fae: 1-64) and segment length (1-255). */
  readSourcesPathSegments: 64,
  pathSegmentUnits: 255,
  /** `readSources` literal search text (Fae: 1-256). */
  searchUnits: 256,
});

export const imagePathLimits = harden({
  /** `path` segments and their length (Fae `image-tool.js:51-53`). */
  pathSegments: 64,
  segmentUnits: 255,
});
