# Field Agent — visionOS Client Handoff

## 0. TL;DR

You are building a **native visionOS / RealityKit client** for an existing, running service: the **field agent**, a capability-confined Endo LLM chat. Its web client (a single-page web app) already renders a live 3D "trace pendant" that animates the agent's tool fan-out in real time. Your job is to render **the same semantic scene as real shapes the user can walk around** in AR, and to let the agent **place significant shapes in the user's field of view with bounded, revocable authority**.

The service is a plain Node HTTP server at `/home/dan/endo-bfb/packages/chat/voice-agent/server.mjs`, default port **8778**, bound to **tailnet IP + loopback only** (`['100.83.80.102', '127.0.0.1']`) — **never** `0.0.0.0`, never public. Your device must be on the tailnet; you reach it over `tailscale serve` HTTPS — the in-file comment names `https://archua.taildd002.ts.net`, but **confirm the live origin from the actual tailscale serve config** (it is not hard-coded as the served origin; the default `BASE_URL` is the raw IP — see §1, §3, §10).

**The 5–6 things you MUST get right:**

1. **Cap-hygiene.** The entire credential is a 32-hex-char "swissnum" carried in the invite URL `#cap=<hex>` fragment. Holding the string IS the authority. **Never render it** — not as text, not as a label, not as a 3D entity, not in your visible URL bar. Keep it out of the scene graph and out of any persisted/screenshot-able surface.
2. **Trusted path / secure attention.** When the agent proposes a destructive action, the confirm prompt and the "who am I talking to / kill switch" chrome must live in a region the agent **cannot draw into or spoof**. The user must be able to tell a real confirm dialog from an agent-drawn fake. (Note: in this architecture the agent has no drawing primitive at all until you give it one — see §7b.)
3. **SSE-driven scene.** The live scene is fed by a **separate** Server-Sent-Events stream `GET /chat/steps?sid=<sessionId>` keyed only by `sid` (never the cap). The `POST /chat` response is a single buffered JSON object, **not** streamed. Open the SSE first, then POST.
4. **Bounded, revocable render authority.** Model "the agent places a shape" as an attenuated capability scoped to a delegated volume, revocable, and tied to the confirm-gated powers model.
5. **Graceful fidelity.** The **semantic** scene (node taxonomy, edges, state) is the source of truth and must port faithfully; the neon-fresnel glow, shaders, and easing are **presentation** that may degrade per device without breaking the contract.

**Fastest path to "hello, live scene":** parse the swissnum from your invite `#cap=` fragment → open `EventSource`-equivalent on `GET /chat/steps?sid=<sid>` → `POST /chat {sessionId:<sid>, text, cap, model:'default', history:[]}` → render each SSE object discriminated by its `t` field (`start`/`done`/`rnode`/`end`) as RealityKit entities. Close the SSE on `t:'end'`.

---

## 1. What this system is

**The field agent** is a capability-confined LLM chat. A user (or another agent) holds a capability — a bearer secret called a *swissnum* — and POSTs chat turns; the agent answers, optionally using **tools that are themselves Endo capabilities** (web search, image generation, note edits, home-assistant control, sub-agent delegation, research, etc.). Authority is lexically confined: an agent can only invoke tools that were physically built into its toolbox; there is no prompt it can emit to reach a power it wasn't granted (see §2 and §8).

**The existing web SPWA** (`/home/dan/endo-bfb/packages/chat/voice-agent/public/app.js`) is the reference client. It reads the cap from its URL fragment, POSTs turns, and — crucially for you — renders a **live 3D "trace pendant"** (`/home/dan/endo-bfb/packages/chat/voice-agent/public/pendant.js`, ~314 lines, Three.js). The pendant "hangs" beneath the latest user prompt and animates, in real time, the directed tree of tool calls the agent makes during a turn: a root prompt node, tool nodes fanning downward, delegate nodes nesting subtrees, and a `research` tool that nests a *live keyed subtree* (research → sub-question → tool/phase).

**The trace pendant is the seed of a spatial UI language.** It already encodes meaning as shape and color (violet octahedron = prompt root, green tetrahedron = tool, gold octahedron = delegate, blue octahedron = sub-question, gold tetrahedron = phase, red = failure), with idle spin, a neon fresnel-glow wireframe, grow-in easing, and hover/click inspection. Your AR client renders **the same semantics** as real shapes the user can walk around — a volume the user *inhabits* rather than a 2D pendant beneath a chat bubble.

**What a native AR client adds:** a real volume; agent-placed shapes positioned "where they are significant" in the user's field of view; spatial input (gaze + pinch) mapping to the web client's raycast hover/click; and a spatial trusted-path for confirm-gated actions.

**Reachability (do not get this wrong):** tailnet (`https://archua.taildd002.ts.net`) + `127.0.0.1:8778` **only** — never public. The in-file comment (server.mjs lines 29–31) states the app is fronted by `tailscale serve` HTTPS specifically so the web client gets a secure context for `getUserMedia` (mic). Your device **must be on the tailnet**. The default `BASE_URL`/`PUBLIC_BASE_URL` is `http://100.83.80.102:8778`, but you should dial the **tailnet HTTPS hostname**, not the raw IP — and the hostname above appears only in an in-file *comment*, not as a verified serve target, so **confirm the live origin from the actual tailscale serve config** (see Gaps in §10).

---

## 2. Mental model for a Swift dev: object-capabilities in 90 seconds

- **A capability is an unforgeable reference that both names a resource and grants the authority to use it.** Here it's a *swissnum*: 128 bits of `crypto.randomBytes(16).toString('hex')` → **32 lowercase hex chars**. Possessing the string IS the permission. No accounts, no roles, no ACLs, no login.
- **The cap is a bearer secret carried in the URL `#fragment`** (`#cap=<hex>`). The fragment is deliberately used (not the query/path) because the fragment is **never sent to the server** in the request line or `Referer` — so the secret never lands in server logs, proxies, or analytics. Your client reads the swissnum from *its own* link and sends it in the JSON **body** of each call. **Because it is a bearer secret, it must never be rendered** — showing the `#cap=…` link as on-screen text (or a 3D label, or your URL bar) is showing a password. This is the load-bearing rule (see §7).
- **"Tools ARE caps = lexical confinement."** When the agent delegates to a sub-agent, the system builds the sub-agent a *smaller tool list* = the intersection of the parent's powers with the requested set, minus non-delegable "meta" powers. The sub-agent can't escalate by "saying the right words" because the verb literally isn't in its toolbox. Confinement is by construction at the delegation edge, not by prompt instruction.
- **Authority is bounded and revocable.** `share(label)` mints a *new* swissnum bound to a *narrower* facet (e.g. one affordance), returning a fresh `#cap=` URL. `revoke(swiss)` forgets that swissnum → the link goes dead instantly; the holder's own access is untouched. Delegation is **monotonic**: a shared sub-cap cannot re-widen or re-delegate.
- **Designation = authorization.** In this system, naming a thing you legitimately hold *is* the authorization to act on it. The agent designates a device/persona by holding a *handle* (a node in a capability tree), never by a free-text id the server re-resolves against an ambient token (that would be the "confused deputy"). This matters for your AR input model: a gaze/pinch on a shape the user *holds* is a legitimate designation; a string the agent merely *speaks* is not.

That's the whole model. The HTTP contract (§3) does not require your client to understand power sets internally — you present the cap, you render the `agentId`/`proposals`/`asks` the server returns, and you honor cap-hygiene.

---

## 3. Connecting — the wire

### Base URL & reachability

- **Server:** plain Node `http` (no Express/Koa, **no WebSocket**). File: `/home/dan/endo-bfb/packages/chat/voice-agent/server.mjs`.
- **Port:** `8778` (env `PORT`).
- **Bind:** `['100.83.80.102', '127.0.0.1']` (env `BIND`, comma-separated) — tailnet IP + loopback only. A server is started per bind IP.
- **Dial origin:** the tailnet HTTPS hostname fronted by `tailscale serve` (the in-file comment names `https://archua.taildd002.ts.net`). The raw IP:port is the bind, not what your device should dial. **Confirm the exact origin from the tailscale serve config** — the hostname is only in a comment, not a configured serve target (see §10 Gaps).

### How the cap addresses the server (auth model)

There is **no bearer token, no cookie, no `Authorization` header, no query/path token** anywhere. The only auth is the swissnum, sent in the **JSON body**:

- Most endpoints: body field **`cap`**.
- `/rpc`: body field **`swissnum`**.

Client flow for the cap (mirrors `app.js` lines 11–20):
1. Parse from your invite link's fragment: the value of `cap` in `URLSearchParams(hash)`.
2. Store it client-side (in app memory / secure storage), keyed like the web client's `localStorage` key `field-agent-cap`.
3. **Strip it from any visible URL** (web client does `history.replaceState`). In AR, never surface it (see §7).
4. Send it in the body of every request.

Server resolves `cap` → `nodeFor(cap)`. A node has: `node.cap` (dispatched via `E(node.cap)[method]`), `node.isRoot` (boolean), `node.powers` (Set of power-name strings), `node.id` (agent id string), `node.toolbox(ctx)`. **Unknown/revoked cap → `nodeFor` returns falsy → 403/404.**

The **root** cap's swissnum is read from `SEED_FILE` (default `${HOME}/.config/field-agent/root.swiss`), validated against `/^[0-9a-f]{32}$/`; if missing/invalid the server generates one and writes it mode `0o600`. The root link is logged as `${BASE_URL}/#cap=${rootSwiss}`.

### Endpoint table

`Cap` column: **any** = any valid cap (403 if none); **root** = requires `node.isRoot` (403 otherwise); **none** = no cap.

| Method | Path | Cap | Request body | Response (200 unless noted) |
| --- | --- | --- | --- | --- |
| POST | `/chat` | any | `{ sessionId, text, cap, attachments?, model?, history? }` | `{ answer, images[], toolsUsed[], steps[], proposals[], autoFired[], asks[], agentId, attachments[] }` · `{cancelled:true}` if superseded · `403 {error}` no cap · `400 {error}` empty |
| POST | `/cancel` | (sid) | `{ sessionId }` | `{ cancelled:true }` (aborts `runs.get(sid)`) |
| GET | `/chat/steps?sid=<sid>` | none (sid) | — | `text/event-stream`; opens `: ok`, heartbeat `: hb` every 15s; `data:` JSON lines discriminated by `t` |
| POST | `/rpc` | any | `{ swissnum, method, args=[] }` | `{ ok:true, result }` · `404 {ok:false,error:'unknown or revoked capability'}` · `400 {ok:false,error}` |
| POST | `/stt` | none | **raw audio bytes** (Content-Type from blob, default `audio/webm`) | `{ text }` · `400 {error}` no audio · `502 {error}` STT upstream |
| POST | `/chats/load` | any | `{ cap }` | `{ data: <bundle JSON>\|null }` (keyed by `sha256(cap)`) |
| POST | `/chats/save` | any | `{ cap, data }` | `{ ok:true }` · `413` if JSON > 6MB |
| POST | `/models` | any | `{ cap }` | `{ models:[{id,label},...] }` (always includes `{id:'default',label:'Gemma (local · default)'}`) |
| POST | `/feed/load` | any | `{ cap }` | `{ items: FeedItem[], attentionCount }` |
| POST | `/feed/dismiss` | any | `{ cap, id }` | `{ ok:true }` |
| POST | `/confirm` | any* | `{ cap, id, dontAskAgain? }` | `commitProposal` output |
| POST | `/reject` | any* | `{ cap, id, dontAskAgain? }` | `rejectProposal` output |
| POST | `/memo` | root | `{ transcript, title, source, cap }` | `{ ok:true, id }` |
| POST | `/memos/load` | root | `{ cap }` | `{ runs: MemoRun[] }` |
| POST | `/memos/delete` | root | `{ cap, id }` | `{ ok:true, removed }` |
| POST | `/memo/rerun` | root | `{ cap, id, persona, label }` | `{ ok:true, version, run }` |
| POST | `/ingest` | root | `{ transcript, title, source, cap }` | `{ ok:true, chatId }` |
| POST | `/seed-chats/load` | root | `{ cap }` | `{ chats: SeedChat[] }` |
| POST | `/chat/rerun` | root | `{ cap, id, persona, label }` | `{ ok:true, version, chat }` |
| POST | `/feedback` | root | `{ cap, comment, context }` | `{ ok:true, taskId }` |
| POST | `/dev/updates` | root | `{ cap, chatId }` | `{ tasks:[{...,thread:[{role,text,at}]}] }` |
| POST | `/thread/reply` | root | `{ cap, parent, chatId, text }` | `{ ok:true }` |
| POST | `/asks/load` | root | `{ cap }` | `{ asks[], answeredPending[], openCount, pendingFlush }` |
| POST | `/asks/answer` | root | `{ cap, id, answers }` | `{ ok, ask }` |
| POST | `/asks/flush` | root | `{ cap }` | `{ ok, flushed }` |
| GET | `/`, `/index.html`, `/app.js`, `/pendant.js`, `/three.module.js`, `/trace.js`, `/trace-app.js`, `/qrcode.js`, `/cap-channel.js` | none | — | static assets (default SEC headers, incl. `x-frame-options: DENY`) |
| GET | `/trace-app.html` | none | — | static asset, **overridden to `x-frame-options: SAMEORIGIN`** so the SPA can frame the trace viewer |
| GET | `/sites/<hex>/<path>` | (hex) | — | agent-published sites (sandboxed CSP) |
| GET | `/uploads/<hex>.<png\|jpg\|jpeg\|webp\|gif>` | (hex) | — | user-attached images (hex name IS the credential) |

\* `/confirm` and `/reject` additionally require `node.isRoot` **OR** `node.powers.has(prop.power)`.

**Security headers (`SEC`, every response — server.mjs lines 127–131):** `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `permissions-policy: payment=(),interest-cohort=(),browsing-topics=()`, and a CSP whose `connect-src` is `'self'`. The **full CSP** (line 130) is:
```
default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'
```
(Note it permits `img-src data:` and `style-src 'unsafe-inline'`; don't assume the whole CSP is just `connect-src 'self'`.) Every static route goes through `serveFile()`, which applies `SEC` verbatim → `x-frame-options: DENY`; the **only** exception is `/trace-app.html`, which explicitly overrides to `SAMEORIGIN` (line 227) so the SPA can iframe the trace viewer. (A native client doesn't care about XFO, but get this right when reasoning about the web client's framing/trusted-path story.) Request bodies are destroyed past **25MB** (`/chats/save` additionally caps JSON at 6MB).

> **CORS note / gap:** the server examples assume same-origin fetch from the served SPA. The facts do not state what `Access-Control-Allow-Origin` (if any) `/rpc` or `/chat` set for off-page callers. A *native* client is not subject to browser same-origin policy, so this likely doesn't block you — but **verify CORS/header behavior in `/home/dan/endo-bfb/packages/chat/voice-agent/server.mjs`** before assuming.

### The `POST /chat` turn protocol

Request JSON: `{ sessionId, text, cap, attachments?, model?, history? }`.

- **`sessionId`** — the active chat id (the web client uses a uuid slice from `initChats`). Server clamps to `slice(0,64)` as `sid`. **The same `sid` keys the SSE step stream AND the barge-in `AbortController`.** Sending a new `/chat` with the same `sid` aborts the prior in-flight run (`runs.get(sid)?.abort()`).
- **`text`** — the current user turn (plain string). Server appends it; do **not** include it in `history`.
- **`cap`** — your swissnum.
- **`model`** — defaults to `'default'`. Get the list from `POST /models`; `'default'` = `Gemma (local · default)`.
- **`history`** — **client-owned durable transcript**, preferred over the server's volatile in-memory `sessions` map. Build it as `[{role:'user'|'assistant', content:String}]`, **excluding the current turn**, `slice(-24)`. The server filters incoming client history to role `user|assistant` with content and also slices it to `-24` (server.mjs line 313), so `-24` is both the client-send recommendation and the server's accepted bound. **It falls back to its volatile in-memory session only if you send none — and that fallback session is capped at `slice(-12)` (server.mjs line 344).** Client-owned durable history at `-24` is preferred and is what the server honors when sent; don't rely on the server's `-12` memory.
- **`attachments`** — optional `[{kind, name, mediaType, url, text}]`.

Response JSON (single buffered `application/json`, **not** streamed):

```jsonc
{
  "answer":   "string",
  "images":   ["data:image/png;base64,…"],   // tool-produced images
  "toolsUsed":["webSearch", "research", …],   // tool names
  "steps":    [ /* Step[] — persisted/authoritative form of the trace */ ],
  "proposals":[ /* destructive-action confirm cards (opaque, see §8) */ ],
  "autoFired":[ {"title":"…","type":"…","ok":true} ],
  "asks":     [ /* typed questions for the operator (opaque) */ ],
  "agentId":  "string",                       // node.id — WHO answered
  "attachments":[ /* saved refs */ ]
}
```

Special early returns: `{ cancelled:true }` (HTTP 200) if the turn was aborted/superseded; `{ error:'…' }` with HTTP 403 (no cap) or 400 (empty text).

`Step` shape (the persisted form your client re-renders, and the same data the SSE streams live):
```ts
type Step = { name: string; ok: boolean; detail?: string;
              children?: Array<{name; detail?; info?; ok?; children?}> };
```

### Swift sketch — a JSON call

```swift
struct ChatRequest: Encodable {
    let sessionId: String
    let text: String
    let cap: String                     // swissnum — NEVER log this, NEVER render it
    var model: String = "default"
    var history: [Turn] = []
    struct Turn: Encodable { let role: String; let content: String } // role: "user"|"assistant"
}

struct ChatResponse: Decodable {
    let answer: String?
    let images: [String]?
    let toolsUsed: [String]?
    let steps: [Step]?
    let proposals: [JSONValue]?         // opaque — render, don't interpret (see §8)
    let asks: [JSONValue]?
    let agentId: String?
    let cancelled: Bool?
    let error: String?
}

func postChat(_ req: ChatRequest, origin: URL) async throws -> ChatResponse {
    var r = URLRequest(url: origin.appendingPathComponent("chat"))
    r.httpMethod = "POST"
    r.setValue("application/json", forHTTPHeaderField: "content-type")  // only header the web client sends
    r.httpBody = try JSONEncoder().encode(req)
    let (data, _) = try await URLSession.shared.data(for: r)
    return try JSONDecoder().decode(ChatResponse.self, from: data)
}
```

### Swift sketch — consuming the SSE step stream

Open this **before** POSTing `/chat`, with the **same `sid`**. The cap never rides this URL (cap-hygiene). Events are the **default unnamed `message` type** with a single `data:` JSON line — there are **no named `event:` lines**. You must skip comment lines (`: ok`, `: hb`).

**iOS gotcha (this WILL bite you):** `URLSession`'s default `timeoutIntervalForRequest`/`timeoutIntervalForResource` will tear down a long-lived SSE connection. The server only keeps it warm with a 15s `: hb` comment, so without configuring those timeouts the stream silently dies. Use a dedicated `URLSession` with a long/disabled `timeoutIntervalForResource` (and a generous `timeoutIntervalForRequest`) for the SSE, and treat >~30s without a `: hb` as a dropped stream → reconnect.

```swift
struct StepEvent: Decodable {            // discriminated on `t`
    let t: String                        // "start" | "done" | "rnode" | "end" | (legacy) "child-done"
    let name: String?
    let ok: Bool?
    let detail: String?
    let children: [JSONValue]?
    // rnode-only:
    let parent: String?
    let key: String?
    let kind: String?                    // "subq" | "tool" | "phase"
    let label: String?
    let info: String?
    let state: String?                   // "pending" | "done" | "fail"
}

func streamSteps(sid: String, origin: URL,
                 onEvent: @escaping (StepEvent) -> Void) async {
    // Dedicated session: SSE is long-lived, kept warm only by a 15s `: hb` heartbeat.
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 60               // generous; > heartbeat interval
    cfg.timeoutIntervalForResource = .greatestFiniteMagnitude  // effectively disabled
    let session = URLSession(configuration: cfg)

    let url = origin.appendingPathComponent("chat/steps")
        .appending(queryItems: [URLQueryItem(name: "sid", value: sid)])
    while !Task.isCancelled {
        do {
            var req = URLRequest(url: url)
            req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            let (bytes, _) = try await session.bytes(for: req)
            for try await line in bytes.lines {
                // SSE: skip comments (": ok", ": hb") and blank separators
                guard line.hasPrefix("data:") else { continue }
                let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard let d = json.data(using: .utf8),
                      let ev = try? JSONDecoder().decode(StepEvent.self, from: d)
                else { continue }
                onEvent(ev)
                if ev.t == "end" { return }      // server emits one `end` per turn; close on it
            }
        } catch {
            try? await Task.sleep(nanoseconds: 1_000_000_000)  // reconnect backoff
        }
    }
}
```

Notes: heartbeat `: hb` arrives every 15s — use it as a liveness signal (no `: hb` for >~30s ⇒ reconnect). Multiple concurrent SSE readers per `sid` are supported. The stream is **coarse-grained tool steps only** — there is **no token stream** for the answer text (see §10).

---

## 4. The live event protocol → scene feed

The SSE stream is your AR scene's live data feed. Every event is a JSON object with a discriminator field **`t`**. (Emitter: `emitStep(sid, obj)` writes `data: <JSON>\n\n`, server.mjs line 108.)

### Exhaustive SSE event schema

**`t:'start'`** — a tool call begins (server.mjs line 324):
```jsonc
{ "t":"start", "name":"<tool name>", "detail":"<short query/url/path/prompt, ≤200 chars, NO contents/cap>" }
```

**`t:'done'`** — a tool result settles (server.mjs line 337):
```jsonc
{ "t":"done", "name":"<tool name>", "ok": true,        // ok = (s.result.ok !== false)
  "detail":"<short>",
  "children": [ … ]   // present for research + delegate/askSpecialist/employ — SHAPES DIFFER, see below
}
```
The `children[]` shape depends on the tool, and the two cases are **not** the same depth:

- **`research`** → `children` is a **rich, deep subtree** (built server-side via `researchTree`, server.mjs line 334): nodes named `❓ <q>` carrying `detail`/`info`/`ok` **and grandchildren** named `webSearch`/`fetchUrl`/`consult`, plus a `report` node. This is the *batched final* form of the same tree that `rnode` streams live.
- **`delegateTask` / `askSpecialist` / `employ`** → `children` is **flat `{name, detail}` only** — no `info`, no `ok`, no grandchildren (server.mjs line 335; `children = result.toolsUsed` mapped to `{name, detail}`). These delegate subtrees **arrive batched at completion, not streamed live** (unlike research). Do not expect nestable delegate subtrees like research's; they are one flat level.

**`t:'rnode'`** — live research-subtree upsert, keyed by `key` (only producer is the research tool, agent-caps.mjs lines 478–485):
```jsonc
{ "t":"rnode",
  "parent":"research" | "s<i>" | "<sub key>",   // optional; default = research/root
  "key":"<stable key>",                         // upsert identity
  "kind":"subq" | "tool" | "phase",             // optional, default 'tool'
  "label":"<label>", "detail":"<short>", "info":"<long>",  // optional
  "state":"pending" | "done" | "fail" }         // optional
```
Observed key scheme (from the research engine → rnode translation):
- **plan** → for each sub-question: `{parent:'research', key:'s<i>', kind:'subq', label:'❓ <q…30>', detail:<q>, state:'pending'}`
- **tool** → `{parent:'s<sub>', key:'s<sub>t<n>', kind:'tool', label:<name>, detail, state:'done'}`
- **distill start** → `{parent:'s<sub>', key:'s<sub>d', kind:'phase', label:'distilling…', state:'pending'}`
- **subdone** → `{key:'s<sub>d', state:'done', label:'distilled'}` then `{key:'s<sub>', state:'done'|'fail', info:<summary>}`
- **synth start/done** → `{parent:'research', key:'synth', kind:'phase', label:'synthesizing…', state:'pending'}` then `{key:'synth', state:'done', label:'report', info:<excerpt>}`

> **Truncation lengths differ between live and final (cosmetic, but reconcile-aware):** live `rnode` sub-question labels truncate the question to **30 chars** (`❓ <q…30>`, agent-caps.mjs:480). The **persisted `researchTree` form truncates the sub-question name to 40 chars and the report `info` to 600 chars** (server.mjs:121,123). So when you reconcile the live tree against the authoritative `steps[]` after `end`, a label or `info` block may *lengthen* on settle. Don't assume live and final text are byte-identical.

**`t:'end'`** — emitted once after the turn completes (server.mjs line 340):
```jsonc
{ "t":"end" }
```
Close the SSE on receipt.

**`t:'child-done'` — DEAD / forward-compat (the GAP).** The web client handles `m.t === 'child-done' → p.childDone(m.parent, m.name, m.ok)`, but **no code in `server.mjs` or `agent-caps.mjs` ever emits it**. Its intended payload (inferred from the client) would be `{ t:'child-done', parent, name, ok }`. **Safely ignore it** until the server emits it; treat it as a nested-node settle if/when it appears.

### Event → meaning → scene mutation

| Event | Meaning | Scene mutation (mirror of `pendant.js`) |
| --- | --- | --- |
| `start` | top-level tool call begins | Grow a NEW node under the root, mark it **pending** (sine-pulse glow), enqueue it FIFO awaiting its `done`, add to `level1`, re-layout the downward arc + re-fit. If `name==='research'`, set it as `activeResearch`. |
| `done` | tool result settles | Pop the matching pending node by `name` (else first unsettled, else create one), **settle** it (recolor red if `ok===false`); if `children[]` present **and** no live children already streamed, build the nested subtree at once. For `research` that subtree is deep; for delegate/askSpecialist/employ it is one flat `{name,detail}` level. Re-layout + re-fit. |
| `rnode` | live research-subtree upsert | Keyed upsert: create-or-update the node by `key` under its resolved `parent` (`research`→`activeResearch`/root); set `label`/`detail`/`info`; `state:'done'`→settle ok, `'fail'`→settle red, `'pending'`→mark pending. Re-fit. |
| `child-done` | (legacy/dead) | Ignore. Originally: flat child add under the most recent `level1` node named `parent`. |
| `end` | turn finished | Close the SSE; finish (settle any still-pending node to ok); then **reconcile against the authoritative `steps[]`** from the `/chat` JSON response (covers a dropped/never-opened stream). |

**Reconciliation matters:** the SSE is the *live* form of the trace; the `/chat` response `steps[]` is the *authoritative final* form (and the persisted form re-rendered when a chat is re-opened). After `end`, apply `steps[]` to fill any node you missed, settle states, and build children not already streamed. This makes the scene correct even if the SSE dropped. (Reconciliation may *lengthen* sub-question labels 30→40 and add `info` up to 600 chars, per the truncation note above.)

---

## 5. The scene model — semantic → spatial

### Node taxonomy (5 kinds)

Each kind has a distinct **geometry + color**. These are the existing visual encoding from `pendant.js` — port the *semantics* faithfully; the exact units are relative proportions (see §10), not meters.

| Kind | Meaning | Geometry (Three.js radius) | Color (`COL`) | Notes |
| --- | --- | --- | --- | --- |
| `root` | the user's prompt the trace descends from | `OctahedronGeometry(0.6)` | `0x7c5cff` violet | label `prompt`; descends from above |
| `tool` | a single top-level tool call (e.g. `webSearch`, `generateImage`, `fileWrite`) | `TetrahedronGeometry(0.34)` | `0x2ea043` green | plain tools render no persistent label (name via tooltip) |
| `delegate` | a fan-out tool that spawns sub-work | `OctahedronGeometry(0.4)` | `0xe3b341` gold | DELEGATE set = `delegateTask`, `askSpecialist`, `research`, `employ` |
| `subq` | a research sub-question (label prefixed `❓`) | `OctahedronGeometry(0.32)` | `0x58a6ff` blue | |
| `phase` | a slow research lead-phase (`distilling…`/`distilled`, `synthesizing…`/`report`) | `TetrahedronGeometry(0.32)` | `0xe3b341` gold | shares delegate gold |

**Failure is not a kind** — any node recolors to `COL.bad = 0xf85149` red via `settle(nd, false)`. There is **no shake/particle on failure**; failure is purely color + settle.

Verbatim palette:
```js
const COL = { root:0x7c5cff, tool:0x2ea043, delegate:0xe3b341, subq:0x58a6ff, bad:0xf85149, line:0x6b7a99 };
const DELEGATE = new Set(['delegateTask','askSpecialist','research','employ']);
const KIND_COL = { subq:COL.subq, tool:COL.tool, phase:COL.delegate, delegate:COL.delegate, root:COL.root };
// label text colors: subq '#9ecbff', phase/delegate '#e3b341', root '#cbbcff', tool/default '#7fe0a0'
```
When re-rendering a *saved* trace (no `kind` tag), classify by name: `DELEGATE` set → delegate; `❓` prefix → subq; `/…|^distilled$|^report$|^synthesiz/i` → phase; else tool.

### Visual encoding (the "feel")

Each node is a `THREE.Group` of three sub-objects:
1. **Wireframe** — `LineSegments(EdgesGeometry(geo))` with a shader-lit material (the visible crisp edges).
2. **Glow shell** — a `Mesh` of the same geo scaled **1.25×**, additive-blended, back-side, depthWrite off — a fresnel rim halo.
3. **Pick mesh** — invisible `SphereGeometry(0.5,8,6)` (`colorWrite:false`), raycast-only; `pick.userData.nd` points back at the node record.

The neon glow shaders (verbatim — this is the exact term to reproduce as a RealityKit fresnel/rim emissive):
```glsl
// WIRE fragment — base brightness scaled by intensity
gl_FragColor = vec4(uColor * (0.85 + uIntensity*0.6), 1.0);

// GLOW fragment — additive fresnel shell (rim brightens at silhouette)
float f = pow(1.0 - max(dot(vN, vV), 0.0), 3.0);
gl_FragColor = vec4(uColor * (0.6 + uIntensity*0.4), f * 0.28 * (0.5 + uIntensity*0.6));
```
**`uIntensity` drives all dynamic glow**, per frame:
- pending (in-flight): `0.5 + 0.5*abs(sin(t*3.0))` — a **sine pulse at 3 rad/s**.
- hovered/pinned: `1.7` — **brighten on hover**.
- resting: `1.0`.
- eased toward target: `cur += (target-cur)*min(1, dt*9)` (exponential smoothing, rate 9).
- connector line tracks it: `lineMat.uIntensity = 0.3 + cur*0.3`.

**Idle spin:** every node (incl. root) has a random axis `Vector3(rand*2-1, 1, rand*2-1).normalized` and per-node speed `0.45 + rand*0.6` rad/s; per frame `group.rotateOnAxis(axis, dt*spin)`.

**Easing / grow-in:**
- `easeInOut` = cubic in-out, used for all position travel (default 0.5s tween).
- `easeOutBack` = overshoot (c1=1.70158), used for "pops."
- `grow(nd)`: scale `0.001 → 1` over **0.44s** with `easeOutBack` (overshoot = appeal).
- Root **descend**: starts at `y = ROOT_Y+2.1` (ROOT_Y=1.35), tweens **0.62s** `easeInOut` down to `y=ROOT_Y`, simultaneously growing scale over 0.55s.
- `buildInstant` short-circuits all tweens (saved-trace replay = no animation).

### Edges & fan-out (spatial topology)

- Root at `(0, 1.35, 0)`.
- **Top-level tools** fan **downward in an arc** (`relayoutLevel1`): `R=1.55`, angles centered on `-π/2` (straight down), `spread = min(π*0.95, 0.45 + n*0.36)`, slight z-stagger `(j-(n-1)/2)*0.14`.
- **Children of a delegate/research node** (`relayoutChildren`): `R = 1.4` if parent is root else `0.95`; base angle = direction grandparent→parent (so subtrees splay *away* from their feed-in); `spread = min(π*0.72, 0.4 + m*0.3)`.
- Every non-root node draws a **connector line** to its parent (2-point geometry, refreshed during position tweens, colored to the child's node color).
- **Research nests 3 levels:** `research`(delegate) → sub-question(subq) → tool(`webSearch`/`fetchUrl`/`consult`) OR phase(`distilling`). A `synth`/`report` phase parents **directly to research**, not to a sub-question.

### Stable semantic placement — "where it's significant" (research-backed)

The current pendant uses a **deterministic arc layout** (`relayoutLevel1`/`relayoutChildren` — fixed radius/angle/stagger from the node's parent and index), which is the right instinct: the same turn always produces the same shape, so nothing "jumps." Preserve that property in AR. When you go beyond the per-turn tree toward the larger vision — *an agent placing significant shapes in a navigable space the user returns to* — the verified prior art (literature review, claims at 3-of-3) is unambiguous about how to keep things put:

- **Force-directed substrate:** the portable model is **d3-force** (`link`/`charge`/`center` forces), extended to 3D by **d3-force-3d** (a drop-in superset), as used by vasturiano's **3d-force-graph**. This is the engine to mirror if/when the trace becomes a persistent spatial graph rather than a per-turn arc.
- **Anchoring = significance stays placed:** set a node's `fx`/`fy`/`fz` to **pin** it — d3-force forces `x/y/z` back to those values and zeroes velocity at the end of every tick (unpin by setting to `null`). *The agent expressing "this is significant, put it here" = pinning that node's coordinates.* Caveat the research flags: pinning anchors the pinned node only — unpinned neighbors can still reflow; it is mental-map *preservation*, not a frozen structure.
- **Deterministic seeding:** d3-force initializes positions deterministically (phyllotaxis only when a coord is `NaN`; otherwise it keeps the value you supplied) with a fixed-seed RNG. **Carry positions across updates** (reuse the last layout as the seed) so adding one node doesn't reshuffle the scene.
- **Incremental/streaming updates ("don't jump"):** the strongest verified method is **incremental-FM3** (Crnovršanin/Chu/Ma, JGAA 2017) — explicitly built to preserve the user's mental map as nodes arrive: new nodes are seeded relative to already-placed anchors (≥2 anchors → their centroid) and only "high-energy" nodes are allowed to move per update.
- **Constraint-based alternative:** **WebCola** (cola.js) replaces free-running annealing with constraint-based stress-majorization (non-overlap, alignment, fixed positions) — "glides to a local minimum, no jitter," noticeably more stable for interactive placement. Reach for it if d3-force's reflow proves too lively.
- **Wrapper gotcha:** 3d-force-graph's README documents post-drag fixing and cooldown/freeze (`cooldownTicks`/`onEngineStop`) but **not** up-front per-node `fx/fy/fz`. The capability is in the underlying engine; wire deterministic anchoring yourself via the `d3Force`/`nodePositionUpdate` hooks. (And don't rely on its DAG-mode depth→position — that claim was *refuted* in verification.)

For a native RealityKit client none of these libraries run directly; the takeaway is the **contract**: significance maps to a *pinned, seeded* coordinate that survives incremental mutation, and your layout function must be a pure function of the semantic graph + the agent's pins, so the scene is reproducible.

### Inspection (hover/click)

Raycast against the invisible pick spheres. Tooltip fields:
- line 1 = `labelText || name` (bold — the tool/sub-question/phase name);
- line 2 = `detail` (the short query/URL/sub-question text);
- when **pinned** (clicked), a third block = `info` (the long content: a sub-question's distilled summary or the synthesis report excerpt, scrollable). When not pinned but `info` exists, show the hint "click to read…".

Node record fields to carry into AR: `name, type, key, detail, info, parent, children[], target (layout pos), axis+spin, pending/settled`.

> **Trusted-chrome caveat:** `detail` and `info` are **agent/tool-influenced text**. They are fine to render *inside the trace volume* as inspection content, but they must never be rendered as — or adjacent to — trusted-chrome affordances (confirm buttons, the kill switch). See §7b.

### RealityKit mapping

| Web (pendant.js) | RealityKit / visionOS |
| --- | --- |
| `THREE.Group` per node | `Entity` per node (one root `Entity` per turn = the "pendant volume") |
| wireframe `LineSegments` | `ModelEntity` with a wireframe mesh, or an edge-rendered `MeshResource` + an unlit material whose emissive ≈ `uColor*(0.85+0.6·I)` |
| additive fresnel glow shell (1.25× back-side) | a second `ModelEntity` (slightly larger, additive/transparent) with a **`ShaderGraphMaterial`** computing the fresnel `pow(1 - dot(N,V), 3)` rim → emissive; or fall back to a Fresnel surface modifier / a soft bloom on the volume |
| `uIntensity` per-frame ease + sine pulse | a **`System`** + **`Component`** (`GlowComponent { state, intensity }`) updated each frame; drive the material's emissive scalar via `material.setParameter` |
| idle spin | per-frame `entity.orientation *= simd_quatf(angle: dt*spin, axis: axis)` in the System |
| grow-in `easeOutBack`, position `easeInOut` | RealityKit `Entity.move(to:relativeTo:duration:timingFunction:)` with custom timing, or animate `scale`/`position` in the System with your own easing functions |
| connector line | a thin cylinder/box `ModelEntity` between parent and child, scaled/oriented per frame, emissive `0.3 + 0.3·I` |
| billboard canvas-text label | **SwiftUI attachment** (RealityView `attachments`) pinned below the node, billboarded to face the user; or a 3D `Text`/`MeshResource.generateText` if you want true depth (decide per §10 gap) |
| raycast pick sphere | a collision shape (`CollisionComponent` sphere ~0.5) for gaze/pinch hit-testing; map a "pinned" entity to a SwiftUI inspector attachment showing `name`/`detail`/`info` |

Suggested component model:
```swift
struct TraceNodeComponent: Component {
    var key: String?            // research upsert key (nil for level1)
    var name: String
    var kind: NodeKind          // root, tool, delegate, subq, phase
    var detail: String
    var info: String
    var pending: Bool
    var settled: Bool
    var failed: Bool
    var spinAxis: SIMD3<Float>
    var spinSpeed: Float        // 0.45...1.05
    var glowIntensity: Float    // eased toward target each frame
    weak var parent: Entity?
}
```
A `TraceSceneSystem: System` runs each frame: ease `glowIntensity` toward `pending ? sinePulse : (hot ? 1.7 : 1.0)`, push it to the materials, apply idle spin, and update connector transforms — a faithful port of pendant.js's animation loop. Keep all numeric ratios (root ≈ 1.9× a tool, glow shell 1.25×, label offset 0.7 below center) and **rescale the whole volume** to a comfortable physical size.

---

## 6. Rendering in visionOS / RealityKit

### Shared Space vs Full Space vs volumetric window — recommendation

**Start in a bounded volumetric window** (a `WindowGroup` with `.windowStyle(.volumetric)` / a `RealityView` inside a fixed volume). Rationale:
- A bounded volume is a **natural security border**: the agent's shapes live *inside the volume you own*, and the system chrome (window controls, the SwiftUI confirm sheets, ornaments) lives *outside* it where the agent's RealityKit content cannot reach. This directly serves the trusted-path requirement (§7b).
- The pendant metaphor ("hangs beneath the latest prompt") maps cleanly to a volume anchored to the conversation window.
- It's the lowest-risk path to M2.

**Promote to a Full Space** only for the "walk around / agent places shapes where significant" experience (M3+) — and only after the trusted-path design (§7, being researched separately) is settled, because in a Full Space the trusted chrome is harder to keep un-spoofable (see §7b/§7d).

### Anchoring the pendant

In the web client the pendant is a body-anchored overlay tracking the latest `.msg.user` bubble. In AR, anchor the turn's pendant volume **relative to the conversation window / the current prompt's spatial position** ("descends from latest prompt"), and reposition on layout changes. When a turn is live, leave it alone; when re-opening a chat with a saved transcript, rebuild instantly (no animation) from the last agent message's `steps[]` — the equivalent of `showSteps`/`buildInstant`.

### Graceful fidelity tiers — the portability contract

**The semantic scene is the source of truth.** Encode it once (node taxonomy, edges, state, layout ratios). Presentation degrades cleanly:

| Tier | What renders |
| --- | --- |
| Full | Fresnel `ShaderGraphMaterial` glow shell + animated emissive + idle spin + eased grow-in + connector glow + SwiftUI attachment labels |
| Reduced | Solid emissive materials (no fresnel shell), simpler pulse on emissive intensity, spin + grow-in kept |
| Minimal | Flat-colored shapes by kind, no glow/pulse, instant placement, labels on demand |

A device or thermal-throttle drop must **never** change *which nodes exist or their state* — only how they're lit. This is what "graceful fidelity" means in §0.

### The portable substrate beyond visionOS (research-backed)

A native RealityKit client is **one tier** of the "boot to 3D across any GPU" vision. If this UI language is to render on a phone browser, a low-end laptop, *and* a Vision Pro from one semantic scene, the verified portability research (3-of-3 claims) points to a concrete substrate and — importantly — to **where capability detection belongs**:

- **Web substrate: Three.js `WebGPURenderer`.** It is a *unified* renderer that **automatically falls back to a WebGL2 backend** when WebGPU is absent (the manual calls this "a crucial design decision"; selection order in source is `forceWebGL → WebGPU.isAvailable() → WebGL2`). Author shaders **once in TSL** (Three Shading Language, in JavaScript); the same node graph is code-generated to **WGSL** (WebGPU) or **GLSL** (WebGL2) per active backend. Your fresnel glow written in TSL would run on both tiers. (Caveat: the fallback covers the render path, not WebGPU-only features like compute shaders.)
- **Capability detection is upfront, not graceful — own it at load time.** WebGPU has **no per-feature runtime degradation**: per-adapter `features`/`limits` are the max requestable set, a device is created with an *exact* capability set at `requestDevice()`, and all work is validated against the *device*. `navigator.gpu.requestAdapter()` **never rejects — it resolves to `null`** to signal "go to fallback." So the pattern is **detect a tier, then pick a code path**, decided by the layer that selects the rendering tier at init — *not* pushed down per-draw. This is the single "detect capability, pick a tier" decision point the substrate should own; it's the web analogue of choosing your RealityKit fidelity tier in §6.
- **Portable scene + fidelity interchange = glTF.** Two ratified/portable mechanisms carry the tiers in one asset: **`MSFT_lod`** expresses discrete LOD chains (an `ids` array from highest→lower quality, definable at the **node** level (geometry swaps) *or* the **material** level (material-only tiers)); **`KHR_materials_variants`** (ratified) carries multiple material variants for **low-latency runtime switching** (one active variant at a time, no reload) — e.g. PBR ↔ simplified ↔ unlit. A minimal portable subset is glTF 2.0 core + these two extensions. (On visionOS this meets the USD/USDZ pipeline — the exact glTF↔USDZ conversion and RealityKit ShaderGraph/MaterialX mapping is an **open question** the research did not close; verify before building a cross-format asset pipeline.)
- **Native cross-platform option if you ever leave the browser:** **bgfx** abstracts one rendering API across **12+ backends** (D3D11/12, Metal, Vulkan, GL, GLES2/3.1, WebGL1/2, WebGPU-via-Dawn) — the "bring your own engine" backend layer. **Google Filament** models tiers explicitly via **cumulative integer feature levels** (1/2/3, FL0 = GLES2-class) plus a shading-model ladder whose **Lit→Unlit** endpoints are a true PBR-to-cheap fallback. Both are the native expression of the same "one scene, integer fidelity tiers" idea — a low-tier material is guaranteed to run on higher-tier hardware (the safe direction is *upward*).

The through-line: **encode the scene and its fidelity tiers in a portable form (glTF core + `MSFT_lod` + `KHR_materials_variants`), detect the device's tier once at load, and select a presentation path.** RealityKit is your top tier; a WebGPU/WebGL Three.js client would be the browser tier from the *same* semantic scene — exactly the "renders beautifully on a 2D screen" portability goal.

### Input — gaze + pinch → web raycast picking

The web client raycasts a pointer against invisible 0.5-radius spheres: hover → tooltip; click → pin (interactive/scrollable info); empty-click → unpin and open the full-screen trace app.

Map to visionOS:
- **Gaze hover** ≈ web `pointermove`/hover → highlight (`glowIntensity → 1.7`) + a transient SwiftUI hover label (`name` + `detail`).
- **Pinch (tap)** on a node ≈ web click → "pin" it: open a SwiftUI inspector attachment with `name`/`detail`/`info` (scrollable). Use `CollisionComponent` spheres + `SpatialTapGesture`/`onTapGesture` targeting entities.
- **Pinch on empty space** ≈ unpin. (The web "open full-screen trace app" maps to expanding into a Full Space or a larger viewer — optional.)

---

## 7. Security model — LOAD-BEARING, read twice

> A deeper AR trusted-path design is being researched separately and will **augment** this section. Treat the rules below as the floor, not the ceiling.

### (a) CAP-HYGIENE in AR

The `#cap=<hex>` swissnum **is the credential**. Your headset's field of view is screenshot, recording, and over-the-shoulder territory — strictly worse than a 2D screen.

- **Never render the swissnum** as any entity, label, floating shape, attachment text, or window — not even briefly, not even small.
- **Keep it out of the scene graph and out of any rendered/persisted/loggable surface entirely** — not in entity names, component fields you might serialize, accessibility labels, analytics, or logs. (Web rule: keep it out of the DOM, not just out of view.) Store it in app memory / Keychain; reference trace items by index or non-secret id.
- **Strip your own cap from any visible URL.** (Web does `history.replaceState(null,'',location.pathname)`.) If you ever surface an origin/URL, it must not contain `#cap=`.
- **Rendering a cap's *output* is fine and is the point** — the answer text, a tool's image, a telemetry value. It is the authority-bearing **designator** (the swissnum/link) that must never be displayed.
- **Hand-offs only via deliberate, transient, user-initiated actions: copy + on-demand QR** (plus the native share sheet where appropriate). The **QR must be generated locally** (never an external QR API — that leaks the cap), shown only on explicit action, dismissable, and **wiped on close**. Copy must degrade gracefully and never dead-end at "copy failed."

### (b) TRUSTED PATH / secure attention in AR

The agent is given **bounded authority to draw in a delegated volume**. The trusted chrome — *who you're talking to* (`agentId` from the `/chat` response), confirm/reject dialogs, the kill switch (disconnect / revoke), and the cap-hand-off UI — must live in a region the agent **cannot draw into or spoof**.

**When does the spoofing threat actually exist?** Be precise so you don't over-engineer M0–M2. In this HTTP/JSON architecture **the agent never authors RealityKit content** — it emits semantic SSE/step data (`t`, `kind`, `state`, `name`, `detail`, `info`) and **your client builds every entity**. There is no channel to ship RealityKit scenes or SwiftUI to the device. Therefore:

- **M0–M2 (trace render):** the client builds every entity from typed enum data (kind/state) with no agent-authored geometry or layout. The agent has **no primitive to draw a fake confirm dialog**, so the "agent paints a fake trusted surface" threat is *not yet reachable*. You still keep confirm/kill-switch chrome system-owned (good hygiene), but you are not defending against agent-drawn fakes yet.
- **M3+ (agent places "significant" shapes) and any rendering of agent/tool-influenced *text* as 3D (`detail`/`info`):** this is where the agent gains influence over free-form shape/text/placement, and where the spoofing threat becomes real. From here on the discipline below is mandatory.

Discipline once the threat is reachable:
- Render trusted chrome as **system-owned surfaces the agent's RealityKit content cannot reach**: SwiftUI sheets/alerts, window ornaments, or a separate window — *not* entities inside the agent-writable volume.
- **Secure attention:** the user must be able to distinguish a real confirm prompt from an agent-drawn fake. The agent can produce shapes that *look like* a confirm dialog inside its volume; therefore the real one must be in a place the agent provably can't author (a system ornament/sheet outside the RealityView content the agent feeds). Consider a fixed, system-rendered "trust frame" the agent's volume is nested inside and can never overpaint.
- **Never render agent/tool-influenced text (`detail`, `info`, `name`) as or adjacent to a trusted-chrome affordance.** Those strings are not yours; a confirm dialog must show only server-classified, client-owned chrome plus the fields the server explicitly designates (`agentId`, proposal `title`/`summary`/`type`).

### (c) BOUNDED, REVOCABLE render authority

Model "the agent places a shape" as an **attenuated capability scoped to its volume**, not ambient permission to draw anywhere:
- The agent's drawing authority is a facet (think `share('agent-render-volume', …)`) bound to *one* volume/anchor, revocable. When the user revokes (kill switch) or the cap is rotated, the agent's shapes stop and clear.
- Tie placement of *significant* shapes (M3) to the **confirm-gated powers** model: drawing something that implies action in the world (e.g. a control surface for a device) should route through propose/commit (§7e), not free draw.
- Mirror the server's monotonic delegation: any sub-authority your client hands onward (e.g. to a sub-view) is strictly narrower and independently revocable.

### (d) OCCLUSION / CLICKJACKING in shared 3D space

In a 3D volume, an agent-drawn shape could be positioned to **occlude trusted chrome** or to sit where the user's gaze/pinch is *meant* for a real control — the 3D analog of clickjacking. (Like §7b, this becomes reachable only once the agent influences placement at M3+; M0–M2 build only typed trace geometry.)

- **Input routing:** gaze/pinch targeting trusted chrome must be resolved by the system surfaces, not by agent entities. Keep agent entities and trusted chrome in **separate, non-overlapping spatial regions and separate input layers** (volume content vs. ornaments/sheets). Don't let agent collision shapes intercept hits intended for trusted controls.
- **Depth/occlusion guard:** the trusted-chrome layer must always render in front of and not be occludable by agent content (system ornaments/sheets inherently win here — another reason to keep chrome out of the RealityView).
- Cap the agent's volume bounds and z-extent so it cannot envelop the user's view of the trusted frame.

### (e) Confirm-gating: propose/commit, NEVER_AUTO, don't-ask-again

The server already enforces a destructive-action gate, **and it does the classification for you.** A chat client does not introspect verbs or decide what is destructive — it renders what the server returns:

- **`proposals[]`** = parked destructive actions awaiting confirmation. Render each in a trusted-path dialog and round-trip `POST /confirm`/`/reject`.
- **`autoFired[]`** = actions that already ran this turn under a "don't ask again" rule. Render as informational ("X happened"), with an option to revoke the rule.

You **never** classify verbs yourself. Details:

- **Propose/commit:** the agent can *describe* a destructive act but cannot *perform* it. Destructive verbs (the `propose*` family + `haAct` + `dietRefreshSite`) become a slim **proposal** `{ proposed:true, id, type, title, summary }` surfaced in the `/chat` response `proposals[]`; the real executor closure is held **server-side**. The operator confirms via `POST /confirm { cap, id, dontAskAgain? }` (or rejects via `/reject`). `/confirm`/`/reject` require `node.isRoot` OR `node.powers.has(prop.power)`.
- **NEVER_AUTO = `{'home-assistant','spawn-specialist'}`** (note the **hyphen** in `home-assistant`). These — physical-world device control and authority-granting (spawn a specialist) — **must ALWAYS re-prompt** with a fresh trusted-path confirm. In your AR UI, the "don't ask again" affordance must be **hidden/disabled** for these two kinds.
- **"Don't ask again":** for other kinds, the operator may pass `dontAskAgain:true`; the server records a `{agent,kind}` auto-rule, after which a matching future proposal *fires immediately mid-turn* (surfaced in the `/chat` response `autoFired[]` as `{title,type,ok}`). Rules are keyed to the creating agent's id and are revocable (`revokeAutoConfirm`). Your UI should show what auto-fired and offer revocation.
- **Coarse powers** (`vmExec`, `agentExec`) run immediately with no per-command confirm — "the grant IS the authorization" over a kernel-isolated sandbox. There is no per-action AR dialog for these; holding the power is the gate.
- Proposal `type` strings visible inline: `note-edit, email, subagent, system-prompt, contact-add, contact-edit, spawn-specialist, give-kazputer, kazputer-setting, kazputer-coins, diet-site-update`. The exact HomeAssistant proposal `type` (the `home-assistant` kind) is set in `homeassistant-trie.mjs` — **verify in `/home/dan/endo-bfb/packages/chat/voice-agent/homeassistant-trie.mjs`** if you must match it.

> **Gap to close before M4:** the exact wire contract for confirming/rejecting (`commitProposal`/`rejectProposal`, and that `/confirm`/`/reject` are the endpoints) is in `/home/dan/endo-bfb/packages/chat/voice-agent/server.mjs`; the `Proposal` and `Ask` object field shapes are produced by `getProposal`/`getAsk` in `agent-caps.mjs` / `asks-store.mjs`. Treat `proposals[]`/`asks[]` as **opaque renderable objects** until you confirm their fields there. Render `title`/`summary`/`type` and the confirm/reject buttons; don't synthesize typed-question controls until you've read those files.

### (f) Prior art & foundations — why these rules are the rules

This whole section is not invented for this project; it restates a settled body of capability-secure-UI research. If you're going to make engineering trade-offs against the security model, read the primary sources — they are unanimous and decades-deep (a focused literature review verified the following claims at 3-of-3 adversarial agreement):

- **Ka-Ping Yee, *User Interaction Design for Secure Systems* (ICICS 2002, CSD-02-1184).** Defines the exact boundary §7 is built on. *Trusted Path:* "an unspoofable and faithful communication channel between the user and any entity trusted to manipulate authorities on the user's behalf." *Identifiability:* distinct objects/actions must have "unspoofably identifiable and distinguishable representations" — i.e. an agent-drawn region must not be able to impersonate trusted chrome (§7b). *Explicit Authority:* authority transfers only "as a result of an explicit action that is understood by the user to imply granting" — your confirm dialogs (§7e). *Revocability:* the user must be able to "easily revoke authorities that the user has granted" (§7c, share/revoke). Same author as the Polaris team below; treat these four as the acceptance criteria for the security model.
- **Dhamija & Tygar, *Dynamic Security Skins* (SOUPS 2005).** The concrete trusted-path mechanism to emulate, and the reason fixed logos/badges are worthless in AR. Their **"general-purpose graphics property":** *any* platform that permits general graphics permits spoofing — "if we are building a system designed to resist spoofing we must assume that uniform graphic designs can be easily copied." So a hard-coded "you're talking to the field agent" glyph an agent could redraw proves nothing. Their fix: make the trusted region's appearance depend on a **per-user secret that never crosses the network** (a personal image only ever *displayed*, never transmitted), and draw all untrusted regions with a "dramatically different, solid, non-patterned border, so they cannot be mistaken for authenticated windows." **The AR translation:** your trusted chrome (the system-owned ornament/sheet of §7b) should carry a per-user secret skin — a color, glyph, or ambient the agent's RealityView volume has never been told and cannot read — so the user authenticates real chrome by one visual match. **This is the §7a cap-hygiene rule turned inside-out:** just as the swissnum must never enter the scene graph, the trusted-path secret must never be readable by agent-drawable content. Keep both out of anything the model can author or observe.
- **Stiegler, Karp, Yee, Close, Miller, *Polaris: virus-safe computing for Windows XP* (CACM 2006 / HPL-2004-221).** The canonical **"designation = authorization"** system (matches the field's own auth model). A confined app gets *only* the authority the user pointed at: "the act of designation is also treated as an act of authorization" — the app reaches only files "the user explicitly specifies by double-clicking or selecting in a dialog," brokered by a trusted **powerbox**. In AR: gaze+pinch *on a specific object* is the grant; the agent's render authority is exactly the volume the user designated, nothing ambient.
- **Confinement primitive — SES Compartments / WASM, not Realms.** If you ever run model-authored applet *code* (not just render server-described shapes — see §10), the verified finding is blunt: a fresh global/Realm is **not** a security boundary on its own ("this cannot be used for isolation or security properties without freezing those intrinsics or hiding them behind a membrane"; the Agoric realms-shim is now marked *OBSOLETE, INSECURE*). `ShadowRealm` is an **integrity** boundary only — its own explainer states it is "not aiming to defend against malicious code" and cannot guarantee availability (same-thread, so a guest can stall you). The real primitives are **SES/HardenedJS Compartments** (already this stack's substrate — `lockdown()` + `Compartment`, independent frozen globals) or a **WASM component** ("the only thing a WebAssembly instance can do is what is available through interfaces it has been explicitly linked with" — zero implicit authority, lexical least-privilege at the module boundary). An applet gets *only* its rendering capability, handed in explicitly.
- **The anti-pattern to avoid — tldraw `make-real`.** The current state of the art in "LLM emits UI" renders model output inline in an iframe that is **not** sandboxed and is granted broad device/sensor permissions (`camera;microphone;usb;geolocation;…`), constrained only by a natural-language system prompt. That is exactly what a capability-secure substrate must *not* do: never let model-authored content run with ambient web-platform authority. Bounded, revocable, explicitly-linked rendering authority is the whole point.

The literature review came back **thin on three angles that matter for the eventual 3D substrate** (portable tiered rendering across heterogeneous GPUs; force-directed/Obsidian-graph legibility as a placement language; and compositor/scene-graph isolation + AR clickjacking/occlusion input-routing). Those are being researched separately; until that lands, treat the occlusion/input-routing details in §7d as a *floor* (the conservative rule — agent geometry never on top of, and never intercepting input destined for, trusted chrome), not a finished design.

---

## 8. The agent-manifest contract

The canonical "Endo SPWA client" contract is defined in `/home/dan/endo-bfb/packages/chat/rover-app/GUIDE.md` (building) and `/home/dan/ENDO-PUBLISHING.md` (publishing), with the verbatim `#agent-manifest` shape in `/home/dan/endo-bfb/packages/chat/gpu-studio/public/index.html`.

### What it is

An SPWA page embeds, in `<head>`, a `<script type="application/json" id="agent-manifest">` block (preceded by an `<!-- AI AGENT? … -->` comment) so that **an LLM handed the invite link can USE and DELEGATE the cap headlessly** — no browser. It tells a headless caller:
- **Where its authority is** — the swissnum is the value after `#cap=` in *its own* URL; the server never receives the fragment, so the agent reads it from its link and sends it as `swissnum` on every call.
- **The wire** — `POST {origin}/rpc` with `{swissnum, method, args}` → `{ok, result|error}`.
- **How to introspect** — every cap answers `__getMethodNames__` (→ method names), `help` (→ usage), `describe` (→ `{kind,...}`).
- **The method catalog** per cap kind (root vs attenuated share), with signatures.
- **How to delegate** — `share(label, opts?)` → `{url}` (a fresh `#cap=` invite); delegation is **monotonic** (a share cap has no `share`/`revoke`, so it cannot re-widen); and how to `revoke(swiss)`.

### Introspecting a cap and which verbs are confirm-gated

> **Whose job is this?** Verb introspection and the propose*-family classification below are a **headless-caller concern** — what an LLM driving the cap over `/rpc` needs. **The chat client (your visionOS app) does NOT do this.** The server already classifies and hands you `proposals[]` (parked, need `/confirm`) and `autoFired[]` (already ran); you render those as returned and never inspect the toolbox or decide what is destructive. The rest of this subsection is for the headless `/rpc` path.

Over `/rpc` against `node.cap`:
- `describe()` → coarse view: `{ kind:'root'|'share', label, powers:[{name,label}], canMint, hasHomeAssistant, hasAgents }`.
- `node.toolbox(ctx)` (the in-turn introspection surface) yields `{toolbox, manifest}` where each manifest entry is `{ name, description, args, reversible }`. **`reversible` does NOT mean "no confirmation."** Confirmation is decided by whether the verb is a `propose*` verb (returns `{proposed:true,id}`), not by `reversible`. `reversible === (class ∈ {reversible, delegate})` — i.e. abortable/speculative or a delegation.

POLICY classes (the enforced contract, `endowments.test.mjs`):
- **read** — observe only, free.
- **reversible** — speculative, abortable (e.g. `generateImage`).
- **scoped-write** — confined to the agent's own home folder (`fileWrite`, `publishSite`).
- **notify** — immediate, low blast radius (`pushFeed`, `notify`, `retitleChat`, …).
- **propose** — DESTRUCTIVE → becomes a confirmable proposal (agent proposes, human confirms).
- **coarse** — the grant IS the authorization (`vmExec`, `agentExec` over a sandbox).
- **delegate** / **share** — attenuated sub-bundles / named revocable invites.

So a **headless caller** decides "does this need a trusted-path confirm?" by **whether the verb is in the `propose*` family** (or `haAct`/`dietRefreshSite`), not by the `reversible` flag. (Again: the chat client doesn't classify — it just renders `proposals[]`/`autoFired[]`.)

### share() / revoke()

- `share(label[, opts])` mints a **new swissnum bound to a narrower facet** → returns `{url, swiss, label, …}`. The label is required (`ENDO-PUBLISHING` refuses an unnamed share). `listShares()` → `[{swiss/url, affordance/label, …}]` backs a name-it-to-revoke-it panel.
- `revoke(swiss)` = `locator.delete(swiss)` → the link goes dead instantly; the holder's own access is untouched.
- **Cap-hygiene applies to mint UI:** the mint affordance confirms *that* a link was made + its attenuation and offers copy/QR — it does **not** print the link. `createInvite` deliberately does **not** return the link to the LLM.

### How a visionOS client could be self-describing

Even though a native app has no DOM, you can ship the same `#agent-manifest` JSON as a bundled resource / a `/.well-known`-style manifest your service exposes, so that an LLM (or another agent) handed *your* client's cap can drive it headlessly. Treat the manifest as **advisory** and rely on live introspection (`__getMethodNames__`/`help`/`describe`) per cap — the schema is conventional, not formally specified, and field names may vary per app.

---

## 9. Milestones

**M0 — read-only SSE scene viewer.** Hard-code/import a valid cap and a `sid`; open `GET /chat/steps?sid=<sid>`; render incoming `start`/`done`/`rnode`/`end` events as RealityKit entities (shapes + colors by kind) in a volumetric window, no animation polish required. The client builds every entity from typed enum data — no agent-authored geometry — so no spoofing defense is needed yet (§7b). *Acceptance:* trigger a turn from the existing web client with the same `sid` and watch the AR volume populate with correctly-typed/colored nodes and edges in real time, then clear/settle on `end`.

**M1 — send a turn.** Add `POST /chat` (open the SSE first, same `sid`), render the buffered `answer`, and reconcile the scene against the response `steps[]` after `end`. Maintain client-owned `history` (`slice(-24)`, exclude current turn; the server honors `-24` when sent and falls back to a `-12` memory only if you send none). *Acceptance:* type a prompt in AR, get an answer, and the scene matches `steps[]` exactly even if you kill the SSE mid-turn.

**M2 — live fan-out render.** Faithful port of the pendant: grow-in (`easeOutBack`), position easing, idle spin, sine-pulse pending glow, fresnel glow shell, connector lines, root descend, research subtree nesting via keyed `rnode` upserts, hover/pin inspection (gaze/pinch). *Acceptance:* a research-heavy turn renders the 3-level nested subtree live (research → sub-question → tool/phase, `synth`→report), with pending pulse → settle → red-on-fail, indistinguishable in *meaning* from the web pendant.

**M3 — placement/anchoring + "where significant."** Anchor the turn volume to the active prompt; promote to walk-around (volumetric or Full Space); let the agent place a small number of *significant* shapes at meaningful positions within its delegated, bounded volume. **This is the milestone that first makes the §7b/§7d spoofing/occlusion threat reachable** (the agent now influences free-form placement) — the system-owned-chrome and input-routing discipline becomes mandatory here. *Acceptance:* the user can walk around the trace; agent-placed shapes appear only inside the bounded volume and never overlap/occlude trusted chrome.

**M4 — confirm-gated actions with trusted path.** Surface `proposals[]` in a system-owned trusted-path dialog (showing `agentId`, `title`, `summary`, `type` — never agent-influenced `detail`/`info` adjacent to the confirm buttons); wire `POST /confirm`/`/reject`; always re-prompt for `home-assistant`/`spawn-specialist` (no "don't ask again"); show `autoFired[]`. The server already classified these for you — render, don't introspect. *Acceptance:* a destructive proposal cannot execute without a confirm rendered in a surface the agent can't draw into; the two NEVER_AUTO kinds always re-prompt; revoking a "don't ask again" rule works. (Read `server.mjs` + `agent-caps.mjs`/`asks-store.mjs` first for the proposal field shapes.)

**M5 — share/revoke caps.** Implement local-only cap hand-off (copy + on-demand locally-generated QR, wiped on close) and a name-it-to-revoke-it Shares panel backed by `share`/`listShares`/`revoke` over `/rpc`. *Acceptance:* you can mint an attenuated invite, see it in the panel (without ever rendering the swissnum), and revoke it so the link goes dead — verified by a second device that loses access immediately.

---

## 10. Open questions & what's still web-only

- **CapTP-over-WebSocket vs HTTP/JSON `/rpc`.** This service is **HTTP/JSON only** (no WebSocket in the server). Sub-caps come back as **swissnum strings**, not live remote object references. The CapTP-over-WS upgrade (which would return live facet refs and compose membranes transparently) exists in the repo (`packages/daemon/src/ws-gateway.js`, `packages/chat/connection.js`, `packages/chat/main.js`) but is **not wired into this voice-agent server**, and there is **no native (non-browser) CapTP client example** in the facts. For now, dial `/rpc` with JSON; treat shared sub-caps as strings.
- **No token stream.** The `/chat` answer is fully buffered (single JSON). The only live signal during a turn is the coarse tool-step SSE. If you want incremental answer text, **this server doesn't provide it** as written — verify against `/home/dan/endo-bfb/packages/chat/voice-agent/server.mjs` if that changes.
- **`child-done` is dead/forward-compat.** The web client handles it; the server never emits it. Ignore until emitted. Also: **delegate/askSpecialist/employ subtrees are NOT live-incremental** — they arrive batched in the `done` event's `children[]` as **flat `{name, detail}` only** (built from `result.toolsUsed`); only **research** streams live via `rnode` and carries a deep subtree with `info`/`ok`/grandchildren.
- **Proposal / Ask field shapes are opaque here.** Produced by `getProposal`/`getAsk` in `agent-caps.mjs` / `asks-store.mjs` (not fully read). Treat as renderable objects; **verify fields** before building typed-question or destructive-confirm controls.
- **Confirm wire details.** `/confirm`/`/reject` are the endpoints; `commitProposal`/`rejectProposal` and exact gating live in `server.mjs` — read it before M4.
- **HomeAssistant proposal `type`.** Set in `homeassistant-trie.mjs` (not read here). Verify if you must match the exact string for the `home-assistant` NEVER_AUTO kind.
- **Live origin / dial host.** Default `BASE_URL` is `http://100.83.80.102:8778`, but the app is reached over `tailscale serve` HTTPS. The hostname `https://archua.taildd002.ts.net` appears only in an **in-file comment** (server.mjs lines 29–31), not as a configured/verified serve target. The exact public-facing origin is environment-dependent (`PUBLIC_BASE_URL` / tailscale serve config) — **confirm from the actual tailscale serve config**, not from `BASE_URL` or the comment.
- **CORS for off-page `/rpc`/`/chat`.** Not documented in the facts; server examples assume same-origin. A native client isn't bound by browser same-origin, but **verify `Access-Control-*` behavior in `server.mjs`**.
- **History length asymmetry.** Send client-owned `history` at `slice(-24)` (the server's accepted incoming bound, server.mjs:313). If you send none, the server falls back to its volatile in-memory session capped at `slice(-12)` (server.mjs:344) — so "what the agent remembers if the client sends nothing" is half the window. Always send the durable transcript.
- **Live-vs-final text truncation.** Live `rnode` sub-question labels truncate to 30 chars (agent-caps.mjs:480); the persisted `researchTree` form truncates the sub-question to 40 chars and report `info` to 600 chars (server.mjs:121,123). Reconciliation against `steps[]` after `end` may lengthen a label/info — cosmetic, but don't assume byte-identical.
- **Scene units are relative, not meters.** Octahedron radii 0.32–0.6, `ROOT_Y=1.35`, layout radii 1.4–1.55 are arbitrary Three.js units sized for a ~150–240px-wide canvas. Preserve **ratios** (root ≈ 1.9× a tool, glow shell 1.25×, label offset 0.7 below center); rescale the whole volume to a comfortable physical anchor size.
- **Labels: 2D billboard vs 3D text.** pendant.js uses billboarded canvas-texture sprites (always camera-facing, depthTest off). You must decide whether AR labels stay 2D billboards (SwiftUI attachments) or become 3D text. The facts don't decide this.
- **Camera/orbit.** pendant.js auto-frames with a fixed `PerspectiveCamera` (no user orbit on the pendant; orbit lives in the separate full-screen `trace.js`, **not read** — read `/home/dan/endo-bfb/packages/chat/voice-agent/public/trace.js` if you want to match the full viewer's interactions). In AR the "camera" is the user's head; the auto-fit/`desiredDist` logic maps to **choosing an initial anchor scale/placement**, not a literal camera move.
- **Native cap-hygiene specifics.** The cap-hygiene rules are written for browser SPAs (DOM, address bar, `navigator.share`, `history.replaceState`). The *spirit* maps to native (Keychain storage, native QR/share sheet, never persisting the swissnum), but the docs give no native-specific guidance — design it deliberately.
- **Deeper AR trusted-path design** (§7b/§7d) is being researched separately and will augment that section.

---

## Appendix

### A. Endpoint reference (compact)

```
POST /chat          any  {sessionId,text,cap,attachments?,model?,history?}
                         -> {answer,images[],toolsUsed[],steps[],proposals[],autoFired[],asks[],agentId,attachments[]}
                         -> {cancelled:true} | 403{error} | 400{error}
POST /cancel        sid  {sessionId} -> {cancelled:true}
GET  /chat/steps    none ?sid=<sid> -> text/event-stream (data: JSON by `t`; `: ok`, `: hb` comments)
POST /rpc           any  {swissnum,method,args=[]} -> {ok,result} | 404{ok:false,error} | 400{ok:false,error}
POST /stt           none <raw audio bytes> -> {text} | 400 | 502
POST /chats/load    any  {cap} -> {data|null}
POST /chats/save    any  {cap,data} -> {ok} | 413
POST /models        any  {cap} -> {models:[{id,label}]}   // 'default' = Gemma local
POST /feed/load     any  {cap} -> {items[],attentionCount}
POST /feed/dismiss  any  {cap,id} -> {ok}
POST /confirm       any* {cap,id,dontAskAgain?} -> commitProposal()   (*isRoot OR powers.has(prop.power))
POST /reject        any* {cap,id,dontAskAgain?} -> rejectProposal()
POST /memo|/memos/load|/memos/delete|/memo/rerun|/ingest|/seed-chats/load|/chat/rerun|/feedback|/dev/updates|/thread/reply|/asks/load|/asks/answer|/asks/flush  ROOT
```

### B. SSE event reference

```
t:'start'  {t,name,detail}                                  // tool-start; detail ≤200ch, NO cap/contents
t:'done'   {t,name,ok,detail,children?}                     // ok=(result.ok!==false)
                                                            //   research children = DEEP researchTree (info/ok/grandchildren/report)
                                                            //   delegate/askSpecialist/employ children = FLAT {name,detail} only
t:'rnode'  {t,key,parent?,kind?,label?,detail?,info?,state?} // research-subtree upsert; kind=subq|tool|phase; state=pending|done|fail
t:'end'    {t}                                              // once per turn; close SSE
t:'child-done' {t,parent,name,ok}                           // DEAD/forward-compat — server never emits; ignore
```

Research key scheme: sub-question `s<i>`; per-sub tool `s<sub>t<n>`; distill phase `s<sub>d`; synthesis phase `synth`.
Truncation: live subq label → 30 chars (agent-caps.mjs:480); persisted form → subq 40 chars, report info 600 chars (server.mjs:121,123).

Security headers (every response, server.mjs:127–131): `x-content-type-options: nosniff`; `x-frame-options: DENY` (only `/trace-app.html` overrides to `SAMEORIGIN`, line 227); `referrer-policy: no-referrer`; `permissions-policy: payment=(),interest-cohort=(),browsing-topics=()`; CSP (line 130) = `default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'`.

### C. Example payloads

`POST /chat` request (mirror of app.js:328–334):
```json
{ "sessionId":"3f9a2c1b", "text":"research the best lidar for an indoor rover",
  "cap":"<32-hex-swissnum>", "model":"default",
  "history":[ {"role":"user","content":"hi"}, {"role":"assistant","content":"hello"} ] }
```

SSE during a research turn (illustrative sequence):
```
: ok
data: {"t":"start","name":"research","detail":"best lidar for indoor rover"}
data: {"t":"rnode","parent":"research","key":"s0","kind":"subq","label":"❓ what lidar specs matter","detail":"what lidar specs matter indoors","state":"pending"}
data: {"t":"rnode","parent":"s0","key":"s0t1","kind":"tool","label":"webSearch","detail":"indoor lidar range accuracy","state":"done"}
data: {"t":"rnode","parent":"s0","key":"s0d","kind":"phase","label":"distilling…","state":"pending"}
data: {"t":"rnode","key":"s0d","state":"done","label":"distilled"}
data: {"t":"rnode","key":"s0","state":"done","info":"<distilled summary…>"}
data: {"t":"rnode","parent":"research","key":"synth","kind":"phase","label":"synthesizing…","state":"pending"}
data: {"t":"rnode","key":"synth","state":"done","label":"report","info":"<report excerpt…>"}
data: {"t":"done","name":"research","ok":true,"detail":"…","children":[ /* deep researchTree subtree */ ]}
data: {"t":"end"}
```

### D. File pointers (read these in source)

| File (absolute) | Why |
| --- | --- |
| `/home/dan/endo-bfb/packages/chat/voice-agent/server.mjs` | The wire: PORT/BIND, `/chat`, `/chat/steps` SSE (`emitStep` line 108), `/rpc`, `/confirm`/`/reject`, root swissnum persistence, security headers (SEC 127–131, XFO override 227), history fallback `-12` (344), researchTree truncation (121,123). Read before M1/M4. |
| `/home/dan/endo-bfb/packages/chat/voice-agent/public/app.js` | Reference client: cap parse/strip (11–20), `/chat` payload + `history` `-24` (328–334), SSE consumer (963–964), pendant lifecycle (`pendantBegin`/`End`/`ShowFor`). |
| `/home/dan/endo-bfb/packages/chat/voice-agent/public/pendant.js` | The scene model to port: COL palette + DELEGATE set + maps (20–33), shaders (35–39), node construction (75–96), grow/tween (110–116), root descend (180–196), `rnode` upsert (215–232), animation loop (292–308), layout math (136–153). |
| `/home/dan/endo-bfb/packages/chat/voice-agent/public/trace.js` | The full-screen viewer (NOT read in facts) — read if you want to match orbit/version-scrubber interactions. |
| `/home/dan/endo-bfb/packages/chat/voice-agent/agent-caps.mjs` | Powers/POLICY/confirm-gating, research→`rnode` mapping + live subq 30-char truncation (478–485), `share`/`revoke`/`createInvite`, `describe()`, sub-agent power-intersection (META_POWERS), proposal/ask producers. |
| `/home/dan/endo-bfb/packages/chat/voice-agent/asks-store.mjs` | `Ask` object shape (verify before rendering typed-question controls). |
| `/home/dan/endo-bfb/packages/chat/voice-agent/homeassistant-trie.mjs` | HomeAssistant proposal `type` string (the `home-assistant` NEVER_AUTO kind). |
| `/home/dan/endo-bfb/packages/chat/rover-app/GUIDE.md` | Canonical Endo SPWA client contract: cap-in-URL, `/rpc` adapter, cap-hygiene §9, share/revoke §3, agent-manifest §7. |
| `/home/dan/ENDO-PUBLISHING.md` | Publishing (tailnet default, nftables accept, public-bind-is-explicit-only), share-with-label, root persistence. |
| `/home/dan/endo-bfb/packages/chat/gpu-studio/public/index.html` | Verbatim `#agent-manifest` reference shape. |