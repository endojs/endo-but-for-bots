// @ts-check

/** @typedef {{ id?: string, type?: string, function: { name: string, arguments: string | object } }} ToolCall */

/** @param {string} raw */
const parseParamValue = raw => {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return trimmed;
  }
};

/** @param {string} block */
const parseFunctionParamFormat = block => {
  const fnMatch = block.match(/<function=([^>]+)>/);
  if (!fnMatch) return undefined;
  const name = fnMatch[1].trim();
  /** @type {Record<string, unknown>} */
  const args = {};
  const paramRe = /<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/g;
  for (const match of block.matchAll(paramRe)) {
    args[match[1].trim()] = parseParamValue(match[2]);
  }
  if (Object.keys(args).length === 0) {
    const looseParamRe =
      /<parameter=([^>]+)>\s*([\s\S]*?)(?=<parameter|<\/function|<function|$)/g;
    for (const match of block.matchAll(looseParamRe)) {
      const key = match[1].trim();
      const value = match[2].replace(/<\/?parameter>/g, '').trim();
      if (key && value) args[key] = parseParamValue(value);
    }
  }
  return name ? { name, args: JSON.stringify(args) } : undefined;
};

/**
 * Recover tool calls emitted as XML in a model's text instead of through the
 * provider's structured tool-call channel.
 *
 * @param {string} content
 * @returns {{ toolCalls: ToolCall[] | undefined, cleanedContent: string }}
 */
export const extractToolCallsFromContent = content => {
  /** @type {ToolCall[]} */
  const toolCalls = [];
  const toolCallRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let index = 0;
  for (const match of content.matchAll(toolCallRe)) {
    const block = match[1].trim();
    let name = '';
    /** @type {string | object} */
    let args = '{}';
    try {
      const parsed = JSON.parse(block);
      if (parsed && typeof parsed === 'object') {
        name = parsed.name || '';
        if (parsed.arguments !== undefined) {
          args =
            typeof parsed.arguments === 'string'
              ? parsed.arguments
              : JSON.stringify(parsed.arguments);
        }
      }
    } catch {
      const parsed = parseFunctionParamFormat(block);
      if (parsed) {
        ({ name, args } = parsed);
      } else {
        name = block.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || '';
        args = block.match(/"arguments"\s*:\s*(\{[\s\S]*\})/)?.[1] || '{}';
      }
    }
    if (name) {
      toolCalls.push({
        id: `tool_${Date.now()}_${index}`,
        type: 'function',
        function: { name, arguments: args },
      });
      index += 1;
    }
  }

  const bareFnRe = /<function=([^>]+)>([\s\S]*?)(?:<\/function>|$)/g;
  const withoutToolCalls = content.replace(toolCallRe, '');
  for (const match of withoutToolCalls.matchAll(bareFnRe)) {
    const name = match[1].trim();
    /** @type {Record<string, unknown>} */
    const args = {};
    const paramRe =
      /<parameter=([^>]+)>\s*([\s\S]*?)(?:<\/parameter>|(?=<parameter)|(?=<\/function)|$)/g;
    for (const parameter of match[2].matchAll(paramRe)) {
      const key = parameter[1].trim();
      const value = parameter[2].replace(/<\/?parameter>/g, '').trim();
      if (key && value) args[key] = parseParamValue(value);
    }
    if (name) {
      toolCalls.push({
        id: `tool_${Date.now()}_${index}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      });
      index += 1;
    }
  }

  const cleanedContent = content
    .replace(toolCallRe, '')
    .replace(bareFnRe, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*/g, '')
    .trim();
  return {
    toolCalls: toolCalls.length === 0 ? undefined : toolCalls,
    cleanedContent,
  };
};
harden(extractToolCallsFromContent);
