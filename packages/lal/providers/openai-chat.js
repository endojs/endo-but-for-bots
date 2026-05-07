// @ts-check
/**
 * Shared converters for the OpenAI Chat Completions API shape.
 *
 * Used by every provider whose upstream speaks Chat Completions:
 * llama.cpp, OpenRouter, Google's OpenAI-compatible Gemini endpoint,
 * and (when wired) OpenAI itself.
 *
 * This module is API-shape code, not a provider — it does not know about
 * any specific vendor and never opens an HTTP connection.
 */

/**
 * @import {
 *   ChatCompletion,
 *   ChatCompletionMessageParam,
 *   ChatCompletionTool,
 * } from 'openai/resources/chat/completions'
 */

/**
 * @typedef {object} Logger
 * @property {(...args: unknown[]) => void} log
 * @property {(...args: unknown[]) => void} error
 * @property {(...args: unknown[]) => void} warn
 */

/**
 * @typedef {object} CommonTool
 * @property {'function'} type
 * @property {{ name: string, description: string, parameters: object }} function
 */

/**
 * @typedef {object} CommonChatMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string} content
 * @property {Array<{ id?: string, function: { name: string, arguments: string|object }}>} [tool_calls]
 * @property {string} [tool_call_id]
 */

/**
 * Convert common tools to the OpenAI Chat Completions tools array.
 * `CommonTool` is structurally identical to `ChatCompletionTool`, so this
 * is currently a pass-through cast. Kept as a named seam so future
 * tool-shape adjustments can land in one place.
 *
 * @param {CommonTool[]} tools
 * @returns {ChatCompletionTool[]}
 */
export const toOpenAIChatTools = tools =>
  /** @type {ChatCompletionTool[]} */ (tools);
harden(toOpenAIChatTools);

/**
 * Convert common messages to OpenAI Chat Completions request messages.
 *
 * @param {CommonChatMessage[]} messages
 * @returns {ChatCompletionMessageParam[]}
 */
export const toOpenAIChatMessages = messages =>
  messages.map(msg => {
    if (msg.role === 'assistant') {
      const out = { role: 'assistant', content: msg.content || '' };
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // @ts-expect-error tool_calls lacks the `type: 'function'`
        // discriminator until a follow-up commit; the OpenAI server
        // tolerates the omission today.
        out.tool_calls = msg.tool_calls.map(tc => ({
          id: tc.id,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }
      return /** @type {ChatCompletionMessageParam} */ (out);
    }
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.tool_call_id ?? '',
        content: msg.content,
      };
    }
    return { role: msg.role, content: msg.content };
  });
harden(toOpenAIChatMessages);

/**
 * Convert an OpenAI Chat Completions response choice to a CommonChatMessage.
 *
 * Note for debuggers: OpenAI-Chat-shape providers (llama.cpp, OpenRouter,
 * Gemini's compat endpoint, etc.) sometimes return a "choice" that silently
 * omits `message.content` and `message.tool_calls` — e.g. when the upstream
 * model truncates mid-stream or returns an unfamiliar `finish_reason`. In that
 * case this function returns an empty assistant message rather than throwing,
 * so the agent loop sees a no-op turn instead of a crash. If you are chasing
 * "the agent suddenly went silent," check the raw upstream response first.
 *
 * @param {ChatCompletion.Choice | undefined} choice
 * @returns {CommonChatMessage}
 */
export const parseOpenAIChatChoice = choice => {
  if (!choice) {
    return { role: 'assistant', content: '' };
  }
  const choiceMsg = choice.message;
  /** @type {CommonChatMessage} */
  const message = {
    role: 'assistant',
    content: choiceMsg?.content ?? '',
  };
  const toolCalls = choiceMsg?.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls.map(tc => ({
      id: tc.id,
      function: {
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '{}',
      },
    }));
  }
  return message;
};
harden(parseOpenAIChatChoice);

/**
 * Truncate to the last N messages when `maxMessages` is set.
 *
 * @param {CommonChatMessage[]} messages
 * @param {number} [maxMessages]
 * @param {Logger} [logger]
 * @returns {CommonChatMessage[]}
 */
export const truncateMessages = (
  messages,
  maxMessages,
  logger = console,
) => {
  if (
    typeof maxMessages !== 'number' ||
    maxMessages <= 0 ||
    messages.length <= maxMessages
  ) {
    return messages;
  }
  logger.log(
    `[LAL] Truncated to last ${maxMessages} messages (was ${messages.length})`,
  );
  return messages.slice(-maxMessages);
};
harden(truncateMessages);
