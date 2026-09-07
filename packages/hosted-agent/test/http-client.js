// @ts-check
import { request } from 'node:http';

/** @import { IncomingMessage, RequestOptions } from 'node:http' */

// Exercise the listener over real HTTP without Node's lazily initialized fetch
// pool, whose error constructors are incompatible with SES on Node 24.20.0.
/**
 * @param {string} url
 * @param {RequestOptions & { body?: string }} options
 * @returns {Promise<IncomingMessage>}
 */
export const requestHttp = (url, { body, ...options }) =>
  new Promise((resolve, reject) => {
    const req = request(url, { ...options, agent: false }, resolve);
    req.once('error', reject);
    req.end(body);
  });
harden(requestHttp);

/** @param {IncomingMessage} response */
export const readHttpText = async response => {
  let text = '';
  response.setEncoding('utf8');
  for await (const chunk of response) text += chunk;
  return text;
};
harden(readHttpText);
