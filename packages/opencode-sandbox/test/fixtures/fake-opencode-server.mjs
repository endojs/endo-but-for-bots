#!/usr/bin/env node
// @ts-check
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const streams = new Set();
const emit = (type, properties) => {
  for (const stream of streams) stream.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
};
const checkpoint = () => ({
  version: 1, summaryID: 'summary', messages: [
    { info: { id: 'request', sessionID: 'ses_fresh', role: 'user' }, parts: [
      { id: 'request-part', messageID: 'request', sessionID: 'ses_fresh', type: 'compaction' },
    ] },
    { info: { id: 'summary', sessionID: 'ses_fresh', role: 'assistant', summary: true,
      parentID: 'request', finish: 'stop' }, parts: [
      { id: 'summary-part', messageID: 'summary', sessionID: 'ses_fresh', type: 'text',
        text: 'S'.repeat(2 * 1024 * 1024) },
    ] },
  ],
});

const server = createServer((request, response) => {
  const route = new URL(request.url || '/', 'http://localhost').pathname;
  if (route === '/event') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': ready\n\n');
    streams.add(response);
    response.on('close', () => streams.delete(response));
    return;
  }
  response.setHeader('content-type', 'application/json');
  if (route === '/session/ses_fresh/prompt_async') {
    if (process.env.FAKE_PROMPT_LOG) appendFileSync(process.env.FAKE_PROMPT_LOG, 'prompt\n');
    response.end('{}');
    const mode = process.env.FAKE_CHECKPOINT_MODE;
    emit('session.status', { sessionID: 'ses_fresh', status: { type: 'busy' } });
    if (mode === 'timeout' || mode === 'interrupt') {
      // The child deliberately keeps producing through SIGTERM for these
      // tests. The bridge must fence queued prompts while awaiting shutdown.
      setTimeout(() => emit('session.compacted', { sessionID: 'ses_fresh', checkpoint: checkpoint() }),
        mode === 'timeout' ? 500 : 5500);
      return;
    }
    if (mode === 'native-error') {
      emit('session.error', { sessionID: 'ses_fresh', error: {
        name: 'UnknownError', data: { message: 'Unable to publish compaction checkpoint' },
      } });
    } else if (mode === 'malformed') {
      for (const stream of streams) stream.write('data: not-json\n\n');
    } else if (mode === 'eof') {
      for (const stream of streams) stream.end();
      return;
    } else {
      const cut = checkpoint();
      emit('session.compacted', { sessionID: 'ses_fresh', checkpoint: cut });
      if (mode === 'conflict') cut.messages[1].parts[0].text = 'changed';
      emit('session.compacted', { sessionID: 'ses_fresh', checkpoint: cut });
    }
    emit('message.updated', { sessionID: 'ses_fresh', info: { id: 'answer', role: 'assistant' } });
    emit('message.part.updated', { part: { sessionID: 'ses_fresh', id: 'answer-part', messageID: 'answer',
      type: 'text', text: 'After checkpoint', time: { end: 1 } } });
    emit('session.status', { sessionID: 'ses_fresh', status: { type: 'idle' } });
    return;
  }
  if (route === '/session/ses_fresh/abort') {
    response.end('{}');
    return;
  }
  if (route === '/session' && request.method === 'POST') {
    if (process.env.FAKE_CREATE_FAILURE === '1') {
      response.writeHead(503);
      response.end('{}');
      return;
    }
    if (process.env.FAKE_CREATE_INVALID === 'null') {
      response.end('null');
      return;
    }
    if (process.env.FAKE_CREATE_INVALID === 'empty-id') {
      response.end(JSON.stringify({ id: '' }));
      return;
    }
    response.end(JSON.stringify({ id: 'ses_fresh' }));
    return;
  }
  if (route === '/config/providers') {
    response.end('{}');
    return;
  }
  // There is no durable native session to resume in this server.
  response.writeHead(404);
  response.end('{}');
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No server port');
  process.stdout.write(`opencode server listening on http://127.0.0.1:${address.port}\n`);
});
process.on('SIGTERM', () => {
  if (['timeout', 'interrupt'].includes(process.env.FAKE_CHECKPOINT_MODE || '')) {
    setTimeout(() => process.exit(0), 800);
    return;
  }
  process.exit(0);
});
