// @ts-check

/**
 * Write a Claude Code transcript from the stack's transcript records, so a
 * revived session resumes the conversation the stack holds rather than one the
 * guest's own store happened to keep.
 *
 * Claude Code names each conversation `projects/<project>/<session-uuid>.jsonl`
 * and fills it with one envelope per line: `uuid` and `parentUuid` chaining the
 * records into a list, `sessionId`, `cwd`, `gitBranch`, `timestamp`,
 * `isSidechain`, `userType`, `entrypoint` and `version` describing the
 * incarnation that wrote it, and `message` carrying a verbatim Anthropic API
 * message. That last part is what makes this writable at all: the payload is
 * the API's own shape, not a private encoding, so a tool call is an assistant
 * `tool_use` block and its result a user `tool_result` block — exactly the
 * distinction a restored transcript has to preserve.
 *
 * The schema here was captured by observation
 * (`designs/hosted-agent-sandbox-unification.md`), not from a specification.
 * That is acceptable because the image is pinned by digest, so it cannot
 * change without a deliberate bump — and it is only acceptable while a bump
 * re-runs the round-trip conformance test, because a format that drifted
 * silently would resume empty rather than fail.
 *
 * @module
 */

import { Fail } from '@endo/errors';
import {
  pairToolCalls,
  splitAtLastCompaction,
} from '@endo/hosted-agent/transcript-records.js';

/** What Claude Code records for a turn the user typed. */
const USER_TYPE = 'external';

/**
 * A deterministic v4-shaped identifier.
 *
 * Restoration must be reproducible: writing the same records twice has to
 * produce the same transcript, or a retried revival forks a second
 * conversation out of the same history. So the ids come from a counter seeded
 * by the session, never from randomness.
 *
 * @param {string} sessionUuid
 * @param {number} index
 */
const recordUuid = (sessionUuid, index) => {
  const seed = `${sessionUuid}`.replace(/-/g, '').padEnd(32, '0').slice(0, 32);
  const counter = index.toString(16).padStart(8, '0');
  const body = `${counter}${seed.slice(8)}`;
  return [
    body.slice(0, 8),
    body.slice(8, 12),
    `4${body.slice(13, 16)}`,
    `a${body.slice(17, 20)}`,
    body.slice(20, 32),
  ].join('-');
};

/**
 * Arguments as a structure, since the API carries `input` as an object while
 * the record stream carries the provider's own argument text. Text that is not
 * JSON is preserved under a single key rather than dropped, so a call whose
 * arguments this layer cannot parse still restores as that call.
 *
 * @param {string} args
 */
const toolInput = args => {
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return { value: parsed };
  } catch {
    return { value: args };
  }
};

/**
 * @param {readonly any[]} records Transcript records from the stack.
 * @param {object} options
 * @param {string} options.sessionUuid The Claude Code session id this
 * transcript belongs to; the file is named for it and every envelope repeats
 * it.
 * @param {string} options.cwd The slice path Claude Code runs in.
 * @param {string} options.version The pinned CLI version, as Claude Code
 * stamps on the records it writes itself.
 * @param {string} [options.model] Recorded on assistant messages; Claude Code
 * writes the model that produced them.
 * @param {string} [options.gitBranch]
 * @param {() => string} [options.now] ISO timestamps, injectable so a test
 * gets a stable file.
 * @returns {string} JSONL, one envelope per line.
 */
export const writeClaudeTranscript = (
  records,
  {
    sessionUuid,
    cwd,
    version,
    model = 'unknown',
    gitBranch = '',
    now = () => new Date().toISOString(),
  },
) => {
  (typeof sessionUuid === 'string' && sessionUuid !== '') ||
    Fail`a Claude transcript needs the session id it is named for`;
  (typeof cwd === 'string' && cwd.startsWith('/')) ||
    Fail`a Claude transcript needs the slice path its session runs in`;
  // Everything before the last compaction is history the model no longer
  // carries. Claude Code has no compaction record of its own, so the summary
  // is written as the conversation's opening exchange and the superseded span
  // is not replayed — which is what the boundary means.
  const { superseded, active } = splitAtLastCompaction(records);
  const { pairs } = pairToolCalls(active);
  const resultById = new Map(
    pairs
      .filter(pair => pair.result !== undefined)
      .map(pair => [pair.call.id, pair.result]),
  );

  let index = 0;
  /** @type {string | null} */
  let parentUuid = null;
  const lines = [];
  /**
   * @param {'user' | 'assistant'} type
   * @param {any} message
   */
  const emit = (type, message) => {
    const uuid = recordUuid(sessionUuid, index);
    index += 1;
    lines.push(
      JSON.stringify({
        parentUuid,
        isSidechain: false,
        userType: USER_TYPE,
        cwd,
        sessionId: sessionUuid,
        version,
        gitBranch,
        type,
        message,
        uuid,
        timestamp: now(),
      }),
    );
    parentUuid = uuid;
  };

  if (superseded.length > 0) {
    const [compaction] = active;
    emit('user', {
      role: 'user',
      content: compaction?.kind === 'compaction' ? compaction.summary : '',
    });
  }

  for (const record of active) {
    if (record.kind === 'message') {
      emit(
        record.role,
        record.role === 'user'
          ? { role: 'user', content: record.content }
          : {
              model,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: record.content }],
              stop_reason: 'end_turn',
              stop_sequence: null,
            },
      );
    } else if (record.kind === 'tool-call') {
      emit('assistant', {
        model,
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: record.id,
            name: record.name,
            input: toolInput(record.args),
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
      });
      // The result follows its call immediately. A call the turn never settled
      // still gets one, saying so: Claude Code refuses a `tool_use` with no
      // answering `tool_result`, and an interrupted turn must restore as an
      // interrupted turn rather than as a conversation that cannot load.
      const result = resultById.get(record.id);
      emit('user', {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: record.id,
            content: result ? result.content : 'Tool call did not complete.',
            ...(result?.failed ? { is_error: true } : {}),
          },
        ],
      });
    }
    // A `compaction` record is the boundary itself and carries no turn of its
    // own; its summary opened the file above.
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
};
harden(writeClaudeTranscript);
