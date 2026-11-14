// @ts-check

/** @import { Delay as CancellableDelay, ConfinedRequest as ConfinedRequestType, ConfinedResponse as ConfinedResponseType, ConfinedResponseSummary as ConfinedResponseSummaryType, FetchLike as FetchLikeType, FetchLikeBodyReader as FetchLikeBodyReaderType, FetchLikeRequestOptions as FetchLikeRequestOptionsType, FetchLikeResponse as FetchLikeResponseType, HttpConfinementPolicy as HttpConfinementPolicyType } from './src/types.js' */

/**
 * @typedef {ConfinedRequestType} ConfinedRequest
 * @typedef {ConfinedResponseType} ConfinedResponse
 * @typedef {ConfinedResponseSummaryType} ConfinedResponseSummary
 * @typedef {CancellableDelay} Delay
 * @typedef {FetchLikeType} FetchLike
 * @typedef {FetchLikeBodyReaderType} FetchLikeBodyReader
 * @typedef {FetchLikeRequestOptionsType} FetchLikeRequestOptions
 * @typedef {FetchLikeResponseType} FetchLikeResponse
 * @typedef {HttpConfinementPolicyType} HttpConfinementPolicy
 */

export {
  HeaderRejectedError,
  MethodNotAllowedError,
  OriginNotAllowedError,
  RateLimitError,
  RevokedError,
  assertHeadersSafe,
  checkOriginAllowed,
  limitResponseBytes,
  makeHttpConfinement,
  makeRateLimiter,
  makeRequestCancellation,
  normalizeMethod,
  parseAllowedOrigins,
  resolveRedirect,
  snapshotHeaders,
  snapshotResponse,
} from './src/http-confine.js';
