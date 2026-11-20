// Observe complete requests on the stock native worker protocol. Inbound payloads
// are decoded in memory; only OCapN method selectors and timing counters are saved.
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { makeSyrupReader } from '@endo/ocapn/syrup';

const skipValue = reader => {
  const kind = reader.peekTypeHint();
  const container = {
    dictionary: 'Dictionary',
    record: 'Record',
    list: 'List',
    set: 'Set',
  }[kind];
  if (!container) {
    reader.readTypeAndMaybeValue();
    return;
  }
  reader[`enter${container}`]();
  while (!reader[`peek${container}End`]()) skipValue(reader);
  reader[`exit${container}`]();
};

const readMethod = (envelope, details) => {
  if (envelope.t !== 'f') return envelope.t;
  const reader = makeSyrupReader(
    Uint8Array.from(Buffer.from(envelope.b64, 'base64')),
  );
  reader.enterRecord();
  const operation = reader.readSelectorAsString();
  if (operation !== 'op:deliver') return operation;
  reader.enterRecord();
  const target = reader.readSelectorAsString();
  if (target !== 'desc:export' && target !== 'desc:answer') return target;
  const targetSlot = String(reader.readInteger());
  reader.exitRecord();
  reader.enterList();
  const method = reader.readSelectorAsString();
  if (!details) return method;
  if (method === 'dispatching') {
    details.push({
      method,
      targetSlot,
      round: Number(reader.readTypeAndMaybeValue().value),
    });
    return method;
  }
  if (method === 'fulfill') {
    if (reader.peekTypeHint() === 'boolean')
      details.push({ method, boolean: reader.readBoolean() });
    return method;
  }
  if (!['startRound', 'deliverMail', 'roundFinal'].includes(method))
    return method;
  reader.enterDictionary();
  const fields = { method };
  if (method === 'roundFinal') fields.targetSlot = targetSlot;
  while (!reader.peekDictionaryEnd()) {
    const name = reader.readString();
    if (method === 'startRound' && name === 'sink') {
      reader.enterRecord();
      fields.sinkDescriptor = reader.readSelectorAsString();
      fields.sinkSlot = String(reader.readInteger());
      reader.exitRecord();
    } else if (method === 'startRound' && name === 'turnId') {
      fields.turnId = reader.readString();
      break;
    } else if (method === 'roundFinal' && name === 'round') {
      fields.round = Number(reader.readTypeAndMaybeValue().value);
      break;
    } else if (method === 'deliverMail' && name === 'postmark') {
      fields.postmark = Number(reader.readTypeAndMaybeValue().value);
      break;
    } else {
      skipValue(reader);
    }
  }
  details.push(fields);
  return method;
};

export const methodOf = (envelope, details) => {
  try {
    return readMethod(envelope, details);
  } catch {
    return '(unparsed)';
  }
};

export const dispatchMethods = (source, details) => {
  // The emitted program is a concatenation of calls with JSON-string arguments.
  const call = /thixotropeDispatch\(("(?:[^"\\]|\\.)*")\);/gy;
  const names = [];
  let offset = 0;
  while (offset < source.length) {
    const found = call.exec(source);
    if (!found) throw Error(`Unrecognized native dispatch at offset ${offset}`);
    names.push(methodOf(JSON.parse(JSON.parse(found[1])), details));
    offset = call.lastIndex;
  }
  if (!names.length) throw Error('Empty native dispatch');
  return names;
};

export const observeForwardWorkers = (processes, directory) => {
  const file = path.join(directory, 'forward-worker.jsonl');
  return harden({
    ...processes,
    spawn: (executable, args, options) => {
      const child = processes.spawn(executable, args, options);
      if (!args[0]?.endsWith('/heap.sqlite')) return child;
      const vat = path.basename(path.dirname(args[0]));
      let pending;
      return harden({
        ...child,
        input: fd => {
          const input = child.input(fd);
          if (fd !== 0 || !input) return input;
          return harden({
            ...input,
            write: text => {
              const message = JSON.parse(text);
              if (message.op !== 'deliver') return input.write(text);
              const incomingDetails = [];
              const methods = dispatchMethods(message.source, incomingDetails);
              pending = { vat, methods, incomingDetails, began: Date.now() };
              return input.write(
                `${JSON.stringify({ ...message, timing: true })}\n`,
              );
            },
          });
        },
        lines: fd => {
          const source = child.lines(fd);
          if (fd !== 1) return source;
          return {
            async *[Symbol.asyncIterator]() {
              for await (const line of source) {
                if (pending) {
                  const ended = Date.now();
                  const answer = JSON.parse(line);
                  if (
                    answer.op !== 'result' ||
                    typeof answer.result !== 'string'
                  )
                    throw Error('Native delivery failed during forward trace');
                  const outgoingDetails = [];
                  const outbound = JSON.parse(answer.result).map(frame =>
                    methodOf(frame, outgoingDetails),
                  );
                  appendFileSync(
                    file,
                    `${JSON.stringify({
                      ...pending,
                      ended,
                      outbound,
                      outgoingDetails,
                      timing: answer.timing,
                    })}\n`,
                    { mode: 0o600 },
                  );
                  pending = undefined;
                }
                yield line;
              }
            },
          };
        },
      });
    },
  });
};
