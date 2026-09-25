// @ts-check
// Runs ONLY inside the existing sandbox. Native transcript data is not authority.
import { open, constants } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const LIMIT = 16 * 1024 * 1024;
// Only errors minted here from static local messages may explain a refusal.
// Native JSON parsing and filesystem errors can contain transcript/path data.
const diagnosticErrors = new WeakMap();
const diagnosticError = message => {
  const error = Error(message);
  diagnosticErrors.set(error, message);
  return error;
};
const uuid = value => {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
  )
    throw diagnosticError('Invalid capture identity');
  return value;
};
const requireValue = (condition, message) => {
  if (!condition) throw diagnosticError(message);
};
const strings = value =>
  Array.isArray(value) && value.every(item => typeof item === 'string');
const exactKeys = (value, expected) =>
  Object.keys(value).length === expected.length &&
  expected.every(key => Object.hasOwn(value, key));
// Loader-generated context the pinned CLI writes to its transcript but not to
// its public stream. The native payload keeps each one byte for byte and in
// order; none of them is dialogue or evidence that a host effect happened.
// Keep in step with `nativeAttachment` in src/claude-context-coverage.js.
const nativeAttachment = attachment =>
  attachment?.type === 'total_tokens_reminder' ||
  (attachment?.type === 'max_turns_reached' &&
    Number.isInteger(attachment.maxTurns) &&
    attachment.maxTurns > 0 &&
    Number.isInteger(attachment.turnCount) &&
    attachment.turnCount > 0) ||
  (attachment?.type === 'agent_listing_delta' &&
    exactKeys(attachment, [
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
    typeof attachment.showConcurrencyNote === 'boolean') ||
  (attachment?.type === 'task_reminder' &&
    exactKeys(attachment, ['type', 'content', 'itemCount']) &&
    Array.isArray(attachment.content) &&
    attachment.content.every(
      item => item !== null && typeof item === 'object' && !Array.isArray(item),
    ) &&
    Number.isSafeInteger(attachment.itemCount) &&
    attachment.itemCount >= 0) ||
  (attachment?.type === 'skill_listing' &&
    exactKeys(attachment, [
      'type',
      'content',
      'skillCount',
      'isInitial',
      'names',
    ]) &&
    typeof attachment.content === 'string' &&
    strings(attachment.names) &&
    typeof attachment.skillCount === 'number' &&
    typeof attachment.isInitial === 'boolean');
const projection = row => {
  if (row.type === 'attachment') {
    // Omitted only from portable dialogue; the native payload preserves the
    // exact attachment for Claude restoration.
    requireValue(
      nativeAttachment(row.attachment),
      'Unsupported context attachment',
    );
    return [];
  }
  requireValue(
    row.type === 'user' || row.type === 'assistant',
    'Unsupported context record',
  );
  requireValue(row.message?.role === row.type, 'Context role mismatch');
  const blocks =
    typeof row.message.content === 'string'
      ? [{ type: 'text', text: row.message.content }]
      : row.message.content;
  requireValue(Array.isArray(blocks), 'Invalid context content');
  return blocks.flatMap(block => {
    if (block.type === 'thinking') {
      requireValue(
        row.type === 'assistant' &&
          typeof block.thinking === 'string' &&
          typeof block.signature === 'string' &&
          block.signature.length > 0,
        'Invalid thinking block',
      );
      return [];
    }
    if (block.type === 'redacted_thinking') {
      requireValue(
        row.type === 'assistant' &&
          typeof block.data === 'string' &&
          block.data.length > 0,
        'Invalid redacted thinking block',
      );
      return [];
    }
    if (block.type === 'text') {
      requireValue(typeof block.text === 'string', 'Invalid text block');
      return { kind: 'message', role: row.type, content: block.text };
    }
    if (block.type === 'tool_use') {
      requireValue(
        row.type === 'assistant' &&
          typeof block.id === 'string' &&
          block.id &&
          typeof block.name === 'string' &&
          block.name &&
          block.input &&
          typeof block.input === 'object' &&
          !Array.isArray(block.input),
        'Invalid tool call',
      );
      return {
        kind: 'tool-call',
        id: block.id,
        name: block.name,
        args: JSON.stringify(block.input),
      };
    }
    if (block.type === 'tool_result') {
      requireValue(
        row.type === 'user' &&
          typeof block.tool_use_id === 'string' &&
          block.tool_use_id &&
          (block.is_error === undefined || typeof block.is_error === 'boolean'),
        'Invalid tool result',
      );
      const content =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .map(part => {
                  requireValue(
                    part.type === 'text' && typeof part.text === 'string',
                    'Unsupported tool result block',
                  );
                  return part.text;
                })
                .join('\n')
            : undefined;
      requireValue(content !== undefined, 'Invalid tool result content');
      return {
        kind: 'tool-result',
        id: block.tool_use_id,
        content,
        ...(block.is_error ? { failed: true } : {}),
      };
    }
    throw diagnosticError('Unsupported context block');
  });
};

const frames = async function* (file) {
  let line = '';
  const decode = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of file.createReadStream({
    autoClose: false,
    start: 0,
  })) {
    line += decode.decode(chunk, { stream: true });
    let end = line.indexOf('\n');
    while (end >= 0) {
      const next = line.slice(0, end);
      requireValue(
        Buffer.byteLength(next) <= LIMIT,
        'Transcript frame exceeds capture limit',
      );
      if (next) yield next;
      line = line.slice(end + 1);
      end = line.indexOf('\n');
    }
    requireValue(
      Buffer.byteLength(line) <= LIMIT,
      'Transcript frame exceeds capture limit',
    );
  }
  line += decode.decode();
  requireValue(line === '', 'Incomplete transcript frame');
};

// CLI operations and state, not conversation context. One list for both the
// coverage witness and context selection, so they cannot drift apart.
const operationalRows = new Set([
  'queue-operation',
  'last-prompt',
  'file-history-snapshot',
  'progress',
  'mode',
  // The CLI's generated session title: display metadata, no uuid.
  'ai-title',
]);
const main = async () => {
  requireValue(process.argv.length === 3, 'Expected boundary record');
  let expected = JSON.parse(process.argv[2]);
  const coverageRequested = Object.hasOwn(expected, 'coverage_before_uuid');
  const coverageBefore =
    coverageRequested && expected.coverage_before_uuid !== null
      ? uuid(expected.coverage_before_uuid)
      : null;
  const expectedBoundary =
    expected.expected_boundary_uuid === undefined
      ? undefined
      : uuid(expected.expected_boundary_uuid);
  const session = uuid(expected.session_id);
  const config = process.env.CLAUDE_CONFIG_DIR;
  if (typeof config !== 'string' || !path.isAbsolute(config)) {
    throw diagnosticError('Missing sandbox config directory');
  }
  const filename = path.join(
    config,
    'projects',
    process.cwd().replaceAll('/', '-'),
    `${session}.jsonl`,
  );
  if (expected.type === 'endo_capture') {
    // Discover only boundary metadata, not an unbounded in-memory transcript.
    // The actual projection below validates the chosen cut again.
    const discovery = await open(
      filename,
      // eslint-disable-next-line no-bitwise
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      requireValue(
        (await discovery.stat()).isFile(),
        'Transcript is not a regular file',
      );
      for await (const text of frames(discovery)) {
        const row = JSON.parse(text);
        if (
          row.type === 'system' &&
          row.subtype === 'compact_boundary' &&
          !row.isSidechain
        ) {
          requireValue(row.sessionId === session, 'Boundary session mismatch');
          const metadata = row.compactMetadata;
          expected = {
            type: 'system',
            subtype: 'compact_boundary',
            session_id: session,
            uuid: row.uuid,
            compact_metadata: {
              preserved_messages: {
                anchor_uuid: metadata?.preservedMessages?.anchorUuid,
                uuids: metadata?.preservedMessages?.uuids,
                all_uuids: metadata?.preservedMessages?.allUuids,
              },
              preserved_segment: {
                anchor_uuid: metadata?.preservedSegment?.anchorUuid,
                head_uuid: metadata?.preservedSegment?.headUuid,
                tail_uuid: metadata?.preservedSegment?.tailUuid,
              },
            },
          };
        }
      }
    } finally {
      await discovery.close();
    }
  }
  if (expectedBoundary !== undefined) {
    requireValue(
      expected.uuid === expectedBoundary,
      'Capture boundary changed',
    );
  }
  const ordinary = expected.type === 'endo_capture';
  requireValue(
    ordinary ||
      (expected.type === 'system' && expected.subtype === 'compact_boundary'),
    'Expected compaction boundary',
  );
  const boundary = ordinary ? null : uuid(expected.uuid);
  const meta = expected.compact_metadata;
  const preserved = meta?.preserved_messages;
  const anchor = ordinary ? undefined : uuid(preserved?.anchor_uuid);
  const ids = ordinary ? [] : preserved?.all_uuids;
  requireValue(
    Array.isArray(ids) &&
      ids.every(id => uuid(id)) &&
      new Set(ids).size === ids.length &&
      !ids.includes(anchor),
    'Invalid retained identities',
  );
  requireValue(
    ordinary ||
      (Array.isArray(preserved.uuids) &&
        preserved.uuids.every(id => ids.includes(uuid(id)))),
    'Invalid retained subset',
  );
  requireValue(
    ordinary || meta.preserved_segment?.anchor_uuid === anchor,
    'Anchor mismatch',
  );
  requireValue(
    ordinary ||
      (ids.includes(meta.preserved_segment.head_uuid) &&
        ids.includes(meta.preserved_segment.tail_uuid)),
    'Retained segment mismatch',
  );
  // NOFOLLOW/nonblocking reject a planted leaf symlink/FIFO. Ancestor paths are
  // evaluated inside the sandbox, never in the daemon's host filesystem.
  /* eslint-disable no-bitwise */
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  /* eslint-enable no-bitwise */
  try {
    requireValue(
      (await file.stat()).isFile(),
      'Transcript is not a regular file',
    );
    const wanted = new Set(ordinary ? [] : [...ids, anchor]);
    const selected = new Map();
    const tail = [];
    const nativeRows = [];
    // Ephemeral admission evidence, not part of the restoration checkpoint.
    // The host checks these rows against its prompt and complete live frames.
    const witnessRows = [];
    let witnessBytes = 0;
    let foundCoverageCut = coverageBefore === null;
    const witness = (row, text) => {
      if (!coverageRequested || ordinary || seenBoundary) return;
      if (row.isSidechain) return;
      if (row.uuid === coverageBefore) {
        requireValue(!foundCoverageCut, 'Repeated coverage cut');
        requireValue(row.sessionId === session, 'Coverage session mismatch');
        foundCoverageCut = true;
        return;
      }
      if (!foundCoverageCut || row.uuid === boundary) return;
      if (operationalRows.has(row.type)) return;
      requireValue(row.sessionId === session, 'Coverage session mismatch');
      witnessBytes += Buffer.byteLength(text) + 1;
      requireValue(witnessBytes <= LIMIT, 'Coverage exceeds capture limit');
      witnessRows.push(text);
    };
    let nativeBytes = 0;
    const retainNative = text => {
      nativeBytes += Buffer.byteLength(text) + 1;
      requireValue(
        nativeBytes <= LIMIT,
        'Native context exceeds capture limit',
      );
      nativeRows.push(text);
    };
    const suffixParents = new Map();
    let frontier = boundary;
    let seenBoundary = ordinary;
    let retainedBytes = 0;
    const accept = text => {
      requireValue(
        Buffer.byteLength(text) <= LIMIT,
        'Transcript frame exceeds capture limit',
      );
      const row = JSON.parse(text);
      witness(row, text);
      if (row.uuid === boundary) {
        requireValue(!seenBoundary, 'Repeated compaction boundary');
        requireValue(
          row.type === 'system' &&
            row.subtype === 'compact_boundary' &&
            row.sessionId === session &&
            row.compactMetadata?.preservedMessages?.anchorUuid === anchor &&
            row.compactMetadata?.preservedSegment?.anchorUuid === anchor &&
            row.compactMetadata?.preservedSegment?.headUuid ===
              meta.preserved_segment.head_uuid &&
            row.compactMetadata?.preservedSegment?.tailUuid ===
              meta.preserved_segment.tail_uuid &&
            JSON.stringify(row.compactMetadata.preservedMessages.uuids) ===
              JSON.stringify(preserved.uuids) &&
            JSON.stringify(row.compactMetadata.preservedMessages.allUuids) ===
              JSON.stringify(ids),
          'Boundary metadata mismatch',
        );
        seenBoundary = true;
        retainNative(text);
        return;
      }
      if (seenBoundary && row.subtype === 'compact_boundary')
        throw diagnosticError('A newer boundary exists');
      const needed = wanted.has(row.uuid);
      requireValue(
        row.uuid !== anchor || seenBoundary,
        'Summary precedes boundary',
      );
      if (!needed && !seenBoundary) return;
      if (row.isSidechain) {
        requireValue(!needed, 'Retained sidechain record');
        return;
      }
      if (seenBoundary && row.type === 'last-prompt') {
        requireValue(
          row.sessionId === session && row.leafUuid === frontier,
          'Ambiguous active transcript leaf',
        );
        // Validate the leaf, but do not import operational loader metadata.
        return;
      }
      if (!needed && operationalRows.has(row.type)) {
        // These are CLI operations/state, not conversation context. Replaying
        // queued prompts or file-history snapshots is not authorized by capture.
        return;
      }
      requireValue(row.sessionId === session, 'Context session mismatch');
      const id = uuid(row.uuid);
      if (seenBoundary) {
        const parent =
          ordinary && row.parentUuid === null ? null : uuid(row.parentUuid);
        if (suffixParents.has(id)) {
          requireValue(
            suffixParents.get(id) === parent,
            'Conflicting duplicate ancestry',
          );
        } else {
          requireValue(
            !selected.has(id) && parent === frontier,
            'Divergent or missing suffix ancestry',
          );
          requireValue(
            ordinary || frontier !== boundary || id === anchor,
            'Missing summary at suffix root',
          );
          suffixParents.set(id, parent);
          frontier = id;
        }
      }
      const records = projection(row);
      const payload = JSON.stringify({
        // Compare context payloads, not the portable projection: different
        // signatures or redacted bytes must never be silently deduplicated.
        type: row.type,
        messageId: row.message?.id,
        messageType: row.message?.type,
        model: row.message?.model,
        role: row.message?.role,
        content: row.message?.content,
        attachment: row.attachment,
        summary: row.isCompactSummary === true,
      });
      if (selected.has(id)) {
        requireValue(
          selected.get(id).payload === payload,
          'Conflicting duplicate context identity',
        );
        retainNative(text);
        return;
      }
      retainedBytes += Buffer.byteLength(payload);
      requireValue(retainedBytes <= LIMIT, 'Context exceeds capture limit');
      selected.set(id, {
        payload,
        records,
        summary: row.isCompactSummary === true,
      });
      retainNative(text);
      if (!wanted.has(id)) tail.push(id);
    };
    for await (const text of frames(file)) accept(text);
    requireValue(
      seenBoundary &&
        selected.size > 0 &&
        [...wanted].every(id => selected.has(id)),
      'Incomplete compaction capture',
    );
    const summary = selected.get(anchor);
    requireValue(
      ordinary ||
        (summary.summary &&
          summary.records.length === 1 &&
          summary.records[0].kind === 'message' &&
          summary.records[0].role === 'user' &&
          summary.records[0].content),
      'Invalid summary anchor',
    );
    const retainedTail = [...ids, ...tail].flatMap(
      id => selected.get(id).records,
    );
    const pending = new Map();
    for (const record of retainedTail) {
      if (record.kind === 'tool-call') {
        requireValue(!pending.has(record.id), 'Duplicate unsettled tool call');
        pending.set(record.id, true);
      } else if (record.kind === 'tool-result') {
        requireValue(pending.delete(record.id), 'Orphan retained tool result');
      }
    }
    requireValue(pending.size === 0, 'Unsettled retained tool call');
    const output = JSON.stringify({
      type: ordinary ? 'endo_context' : 'endo_compaction',
      ...(ordinary ? {} : { summary: summary.records[0].content }),
      retainedTail,
      ...(coverageRequested && !ordinary
        ? {
            compactionWitness: `${witnessRows.join('\n')}\n`,
          }
        : {}),
      nativeContext: {
        format: 'claude-code-jsonl-v1',
        transcript: `${nativeRows.join('\n')}\n`,
        leafUuid: frontier,
      },
    });
    requireValue(
      !coverageRequested ||
        ordinary ||
        (foundCoverageCut && witnessRows.length > 0),
      'Missing compaction coverage',
    );
    requireValue(
      Buffer.byteLength(output) + 1 <= LIMIT,
      'Capture output exceeds limit',
    );
    process.stdout.write(`${output}\n`);
  } finally {
    await file.close();
  }
};
main().catch(error => {
  // Never leak transcript contents, paths, or native parse errors to stderr.
  const reason = diagnosticErrors.get(error) ?? 'Unclassified capture failure';
  process.stderr.write(`Claude compaction capture failed: ${reason}\n`);
  process.exitCode = 1;
});
