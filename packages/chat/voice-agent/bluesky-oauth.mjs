// bluesky-oauth.mjs — "Sign in with Bluesky" via AT-Protocol OAuth (the standard branded flow).
//
// Wraps @atproto/oauth-client-node (NodeOAuthClient). It is a CONFIDENTIAL web client: the client_id IS the public
// URL of the client-metadata document we serve, so there is no app-registration step — the Authorization Server
// fetches our metadata + public JWKS at authorize time. We use scope `atproto` ONLY: that proves the account DID
// and grants NOTHING else (no posting, no repo read) — we just need to know WHO signed in. Empirically verified to
// run in-process under @endo/init SES lockdown (jose's Web-Crypto paths don't touch frozen intrinsics).
//
// GRACEFUL: the dependency is loaded by DYNAMIC import. If it isn't installed yet, `available()` is false and the
// login/callback routes return a clear "not installed" message — while client-metadata.json + jwks.json still
// serve (they only need the stored keypair), so setup can be staged. Turning it on in the morning = install the
// dep + (auto-)generate the keypair + restart.
//
// Secrets: the signing keypair's PRIVATE JWK lives in ~/.config/field-agent/bluesky-oauth-key.json (mode 600),
// NEVER in code/chat/logs. Only the PUBLIC half is served at /bsky/jwks.json.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

if (typeof globalThis.harden !== 'function') globalThis.harden = x => Object.freeze(x);

const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, obj, mode = 0o600) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode }); fs.renameSync(tmp, file); };

// A tiny persistent key→opaque-blob store backing the OAuth client's stateStore/sessionStore.
const makeFileStore = file => {
  const all = () => readJson(file, {}) || {};
  return harden({
    async get(key) { return all()[key]; },
    async set(key, value) { const d = all(); d[key] = value; writeJson(file, d); },
    async del(key) { const d = all(); delete d[key]; writeJson(file, d); },
  });
};

// Public JWK = private JWK minus the private scalar `d` (so we can serve jwks.json without the OAuth lib).
const publicOf = jwk => { if (!jwk) return null; const { d, ...pub } = jwk; return { ...pub, use: pub.use || 'sig', alg: pub.alg || 'ES256' }; };

/**
 * @param {object} opts
 * @param {string} opts.baseUrl     public origin, e.g. https://agentc.chu.vmkqx.com
 * @param {string} opts.keyFile     where the private signing JWK is stored
 * @param {string} opts.stateFile   ephemeral OAuth state store
 * @param {string} opts.sessionFile persistent OAuth session store (keyed by DID)
 * @param {string} [opts.clientName]
 */
export const makeBlueskyOAuth = ({ baseUrl, keyFile, stateFile, sessionFile, clientName = 'Agent C' } = {}) => {
  const CLIENT_ID = `${baseUrl}/bsky/client-metadata.json`;
  const REDIRECT = `${baseUrl}/bsky/callback`;
  const KID = 'agentc-bsky-1';

  // The client-metadata document (pure data; no lib needed). Confidential web client, scope atproto only.
  const clientMetadata = () => harden({
    client_id: CLIENT_ID,
    client_name: clientName,
    client_uri: baseUrl,
    redirect_uris: [REDIRECT],
    scope: 'atproto',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'web',
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'ES256',
    dpop_bound_access_tokens: true,
    jwks_uri: `${baseUrl}/bsky/jwks.json`,
  });

  // Ensure a signing keypair exists; generate via the lib if missing. Returns the PRIVATE jwk (or null if no lib).
  const ensureKey = async () => {
    let jwk = readJson(keyFile);
    if (jwk && jwk.d) return jwk;
    const { JoseKey } = await import('@atproto/oauth-client-node'); // throws if dep absent → caller handles
    const key = await JoseKey.generate(['ES256'], KID);
    jwk = key.privateJwk || (typeof key.export === 'function' ? await key.export() : null);
    if (!jwk || !jwk.d) throw new Error('could not generate a private JWK');
    if (!jwk.kid) jwk.kid = KID;
    writeJson(keyFile, jwk);
    return jwk;
  };

  // The public JWKS (served at /bsky/jwks.json). Works from the stored key WITHOUT the lib.
  const jwks = () => { const jwk = readJson(keyFile); const pub = publicOf(jwk); return harden({ keys: pub ? [pub] : [] }); };

  // Memoized NodeOAuthClient. Lazily constructed; null if the dep isn't installed.
  let clientP = null;
  let unavailable = null;
  const getClient = async () => {
    if (unavailable) return null;
    if (clientP) return clientP;
    clientP = (async () => {
      const { NodeOAuthClient, JoseKey } = await import('@atproto/oauth-client-node');
      const jwk = await ensureKey();
      const key = await JoseKey.fromImportable(jwk, jwk.kid || KID);
      return new NodeOAuthClient({
        clientMetadata: clientMetadata(),
        keyset: [key],
        stateStore: makeFileStore(stateFile),
        sessionStore: makeFileStore(sessionFile),
      });
    })().catch(e => { unavailable = e; return null; });
    return clientP;
  };

  const available = async () => !!(await getClient());

  // → a URL string to redirect the user to (their PDS authorize page). `state` is our CSRF/round-trip token.
  const loginUrl = async (handle, state) => {
    const client = await getClient();
    if (!client) throw new Error('Bluesky OAuth not available (dependency not installed) — see the runbook');
    const url = await client.authorize(String(handle || '').trim(), { state });
    return url.toString();
  };

  // Handle the OAuth redirect-back. Returns { did, handle?, state }. `params` is a URLSearchParams.
  const callback = async params => {
    const client = await getClient();
    if (!client) throw new Error('Bluesky OAuth not available (dependency not installed)');
    const { session, state } = await client.callback(params);
    return harden({ did: session.did, state: state || null });
  };

  return harden({ clientMetadata, jwks, loginUrl, callback, available, CLIENT_ID, REDIRECT });
};
