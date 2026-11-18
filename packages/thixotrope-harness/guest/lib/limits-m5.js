// @ts-check
/**
 * M5's design settings (W5.0; `designs/m5-interfaces.md` section 1.3):
 * presets, the operator inventory, the session's label map, granted tools,
 * mentions, the exec membrane and the inspector.
 *
 * A file of its own so that M5 adds no line to `limits.js` or
 * `config/defaults.js`, which M3 and M4 may edit in parallel. Every value
 * here is a guest design setting (no Node-side copy exists); Node code and
 * tests import this module after the guest prelude, like `limits.js`.
 *
 * Units as `limits.js`: `...Bytes` are UTF-8 bytes, `...Units` UTF-16 code
 * units, `...Ms` milliseconds. Each entry says what it bounds and why.
 *
 * Plain data only: this module is evaluated in vats and in Node alike.
 */
import { limits } from './limits.js';

export const limitsM5 = harden({
  // ---- presets (factory vat; R3-17, R3-22, R4-4, R6-55) ----
  /** Presets in the catalogue, built-in ones included (Fae: 58 + built-ins). */
  maxPresets: 64,
  /** A preset's label (Fae `title`: 120 characters). */
  presetLabelUnits: 120,
  /**
   * A preset's description. Fae allows 1,000 characters; here 500 units, so
   * that a preset with long instructions and 32 endowments still fits
   * `presetRecordBytes` (W5.0-settle; the preset record's frame margin).
   */
  presetDescriptionUnits: 500,
  /**
   * A preset's free-text instructions (R4-26 part 7). Fae allows 32,768
   * characters; here 4,096 units (12,288 bytes at three bytes a unit), so
   * that one preset fits one frame. Open decision O-4 in `m5-interfaces.md`.
   */
  presetInstructionsUnits: 4096,
  /**
   * The string content bytes (UTF-8, keys included; contract rule 4) of one
   * `PresetRecord` the catalogue accepts, checked with `fitsFrame(record,
   * presetRecordBytes)` by the editor before sending and by the catalogue's
   * validation (`texts.presetTooLarge`). The per-field bounds alone allow
   * about 31.6 KB at three bytes a unit (measured in W5.0-settle with the
   * smallcaps encoding, 16 template objects); this whole-record bound keeps
   * 2,048 bytes of `frameBytes` for the CapTP or OCapN envelope, the handles
   * and the fields `describe()` adds (`builtIn`, `revision`, `available`,
   * `unavailableReason`), so every saved preset's `PresetView` fits a frame.
   */
  presetRecordBytes: limits.frameBytes - 2048,
  /** An endowment's or an inventory entry's label (Fae: 80 characters). */
  endowmentLabelUnits: 80,
  /** Endowments a preset adds (R3-22 default 32). */
  maxEndowments: 32,
  /** Template objects a preset selects (Fae: 16). */
  maxTemplateObjects: 16,
  /** A template object's kind (`git-workspace`, `development-environment`, ...). */
  templateKindUnits: 64,

  // ---- operator inventory (factory vat; P-52 mapping, R6-40) ----
  /** Entries the operator inventory keeps (M12 Home watches 1,000). */
  maxInventoryEntries: 1024,
  /** Entries in one `Inventory.list` page, and in one `addAll` batch. */
  inventoryPageEntries: 50,

  // ---- the session's label map (session vat; R3-1, R3-31) ----
  /**
   * Labels one session holds at once: preset objects, endowments, adopted
   * attachments, stored values. A bound on retained state (owner's PR 1248
   * rule), not on how many were ever made: `remove` frees a slot.
   */
  maxLabels: 256,
  /** One stored JSON value (model text, never parsed in the session vat). */
  labelValueBytes: limits.inlineBytes,
  /** All stored JSON values of one session together. */
  labelJsonBytes: 262_144,
  /** A method name rendered for a remote capability. */
  methodNameUnits: 128,
  /** Method names rendered for a remote capability (exec/render.js keeps 128). */
  maxMethodNames: 128,

  // ---- granted tools (session vat; R3-6, P-65) ----
  /** Grants a session keeps, offered or not (withdrawn ones are dropped). */
  maxGrantedTools: 32,
  /**
   * A granted tool's description as offered to the model (R3-27 allows
   * 16,384; cut here with the R4-46 marker so that the round request stays
   * within a frame). Open decision O-6.
   */
  grantedDescriptionUnits: 1024,
  /** A granted tool's JSON Schema text; a longer one is refused. */
  grantedParametersUnits: 2048,
  /**
   * UTF-8 bytes of granted tools' descriptions in one round request; tools
   * past it are not offered that round (`refused-budget`), newest first.
   */
  roundGrantedToolBytes: 12_288,

  // ---- mentions and packages (session vat; R3-8, R3-9, R4-29, R4-99) ----
  /** Attachments one message carries (R3-9, R4-99). */
  maxAttachments: 32,
  /** Message text of a message with attachments (R3-9: 64,000 characters). */
  packageTextUnits: 64_000,

  // ---- the inspector (exec vat answers for the session; D-M5-2) ----
  /** Inspector calls a session has in flight at once (callWindow). */
  inspectWindow: limits.callWindow,
  /** `describeCapability` documentation (Fae: 8,000 characters). */
  describeDocumentationUnits: 8000,
  /** `describeCapability` and `readSources` JSON results (Fae: 48,000). */
  inspectResultUnits: 48_000,
  /** `readSources` items per call (Fae: 1-8). */
  readSourcesItems: 8,
  /** `readSources` lines per item (Fae: 1-200, default 80). */
  readSourcesLineCount: 200,
  /** `readSources` default line count. */
  readSourcesDefaultLines: 80,
  /** `readSources` largest start line (Fae: 1,000,000). */
  readSourcesMaxStartLine: 1_000_000,
  /** `readSources` text per item (Fae: 8,000 characters). */
  readSourcesItemUnits: 8000,
  /** `readSources` path segments (Fae: 1-64) and segment length (1-255). */
  readSourcesPathSegments: 64,
  pathSegmentUnits: 255,
  /** `readSources` literal search text (Fae: 1-256). */
  searchUnits: 256,

  // ---- the exec membrane (exec vat; D-M5-3, open decision O-9) ----
  /**
   * Estimated bytes (units x 3) of one message model code sends to an
   * object outside its exec vat: half a frame, so a receiving vat never
   * meets a message near the 94 KB halt point (fact 2).
   */
  membraneArgBytes: 12_288,
  /** Keys of one record in such a message. */
  membraneRecordKeys: 32,
  /** Record keys of one message, counted over every record in it. */
  membraneMessageKeys: 256,
  /** Nesting depth of one such message. */
  membraneDepth: 32,
});
