// buffer-caps.mjs — Buffer (buffer.com) social scheduling as an attenuatable object-capability.
//
// Buffer's CURRENT API is a single GraphQL endpoint (https://api.buffer.com, `Authorization: Bearer <token>`).
// The whole permission surface is therefore: a set of CHANNELS (connected social accounts) × a set of OPERATIONS
// (read / draft / publish / delete). We mirror exactly that — the cap's methods ARE Buffer's affordances, and a
// cap is attenuated along two axes:
//   • channels — bind an allow-list so a "post to @brandX only" cap can't touch another account;
//   • operations — withhold publish (draft-only, human approves) and/or delete and/or all writes (read-only).
//
// CAP HYGIENE: the Bearer token is closed over here and NEVER returned, logged, put in argv, or rendered. Callers
// get methods, not the token. (Token is read on demand via getToken so it always reflects the on-disk secret.)
//
// Plain Node (global fetch) so it imports under the SES server and runs standalone in tests.

if (typeof globalThis.harden !== 'function') globalThis.harden = x => Object.freeze(x);

const ENDPOINT = 'https://api.buffer.com';

// the OAuth scope quartet Buffer exposes — the principled grouping for attenuation
export const BUFFER_SCOPES = harden(['posts:read', 'posts:write', 'account:read']);

const PUBLISH_MODES = new Set(['shareNow', 'shareNext', 'addToQueue', 'customScheduled']);

/**
 * @param {object} opts
 * @param {() => string} opts.getToken   returns the Bearer token (e.g. () => getSecret('buffer-key'))
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {object} [opts.bound]          attenuation: { channels?: string[]|null, publish?: bool, del?: bool, write?: bool }
 */
export const makeBuffer = ({ getToken, fetchImpl, bound } = {}) => {
  const doFetch = fetchImpl || globalThis.fetch;
  const cap = harden({ channels: null, publish: true, del: true, write: true, ...(bound || {}) }); // default = full
  const allow = cap.channels ? new Set(cap.channels.map(String)) : null;

  const gql = async (query, variables = {}) => {
    const token = String(getToken ? getToken() : '').trim();
    if (!token) throw new Error('no Buffer token configured (secrets/buffer-key)');
    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    if (json.errors) throw new Error(`Buffer: ${json.errors.map(e => e.message).join('; ')}`);
    if (!res.ok) throw new Error(`Buffer HTTP ${res.status}`);
    return json.data;
  };

  // the org id is needed for almost every call; resolve + memoize (the token's first org)
  let _org = null;
  const orgId = async () => {
    if (_org) return _org;
    const d = await gql(`query { account { organizations { id name } } }`);
    const orgs = (d.account && d.account.organizations) || [];
    if (!orgs.length) throw new Error('Buffer account has no organizations');
    _org = orgs[0].id;
    return _org;
  };

  const requireChannel = id => { if (allow && !allow.has(String(id))) throw new Error(`this Buffer cap is not authorized for channel ${id}`); };
  const requireWrite = () => { if (!cap.write) throw new Error('this Buffer cap is read-only'); };

  // ── READ (account:read / posts:read) ───────────────────────────────────────────────────────────────────────
  const channels = async () => {
    const d = await gql(`query ($input: ChannelsInput!) { channels(input: $input) {
      id name service descriptor displayName isDisconnected externalLink } }`, { input: { organizationId: await orgId() } });
    let list = d.channels || [];
    if (allow) list = list.filter(c => allow.has(String(c.id))); // a bound cap only SEES its channels
    return harden(list);
  };

  const posts = async ({ status = 'scheduled', channelId } = {}) => {
    if (channelId) requireChannel(channelId);
    const filter = { status: [String(status)], ...(channelId ? { channelIds: [String(channelId)] } : (allow ? { channelIds: [...allow] } : {})) };
    const d = await gql(`query ($input: PostsInput!) { posts(input: $input) {
      edges { node { id text status dueAt sentAt channelId } } pageInfo { endCursor hasNextPage } } }`,
      { input: { organizationId: await orgId(), filter, sort: [{ field: 'dueAt', direction: 'asc' }] } });
    return harden(((d.posts && d.posts.edges) || []).map(e => e.node));
  };

  const getPost = async id => {
    const d = await gql(`query ($input: PostInput!) { post(input: $input) {
      id text status dueAt sentAt channelId channelService } }`, { input: { id: String(id) } });
    return harden(d.post || null);
  };

  // ── WRITE (posts:write) — create a post. mode: shareNow|shareNext|addToQueue|customScheduled; draft=saveToDraft.
  const createPost = async ({ channelId, text, mode = 'addToQueue', dueAt, draft = false, assets = [] } = {}) => {
    requireWrite();
    requireChannel(channelId);
    if (!channelId) throw new Error('channelId required');
    if (!PUBLISH_MODES.has(String(mode))) throw new Error(`bad mode "${mode}"`);
    // a no-publish cap may ONLY draft (saveToDraft true); it can never put a live post in the queue/feed
    const isDraft = !!draft;
    if (!isDraft && !cap.publish) throw new Error('this Buffer cap is draft-only (publishing withheld)');
    const input = { channelId: String(channelId), text: String(text || ''), schedulingType: 'automatic', mode: String(mode), assets, ...(dueAt ? { dueAt: String(dueAt) } : {}), ...(isDraft ? { saveToDraft: true } : {}) };
    const d = await gql(`mutation ($input: CreatePostInput!) { createPost(input: $input) {
      ... on PostActionSuccess { post { id text status dueAt channelId } } ... on MutationError { message } } }`, { input });
    const r = d.createPost || {};
    if (r.message) throw new Error(`Buffer: ${r.message}`);
    return harden(r.post);
  };

  const editPost = async ({ id, text, dueAt } = {}) => {
    requireWrite();
    if (!id) throw new Error('id required');
    const cur = await getPost(id); if (!cur) throw new Error('no such post');
    requireChannel(cur.channelId);
    const input = { id: String(id), ...(text != null ? { text: String(text) } : {}), schedulingType: 'automatic', mode: 'addToQueue', assets: [], ...(dueAt ? { dueAt: String(dueAt) } : {}) };
    const d = await gql(`mutation ($input: EditPostInput!) { editPost(input: $input) {
      ... on PostActionSuccess { post { id text status dueAt channelId } } ... on MutationError { message } } }`, { input });
    const r = d.editPost || {};
    if (r.message) throw new Error(`Buffer: ${r.message}`);
    return harden(r.post);
  };

  const deletePost = async id => {
    requireWrite();
    if (!cap.del) throw new Error('this Buffer cap may not delete posts');
    const cur = await getPost(id); if (cur) requireChannel(cur.channelId);
    const d = await gql(`mutation ($input: DeletePostInput!) { deletePost(input: $input) {
      ... on DeletePostSuccess { id } ... on MutationError { message } } }`, { input: { id: String(id) } });
    const r = d.deletePost || {};
    if (r.message) throw new Error(`Buffer: ${r.message}`);
    return harden({ ok: true, id: r.id });
  };

  // ── BLAST: the same post to EVERY channel this cap is authorized for (Buffer is one-channel-per-createPost, so
  //    we fan out). Per-channel try/catch → one network rejecting (e.g. text too long for Twitter) never aborts the
  //    rest; returns a per-channel report. Honors attenuation: a bound cap blasts only its channels; a draft-only
  //    cap blasts drafts. `channels` (optional) narrows the blast to a subset of the authorized set.
  const blast = async ({ text, mode = 'addToQueue', dueAt, draft = false, assets = [], channels: only } = {}) => {
    requireWrite();
    const all = (await channels()).filter(c => !c.isDisconnected);
    const targets = only ? all.filter(c => only.map(String).includes(String(c.id))) : all;
    if (!targets.length) throw new Error('no connected channels to blast to');
    const results = [];
    for (const c of targets) {
      try { const p = await createPost({ channelId: c.id, text, mode, dueAt, draft, assets }); results.push({ channelId: c.id, service: c.service, name: c.displayName || c.name, ok: true, id: p && p.id, status: p && p.status }); }
      catch (e) { results.push({ channelId: c.id, service: c.service, name: c.displayName || c.name, ok: false, error: String(e && e.message || e).slice(0, 200) }); }
    }
    return harden({ ok: results.some(r => r.ok), mode, draft: !!draft, posted: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
  };

  // ── ATTENUATION: mint a weaker cap. You can only ever REMOVE authority (channels ∩, flags ↓). ────────────────
  const restrict = ({ channels: ch, publish, del, write } = {}) => {
    const nextChannels = ch ? (allow ? ch.filter(c => allow.has(String(c))) : ch.map(String)) : cap.channels;
    return makeBuffer({ getToken, fetchImpl: doFetch, bound: {
      channels: nextChannels,
      publish: cap.publish && (publish !== false), // can only turn OFF
      del: cap.del && (del !== false),
      write: cap.write && (write !== false),
    } });
  };

  return harden({ channels, posts, getPost, createPost, editPost, deletePost, blast, restrict, orgId,
    rights: () => harden({ channels: cap.channels, publish: cap.publish, del: cap.del, write: cap.write }) });
};
