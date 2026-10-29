// @ts-nocheck
/* global globalThis */
// Removes the host text codecs before SES initializes, so that
// _xs-missing-text-codecs.js observes a host that never provided them.

delete globalThis.TextEncoder;
delete globalThis.TextDecoder;
