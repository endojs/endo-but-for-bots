#!/usr/bin/env node
// @ts-check
import { createServer } from 'node:http';
import process from 'node:process';

const server = createServer((request, response) => {
  const route = new URL(request.url || '/', 'http://localhost').pathname;
  if (route === '/event') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': ready\n\n');
    return;
  }
  response.setHeader('content-type', 'application/json');
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
process.on('SIGTERM', () => process.exit(0));
