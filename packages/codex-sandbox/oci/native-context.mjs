// @ts-check
// Data selection only: no filesystem access, runtime authority, or effect evidence.

const LIMIT = 16 * 1024 * 1024;
const uuid = value =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const record = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const requireValue = condition => {
  if (!condition) throw Error('Unsupported or incomplete Codex native context');
};
// Names from the pinned 0.152.0 RawResponseItemCompletedNotification schema.
// Preserve each supported item's fields verbatim, including opaque encrypted data.
const itemTypes = new Set([
  'message',
  'reasoning',
  'local_shell_call',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'tool_search_call',
  'tool_search_output',
  'web_search_call',
  'image_generation_call',
  'compaction',
  'compaction_trigger',
  'context_compaction',
]);
const assertItem = item =>
  requireValue(record(item) && itemTypes.has(item.type));

const assertRow = row => {
  requireValue(
    record(row) &&
      (!Object.hasOwn(row, 'ordinal') ||
        (Number.isInteger(row.ordinal) && row.ordinal >= 0)) &&
      typeof row.timestamp === 'string' &&
      record(row.payload),
  );
};

const assertContextRow = (row, cwd) => {
  assertRow(row);
  if (row.type === 'response_item') assertItem(row.payload);
  else if (row.type === 'compacted') {
    requireValue(
      typeof row.payload.message === 'string' &&
        Array.isArray(row.payload.replacement_history) &&
        row.payload.replacement_history.length > 0,
    );
    row.payload.replacement_history.forEach(assertItem);
  } else if (row.type === 'turn_context') {
    requireValue(uuid(row.payload.turn_id) && row.payload.cwd === cwd);
  } else requireValue(row.type === 'world_state');
};

// Pinned observation events do not alter the reconstructed native context.
// This deliberately does not claim support for every tool/transition event:
// a new event must be classified before its context effects can be ignored.
const observationEvents = new Set([
  'user_message',
  'agent_message',
  'item_completed',
  'token_count',
  'thread_settings_applied',
]);

/**
 * Incrementally select context, bounding rows and the current retained cut,
 * not the physical lifetime of a rollout. No guest authenticity is implied.
 * @param {{sessionId: string, turnId: string, cwd: string, cliVersion: string}} expected
 */
export const makeCodexNativeContextSelector = expected => {
  requireValue(
    record(expected) &&
      uuid(expected.sessionId) &&
      uuid(expected.turnId) &&
      typeof expected.cwd === 'string' &&
      expected.cwd.startsWith('/') &&
      expected.cliVersion === '0.152.0',
  );
  let initialized = false;
  let refused = false;
  let finished = false;
  let started = false;
  let seenExpected = false;
  /** @type {string|undefined} */
  let active;
  /** @type {string|undefined} */
  let completed;
  let baseInstructions = '';
  let baseBytes = 0;
  let selectedBytes = 0;
  let overflow = false;
  /** @type {string[]} */
  let selected = [];
  const retain = (line, bytes, reset = false) => {
    if (reset) {
      selected = [];
      selectedBytes = 0;
      overflow = false;
    }
    if (overflow) return;
    if (baseBytes + selectedBytes + bytes > LIMIT) {
      // Discard the unsupported current cut, but continue structural parsing:
      // a later compaction may replace it with a bounded supported context.
      selected = [];
      selectedBytes = 0;
      overflow = true;
      return;
    }
    selected.push(line);
    selectedBytes += bytes;
  };
  /** @param {string} line A complete JSONL row, without its newline. */
  const accept = line => {
    requireValue(!refused && !finished);
    try {
      requireValue(typeof line === 'string' && !line.includes('\n'));
      const bytes = new TextEncoder().encode(line).byteLength + 1;
      requireValue(bytes <= LIMIT);
      const row = JSON.parse(line);
      assertRow(row);
      const { payload } = row;
      if (!initialized) {
        requireValue(
          row.type === 'session_meta' &&
            (!Object.hasOwn(row, 'ordinal') || row.ordinal === 0) &&
            payload.id === expected.sessionId &&
            payload.session_id === expected.sessionId &&
            payload.cli_version === expected.cliVersion &&
            payload.cwd === expected.cwd &&
            record(payload.base_instructions) &&
            typeof payload.base_instructions.text === 'string',
        );
        baseInstructions = payload.base_instructions.text;
        baseBytes = new TextEncoder().encode(baseInstructions).byteLength;
        initialized = true;
        return;
      }
      if (row.type === 'event_msg') {
        requireValue(typeof payload.type === 'string');
        if (payload.type === 'task_started') {
          requireValue(
            active === undefined &&
              uuid(payload.turn_id) &&
              payload.turn_id !== completed,
          );
          if (payload.turn_id === expected.turnId) {
            requireValue(!seenExpected);
            seenExpected = true;
          }
          active = payload.turn_id;
          started = true;
        } else if (payload.type === 'task_complete') {
          requireValue(active !== undefined && payload.turn_id === active);
          completed = active;
          active = undefined;
        } else {
          requireValue(observationEvents.has(payload.type));
          if (payload.turn_id !== undefined)
            requireValue(payload.turn_id === active);
          if (payload.thread_id !== undefined)
            requireValue(payload.thread_id === expected.sessionId);
        }
      } else if (row.type === 'turn_context') {
        assertContextRow(row, expected.cwd);
        requireValue(
          active === undefined ? !started : payload.turn_id === active,
        );
        retain(line, bytes);
      } else if (row.type === 'world_state') {
        requireValue(active !== undefined || !started);
        retain(line, bytes);
      } else if (row.type === 'response_item' || row.type === 'compacted') {
        assertContextRow(row, expected.cwd);
        requireValue(active !== undefined || !started);
        retain(line, bytes, row.type === 'compacted');
      } else requireValue(false);
    } catch (error) {
      refused = true;
      throw error;
    }
  };
  const finish = () => {
    requireValue(!refused && !finished);
    finished = true;
    requireValue(
      initialized &&
        active === undefined &&
        completed === expected.turnId &&
        !overflow &&
        selected.length > 0,
    );
    return Object.freeze({
      sessionId: expected.sessionId,
      turnId: expected.turnId,
      baseInstructions,
      payload: `${selected.join('\n')}\n`,
    });
  };
  return Object.freeze({ accept, finish });
};
if (typeof harden === 'function') harden(makeCodexNativeContextSelector);

/**
 * Whole-string convenience API; capture I/O uses the incremental selector.
 * @param {string} jsonl Complete native JSONL.
 * @param {{sessionId: string, turnId: string, cwd: string, cliVersion: string}} expected
 */
export const selectCodexNativeContext = (jsonl, expected) => {
  requireValue(typeof jsonl === 'string' && jsonl.endsWith('\n'));
  const selector = makeCodexNativeContextSelector(expected);
  let start = 0;
  for (;;) {
    const end = jsonl.indexOf('\n', start);
    if (end < 0) break;
    selector.accept(jsonl.slice(start, end));
    start = end + 1;
  }
  return selector.finish();
};
if (typeof harden === 'function') harden(selectCodexNativeContext);

/**
 * Render a context projection under a fresh host-selected identity. Native
 * baseline rows and base instruction text are context, not launch authority.
 * Never copy a guest's session metadata, dynamic tool catalog, or queued events.
 * No filesystem operations occur here. The caller binds model, policy and
 * provider configuration separately when resuming the projected thread.
 * @param {ReturnType<typeof selectCodexNativeContext>} capture
 * @param {{sessionId: string, cwd: string, modelProvider: string, timestamp: string,
 * dynamicTools: readonly {type?: string, name: string, description: string, inputSchema: object}[]}} target Host configuration, not transcript metadata.
 */
export const renderCodexNativeContext = (capture, target) => {
  requireValue(
    record(capture) &&
      uuid(capture.sessionId) &&
      uuid(capture.turnId) &&
      typeof capture.baseInstructions === 'string' &&
      typeof capture.payload === 'string',
  );
  requireValue(
    record(target) &&
      uuid(target.sessionId) &&
      target.sessionId !== capture.sessionId &&
      typeof target.cwd === 'string' &&
      target.cwd.startsWith('/') &&
      typeof target.modelProvider === 'string' &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(target.modelProvider) &&
      typeof target.timestamp === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(target.timestamp) &&
      new Date(target.timestamp).toISOString() === target.timestamp &&
      Array.isArray(target.dynamicTools),
  );
  requireValue(
    capture.payload.endsWith('\n') &&
      new TextEncoder().encode(capture.payload).byteLength <= LIMIT &&
      new TextEncoder().encode(capture.baseInstructions).byteLength <= LIMIT,
  );
  const rows = capture.payload
    .slice(0, -1)
    .split('\n')
    .map(line => JSON.parse(line));
  for (const [index, row] of rows.entries()) {
    assertContextRow(row, target.cwd);
    requireValue(row.type !== 'compacted' || index === 0);
  }
  const names = new Set();
  const dynamicTools = target.dynamicTools.map(tool => {
    requireValue(
      record(tool) &&
        (tool.type === undefined || tool.type === 'function') &&
        typeof tool.name === 'string' &&
        tool.name.length > 0 &&
        !names.has(tool.name) &&
        typeof tool.description === 'string' &&
        record(tool.inputSchema),
    );
    names.add(tool.name);
    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
  });
  const meta = {
    timestamp: target.timestamp,
    ordinal: 0,
    type: 'session_meta',
    payload: {
      id: target.sessionId,
      session_id: target.sessionId,
      timestamp: target.timestamp,
      cwd: target.cwd,
      originator: 'endo',
      cli_version: '0.152.0',
      source: 'vscode',
      model_provider: target.modelProvider,
      base_instructions: { text: capture.baseInstructions },
      dynamic_tools: dynamicTools,
    },
  };
  const transcript = `${JSON.stringify(meta)}\n${capture.payload}`;
  requireValue(new TextEncoder().encode(transcript).byteLength <= LIMIT);
  return Object.freeze({ sessionId: target.sessionId, transcript });
};
if (typeof harden === 'function') harden(renderCodexNativeContext);
