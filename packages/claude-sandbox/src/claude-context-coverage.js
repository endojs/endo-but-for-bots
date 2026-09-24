// @ts-check
import { Fail, b } from '@endo/errors';

const LIMIT = 16 * 1024 * 1024;
const isUuid = value =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
// Compare JSON structure, not object insertion order. Arrays, fields and
// scalar values remain exact. The byte-prefix receipt below is deliberately
// separate and still compares historical serialization byte for byte.
// Explicit traversal frames avoid recursive comparison on deeply nested tool
// input, and avoid queuing every child of a wide object at once.
const same = (left, right) => {
  const ancestorsLeft = new WeakSet();
  const ancestorsRight = new WeakSet();
  const stack = [];
  let a = left;
  let bValue = right;
  for (;;) {
    if (a !== bValue) {
      if (!a || !bValue || typeof a !== 'object' || typeof bValue !== 'object')
        return false;
      if (Array.isArray(a) !== Array.isArray(bValue)) return false;
      if (Array.isArray(a) && a.length !== bValue.length) return false;
      const keys = Object.keys(a);
      if (
        keys.length !== Object.keys(bValue).length ||
        keys.some(name => !Object.hasOwn(bValue, name))
      )
        return false;
      // Inputs are JSON records; reject cycles rather than inventing cyclic
      // equivalence if an internal caller violates that boundary.
      if (ancestorsLeft.has(a) || ancestorsRight.has(bValue)) return false;
      ancestorsLeft.add(a);
      ancestorsRight.add(bValue);
      stack.push({ left: a, right: bValue, keys, index: 0 });
    }
    let next = false;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index === frame.keys.length) {
        ancestorsLeft.delete(frame.left);
        ancestorsRight.delete(frame.right);
        stack.pop();
      } else {
        const name = frame.keys[frame.index];
        frame.index += 1;
        a = frame.left[name];
        bValue = frame.right[name];
        next = true;
        break;
      }
    }
    if (!next) return true;
  }
};

// Anthropic SDKRateLimitEvent / SDKRateLimitInfo is a capacity notification,
// not dialogue or a terminal result. Closed shape prevents hidden message or
// tool payloads from being silently treated as inert framing.
// https://app.unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.185/files/sdk.d.ts
const isRateLimitEvent = event => {
  const info = event.rate_limit_info;
  const status = value =>
    ['allowed', 'allowed_warning', 'rejected'].includes(value);
  const numeric = [
    'resetsAt',
    'utilization',
    'overageResetsAt',
    'surpassedThreshold',
  ];
  const boolean = [
    'isUsingOverage',
    'overageInUse',
    'canUserPurchaseCredits',
    'hasChargeableSavedPaymentMethod',
  ];
  const fields = [
    'status',
    'rateLimitType',
    'overageStatus',
    'overageDisabledReason',
    'errorCode',
    ...numeric,
    ...boolean,
  ];
  return (
    Object.keys(event).every(name =>
      ['type', 'rate_limit_info', 'uuid', 'session_id'].includes(name),
    ) &&
    isUuid(event.uuid) &&
    info &&
    typeof info === 'object' &&
    !Array.isArray(info) &&
    Object.keys(info).every(name => fields.includes(name)) &&
    status(info.status) &&
    numeric.every(
      name =>
        info[name] === undefined ||
        (typeof info[name] === 'number' &&
          Number.isFinite(info[name]) &&
          info[name] >= 0),
    ) &&
    boolean.every(
      name => info[name] === undefined || typeof info[name] === 'boolean',
    ) &&
    (info.rateLimitType === undefined ||
      [
        'five_hour',
        'seven_day',
        'seven_day_opus',
        'seven_day_sonnet',
        'overage',
      ].includes(info.rateLimitType)) &&
    (info.overageStatus === undefined || status(info.overageStatus)) &&
    (info.errorCode === undefined || info.errorCode === 'credits_required') &&
    (info.overageDisabledReason === undefined ||
      [
        'overage_not_provisioned',
        'org_level_disabled',
        'org_level_disabled_until',
        'out_of_credits',
        'seat_tier_level_disabled',
        'member_level_disabled',
        'seat_tier_zero_credit_limit',
        'group_zero_credit_limit',
        'member_zero_credit_limit',
        'org_service_level_disabled',
        'no_limits_configured',
        'fetch_error',
        'unknown',
      ].includes(info.overageDisabledReason))
  );
};

/**
 * Conservative coverage proof for the pinned CLI's mainline partial stream.
 * This does not establish signature validity, effect settlement, or producer
 * shutdown. Call only after an independently confirmed stopped producer and
 * pass a transcript already validated by the sandbox capture helper.
 * Unsupported framing is an availability failure, never a partial proof.
 * The caller must supply a trusted SHA-256 implementation and a pre-turn
 * receipt retained outside the guest. Hashing the candidate prefix to invent
 * its expected receipt would defeat historical coverage validation.
 * @param {{sha256: (text: string) => string}} powers UTF-8 text to lowercase SHA-256 hex.
 */
export const makeClaudeContextCoverage = ({ sha256 }) => {
  let refused = false;
  let bytes = 0;
  let session;
  let initialized = false;
  let terminal = false;
  /** @type {'success'|'failure'|undefined} */
  let outcome;
  /** @type {any} */
  let message;
  /** @type {any} */
  let block;
  let nextIndex = 0;
  /** @type {any} */
  let boundary;
  let boundaryPosition = -1;
  /** @type {Array<{uuid: string, role: string, content: any, messageId?: string, model?: string, messageType?: string}>} */
  const frames = [];
  const frameIds = new Set();
  const completedToolIds = new Set();
  const receivedToolResults = new Set();
  let diagnosticPhase = 'initial';
  let diagnosticCheck = 0;
  const requireValue = condition => {
    diagnosticCheck += 1;
    if (!condition) {
      refused = true;
      // Only static phase names and a local check ordinal. Never include
      // producer text, arguments, identifiers, payloads, or unknown event names.
      throw Fail`Claude native context coverage unavailable (${b(`phase=${diagnosticPhase}, check=${diagnosticCheck}`)})`;
    }
  };
  const guarded = operation => {
    requireValue(!refused);
    try {
      return operation();
    } catch (error) {
      refused = true;
      throw error;
    }
  };
  const charge = value => {
    bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
    requireValue(bytes <= LIMIT);
  };
  const validateUserContent = content => {
    requireValue(
      typeof content === 'string' ||
        (Array.isArray(content) &&
          content.every(item =>
            item.type === 'text'
              ? typeof item.text === 'string'
              : item.type === 'tool_result' &&
                typeof item.tool_use_id === 'string' &&
                (typeof item.content === 'string' ||
                  (Array.isArray(item.content) &&
                    item.content.every(
                      part =>
                        part.type === 'text' && typeof part.text === 'string',
                    ))),
          )),
    );
  };
  const completedBlock = () => {
    if (block.value.type !== 'tool_use') return block.value;
    // A tool called with no arguments streams no input JSON at all (or only
    // empty fragments). Its start block already carried exactly `{}`, which
    // the completed assistant block must still match field for field.
    const input = block.json === '' ? {} : JSON.parse(block.json);
    requireValue(input && typeof input === 'object' && !Array.isArray(input));
    return { ...block.value, input };
  };
  /** @param {any} event */
  const observe = event =>
    guarded(() => {
      diagnosticPhase = 'observe';
      diagnosticCheck = 0;
      charge(event);
      requireValue(event && typeof event === 'object');
      if (
        [
          'system',
          'result',
          'assistant',
          'user',
          'stream_event',
          // Named protocol categories do not themselves certify coverage.
          'rate_limit_event',
          'tool_progress',
          'tool_use_summary',
        ].includes(event.type)
      ) {
        diagnosticPhase = `observe/${event.type}`;
      }
      // Subagent events are not mainline dialogue. They cannot certify coverage.
      if (event.parent_tool_use_id) return;
      requireValue(!terminal && isUuid(event.session_id));
      if (session === undefined) session = event.session_id;
      requireValue(event.session_id === session);
      if (event.type === 'system') {
        if (
          ['init', 'compact_boundary', 'status', 'thinking_tokens'].includes(
            event.subtype,
          )
        ) {
          diagnosticPhase = `observe/system/${event.subtype}`;
        }
        if (event.subtype === 'init') {
          requireValue(!initialized && frames.length === 0 && !message);
          initialized = true;
        } else if (event.subtype === 'compact_boundary') {
          requireValue(initialized && !boundary && !message && !block);
          requireValue(isUuid(event.uuid) && isUuid(event.logical_parent_uuid));
          requireValue(event.compact_metadata?.trigger === 'auto');
          boundary = JSON.parse(JSON.stringify(event));
          boundaryPosition = frames.length;
        } else {
          requireValue(
            initialized &&
              ['status', 'thinking_tokens'].includes(event.subtype),
          );
        }
        return;
      }
      requireValue(initialized);
      if (event.type === 'rate_limit_event') {
        requireValue(isRateLimitEvent(event));
        // Never advances frames, block state, terminal state or success. Even
        // rejected capacity is not a replacement for the producer's result.
        return;
      }
      if (boundary && frames.length === boundaryPosition) {
        requireValue(
          event.type === 'user' &&
            event.isSynthetic === true &&
            event.uuid ===
              boundary.compact_metadata?.preserved_segment?.anchor_uuid,
        );
      }
      if (event.type === 'result') {
        requireValue(
          (event.is_error === false && event.subtype === 'success') ||
            (event.is_error === true &&
              typeof event.subtype === 'string' &&
              /^error_[a-z_]+$/.test(event.subtype)),
        );
        // A result's text can be separately displayed by the translator when
        // nothing streamed. Do not certify an unrepresented synthetic answer.
        requireValue(!message && !block && frames.length > 0);
        if (
          !event.is_error &&
          typeof event.result === 'string' &&
          event.result !== ''
        ) {
          requireValue(
            frames.some(
              frame =>
                frame.role === 'assistant' &&
                Array.isArray(frame.content) &&
                frame.content.some(
                  item => item.type === 'text' && item.text === event.result,
                ),
            ),
          );
        }
        terminal = true;
        outcome = event.is_error ? 'failure' : 'success';
        return;
      }
      if (event.type === 'assistant' || event.type === 'user') {
        requireValue(isUuid(event.uuid) && !frameIds.has(event.uuid));
        requireValue(event.message?.role === event.type);
        const content = event.message.content;
        if (event.type === 'assistant') {
          requireValue(
            message &&
              block &&
              !block.matched &&
              event.message.id === message.id &&
              event.message.type === 'message' &&
              event.message.model === message.model,
          );
          requireValue(Array.isArray(content) && content.length === 1);
          const completed = completedBlock();
          // The CLI stores a built-in tool's input as its own schema parsed
          // it, with defaults filled in (Edit's `replace_all: false`). Built-in
          // tools are guest-controlled, not host-certified: they may change
          // the workspace, but nothing treats their frames as host evidence.
          // Every streamed key must still match; the CLI may add keys. MCP
          // tools (Endo's host tools among them) must match exactly.
          const extendsStreamedInput = (actual, streamed) => {
            if (
              streamed.type !== 'tool_use' ||
              actual?.type !== 'tool_use' ||
              typeof streamed.name !== 'string' ||
              streamed.name.startsWith('mcp__')
            )
              return false;
            const rest = value =>
              Object.fromEntries(
                Object.entries(value).filter(([key]) => key !== 'input'),
              );
            const input = actual.input;
            return (
              same(rest(actual), rest(streamed)) &&
              input !== null &&
              typeof input === 'object' &&
              !Array.isArray(input) &&
              Object.keys(streamed.input).every(
                key =>
                  Object.hasOwn(input, key) &&
                  same(input[key], streamed.input[key]),
              )
            );
          };
          const matches =
            same(content[0], completed) ||
            extendsStreamedInput(content[0], completed);
          if (!matches) {
            // Describe only a fixed protocol field and mismatch category,
            // never producer values, tool arguments or unknown field names.
            diagnosticPhase = 'observe/assistant/block-other';
            if (content[0] && typeof content[0] === 'object') {
              for (const key of [
                'type',
                'text',
                'thinking',
                'signature',
                'data',
                'id',
                'name',
                'input',
                'caller',
                'citations',
              ]) {
                if (
                  Object.hasOwn(content[0], key) !==
                  Object.hasOwn(completed, key)
                ) {
                  diagnosticPhase = `observe/assistant/${key}-presence`;
                  break;
                }
                if (!same(content[0][key], completed[key])) {
                  diagnosticPhase = `observe/assistant/${key}-value`;
                  break;
                }
              }
            }
          }
          requireValue(matches);
          if (completed.type === 'tool_use') {
            requireValue(!completedToolIds.has(completed.id));
            completedToolIds.add(completed.id);
          }
          block.matched = true;
        } else {
          // Claude drains completed tools while other assistant blocks stream.
          // Such results must name an already completed tool, without consuming
          // or closing the still-open message/block. This is context, not proof
          // of a host effect; authoritative reconciliation remains separate.
          if (message || block) {
            requireValue(
              Array.isArray(content) &&
                content.length > 0 &&
                content.every(
                  item =>
                    item.type === 'tool_result' &&
                    completedToolIds.has(item.tool_use_id) &&
                    !receivedToolResults.has(item.tool_use_id),
                ) &&
                new Set(content.map(item => item.tool_use_id)).size ===
                  content.length,
            );
          }
          validateUserContent(content);
          if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === 'tool_result') {
                requireValue(!receivedToolResults.has(item.tool_use_id));
                receivedToolResults.add(item.tool_use_id);
              }
            }
          }
        }
        frameIds.add(event.uuid);
        // Copy so a caller cannot mutate an observation after acceptance.
        frames.push(
          JSON.parse(
            JSON.stringify({
              uuid: event.uuid,
              role: event.type,
              content,
              ...(event.type === 'assistant'
                ? {
                    messageId: event.message.id,
                    messageType: event.message.type,
                    model: event.message.model,
                  }
                : {}),
            }),
          ),
        );
        return;
      }
      requireValue(event.type === 'stream_event');
      const stream = event.event;
      requireValue(stream && typeof stream === 'object');
      if (
        [
          'message_start',
          'content_block_start',
          'content_block_delta',
          'content_block_stop',
          'message_delta',
          'message_stop',
        ].includes(stream.type)
      ) {
        diagnosticPhase = `observe/stream/${stream.type}`;
      }
      if (stream.type === 'message_start') {
        requireValue(
          !message &&
            !block &&
            stream.message?.role === 'assistant' &&
            typeof stream.message.id === 'string' &&
            stream.message.id !== '' &&
            stream.message.type === 'message' &&
            typeof stream.message.model === 'string' &&
            stream.message.model !== '' &&
            Array.isArray(stream.message.content) &&
            stream.message.content.length === 0,
        );
        message = { id: stream.message.id, model: stream.message.model };
        nextIndex = 0;
        return;
      }
      requireValue(message);
      if (stream.type === 'content_block_start') {
        requireValue(!block && stream.index === nextIndex);
        const value = stream.content_block;
        requireValue(value && typeof value === 'object');
        requireValue(
          (value.type === 'text' && typeof value.text === 'string') ||
            (value.type === 'thinking' && typeof value.thinking === 'string') ||
            (value.type === 'redacted_thinking' &&
              typeof value.data === 'string' &&
              value.data !== '') ||
            (value.type === 'tool_use' &&
              typeof value.id === 'string' &&
              typeof value.name === 'string' &&
              same(value.input, {})),
        );
        block = {
          value: JSON.parse(JSON.stringify(value)),
          json: '',
          matched: false,
        };
        if (value.type === 'thinking')
          block.value.signature = value.signature ?? '';
        return;
      }
      if (stream.type === 'content_block_delta') {
        requireValue(block && !block.matched && stream.index === nextIndex);
        const delta = stream.delta;
        if (block.value.type === 'text') {
          requireValue(
            delta?.type === 'text_delta' && typeof delta.text === 'string',
          );
          block.value.text += delta.text;
        } else if (block.value.type === 'thinking') {
          requireValue(
            ['thinking_delta', 'signature_delta'].includes(delta?.type),
          );
          const key =
            delta.type === 'thinking_delta' ? 'thinking' : 'signature';
          requireValue(typeof delta[key] === 'string');
          block.value[key] += delta[key];
        } else {
          requireValue(block.value.type === 'tool_use');
          requireValue(
            delta?.type === 'input_json_delta' &&
              typeof delta.partial_json === 'string',
          );
          block.json += delta.partial_json;
        }
        return;
      }
      if (stream.type === 'content_block_stop') {
        requireValue(block?.matched && stream.index === nextIndex);
        block = undefined;
        nextIndex += 1;
        return;
      }
      requireValue(!block && nextIndex > 0);
      if (stream.type === 'message_stop') message = undefined;
      else
        requireValue(
          stream.type === 'message_delta' &&
            Object.keys(stream.delta ?? {}).every(
              key =>
                ['stop_reason', 'stop_sequence'].includes(key) ||
                // Anthropic's message delta also carries nullable container
                // and refusal metadata. Only absence is inert here; populated
                // metadata needs its own coverage contract before acceptance.
                (['container', 'stop_details'].includes(key) &&
                  stream.delta[key] === null),
            ),
        );
    });

  /** @param {'success'|'failure'} expected */
  const assertOutcome = expected =>
    guarded(() => {
      diagnosticPhase = 'outcome';
      diagnosticCheck = 0;
      requireValue(
        initialized &&
          terminal &&
          frames.length > 0 &&
          !message &&
          !block &&
          (expected === 'success' || expected === 'failure') &&
          outcome === expected,
      );
    });

  // Native-only context is preserved byte-for-byte, not certified as streamed
  // dialogue or host effect evidence. The guest may alter its own context.
  const nativeAttachment = row => {
    if (row.type !== 'attachment') return false;
    const attachment = row.attachment;
    const strings = value =>
      Array.isArray(value) && value.every(item => typeof item === 'string');
    const keys = expected =>
      Object.keys(attachment).length === expected.length &&
      expected.every(key => Object.hasOwn(attachment, key));
    if (attachment?.type === 'agent_listing_delta')
      return (
        keys([
          'type',
          'addedTypes',
          'addedLines',
          'removedTypes',
          'isInitial',
          'showConcurrencyNote',
        ]) &&
        strings(attachment.addedTypes) &&
        strings(attachment.addedLines) &&
        strings(attachment.removedTypes) &&
        typeof attachment.isInitial === 'boolean' &&
        typeof attachment.showConcurrencyNote === 'boolean'
      );
    if (attachment?.type === 'task_reminder')
      return (
        keys(['type', 'content', 'itemCount']) &&
        Array.isArray(attachment.content) &&
        attachment.content.every(
          item =>
            item !== null && typeof item === 'object' && !Array.isArray(item),
        ) &&
        Number.isSafeInteger(attachment.itemCount) &&
        Number(attachment.itemCount) >= 0
      );
    if (attachment?.type === 'skill_listing')
      return (
        keys(['type', 'content', 'skillCount', 'isInitial', 'names']) &&
        typeof attachment.content === 'string' &&
        strings(attachment.names) &&
        typeof attachment.skillCount === 'number' &&
        typeof attachment.isInitial === 'boolean'
      );
    return (
      attachment?.type === 'total_tokens_reminder' ||
      (attachment?.type === 'max_turns_reached' &&
        [attachment.maxTurns, attachment.turnCount].every(
          value =>
            typeof value === 'number' && Number.isInteger(value) && value > 0,
        ))
    );
  };
  const ordinaryFlags = row =>
    ['isCompactSummary', 'isVisibleInTranscriptOnly', 'isMeta'].every(
      key => row[key] === undefined || row[key] === false,
    );
  const identity = row => ({
    type: row.type,
    parentUuid: row.parentUuid,
    role: row.message?.role,
    id: row.message?.id,
    messageType: row.message?.type,
    model: row.message?.model,
    content: row.message?.content,
    attachment: row.attachment,
    isCompactSummary: row.isCompactSummary === true,
    isMeta: row.isMeta === true,
    isVisibleInTranscriptOnly: row.isVisibleInTranscriptOnly === true,
  });
  const matches = (row, frame) =>
    frame &&
    row.uuid === frame.uuid &&
    row.type === frame.role &&
    row.message?.role === frame.role &&
    (frame.role !== 'assistant' ||
      (row.message.id === frame.messageId &&
        row.message.type === frame.messageType &&
        row.message.model === frame.model)) &&
    same(row.message.content, frame.content);
  const parseRows = (text, sessionId) => {
    requireValue(
      typeof text === 'string' &&
        (text === '' || text.endsWith('\n')) &&
        new TextEncoder().encode(text).byteLength <= LIMIT,
    );
    const rows =
      text === '' ? [] : text.slice(0, -1).split('\n').map(JSON.parse);
    requireValue(
      rows.every(
        row =>
          row.sessionId === sessionId && !row.isSidechain && isUuid(row.uuid),
      ),
    );
    return rows;
  };
  const uniqueRows = rows => {
    const byId = new Map();
    for (const row of rows) {
      const prior = byId.get(row.uuid);
      requireValue(!prior || same(identity(prior), identity(row)));
      if (!prior) byId.set(row.uuid, row);
    }
    return byId;
  };
  const assertChain = (rows, parent, expectedFrames) => {
    let position = 0;
    for (const row of rows) {
      requireValue(row.parentUuid === parent && ordinaryFlags(row));
      parent = row.uuid;
      if (!nativeAttachment(row)) {
        requireValue(matches(row, expectedFrames[position]));
        position += 1;
      }
    }
    requireValue(position === expectedFrames.length);
    return parent;
  };

  const assertCompacted = (rows, cut) => {
    // A compaction transition intentionally replaces dropped history with its
    // streamed summary. This proves retained row identity and current prompt /
    // frame coverage, not summary semantics or unchanged dropped guest bytes.
    const {
      beforePayload,
      beforeUuid,
      prefixSha256,
      compactionWitness,
      sessionId,
      prompt,
    } = cut;
    const oldRows = parseRows(beforePayload, sessionId);
    requireValue(sha256(beforePayload) === prefixSha256);
    const known = uniqueRows(oldRows);
    requireValue(([...known.keys()].at(-1) ?? null) === beforeUuid);
    const witness = uniqueRows(parseRows(compactionWitness, sessionId));
    requireValue(witness.size > 0);
    for (const uuid of witness.keys()) requireValue(!known.has(uuid));
    const [admitted, ...active] = witness.values();
    requireValue(
      admitted.type === 'user' &&
        admitted.message?.role === 'user' &&
        admitted.parentUuid === beforeUuid &&
        ordinaryFlags(admitted) &&
        (admitted.message.content === prompt ||
          same(admitted.message.content, [{ type: 'text', text: prompt }])),
    );
    requireValue(
      assertChain(active, admitted.uuid, frames.slice(0, boundaryPosition)) ===
        boundary.logical_parent_uuid,
    );
    for (const [uuid, row] of witness) known.set(uuid, row);

    const boundaries = rows.filter(
      row => row.type === 'system' && row.subtype === 'compact_boundary',
    );
    requireValue(boundaries.length === 1);
    const capturedBoundary = boundaries[0];
    const metadata = boundary.compact_metadata;
    const segment = metadata.preserved_segment;
    const preserved = metadata.preserved_messages;
    requireValue(segment && preserved && isUuid(segment.anchor_uuid));
    requireValue(
      Array.isArray(preserved.all_uuids) && Array.isArray(preserved.uuids),
    );
    requireValue(preserved.anchor_uuid === segment.anchor_uuid);
    requireValue(
      new Set(preserved.all_uuids).size === preserved.all_uuids.length &&
        preserved.all_uuids.every(isUuid),
    );
    requireValue(
      same(
        preserved.all_uuids.filter(uuid => preserved.uuids.includes(uuid)),
        preserved.uuids,
      ),
    );
    requireValue(
      segment.head_uuid === preserved.uuids[0] &&
        segment.tail_uuid === preserved.uuids.at(-1),
    );
    requireValue(!known.has(boundary.uuid) && !known.has(segment.anchor_uuid));
    requireValue(
      capturedBoundary.uuid === boundary.uuid &&
        capturedBoundary.parentUuid === null &&
        capturedBoundary.logicalParentUuid === boundary.logical_parent_uuid,
    );
    const nativeMetadata = capturedBoundary.compactMetadata;
    requireValue(
      nativeMetadata?.trigger === metadata.trigger &&
        nativeMetadata.preTokens === metadata.pre_tokens &&
        nativeMetadata.postTokens === metadata.post_tokens &&
        nativeMetadata.cumulativeDroppedTokens ===
          metadata.cumulative_dropped_tokens &&
        nativeMetadata.durationMs === metadata.duration_ms &&
        same(nativeMetadata.preservedSegment, {
          headUuid: segment.head_uuid,
          anchorUuid: segment.anchor_uuid,
          tailUuid: segment.tail_uuid,
        }) &&
        same(nativeMetadata.preservedMessages, {
          anchorUuid: preserved.anchor_uuid,
          uuids: preserved.uuids,
          allUuids: preserved.all_uuids,
        }),
    );
    const boundaryIndex = rows.indexOf(capturedBoundary);
    const retained = uniqueRows(rows.slice(0, boundaryIndex));
    requireValue(same([...retained.keys()], preserved.all_uuids));
    for (const [uuid, row] of retained) {
      requireValue(
        (row.type === 'user' ||
          row.type === 'assistant' ||
          nativeAttachment(row)) &&
          known.has(uuid) &&
          same(identity(row), identity(known.get(uuid))),
      );
    }
    // The actual loader writes a string for the exact one-text-block summary
    // emitted on its stream. No general message normalization is permitted.
    const summary = rows[boundaryIndex + 1];
    const summaryFrame = frames[boundaryPosition];
    requireValue(
      summary?.uuid === segment.anchor_uuid &&
        summary.parentUuid === boundary.uuid &&
        summary.type === 'user' &&
        summary.message?.role === 'user' &&
        summary.isCompactSummary === true &&
        !summary.isMeta &&
        summary.isVisibleInTranscriptOnly === true &&
        summaryFrame?.uuid === summary.uuid &&
        summaryFrame.role === 'user' &&
        same(summaryFrame.content, [
          { type: 'text', text: summary.message.content },
        ]) &&
        typeof summary.message.content === 'string',
    );
    const suffix = rows.slice(boundaryIndex + 2);
    requireValue(new Set(suffix.map(row => row.uuid)).size === suffix.length);
    requireValue(
      suffix.every(
        row =>
          !known.has(row.uuid) &&
          row.uuid !== summary.uuid &&
          row.uuid !== boundary.uuid,
      ),
    );
    assertChain(suffix, summary.uuid, frames.slice(boundaryPosition + 1));
  };

  /**
   * @param {string} nativeTranscript Helper-validated native JSONL.
   * @param {{sessionId: string, beforeUuid: string|null, prefixSha256: string, beforePayload: string, compactionWitness?: string, prompt: string, outcome: 'success'|'failure'}} cut
   * Trusted pre-turn receipt; an empty initial store uses null plus SHA-256 of empty text.
   */
  const assertCaptured = (nativeTranscript, cut) =>
    guarded(() => {
      diagnosticPhase = 'capture';
      diagnosticCheck = 0;
      const {
        sessionId,
        beforeUuid,
        prefixSha256,
        beforePayload,
        prompt,
        outcome: expectedOutcome,
      } = cut;
      assertOutcome(expectedOutcome);
      diagnosticPhase = 'capture';
      diagnosticCheck = 0;
      requireValue(
        isUuid(sessionId) &&
          sessionId === session &&
          (beforeUuid === null || isUuid(beforeUuid)) &&
          typeof prefixSha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(prefixSha256) &&
          typeof prompt === 'string',
      );
      requireValue(
        typeof nativeTranscript === 'string' &&
          nativeTranscript.endsWith('\n') &&
          new TextEncoder().encode(nativeTranscript).byteLength <= LIMIT,
      );
      const lines = nativeTranscript.slice(0, -1).split('\n');
      const rows = lines.map(line => JSON.parse(line));
      requireValue(
        rows.every(
          row =>
            row.sessionId === sessionId && !row.isSidechain && isUuid(row.uuid),
        ),
      );
      if (boundary) {
        assertCompacted(rows, cut);
        return;
      }
      const priorRows = parseRows(beforePayload, sessionId);
      const prior = uniqueRows(priorRows);
      requireValue(([...prior.keys()].at(-1) ?? null) === beforeUuid);
      requireValue(nativeTranscript.startsWith(beforePayload));
      requireValue(sha256(beforePayload) === prefixSha256);
      const active = rows.slice(priorRows.length);
      // The ordinary-turn stream does not attest loader-only visibility or
      // summary roles. Matching message content cannot certify those changes.
      requireValue(
        active.every(row =>
          ['isCompactSummary', 'isVisibleInTranscriptOnly', 'isMeta'].every(
            key => row[key] === undefined || row[key] === false,
          ),
        ),
      );
      const admitted = active.shift();
      requireValue(
        admitted?.type === 'user' &&
          admitted.message?.role === 'user' &&
          admitted.parentUuid === beforeUuid &&
          isUuid(admitted.uuid),
      );
      requireValue(
        admitted.message.content === prompt ||
          same(admitted.message.content, [{ type: 'text', text: prompt }]),
      );
      let parent = admitted.uuid;
      let position = 0;
      const ids = new Set([parent]);
      for (const row of active) {
        requireValue(
          isUuid(row.uuid) && !ids.has(row.uuid) && row.parentUuid === parent,
        );
        ids.add(row.uuid);
        parent = row.uuid;
        if (row.type === 'attachment') {
          requireValue(nativeAttachment(row));
        } else {
          const frame = frames[position];
          requireValue(
            frame &&
              row.uuid === frame.uuid &&
              row.type === frame.role &&
              row.message?.role === frame.role &&
              (frame.role !== 'assistant' ||
                (row.message.id === frame.messageId &&
                  row.message.type === frame.messageType &&
                  row.message.model === frame.model)) &&
              same(row.message.content, frame.content),
          );
          position += 1;
        }
      }
      requireValue(position === frames.length);
    });
  return harden({ observe, assertOutcome, assertCaptured });
};
harden(makeClaudeContextCoverage);
