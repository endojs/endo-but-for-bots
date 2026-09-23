// @ts-check
import { Fail } from '@endo/errors';
import { pairToolCalls } from '@endo/hosted-agent/transcript-records.js';

import { encodeJournalPresentation } from './journal-presentation.js';
import { UNSETTLED_TOOL_RESULT } from './hosted-turn.js';
import {
  encodeJournalTranscript,
  transcriptIndex,
} from './journal-transcript.js';
import {
  UNKNOWN_TOOL_OUTCOME,
  reconcileTurnEvidence,
} from './turn-evidence.js';

/**
 * UI projection only: public thinking, mail metadata and tool previews never
 * become model instructions. Compaction summaries/tails remain model context.
 * @param {any} turn
 * @param {(ref: any) => Promise<string>} readContent
 * @param {boolean} [omitInput] A repeated typed receipt, not execution dedup.
 */
export const projectJournalTurnHistory = async (
  turn,
  readContent,
  omitInput = false,
) => {
  const fullText = async (text, ref) => (ref ? readContent(ref) : text);
  const records = [];
  for (const [index, entry] of (turn.transcript ?? []).entries()) {
    transcriptIndex(entry.ordinal, index) === index ||
      Fail`Invalid history transcript ordinal`;
    // eslint-disable-next-line no-await-in-loop
    const payload = await fullText(entry.payload, entry.payloadRef);
    const record = JSON.parse(payload);
    encodeJournalTranscript(record) === payload ||
      Fail`Invalid history transcript payload`;
    records.push(record);
  }
  /** @type {any[]} */
  let thinking = [];
  if (turn.presentation !== undefined) {
    const payload = await fullText(
      turn.presentation.payload,
      turn.presentation.payloadRef,
    );
    thinking = JSON.parse(payload);
    encodeJournalPresentation(thinking, records.length) === payload ||
      Fail`Invalid history presentation`;
  }
  const { pairs } = pairToolCalls(records);
  const rows = await reconcileTurnEvidence({
    turnId: turn.turnId,
    known: pairs.map(({ call, result }) => ({
      id: call.id,
      name: call.name,
      args: call.args,
      result: result?.content,
    })),
    activity: turn.activity,
    tools: turn.tools,
    read: tool => ({
      args: tool.args,
      result: tool.result,
      cut: {
        args: tool.argsRef !== undefined,
        result: tool.resultRef !== undefined,
      },
    }),
  });
  const paired = new Map(pairs.map((pair, index) => [pair.call, rows[index]]));
  /** @param {import('./turn-evidence.js').EvidenceRow} row */
  const toolRow = row => ({
    role: 'tool',
    ...(row.source !== 'host' ? { id: row.id } : {}),
    name: row.name,
    args: row.args,
    result:
      row.source === 'host' && turn.activity?.length
        ? `[Durable Endo execution evidence; may correspond to a backend observation above, not an additional execution.]\n${row.result ?? UNKNOWN_TOOL_OUTCOME}`
        : (row.result ??
          (row.source === 'tree'
            ? UNSETTLED_TOOL_RESULT
            : UNKNOWN_TOOL_OUTCOME)),
  });
  /** @type {any[]} */
  const messages = [];
  const user = content => ({
    role: 'user',
    content,
    ...(turn.mail === undefined ? {} : { meta: { mail: turn.mail } }),
  });
  if (
    !omitInput &&
    !records.some(record => record.kind === 'message' && record.role === 'user')
  ) {
    messages.push(user(await fullText(turn.input, turn.inputRef)));
  }
  let thinkingIndex = 0;
  let assistantText = '';
  let sawInput = false;
  for (let index = 0; index <= records.length; index += 1) {
    while (
      thinkingIndex < thinking.length &&
      Number(thinking[thinkingIndex].beforeTranscriptOrdinal) === index
    ) {
      const block = thinking[thinkingIndex];
      messages.push({
        role: 'thinking',
        content: block.text,
        thinking: {
          startedAt: block.startedAt,
          endedAt: block.endedAt,
          truncated: block.truncated,
        },
      });
      thinkingIndex += 1;
    }
    const record = records[index];
    if (record?.kind === 'message') {
      if (record.role === 'user') {
        if (sawInput) messages.push({ role: 'user', content: record.content });
        else if (!omitInput) messages.push(user(record.content));
        sawInput = true;
      } else {
        assistantText += record.content;
        if (record.content.trim() !== '')
          messages.push({ role: 'assistant', content: record.content });
      }
    } else if (record?.kind === 'tool-call') {
      const row = paired.get(record);
      if (!row) throw Fail`Missing history tool pairing`;
      messages.push(toolRow(row));
    }
  }
  // Older/interrupted turns can have a joined output in addition to an ordered
  // acknowledged prefix. Append only a provable suffix; never duplicate it.
  const output = await fullText(turn.output ?? '', turn.outputRef);
  if (typeof output === 'string' && output.startsWith(assistantText)) {
    const suffix = output.slice(assistantText.length);
    if (suffix.trim() !== '')
      messages.push({ role: 'assistant', content: suffix });
  } else if (
    !turn.transcriptComplete &&
    typeof output === 'string' &&
    output.trim() !== ''
  ) {
    messages.push({
      role: 'assistant',
      content: `[Recovered reply; ordering relative to the recorded conversation is unknown.]\n${output}`,
      meta: { recoveredEvidence: true, orderUnknown: true },
    });
  }
  for (const row of rows.filter(item => item.source !== 'tree')) {
    const message = toolRow(row);
    messages.push({
      ...message,
      result:
        assistantText || output
          ? `[Recovered evidence; ordering relative to the reply is unknown.]\n${message.result}`
          : message.result,
      meta: { recoveredEvidence: true, orderUnknown: true },
    });
  }
  const meta = {
    turnId: turn.turnId,
    turnState: turn.state,
    ...(turn.resolution ? { resolution: turn.resolution } : {}),
  };
  const result = messages.map(message =>
    turn.state === 'completed'
      ? message
      : { ...message, meta: { ...message.meta, ...meta } },
  );
  if (turn.state !== 'completed')
    result.push({
      role: 'assistant',
      content: `Turn ${turn.state}${turn.error ? `: ${turn.error}` : '.'}`,
      meta: { ...meta, turnStatus: true },
    });
  return harden(result);
};
harden(projectJournalTurnHistory);
