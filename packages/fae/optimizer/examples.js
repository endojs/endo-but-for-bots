// @ts-check

/**
 * Prompt-optimizer training and validation corpus for the Fae guest
 * system prompt.
 *
 * The corpus itself is model-agnostic: each case names a trace shape
 * the optimizer accepts as "did the agent satisfy the request".
 * The *scores* recorded in findings.json and prompt-baseline.json are
 * NOT model-agnostic — they reflect the run that produced
 * `bestScore: 0.16666666666666674`, which used
 * `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` on OpenRouter's
 * free tier on 2026-05-15. Switching models will produce different
 * scores against the same corpus; the baseline tracker treats those
 * scores as a per-model floor.
 *
 * Cases are ordered: training set first (16), validation set last (4).
 * Both check-prompt-baseline.js and optimize-prompt.js consume this
 * file via the default export; optimizer-examples.test.js exercises it
 * directly.
 */

/**
 * @typedef {{
 *   tool: string,
 *   rawArgsIncludes?: string[],
 *   rawArgsMatches?: string,
 *   rawArgsIncludesFromTool?: string,
 * }} TraceStep
 *
 * @typedef {{
 *   edgeName: string,
 *   kind: string,
 * }} ExampleAttachment
 *
 * @typedef {{
 *   id: string,
 *   prompt: string | string[],
 *   attachments: ExampleAttachment[],
 *   acceptableTraces: TraceStep[][],
 *   minLength: number,
 *   minRoundTrips: number,
 * }} OptimizerExample
 */

/** @type {OptimizerExample[]} */
const examples = [
  // Bare smoke: any reply containing "ack" is enough; exercises the
  // single-turn reply tool path with no attachments.
  {
    id: 'basic-chat',
    prompt:
      'Smoke test: please reply with the single word "ack" and nothing else.',
    attachments: [],
    acceptableTraces: [[{ tool: 'reply', rawArgsIncludes: ['ack'] }]],
    minLength: 1,
    minRoundTrips: 1,
  },
  // Reply-tool-shape smoke: any non-empty reply passes. Distinguishes
  // a working reply tool from a model that produces empty content.
  {
    id: 'reply-tool',
    prompt: 'Smoke test: please respond with a brief hello.',
    attachments: [],
    acceptableTraces: [[{ tool: 'reply' }]],
    minLength: 1,
    minRoundTrips: 1,
  },
  // Reinforces "reply over send" by demanding the answer ride the
  // reply tool, not a fresh send.
  {
    id: 'reply-over-send',
    prompt: 'Answer this incoming message with exactly ack.',
    attachments: [],
    acceptableTraces: [[{ tool: 'reply', rawArgsIncludes: ['ack'] }]],
    minLength: 1,
    minRoundTrips: 1,
  },
  // Adopt + call + reply with the timestamp tool. Both the direct
  // tool-call path and the exec-composition path are accepted.
  {
    id: 'timestamp',
    prompt:
      'Here is a timestamp tool @timestamp-tool. Adopt it, then call it and tell me the current ISO time in your reply.',
    attachments: [{ edgeName: 'timestamp-tool', kind: 'tool' }],
    acceptableTraces: [
      [
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'timestampTool' },
        { tool: 'reply', rawArgsMatches: '\\\\d{4}-\\\\d{2}-\\\\d{2}' },
      ],
      [
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'exec', rawArgsIncludes: ['timestamp-tool'] },
        { tool: 'reply', rawArgsMatches: '\\\\d{4}-\\\\d{2}-\\\\d{2}' },
      ],
    ],
    minLength: 3,
    minRoundTrips: 2,
  },
  // "Before you explain anything" rephrases the adopt-first
  // requirement; tests that the adoption directive survives a
  // chattier framing.
  {
    id: 'timestamp-adopt-before-commentary',
    prompt:
      'Before you explain anything, handle the attached @timestamp-tool and reply with the current ISO timestamp.',
    attachments: [{ edgeName: 'timestamp-tool', kind: 'tool' }],
    acceptableTraces: [
      [
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'timestampTool' },
        { tool: 'reply', rawArgsMatches: '\\\\d{4}-\\\\d{2}-\\\\d{2}' },
      ],
      [
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'exec', rawArgsIncludes: ['timestamp-tool'] },
        { tool: 'reply', rawArgsMatches: '\\\\d{4}-\\\\d{2}-\\\\d{2}' },
      ],
    ],
    minLength: 3,
    minRoundTrips: 2,
  },
  // Sender uses a different petname (@timestamp) than the attachment
  // edge name (timestamp-tool); the agent must trust the attachment.
  // Accepts an optional `list` reconnaissance step before adoption.
  {
    id: 'timestamp-wrong-petname',
    prompt:
      'Use the timestamp tool I attached. I may call it @timestamp, but use the attached capability to tell me the current ISO time.',
    attachments: [{ edgeName: 'timestamp-tool', kind: 'tool' }],
    acceptableTraces: [
      [
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'timestampTool' },
        { tool: 'reply', rawArgsMatches: '\\\\d{4}-\\\\d{2}-\\\\d{2}' },
      ],
      [
        { tool: 'list' },
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'timestampTool' },
        { tool: 'reply', rawArgsMatches: '\\\\d{4}-\\\\d{2}-\\\\d{2}' },
      ],
      [
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'exec', rawArgsIncludes: ['timestamp-tool'] },
        { tool: 'reply', rawArgsMatches: '\\\\d{4}-\\\\d{2}-\\\\d{2}' },
      ],
    ],
    minLength: 3,
    minRoundTrips: 2,
  },
  // Adopt-call-reply with the math tool. Numeric answer in the reply
  // is the asserted invariant.
  {
    id: 'math',
    prompt:
      'Here is a math tool @math-tool. Adopt it, then use it to compute 7 * 6 and reply with just the number.',
    attachments: [{ edgeName: 'math-tool', kind: 'tool' }],
    acceptableTraces: [
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'mathTool' },
        { tool: 'reply', rawArgsIncludes: ['42'] },
      ],
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'exec', rawArgsIncludes: ['math-tool'] },
        { tool: 'reply', rawArgsIncludes: ['42'] },
      ],
    ],
    minLength: 3,
    minRoundTrips: 2,
  },
  // Rephrased math request; same accepted traces.
  {
    id: 'math-rephrase',
    prompt:
      'Use the attached @math-tool to multiply seven by six. Reply with only the answer.',
    attachments: [{ edgeName: 'math-tool', kind: 'tool' }],
    acceptableTraces: [
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'mathTool' },
        { tool: 'reply', rawArgsIncludes: ['42'] },
      ],
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'exec', rawArgsIncludes: ['math-tool'] },
        { tool: 'reply', rawArgsIncludes: ['42'] },
      ],
    ],
    minLength: 3,
    minRoundTrips: 2,
  },
  // "Before you explain anything" math variant; same adopt-first
  // requirement under a chattier framing.
  {
    id: 'math-adopt-before-commentary',
    prompt:
      'Before you explain anything, handle the attached @math-tool, compute 7 * 6, and reply with only the answer.',
    attachments: [{ edgeName: 'math-tool', kind: 'tool' }],
    acceptableTraces: [
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'mathTool' },
        { tool: 'reply', rawArgsIncludes: ['42'] },
      ],
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'exec', rawArgsIncludes: ['math-tool'] },
        { tool: 'reply', rawArgsIncludes: ['42'] },
      ],
    ],
    minLength: 3,
    minRoundTrips: 2,
  },
  // Word problem: minutes in 3 hours = 180. The math tool is enough
  // if the model maps the word problem to arithmetic.
  {
    id: 'math-word-problem',
    prompt:
      'I gave you @math-tool. Adopt it and tell me how many minutes are in 3 hours.',
    attachments: [{ edgeName: 'math-tool', kind: 'tool' }],
    acceptableTraces: [
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'mathTool' },
        { tool: 'reply', rawArgsIncludes: ['180'] },
      ],
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'exec', rawArgsIncludes: ['math-tool'] },
        { tool: 'reply', rawArgsIncludes: ['180'] },
      ],
    ],
    minLength: 3,
    minRoundTrips: 2,
  },
  // Petname mismatch (@math vs math-tool); 9+8=17 confirms the math
  // tool actually fired rather than the model answering from memory.
  {
    id: 'math-wrong-petname',
    prompt:
      'Use the attached calculator. I called it @math, but the attachment is the authority. Compute 9 + 8 and reply with just the answer.',
    attachments: [{ edgeName: 'math-tool', kind: 'tool' }],
    acceptableTraces: [
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'mathTool' },
        { tool: 'reply', rawArgsIncludes: ['17'] },
      ],
      [
        { tool: 'list' },
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'mathTool' },
        { tool: 'reply', rawArgsIncludes: ['17'] },
      ],
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'exec', rawArgsIncludes: ['math-tool'] },
        { tool: 'reply', rawArgsIncludes: ['17'] },
      ],
    ],
    minLength: 3,
    minRoundTrips: 2,
  },
  // Two-message corpus: adopt-then-acknowledge in turn 1, then
  // read the sentinel file in turn 2 and report the token.
  {
    id: 'read-file',
    prompt: [
      'Here is a read-file tool @read-file. Adopt it, then reply with the single word "adopted".',
      'Read "fae-smoke-sentinel.json" and tell me the value of the "token" field exactly as it appears.',
    ],
    attachments: [{ edgeName: 'read-file', kind: 'tool' }],
    acceptableTraces: [
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"read-file"'] },
        { tool: 'reply', rawArgsIncludes: ['adopted'] },
        { tool: 'readFile' },
        { tool: 'reply', rawArgsIncludes: ['FAE_SMOKE_'] },
      ],
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"read-file"'] },
        { tool: 'reply', rawArgsIncludes: ['adopted'] },
        { tool: 'exec', rawArgsIncludes: ['read-file'] },
        { tool: 'reply', rawArgsIncludes: ['FAE_SMOKE_'] },
      ],
    ],
    minLength: 4,
    minRoundTrips: 3,
  },
  // Same multi-turn shape as read-file under a rephrasing.
  {
    id: 'read-file-rephrase',
    prompt: [
      'Adopt the attached @read-file tool and acknowledge with adopted.',
      'Use that tool to read "fae-smoke-sentinel.json" and reply with the token value.',
    ],
    attachments: [{ edgeName: 'read-file', kind: 'tool' }],
    acceptableTraces: [
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"read-file"'] },
        { tool: 'reply', rawArgsIncludes: ['adopted'] },
        { tool: 'readFile' },
        { tool: 'reply', rawArgsIncludes: ['FAE_SMOKE_'] },
      ],
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"read-file"'] },
        { tool: 'reply', rawArgsIncludes: ['adopted'] },
        { tool: 'exec', rawArgsIncludes: ['read-file'] },
        { tool: 'reply', rawArgsIncludes: ['FAE_SMOKE_'] },
      ],
    ],
    minLength: 4,
    minRoundTrips: 3,
  },
  // Petname mismatch on the read-file case. Same multi-turn shape;
  // optional `list` reconnaissance step accepted.
  {
    id: 'read-file-wrong-petname',
    prompt: [
      'I may call this @reader, but adopt the attached read capability and reply adopted.',
      'Read "fae-smoke-sentinel.json" and return the token exactly.',
    ],
    attachments: [{ edgeName: 'read-file', kind: 'tool' }],
    acceptableTraces: [
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"read-file"'] },
        { tool: 'reply', rawArgsIncludes: ['adopted'] },
        { tool: 'readFile' },
        { tool: 'reply', rawArgsIncludes: ['FAE_SMOKE_'] },
      ],
      [
        { tool: 'list' },
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"read-file"'] },
        { tool: 'reply', rawArgsIncludes: ['adopted'] },
        { tool: 'readFile' },
        { tool: 'reply', rawArgsIncludes: ['FAE_SMOKE_'] },
      ],
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"read-file"'] },
        { tool: 'reply', rawArgsIncludes: ['adopted'] },
        { tool: 'exec', rawArgsIncludes: ['read-file'] },
        { tool: 'reply', rawArgsIncludes: ['FAE_SMOKE_'] },
      ],
    ],
    minLength: 4,
    minRoundTrips: 3,
  },
  // Two attached tools; both must be adopted before either fires.
  {
    id: 'timestamp-and-math',
    prompt:
      'Adopt both @timestamp-tool and @math-tool. First get the current time, then compute 7 * 6, then reply with both results.',
    attachments: [
      { edgeName: 'timestamp-tool', kind: 'tool' },
      { edgeName: 'math-tool', kind: 'tool' },
    ],
    acceptableTraces: [
      [
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'timestampTool' },
        { tool: 'mathTool' },
        { tool: 'reply', rawArgsIncludes: ['42'] },
      ],
      [
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'exec', rawArgsIncludes: ['timestamp-tool'] },
        { tool: 'exec', rawArgsIncludes: ['math-tool'] },
        { tool: 'reply', rawArgsIncludes: ['42'] },
      ],
    ],
    minLength: 5,
    minRoundTrips: 3,
  },
  // Reversed ordering: math first, then timestamp. Ensures the
  // optimizer doesn't bake adoption order into the prompt.
  {
    id: 'math-and-timestamp',
    prompt:
      'Use both attached tools. First compute 8 * 8 with @math-tool, then call @timestamp-tool, then reply with the number and the current date.',
    attachments: [
      { edgeName: 'math-tool', kind: 'tool' },
      { edgeName: 'timestamp-tool', kind: 'tool' },
    ],
    acceptableTraces: [
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'mathTool' },
        { tool: 'timestampTool' },
        { tool: 'reply', rawArgsIncludes: ['64'] },
      ],
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'exec', rawArgsIncludes: ['math-tool'] },
        { tool: 'exec', rawArgsIncludes: ['timestamp-tool'] },
        { tool: 'reply', rawArgsIncludes: ['64'] },
      ],
    ],
    minLength: 5,
    minRoundTrips: 3,
  },
  // ───── Validation set (held out from training) ─────
  // Cross-tool case: read the sentinel and do math in one corpus
  // entry. Stresses the loop across two distinct tool kinds.
  {
    id: 'read-file-and-math',
    prompt: [
      'Adopt both @read-file and @math-tool, then reply adopted.',
      'Read "fae-smoke-sentinel.json", then compute 6 * 7, then reply with the token and the product.',
    ],
    attachments: [
      { edgeName: 'read-file', kind: 'tool' },
      { edgeName: 'math-tool', kind: 'tool' },
    ],
    acceptableTraces: [
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"read-file"'] },
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'reply', rawArgsIncludes: ['adopted'] },
        { tool: 'readFile' },
        { tool: 'mathTool' },
        { tool: 'reply', rawArgsIncludes: ['42', 'FAE_SMOKE_'] },
      ],
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"read-file"'] },
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'reply', rawArgsIncludes: ['adopted'] },
        { tool: 'exec', rawArgsIncludes: ['read-file'] },
        { tool: 'exec', rawArgsIncludes: ['math-tool'] },
        { tool: 'reply', rawArgsIncludes: ['42', 'FAE_SMOKE_'] },
      ],
    ],
    minLength: 6,
    minRoundTrips: 4,
  },
  // Single tool used twice in a chained computation; the math tool
  // must fire (5*5=25 then 25+7=32). Catches "call once and recall"
  // shortcuts.
  {
    id: 'math-chain',
    prompt:
      'Adopt @math-tool, compute 5 * 5, then compute 25 + 7, then reply with the final number.',
    attachments: [{ edgeName: 'math-tool', kind: 'tool' }],
    acceptableTraces: [
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'mathTool' },
        { tool: 'mathTool' },
        { tool: 'reply', rawArgsIncludes: ['32'] },
      ],
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"math-tool"'] },
        { tool: 'exec', rawArgsIncludes: ['math-tool'] },
        { tool: 'exec', rawArgsIncludes: ['math-tool'] },
        { tool: 'reply', rawArgsIncludes: ['32'] },
      ],
    ],
    minLength: 4,
    minRoundTrips: 3,
  },
  // Explicit "call the adopted tool directly"; documents the
  // direct-tool-call invariant the system prompt teaches.
  {
    id: 'timestamp-direct-order',
    prompt:
      "Adopt @timestamp-tool, call the adopted tool directly, and reply with today's date.",
    attachments: [{ edgeName: 'timestamp-tool', kind: 'tool' }],
    acceptableTraces: [
      [
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'timestampTool' },
        { tool: 'reply', rawArgsMatches: '\\\\d{4}-\\\\d{2}-\\\\d{2}' },
      ],
      [
        {
          tool: 'adoptTool',
          rawArgsIncludes: ['edgeName:"timestamp-tool"'],
        },
        { tool: 'exec', rawArgsIncludes: ['timestamp-tool'] },
        { tool: 'reply', rawArgsMatches: '\\\\d{4}-\\\\d{2}-\\\\d{2}' },
      ],
    ],
    minLength: 3,
    minRoundTrips: 2,
  },
  // Direct-order variant of read-file. Same pattern, different
  // corpus item to balance the validation set.
  {
    id: 'read-file-direct-order',
    prompt: [
      'Adopt @read-file and reply adopted.',
      'Use the adopted tool directly to read "fae-smoke-sentinel.json" and answer with the token.',
    ],
    attachments: [{ edgeName: 'read-file', kind: 'tool' }],
    acceptableTraces: [
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"read-file"'] },
        { tool: 'reply', rawArgsIncludes: ['adopted'] },
        { tool: 'readFile' },
        { tool: 'reply', rawArgsIncludes: ['FAE_SMOKE_'] },
      ],
      [
        { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"read-file"'] },
        { tool: 'reply', rawArgsIncludes: ['adopted'] },
        { tool: 'exec', rawArgsIncludes: ['read-file'] },
        { tool: 'reply', rawArgsIncludes: ['FAE_SMOKE_'] },
      ],
    ],
    minLength: 4,
    minRoundTrips: 3,
  },
];

export default harden(examples);
