// @ts-check
/**
 * `viewImage` as the session vat offers it: the description, the closed
 * argument names, the one argument text the vat checks, and the image
 * limits (the M8 contract, `designs/m8-interfaces.md` sections 3.4, 6 and
 * 9; P-37; R3-30, R4-39).
 *
 * Image bytes never enter a vat (architecture section 0, the frame ceiling
 * CC-027): the session vat resolves the label and hands the target object
 * to the agent-host adapter's `ImageTool`, which reads the bytes, checks
 * them and stages the envelope as a Blob; the vat sees a `ToolOutcome`
 * whose text is that StagedText, with the receipt as its preview.
 *
 * Only what the session program needs lives here (its bundle is shared by
 * M6, M8 and M9, contract section 9): the envelope, the `ImageTool` and
 * `ImageSource` guards and the adapter's texts are in the Node-only
 * `../image-guards.js`. Constants only. The fold moves these entries into
 * `./session.js` and `../limits.js` (contract section 18).
 *
 * Guest rules.
 */

// ---------------------------------------------------------------- limits

export const imageLimits = harden({
  /** R4-39: the largest image, bytes (hosted-agent `image-result.js:8`). */
  maxImageBytes: 2 * 1024 * 1024,
  /**
   * Raw bytes asked of an `ImageSource` per `readBase64` call (an answer
   * of 262,144 base64 characters; it travels toward the adapter, never
   * into a vat).
   */
  readPageBytes: 196_608,
  /** Empty pages before a source is refused (Fae `image-tool.js:125`). */
  maxEmptyReads: 64,
  /** The whole read, from the first call to the last page (ms). */
  readTimeoutMs: 30_000,
  /**
   * Images sent natively per provider request, newest first; older image
   * results are sent as their receipt (contract D-M8-9, open question Q-2).
   */
  imagesPerRequest: 20,
  /** `petName` (Fae `image-tool.js:46`). */
  petNameUnits: 256,
  /** `path` segments and their length (Fae `image-tool.js:51-53`). */
  pathSegments: 64,
  segmentUnits: 255,
  /**
   * The raw `path` text the vat passes on: the arguments of a local tool
   * are at most `inlineBytes` (staged arguments are refused, M5 2.4.2),
   * so a path of 64 segments of 255 characters is refused as too large;
   * the bound only caps the guard.
   */
  pathTextUnits: 8192,
});

// ---------------------------------------------------------------- the tool

/** Closed argument names (R3-26; Fae `image-tool.js:44-56`). */
export const viewImageArgumentNames = harden(['petName', 'path']);

/**
 * The tool as offered to the model (R3-30; Fae `image-tool.js:38-58`,
 * adapted: a held image source or a workspace, no Endo blob or mount).
 */
export const viewImageDescription = harden({
  name: 'viewImage',
  description:
    'Read a PNG, JPEG or WebP through an already-held capability and see it as image input (requires a vision-capable model). Use petName for an image source or a workspace; path is an optional array of relative file segments inside a workspace. Example: {"petName":"workspace","path":["screenshots","mobile.png"]}. Maximum 2 MiB; resize larger images first. For visual development, render in a browser, save desktop/mobile screenshots into the workspace, call viewImage, inspect browser errors, and iterate. Source code or a syntax check alone does not verify the rendered scene. This tool does not render HTML or fetch URLs.',
  parameters: JSON.stringify({
    type: 'object',
    additionalProperties: false,
    properties: {
      petName: { type: 'string', minLength: 1, maxLength: 256 },
      path: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: { type: 'string', minLength: 1, maxLength: 255 },
      },
    },
    required: ['petName'],
  }),
});

/** The argument text the vat checks before any send (Fae `image-tool.js:73`). */
export const viewImageTexts = harden({
  badPetName: 'petName must be a nonempty name of at most 256 characters',
});
