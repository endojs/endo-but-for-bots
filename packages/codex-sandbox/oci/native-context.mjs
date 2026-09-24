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
 * Select the supported native context at a completed rollout cut. This detects
 * ordinary stale/torn exports; it does not authenticate a hostile guest's data.
 * The caller supplies runtime identity. Returned base instructions are context
 * text, never authority to select a provider, model, tools, paths, or policies.
 * @param {string} jsonl Complete, bounded UTF-8 JSONL from the guest.
 * @param {{sessionId: string, turnId: string, cwd: string, cliVersion: string}} expected
 */
export const selectCodexNativeContext = (jsonl, expected) => {
  requireValue(
    record(expected) &&
      uuid(expected.sessionId) &&
      uuid(expected.turnId) &&
      typeof expected.cwd === 'string' &&
      expected.cwd.startsWith('/') &&
      expected.cliVersion === '0.152.0',
  );
  requireValue(
    typeof jsonl === 'string' &&
      jsonl.endsWith('\n') &&
      new TextEncoder().encode(jsonl).byteLength <= LIMIT,
  );
  const lines = jsonl.slice(0, -1).split('\n');
  const rows = lines.map(line => JSON.parse(line));
  requireValue(rows.length > 1);
  // Pinned 0.152.0 omits ordinals on rows appended after native restore.
  rows.forEach(assertRow);
  const meta = rows[0];
  requireValue(
    meta.type === 'session_meta' &&
      (!Object.hasOwn(meta, 'ordinal') || meta.ordinal === 0) &&
      meta.payload.id === expected.sessionId &&
      meta.payload.session_id === expected.sessionId &&
      meta.payload.cli_version === expected.cliVersion &&
      meta.payload.cwd === expected.cwd &&
      record(meta.payload.base_instructions) &&
      typeof meta.payload.base_instructions.text === 'string',
  );
  /** @type {string|undefined} */
  let active;
  /** @type {string|undefined} */
  let completed;
  const turns = new Set();
  /** @type {string[]} */
  let selected = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const { payload } = row;
    if (row.type === 'event_msg') {
      requireValue(typeof payload.type === 'string');
      if (payload.type === 'task_started') {
        requireValue(
          active === undefined &&
            uuid(payload.turn_id) &&
            !turns.has(payload.turn_id),
        );
        active = payload.turn_id;
        turns.add(active);
      } else if (payload.type === 'task_complete') {
        requireValue(active !== undefined && payload.turn_id === active);
        completed = active;
        active = undefined;
      } else {
        // Rollback, interruption and unknown transitions require their own
        // reconstruction rule; they are not harmless event omissions.
        requireValue(observationEvents.has(payload.type));
        if (payload.turn_id !== undefined)
          requireValue(payload.turn_id === active);
        if (payload.thread_id !== undefined)
          requireValue(payload.thread_id === expected.sessionId);
      }
    } else if (row.type === 'turn_context') {
      assertContextRow(row, expected.cwd);
      requireValue(
        active === undefined ? turns.size === 0 : payload.turn_id === active,
      );
      // Pinned replay uses both baseline records to avoid injecting duplicate
      // environment/developer messages. They are context, not launch authority.
      selected.push(lines[index]);
    } else if (row.type === 'world_state') {
      requireValue(active !== undefined || turns.size === 0);
      selected.push(lines[index]);
    } else if (row.type === 'response_item' || row.type === 'compacted') {
      assertContextRow(row, expected.cwd);
      // Imported context may precede the first turn. New context after an
      // already completed turn requires a new explicit task_started record.
      requireValue(active !== undefined || turns.size === 0);
      if (row.type === 'response_item') {
        selected.push(lines[index]);
      } else {
        selected = [lines[index]];
      }
    } else {
      // Unknown rows might change context (including queued/rollback state).
      requireValue(false);
    }
  }
  requireValue(
    active === undefined &&
      completed === expected.turnId &&
      selected.length > 0,
  );
  return Object.freeze({
    sessionId: expected.sessionId,
    turnId: expected.turnId,
    baseInstructions: meta.payload.base_instructions.text,
    payload: `${selected.join('\n')}\n`,
  });
};
// Also loaded by plain Node inside OCI images, which has no SES globals.
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
