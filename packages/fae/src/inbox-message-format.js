// @ts-check

/**
 * Build the user-role content string for an inbound inbox message.
 *
 * For `package` messages, prose strings and `@`-edge-names are interleaved
 * into the message body, then a structured "Attached references" block is
 * appended that names each attachment with its detected kind and the exact
 * adoption call the agent should use. Attachments are NOT pet names yet —
 * the block exists to keep the model from trying to use them as such.
 *
 * @param {object} message
 * @param {number | bigint} message.number
 * @param {string} message.type
 * @param {string[]} [message.strings]
 * @param {string[]} [message.names]
 * @param {string[]} [message.ids]
 * @param {(id: string | undefined) => Promise<'tool' | 'value' | 'unknown'>} probeKind
 * @returns {Promise<string>}
 */
export const buildInboxMessageContent = async (message, probeKind) => {
  const { number, type, strings, names, ids } = message;
  const replyHint = `Use reply(messageNumber: ${number}, ...) to respond to this message.`;

  if (type !== 'package' || !Array.isArray(strings)) {
    return `[Inbox message #${number}] (${type || 'unknown'} message)\n\n${replyHint}`;
  }

  const namesArray = Array.isArray(names) ? names : [];
  const idsArray = Array.isArray(ids) ? ids : [];

  const parts = [];
  for (let i = 0; i < strings.length; i += 1) {
    parts.push(strings[i]);
    if (i < namesArray.length) {
      parts.push(`@${namesArray[i]}`);
    }
  }
  const textContent = parts.join('').trim();

  let attachmentBlock = '';
  if (namesArray.length > 0) {
    const lines = [];
    for (let i = 0; i < namesArray.length; i += 1) {
      const edgeName = namesArray[i];
      // eslint-disable-next-line no-await-in-loop
      const kind = await probeKind(idsArray[i]);
      if (kind === 'tool') {
        lines.push(
          `- ${edgeName} (kind=tool) — install with adoptTool(messageNumber=${number}, edgeName="${edgeName}", toolName="${edgeName}")`,
        );
      } else if (kind === 'value') {
        lines.push(
          `- ${edgeName} (kind=value) — store with adopt(messageNumber=${number}, edgeName="${edgeName}", petName="${edgeName}")`,
        );
      } else {
        lines.push(
          `- ${edgeName} (kind=unknown) — try adoptTool for capabilities or adopt for plain values`,
        );
      }
    }
    attachmentBlock = `\n\nAttached references (the @-names above resolve to these; you MUST adopt each before using it — they are NOT pet names yet):\n${lines.join('\n')}`;
  }

  return `[Inbox message #${number}] ${textContent}${attachmentBlock}\n\n${replyHint}`;
};
harden(buildInboxMessageContent);
