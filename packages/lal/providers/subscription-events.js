// @ts-check
import { Fail } from '@endo/errors';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** @param {AsyncIterableIterator<Uint8Array>} bytes */
export const responseEvents = async function* responseEventIterator(bytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data = [];
  let size = 0;
  const takeEvent = () => {
    const text = data.join('\n');
    data = [];
    if (text === '[DONE]') return { type: 'stream.done' };
    try {
      return JSON.parse(text);
    } catch {
      throw Error('Invalid Responses stream event');
    }
  };
  for await (const chunk of bytes) {
    size += chunk.byteLength;
    size <= MAX_RESPONSE_BYTES ||
      Fail`Responses stream exceeds transport bound`;
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = /^(.*?)(\r\n|\n|\r(?!$))/s.exec(pending);
      if (!match) break;
      pending = pending.slice(match[0].length);
      const line = match[1];
      if (line === '') {
        if (data.length > 0) {
          const event = takeEvent();
          if (event !== undefined) yield event;
        }
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  pending += decoder.decode();
  // A trailing CR is held across chunks to distinguish CRLF. At EOF it is
  // itself the final line ending, including a CR-only blank dispatch line.
  if (pending === '\r') {
    pending = '';
    if (data.length > 0) {
      const event = takeEvent();
      if (event !== undefined) yield event;
    }
  }
  (!pending.trim() && data.length === 0) ||
    Fail`Truncated Responses stream event`;
};

harden(responseEvents);
