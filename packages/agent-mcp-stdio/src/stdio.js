// @ts-check
// prefer-endo-primitives-exempt: @endo/bytes has no streaming UTF-8 decoder,
// and a multi-byte character may straddle two stdin chunks.

import { PARSE_ERROR } from '@endo/agent-tools/adapters/mcp.js';

// MCP stdio framing: one JSON-RPC message per line, delimited by `\n` ONLY.
// Node's `readline` also splits on `\r`, U+2028, and U+2029. JSON allows a raw
// `\r` as whitespace between tokens, and U+2028 and U+2029 raw inside strings,
// so splitting on any of them would tear a valid frame; this reader splits the
// byte stream itself. Replies are written in arrival order of completion; a
// slow `tools/call` does not block `ping` or another call.

/**
 * The default bound on one frame, in UTF-16 code units. A peer that never
 * sends `\n` cannot grow the process past it.
 */
export const DEFAULT_MAX_FRAME_LENGTH = 16 * 1024 * 1024;

/**
 * @param {object} options
 * @param {AsyncIterable<Uint8Array | string>} options.input - the client's
 *   channel (stdin).
 * @param {(line: string) => void} options.writeLine - writes one frame
 *   (without its trailing newline) to the client (stdout).
 * @param {(line: string) => Promise<string | undefined>} options.handleLine
 *   - answers one frame; expected never to reject.
 * @param {() => void} [options.onEof] - called once input reaches EOF, before
 *   waiting on in-flight replies. The client has hung up, so a caller tears
 *   down here whatever would otherwise keep those replies pending.
 * @param {(error: unknown) => void} [options.onError] - reports a
 *   `handleLine` rejection or a `writeLine` throw, whose frame then goes
 *   unanswered; other frames are still served.
 * @param {number} [options.maxFrameLength] - the longest frame accepted, in
 *   UTF-16 code units. A longer frame is discarded unread and answered with a
 *   JSON-RPC `Parse error`.
 * @returns {Promise<void>} settles once input reaches EOF and every in-flight
 *   reply has settled.
 */
export const serveStdio = async ({
  input,
  writeLine,
  handleLine,
  onEof = () => {},
  onError = () => {},
  maxFrameLength = DEFAULT_MAX_FRAME_LENGTH,
}) => {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();
  // The pieces of the frame not yet terminated. Each chunk is searched for
  // `\n` once, and a frame is joined once, so framing is linear in the input.
  /** @type {string[]} */
  let pieces = [];
  let piecesLength = 0;
  // Set while skipping the rest of a frame already refused as too long.
  let discarding = false;

  const refuseOversize = () => {
    try {
      writeLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: PARSE_ERROR,
            message: 'Parse error',
            data: { detail: `frame exceeds ${maxFrameLength} characters` },
          },
        }),
      );
    } catch (error) {
      onError(error);
    }
  };

  /** @param {string} line */
  const dispatch = line => {
    // Tolerate a CRLF client, but never split on a bare `\r`.
    const frame = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (frame.trim() === '') {
      return;
    }
    const done = handleLine(frame)
      .then(reply => {
        if (reply !== undefined) {
          writeLine(reply);
        }
      })
      .catch(onError);
    inFlight.add(done);
    done.finally(() => inFlight.delete(done));
  };

  /** @param {string} tail - the last piece of a terminated frame. */
  const endFrame = tail => {
    if (discarding) {
      discarding = false;
    } else if (piecesLength + tail.length > maxFrameLength) {
      refuseOversize();
    } else {
      pieces.push(tail);
      dispatch(pieces.join(''));
    }
    pieces = [];
    piecesLength = 0;
  };

  /** @param {string} text */
  const take = text => {
    let start = 0;
    let index = text.indexOf('\n');
    while (index >= 0) {
      endFrame(text.slice(start, index));
      start = index + 1;
      index = text.indexOf('\n', start);
    }
    const rest = text.slice(start);
    if (discarding || rest === '') {
      return;
    }
    if (piecesLength + rest.length > maxFrameLength) {
      refuseOversize();
      pieces = [];
      piecesLength = 0;
      discarding = true;
      return;
    }
    pieces.push(rest);
    piecesLength += rest.length;
  };

  for await (const chunk of input) {
    take(
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true }),
    );
  }
  take(decoder.decode());
  if (piecesLength > 0 && !discarding) {
    endFrame('');
  }
  onEof();
  await Promise.all([...inFlight]);
};
harden(serveStdio);

/**
 * Serialize one frame. `JSON.stringify` escapes every control character inside
 * strings, so the result never embeds a raw newline.
 *
 * @param {{ write: (chunk: string) => unknown }} output
 * @returns {(line: string) => void}
 */
export const makeLineWriter = output => line => {
  output.write(`${line}\n`);
};
harden(makeLineWriter);

/**
 * Settle once every frame written so far has been handed to the operating
 * system. A pipe write is asynchronous on POSIX, so a process that exits the
 * moment its work settles can drop its last frames; an empty write's callback
 * runs only after every earlier write has flushed.
 *
 * @param {{ write: (chunk: string, callback?: (error?: Error | null) => void) => unknown }} output
 * @returns {Promise<void>}
 */
export const flushOutput = output =>
  new Promise(resolve => {
    // A flush error means the reader has gone; nothing is left to deliver.
    output.write('', () => resolve());
  });
harden(flushOutput);
