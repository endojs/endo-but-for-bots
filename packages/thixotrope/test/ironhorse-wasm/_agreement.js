// @ts-check
// The request lines both engines must answer byte for byte alike: values of
// every kind, promise jobs, deliveries with outbound frames, malformed
// budgets and requests, and close. The same list as `module.js`'s, which
// drives the module directly; this one is driven through the launcher and
// the shell. `module.js` cannot be imported for it (it registers tests), so
// keep the two in step until it imports this file.

/** @param {Record<string, unknown>} request */
const line = request => JSON.stringify(request);

export const AGREEMENT = Object.freeze([
  line({ source: '1 + 1' }),
  line({ source: "'text with \\u00e9 and \\n'" }),
  line({ source: 'null' }),
  line({ source: 'undefined' }),
  line({ source: 'true' }),
  line({ source: '1.5e300' }),
  line({ source: '-0' }),
  line({ source: "[1, 'two', null, { three: 3 }]" }),
  line({ source: '({ nested: { list: [1, 2n] } })' }),
  line({ source: "JSON.stringify({ a: 1, b: [true, null, 'c'] })" }),
  line({
    source: "try { null.x } catch (e) { e.name + ': ' + e.message }",
  }),
  line({
    source:
      "globalThis.order = []; Promise.resolve(1).then(v => order.push(v)); Promise.reject(Error('no')).catch(e => order.push(e.message)); order.push('sync'); 'queued'",
  }),
  line({ source: "order.join(',')" }),
  line({
    op: 'deliver',
    source: 'thixotropeSend(\'{"t":"f","b64":"AA=="}\'); 1',
  }),
  line({
    op: 'deliver',
    source:
      'thixotropeSend(\'{"t":"f","b64":"AQ=="}\'); thixotropeSend(\'{"t":"f","b64":"Ag=="}\')',
    budget: '5000000',
    drainBudget: '5000000',
  }),
  line({ op: 'deliver', source: '2' }),
  line({ source: '1', budget: '0' }),
  line({ source: '1', budget: '-5' }),
  line({ source: '1', budget: 1.5 }),
  line({ op: 'deliver', source: '1', drainBudget: 'x' }),
  line({ source: '1', budget: '18446744073709551616' }),
  '[1, 2]',
  '"just a string"',
  'not json',
  '',
  line({ op: 'unknown', source: "'an unknown op evaluates'" }),
  line({ op: 'frobnicate' }),
  line({ source: 'Object.keys(globalThis).length > 0' }),
  line({ op: 'close' }),
]);
