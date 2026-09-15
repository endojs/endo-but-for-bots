// @ts-check

/**
 * @typedef {Record<string, string | string[] | undefined>} HttpHeaders
 *
 * @typedef {object} HttpRequestDescription
 * @property {string} method
 * @property {string} path
 * @property {HttpHeaders} headers
 *
 * @typedef {object} HttpRequest
 * @property {string} method
 * @property {string} path
 * @property {HttpHeaders} headers
 * @property {string} body already decoded, and no larger than `maxBodyBytes`
 *
 * @typedef {object} HttpResponse
 * @property {number} status
 * @property {string} body
 *
 * @typedef {{ allowed: true } | { allowed: false, status: number, body: string }} HttpAdmission
 *
 * The power tells core when a request is finished (deadline, disconnect, or
 * listener close) through this signal, so core can release the resources the
 * request acquired even though its handler promise may never settle.
 *
 * @typedef {object} HttpAbortSignal
 * @property {() => boolean} aborted
 * @property {(listener: () => void) => void} onAbort
 *
 * @typedef {object} HttpListenerOptions
 * @property {number} port
 * @property {string} host
 * @property {number} maxBodyBytes
 * @property {number} maxResponseBytes
 * @property {number} maxHeaderBytes
 * @property {number} maxRequests concurrent requests before 503
 * @property {number} requestDeadlineMs
 * @property {number} keepAliveTimeoutMs
 * @property {(request: HttpRequestDescription) => HttpAdmission | Promise<HttpAdmission>} admit
 *   decides on the request line and headers alone, before any body is read, so
 *   a denied request costs whoever it was aimed at nothing. It may answer
 *   asynchronously — a guest can hold this — which is why the request cap and
 *   the deadline are applied before it is consulted rather than after
 * @property {(request: HttpRequest, abort: HttpAbortSignal) => Promise<HttpResponse>} handle
 * @property {(error: unknown) => void} onError
 *
 * @typedef {object} HttpListener
 * @property {() => Promise<void>} close
 *
 * The transport half of an HTTP listener: socket tracking, header and
 * body limits, deadlines, and the reject responses that enforce them.
 * Core supplies only admission policy and the guest invocation, so no
 * `IncomingMessage`, `ServerResponse`, or `Server` crosses the boundary.
 *
 * @typedef {object} HttpListenerPowers
 * @property {(options: HttpListenerOptions) => Promise<HttpListener>} listen
 */

// Port only: the host implementation is `node/http-listeners.js`.
export {};
