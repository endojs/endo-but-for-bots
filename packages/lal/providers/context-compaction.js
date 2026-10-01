// @ts-check

import { Fail } from '@endo/errors';

/**
 * A conservative wire-size estimate, not a token reading. Include opaque
 * context and tool schemas; no provider capacity is invented here.
 * @param {any} value
 */
const wireBytes = value =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Select an older, completed prefix. The last two user turns and every native
 * output/call/outcome in them remain verbatim. Owners persist the checkpoint
 * and its source boundary; this module owns no conversation or storage.
 * @param {readonly any[]} messages
 * @param {object} [options]
 * @param {readonly any[]} [options.tools]
 * @param {number} [options.windowTokens] Exact selected-model catalog reading.
 * @param {number} [options.usedTokens] Last request's observation, not a lifetime sum.
 * @param {boolean} [options.force] Acceptance-only, not a fabricated model limit.
 */
export const planContextCompaction = (
  messages,
  { tools = [], windowTokens = 0, usedTokens = 0, force = false } = {},
) => {
  const estimate = wireBytes({ messages, tools });
  // Reserve 30% for the next reply, tool results and estimation error.
  const threshold = Math.floor(windowTokens * 0.7);
  if (!force && (!windowTokens || Math.max(estimate, usedTokens) < threshold))
    return undefined;
  const userOffsets = messages.flatMap((message, index) =>
    message.role === 'user' ? [index] : [],
  );
  // One large turn cannot be safely summarized under this initial policy.
  userOffsets.length >= 3 ||
    Fail`Compaction needs an older completed user turn`;
  const cut = userOffsets.at(-2);
  const system = messages.filter(message => message.role === 'system');
  const prefix = messages
    .slice(0, cut)
    .filter(message => message.role !== 'system');
  const retained = messages.slice(cut);
  const pending = new Map();
  for (const message of prefix) {
    !message.outcomeUnknown ||
      Fail`Compaction cannot conceal unknown tool outcomes`;
    if (message.role === 'user') {
      pending.size === 0 || Fail`Compaction cannot split a tool group`;
    }
    for (const call of message.tool_calls ?? []) {
      (typeof call.id === 'string' && !pending.has(call.id)) ||
        Fail`Invalid compaction tool identity`;
      pending.set(call.id, true);
    }
    if (message.role === 'tool') {
      pending.delete(message.tool_call_id) ||
        Fail`Compaction tool outcome has no call`;
    }
  }
  pending.size === 0 || Fail`Compaction prefix has unresolved tool calls`;
  if (
    !force &&
    wireBytes({ messages: [...system, ...retained], tools }) >= threshold
  )
    Fail`Compaction retained tail exceeds the model headroom`;
  return harden({
    system,
    prefix,
    retained,
    tools,
    headroomBytes: threshold || undefined,
    originalBytes: estimate,
  });
};
harden(planContextCompaction);

/**
 * Summarization spends the same granted inference authority, without tools.
 * A summary is model-authored context, never promoted into system authority.
 * @param {ReturnType<typeof planContextCompaction>} plan
 * @param {(messages: any[]) => Promise<any>} invoke
 * @param {AbortSignal} [signal]
 */
export const summarizeContext = async (plan, invoke, signal) => {
  if (plan === undefined) throw Fail`Missing compaction plan`;
  signal?.throwIfAborted();
  const answer = await invoke([
    ...plan.system,
    ...plan.prefix,
    {
      role: 'user',
      content:
        'Summarize the completed conversation above for continuation. Preserve decisions, constraints, file/workspace locations, completed effects, failures, and unfinished tasks. Do not call tools or invent results. Return only a concise factual continuation summary.',
    },
  ]);
  signal?.throwIfAborted();
  const message = answer?.message;
  (message?.role === 'assistant' &&
    typeof message.content === 'string' &&
    message.content.trim() !== '' &&
    (message.tool_calls === undefined ||
      (Array.isArray(message.tool_calls) &&
        Number(message.tool_calls.length) === 0))) ||
    Fail`Invalid compaction summary`;
  const summary = message.content;
  const context = [
    ...plan.system,
    { role: 'assistant', content: summary },
    ...plan.retained,
  ];
  const nextBytes = wireBytes({ messages: context, tools: plan.tools });
  nextBytes < plan.originalBytes || Fail`Compaction did not reduce context`;
  if (plan.headroomBytes !== undefined && nextBytes >= plan.headroomBytes)
    Fail`Compaction summary and tail exceed the model headroom`;
  return harden({
    summary,
    retained: plan.retained,
    context,
    usage: answer.usage,
  });
};
harden(summarizeContext);
